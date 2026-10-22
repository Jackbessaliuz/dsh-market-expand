/**
 * market-expand 更新助手（独立进程，Detached）
 *
 * 为什么要有这个进程：官方桌面端的 profile 被 Electron 独占，运行中的 DSH
 * 不能改自己的 node_modules（市场自更新会在 remove 那步把自己摘掉，#900；
 * 设置页没有更新入口 #909）。唯一可靠的路是：宿主退出后，在 profile 目录
 * 跑 pnpm add。
 *
 * 本进程的职责就是把这套流程自动化：
 *   1. 等宿主进程消失（用户退出 DSH）
 *   2. 在 profile 目录逐个 pnpm add <name>@<target> --config.minimum-release-age=0
 *   3. 写报告（成功/失败/输出尾部）
 *   4. 重新启动宿主（可选）
 *
 * 用 detached + stdio:ignore 启动，宿主退出后它仍然活着。
 * 由 lib/index.js 的 /apply 端点 spawn；也可以手动：
 *   node lib/updater.mjs <queue.json>
 */
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROGRESS_PS1 = path.join(HERE, 'progress-window.ps1')
/** 进度窗口底部那四格：更新 → 自检 → 回退 → 重启。 */
const PROGRESS_STEPS = ['更新', '自检', '回退', '重启']

/**
 * 单次 `dsh plugin add` 的总时长上限。
 *
 * 为什么是 10 分钟：官方 plugin manager 自己的 idleTimeoutMs 就是 600000
 * （10 分钟没有输出才判死），它给 pnpm 安装的时间远不止 5 分钟。GitHub 源
 * 的包尤其慢 —— 2026-10-21 群友实测一个 `github:...#tag` 装了约 9 分钟。
 * v1.2.4 用 300 秒，等于给正常安装判了死刑，还连带把后面的包卡死。
 *
 * ME_CLI_TIMEOUT_MS 只给冒烟测试覆盖用，正式运行不要设。
 */
const CLI_TIMEOUT_MS = Number(process.env.ME_CLI_TIMEOUT_MS) > 0
  ? Number(process.env.ME_CLI_TIMEOUT_MS)
  : 600000
/** 等 profile 写锁的上限（官方 lockWaitMs 默认 120000）。 */
const LOCK_WAIT_MS = 120000

/**
 * 进程活着之后，最多再等多久让主窗口出现（2026-10-22 群友事故后加）。
 *
 * 旧自检只看「进程存活 + 无 crash 日志」：群友那次助手报「已重启 + 自检通过」，
 * 但他整整 2.5 分钟没看到 DSH 窗口（录屏实证）。Electron 应用 spawn 成功 ≠ 窗口
 * 出来，所以补一道主窗口句柄检查。
 *
 * ME_WINDOW_GRACE_MS 只给实例测试缩短用，正式运行不要设。
 */
const WINDOW_GRACE_MS = Number(process.env.ME_WINDOW_GRACE_MS) > 0
  ? Number(process.env.ME_WINDOW_GRACE_MS)
  : 90000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

// 最近几行日志同步给进度窗 —— DSH 起不来时，那是用户唯一能看到的地方
const LOG_LINES = []
let PROGRESS_FILE = null

// ---------- 基础 ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch { /* 报告写不进去不该让整个更新挂掉 */ }
}
function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `[${nowIso()}] ${line}\n`, 'utf8')
  } catch { }
  LOG_LINES.push(String(line))
  if (LOG_LINES.length > 8) LOG_LINES.shift()
  // 立即补进进度窗（两次 writeProgress 之间也能看到日志在走）
  if (PROGRESS_FILE) {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        const st = readJson(PROGRESS_FILE, null)
        if (st) { st.logLines = LOG_LINES.slice(-6); st.at = nowIso(); writeJson(PROGRESS_FILE, st) }
      }
    } catch { }
  }
}

/** 进程是否还活着（Windows 上 kill(pid,0) 对不存在进程抛 ESRCH/EPERM）。 */
function alive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// ---------- pnpm 定位 ----------
/**
 * 找一个可用的 pnpm。桌面端的 Electron 进程继承的 PATH 未必含 nvm/npm 的
 * shim，所以除了 PATH 还探测几个常见安装位；每个候选都真的跑一次 --version，
 * 只信能跑通的。
 */
function pnpmCandidates() {
  const out = []
  const push = (p) => { if (p) out.push(p) }
  push(process.env.PNPM_PATH)
  push('pnpm')                                  // PATH 里的 shim
  if (process.env.APPDATA) {
    push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'))
    push(path.join(process.env.APPDATA, 'npm', 'pnpm'))
    push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  if (process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'pnpm.exe'))
    push(path.join(process.env.LOCALAPPDATA, 'Author Software', 'nvm', '.nodejs', 'pnpm.exe'))
    push(path.join(process.env.LOCALAPPDATA, 'nvm', 'pnpm.exe'))
  }
  if (process.env.USERPROFILE) {
    push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'pnpm.cmd'))
  }
  // 去重
  return [...new Set(out.filter(Boolean))]
}

/** cmd.exe 里的参数安全包裹：含空白/引号的才加引号。 */
function cmdQuote(s) {
  const v = String(s)
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * 跑一个命令，返回 {ok, code, out, err, timedOut}；Windows 的 .cmd/.bat 走 cmd /c。
 *
 * 实测坑：`cmd /d /s /c <带空格的路径>.cmd --version` 会在空格处截断
 * （报「'C:\Program' 不是内部或外部命令」）。正确写法是整条命令再包一层
 * 引号，并用 windowsVerbatimArguments 原样交给 cmd。
 *
 * 超时为什么不用 execFile 自带的 timeout：Windows 上它只 TerminateProcess
 * 直接子进程（我们 spawn 的 cmd.exe），cmd 拉起的 node 孙进程会继续活着 ——
 * 而 `dsh plugin add` 的整个 pnpm 安装都在 node 里、且持着 profile 写锁
 * （2026-10-21 群友事故：超时后残留 node 又跑了 6 分钟，后续两个包全卡在
 * 锁上）。实测复现：parent KILLED by timeout 后 6 秒，孙进程照样写文件。
 * 现在自己计时，超时用 taskkill /T /F 杀整棵树。
 */
function runFile(file, args, opts = {}) {
  return new Promise((resolve) => {
    const isShim = /\.(cmd|bat)$/i.test(file)
    const cmdExe = process.env.ComSpec || 'cmd.exe'
    const line = isShim
      ? `""${file}" ${args.map(cmdQuote).join(' ')}"`
      : null
    const spawnFile = isShim ? cmdExe : file
    const spawnArgs = isShim ? ['/d', '/s', '/c', line] : args
    const timeoutMs = opts.timeout || 180000
    let child = null
    let timedOut = false
    let settled = false
    let timer = null
    let hardTimer = null

    const finish = (err, stdout, stderr) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
        timedOut,
      })
    }

    child = execFile(spawnFile, spawnArgs, {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: isShim,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
    }, finish)

    timer = setTimeout(async () => {
      if (settled) return
      timedOut = true
      if (child && child.pid) {
        if (process.platform === 'win32') await killTree(child.pid, opts.logFile, '安装进程')
        else { try { process.kill(child.pid, 'SIGKILL') } catch { } }
      }
      // 树都杀了回调还不来（极端情况），自己收尾，别把整个更新卡死
      hardTimer = setTimeout(() => finish(new Error('超时后进程仍未退出'), '', ''), 15000)
    }, timeoutMs)
  })
}

/** 把失败归成几类 —— 报告里必须写清楚，不然一句「没有可用的更新通道」会把排查带偏。 */
function classifyFailure(r) {
  if (!r) return 'failed'
  if (r.timedOut) return 'timeout'
  const text = `${r.err || ''}\n${r.out || ''}`
  if (/timed out waiting for the writer lock/i.test(text)) return 'lock'
  if (/being written to by another process|EBUSY|EPERM.*package\.json/i.test(text)) return 'lock'
  return 'failed'
}

/** 失败原因的人话版本：写进 last-update.json 和桌面 txt，保留真实错误尾部。 */
function failureText(kind, r) {
  const tail = String((r && (r.err || r.out)) || '').trim()
    .split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 200)
  const suffix = tail ? `；原始错误：${tail}` : ''
  if (kind === 'timeout') return `更新超时（${Math.round(CLI_TIMEOUT_MS / 1000)} 秒内没装完），已结束该安装进程及其子进程${suffix}`
  if (kind === 'lock') return `profile 写锁被另一个安装进程占着（等了 ${Math.round(LOCK_WAIT_MS / 1000)} 秒没释放）${suffix}`
  if (kind === 'channel') return `没有可用的更新通道（桌面端 CLI 不可用，也没找到 pnpm）${suffix}`
  return tail || '未知错误'
}

/** profile 写锁（atomic-write 的 <package.json>.lock）当前持有者 pid；没锁返回 0。 */
function readProfileLockPid(profileDir) {
  try {
    const n = Number(fs.readFileSync(path.join(profileDir, 'package.json.lock'), 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

/**
 * 等 profile 写锁空出来。
 * 锁文件里的 PID 已经不存在时直接算空闲 —— atomic-write 的 takeOverExitedLock
 * 会自己接管死锁，不需要我们删（也不该删别人的锁）。
 */
async function waitProfileLockFree(profileDir, { maxMs = LOCK_WAIT_MS, logFile, reason = '' } = {}) {
  const start = Date.now()
  let nextNote = 30000
  for (;;) {
    const pid = readProfileLockPid(profileDir)
    if (!pid) return { free: true, waited: Date.now() - start, holder: 0 }
    if (!alive(pid)) return { free: true, waited: Date.now() - start, holder: pid, deadHolder: true }
    const waited = Date.now() - start
    if (waited >= maxMs) return { free: false, waited, holder: pid }
    if (logFile && waited >= nextNote) {
      appendLog(logFile, `  等待 profile 写锁释放…已 ${Math.round(waited / 1000)} 秒（持有 pid=${pid}${reason ? '，' + reason : ''}）`)
      nextNote += 30000
    }
    await sleep(1500)
  }
}

async function findPnpm(logFile) {
  // node 直接跑 pnpm.cjs 的分支：显式 node 可执行文件
  for (const cand of pnpmCandidates()) {
    if (/pnpm\.cjs$/i.test(cand)) {
      if (!fs.existsSync(cand)) continue
      const nodeExe = process.execPath
      const r = await runFile(nodeExe, [cand, '--version'], { timeout: 60000, env: { ELECTRON_RUN_AS_NODE: '1' } })
      if (r.ok) {
        appendLog(logFile, `pnpm 定位成功（node ${path.basename(nodeExe)} + ${cand}）: ${r.out.trim()}`)
        return { kind: 'node-cjs', file: cand, version: r.out.trim() }
      }
      continue
    }
    if (cand !== 'pnpm' && !fs.existsSync(cand)) continue
    const r = await runFile(cand, ['--version'], { timeout: 60000 })
    if (r.ok && /\d+\.\d+/.test(r.out)) {
      appendLog(logFile, `pnpm 定位成功（${cand}）: ${r.out.trim()}`)
      return { kind: 'bin', file: cand, version: r.out.trim() }
    }
  }
  appendLog(logFile, 'pnpm 定位失败：所有候选都跑不通')
  return null
}

async function runPnpm(pnpm, args, cwd, logFile) {
  appendLog(logFile, `$ pnpm ${args.join(' ')}`)
  const r = pnpm.kind === 'node-cjs'
    ? await runFile(process.execPath, [pnpm.file, ...args], { cwd, timeout: 600000, env: { ELECTRON_RUN_AS_NODE: '1' } })
    : await runFile(pnpm.file, args, { cwd, timeout: 600000 })
  const tail = (s) => String(s || '').trim().split(/\r?\n/).slice(-8).join('\n').slice(0, 1200)
  if (r.ok) appendLog(logFile, `  ok: ${tail(r.out)}`)
  else appendLog(logFile, `  FAIL(${r.code}): ${tail(r.err || r.out)}`)
  return { ok: r.ok, code: r.code, out: tail(r.out), err: tail(r.err) }
}

/**
 * 首选通道：Desktop 自带的 CLI。
 *
 * 官方从 rc.2 起只接受 Desktop 自己的 carrier 管理 desktop profile，且必须
 * Desktop 完全退出——更新助手正好在退出之后跑。CLI 会走官方 plugin manager，
 * 维护 dsh.profile.bundles 与兼容性检查，比裸 pnpm 更完整。
 */
async function runCliAdd(cli, profileName, spec, logFile) {
  appendLog(logFile, `$ dsh plugin --profile ${profileName} add ${spec}`)
  const r = await runFile(cli, ['plugin', '--profile', profileName, 'add', spec], { timeout: CLI_TIMEOUT_MS, logFile })
  const tail = (s) => String(s || '').trim().split(/\r?\n/).slice(-8).join('\n').slice(0, 1200)
  if (r.ok) appendLog(logFile, `  ok: ${tail(r.out)}`)
  else if (r.timedOut) appendLog(logFile, `  TIMEOUT(${Math.round(CLI_TIMEOUT_MS / 1000)}s)：已杀进程树`)
  else appendLog(logFile, `  FAIL(${r.code}): ${tail(r.err || r.out)}`)
  return { ok: r.ok, code: r.code, out: tail(r.out), err: tail(r.err), timedOut: r.timedOut }
}

// ---------- bundles 补齐（pnpm 通道的必要补丁） ----------
/**
 * pnpm 不走官方 plugin manager，不会维护 `dsh.profile.bundles`。
 * 声明了 `dsh.bundle` 的包装上了却不在 bundles 里 → DSH 根本不会加载它（2026-10-21 实测）。
 * 这里按包自己的声明补齐（只加不删），CLI 通道成功后同样调用（幂等）。
 */
function ensureBundles(profileDir, names, logFile) {
  if (!names.length) return []
  const pkgFile = path.join(profileDir, 'package.json')
  const pkg = readJson(pkgFile, null)
  if (!pkg) return []
  const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : null
  if (!bundles) return []
  const added = []
  for (const name of names) {
    if (bundles.includes(name)) continue
    const manifest = readJson(path.join(profileDir, 'node_modules', name, 'package.json'), {})
    if (!(manifest.dsh && manifest.dsh.bundle)) continue
    bundles.push(name)
    added.push(name)
  }
  if (!added.length) return []
  try {
    if (!pkg.dsh) pkg.dsh = {}
    if (!pkg.dsh.profile) pkg.dsh.profile = {}
    pkg.dsh.profile.bundles = bundles
    const tmp = pkgFile + '.me-bundles.tmp'
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, pkgFile)
    appendLog(logFile, `已补写 dsh.profile.bundles：${added.join(', ')}`)
  } catch (e) {
    appendLog(logFile, '补写 bundles 失败：' + (e && e.message || e))
    try { fs.rmSync(pkgFile + '.me-bundles.tmp', { force: true }) } catch { }
  }
  return added
}

// ---------- 重启宿主 ----------
function restartHost(restart, logFile) {
  if (!restart || !restart.exe) return { ok: false, reason: 'no-restart-config' }
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Electron 打包应用：exe 直接启动；开发模式：exe <appPath>
    const args = Array.isArray(restart.args) && restart.args.length ? restart.args : []
    // 把宿主的 stdout/stderr 也留下来：stdio:'ignore' 会让启动错误彻底看不见
    let outFd = null
    try {
      const hostLog = path.join(path.dirname(logFile), 'host-stdout.log')
      outFd = fs.openSync(hostLog, 'a')
      fs.writeSync(outFd, `\n=== host start ${nowIso()} ===\n`)
    } catch (e) { outFd = null }
    const child = spawn(restart.exe, args, {
      detached: true,
      stdio: outFd ? ['ignore', outFd, outFd] : 'ignore',
      windowsHide: true,
      cwd: restart.cwd || path.dirname(restart.exe),
      env,
    })
    child.unref()
    if (outFd) { try { fs.closeSync(outFd) } catch { } }
    appendLog(logFile, `已重启宿主：${restart.exe} ${args.join(' ')} (pid=${child.pid})`)
    return { ok: true, pid: child.pid, exe: restart.exe }
  } catch (e) {
    appendLog(logFile, `重启宿主失败：${e && e.message || e}`)
    return { ok: false, reason: String(e && e.message || e) }
  }
}

// ---------- 认证 cookie 清理（2026-10-22 事故后） ----------
/**
 * 桌面端的 userData 目录（Chromium 的 cookie 库在这里）。
 * 默认 %APPDATA%\@deepseek-ai\dsh-desktop；查不到返回 null（清理自动跳过）。
 */
function desktopUserDataDir() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const p = path.join(appData, '@deepseek-ai', 'dsh-desktop')
  return fs.existsSync(p) ? p : null
}

/**
 * 剪掉 `dsh-auth-*` 认证 cookie。
 *
 * 2026-10-22 事故：桌面版每次启动都用随机端口，认证 cookie 名带端口哈希、
 * Max-Age 60 天、旧的从不清理 → 攒到 71 条时 Cookie 头 16,110 字节，超过
 * Node 默认 maxHeaderSize 16,384，host 直接拒收 → Electron welcome 认证失败
 * → 窗口不出现，手动双击也打不开。这些 cookie 每次启动即作废（账号登录不靠
 * 它），删掉完全安全。
 *
 * Node 24 的 node:sqlite 直接读写；任何失败都只记日志，不阻断重启。
 */
async function pruneAuthCookies(userDataDir, logFile) {
  if (!userDataDir) return { skipped: 'no-user-data' }
  const dbPath = path.join(userDataDir, 'Network', 'Cookies')
  if (!fs.existsSync(dbPath)) return { skipped: 'no-cookie-db' }
  let DatabaseSync = null
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch { return { skipped: 'sqlite-unavailable' } }
  let db = null
  try {
    db = new DatabaseSync(dbPath)
    const row = db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'").get()
    const count = Number((row && row.c) || 0)
    if (!count) return { deleted: 0 }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${dbPath}.bak-${stamp}-before-authcookie-clean`
    try { fs.copyFileSync(dbPath, backup) } catch { }
    const n = db.prepare("DELETE FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'").run()
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { }
    appendLog(logFile, `认证 cookie：删除 ${n.changes} 条 dsh-auth-*（原 ${count} 条，备份 ${path.basename(backup)}）`)
    return { deleted: Number(n.changes || 0), count, backup }
  } catch (e) {
    appendLog(logFile, '认证 cookie 清理失败（不阻断重启）：' + (e && e.message || e))
    return { error: String((e && e.message) || e) }
  } finally {
    try { if (db) db.close() } catch { }
  }
}

/** 本次重启之后宿主写下的 stdout（从最后一个 `=== host start` 起算）。 */
function hostOutputSince(logFile, maxBytes = 65536) {
  const p = path.join(path.dirname(logFile), 'host-stdout.log')
  try {
    const size = fs.statSync(p).size
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    const i = text.lastIndexOf('=== host start')
    return i >= 0 ? text.slice(i) : text
  } catch { return '' }
}

/** 拉起宿主前先剪认证 cookie，再启动（R2：重试前必须改变失败条件）。 */
async function restartHostSafe(restart, logFile) {
  try { await pruneAuthCookies(desktopUserDataDir(), logFile) } catch { }
  return restartHost(restart, logFile)
}

// ---------- 更新前备份 ----------
/** 备份组合关键文件：package.json / cordis.patch.yml / 市场 state.json。 */
function backupProfileFiles(queue, logFile) {
  const dir = queue.backupDir
  if (!dir) return null
  try {
    fs.mkdirSync(dir, { recursive: true })
    const files = ['package.json', 'cordis.patch.yml', path.join('.dsh-market', 'state.json')]
    const saved = []
    for (const rel of files) {
      const src = path.join(queue.profileDir, rel)
      if (!fs.existsSync(src)) continue
      const dst = path.join(dir, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      saved.push(rel)
    }
    appendLog(logFile, `更新前已备份：${saved.join(', ') || '（无可备份文件）'} → ${dir}`)
    return dir
  } catch (e) {
    appendLog(logFile, '更新前备份失败：' + (e && e.message || e))
    return null
  }
}

// ---------- 启动自检（2026-10-21 新增） ----------
// 为什么需要：桌面端启动失败会弹一个只有「禁用全部插件」按钮的窗口，点下去
// sanitizeProfile 会把 cordis.patch.yml 改名、bundles 重置成 base+web-app。
// 助手要在用户点到那个按钮之前，自己发现问题并回退。

/** 列出与给定 exe 同名的所有进程 pid（Windows tasklist）。 */
function listSameExePids(exe) {
  return new Promise((resolve) => {
    if (!exe || process.platform !== 'win32') return resolve([])
    const name = path.basename(exe)
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([])
      const pids = []
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/)
        if (m && m[1].toLowerCase() === name.toLowerCase()) pids.push(Number(m[2]))
      }
      resolve(pids)
    })
  })
}

/**
 * 更新包的「组合破坏」检查（2026-10-21 首日事故真根因后新增）。
 *
 * 有些插件的 bundle patch 会改写官方 preset 的 inject 列表，或者 insert 一个
 * 用户可以禁用的条目。一旦那个服务/条目被禁用，preset 会永远 pending，
 * Agent 预设列表整页空白 —— 这类失败不写 crash log，自检看不见。
 * 这里在更新后做静态检查，把风险点名写进日志和进度窗。
 */
function checkBundleRisks(queue, logFile) {
  const risks = []
  const profilePatch = path.join(queue.profileDir, 'cordis.patch.yml')
  let patchText = ''
  try { patchText = fs.readFileSync(profilePatch, 'utf8') } catch { patchText = '' }
  const disabledIds = new Set()
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*id:\s*([A-Za-z0-9._@/-]+)\s*$/)
    if (m) disabledIds.add(m[1])
  }
  // 只把「真的写了 disabled: true」的算进来
  const hardDisabled = new Set()
  {
    const lines = patchText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s*id:\s*([A-Za-z0-9._@/-]+)\s*$/)
      if (!m) continue
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^\s*-\s*id:/.test(lines[j])) break
        if (/^\s*disabled:\s*true\s*$/.test(lines[j])) { hardDisabled.add(m[1]); break }
      }
    }
  }

  for (const p of (queue.packages || [])) {
    if (!p || !p.name) continue
    const dir = path.join(queue.profileDir, 'node_modules', p.name)
    const manifest = readJson(path.join(dir, 'package.json'), null)
    if (!manifest) continue
    const desc = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
    const files = Array.isArray(desc) ? desc : desc ? [desc] : []
    for (const rel of files) {
      const f = path.join(dir, rel)
      if (!fs.existsSync(f)) continue
      let text = ''
      try { text = fs.readFileSync(f, 'utf8') } catch { continue }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        // ① patch 改了官方 preset 的 inject 列表
        const pm = lines[i].match(/^\s*-\s*id:\s*(preset-[A-Za-z0-9_-]+)\s*$/)
        if (pm) {
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (/^\s*-\s*id:/.test(lines[j])) break
            const im = lines[j].match(/^\s*inject:\s*(.+)$/)
            if (im) {
              risks.push({
                kind: 'preset-inject',
                package: p.name,
                preset: pm[1],
                inject: im[1].trim(),
                file: rel,
                note: `${p.name} 会给 ${pm[1]} 注入 ${im[1].trim()}；若提供该服务的插件被禁用，Agent 预设会全部不可用`,
              })
              break
            }
          }
        }
        // ② patch insert 的 id 在 profile 里被 disabled 了
        const im2 = lines[i].match(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/)
        if (im2 && !im2[1].startsWith('preset-')) {
          // 只认 insert 块里的（往上看 8 行有没有 insert:）
          let inInsert = false
          for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
            if (/^\s*-\s*id:/.test(lines[k])) break
            if (/^\s*-\s*insert:\s*$/.test(lines[k]) || /^\s*insert:\s*$/.test(lines[k])) { inInsert = true; break }
          }
          if (inInsert && hardDisabled.has(im2[1])) {
            risks.push({
              kind: 'insert-disabled',
              package: p.name,
              entry: im2[1],
              file: rel,
              note: `${p.name} 依赖自己 insert 的条目 "${im2[1]}"，而你的 profile 把它禁用了 —— 可能导致插件或 preset 失效`,
            })
          }
        }
      }
    }
  }
  if (risks.length) {
    appendLog(logFile, '⚠ 组合风险：' + risks.map((r) => r.note).join('；'))
  } else {
    appendLog(logFile, '组合检查：本次更新的包没有改写 preset/inject 声明')
  }
  return risks
}

/** since 之后新增的 web-boot 崩溃日志；没有则 null。 */
function findNewCrash(logsDir, since) {
  if (!logsDir || !fs.existsSync(logsDir)) return null
  let best = null
  try {
    for (const f of fs.readdirSync(logsDir)) {
      if (!/-web-boot\.log$/i.test(f)) continue
      const full = path.join(logsDir, f)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.mtimeMs < since - 5000) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs }
    }
  } catch (e) { /* 目录读不了 = 没有崩溃证据 */ }
  return best
}

/** 从崩溃日志里解析出没激活的插件名（`dsh-meme: import failed: …`）。 */
function parseWebBootCrash(file) {
  const names = new Set()
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (!/web boot:|did not activate/i.test(text)) return []
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([@A-Za-z0-9._/-]+):\s+(?:import failed|failed to activate|did not activate)/)
      if (m) names.add(m[1])
    }
  } catch (e) { /* 读不了就是解析不出 */ }
  return [...names]
}

/**
 * 把宿主的窗口恢复并带到前台（单次尝试）。
 *
 * 2026-10-22 但丁反馈：自动拉起的 DSH 只留在任务栏，点一下才出来；加了激活后
 * 日志说「已恢复到前台」，但他还是没看到。实验证实 detached 进程里
 * SetForegroundWindow 本身能成功（返回 true），问题在**时机**——窗口刚出现时
 * Electron 还在初始化，这一下会被吞掉。所以改成「稳定后多轮重试 + 最后强制置顶」。
 *
 * 返回 { found, handle, iconic, foreground }；查不到时 found=false。
 */
async function activateWindow(pid, handleHint) {
  if (process.platform !== 'win32' || !pid) return { found: false }
  let hwndNum = Number(handleHint || 0)
  if (!hwndNum) {
    // 窗口可能已创建但隐藏：用 EnumWindows 拿句柄（会顺手 ShowWindow），
    // 不能再用 MainWindowHandle —— 它对隐藏窗口返回 0，这正是 2026-10-22
    // 「激活老是没拿到句柄」的原因。
    const w = await findHostWindow(pid)
    if (!w.found || !w.handle) return { found: false }
    hwndNum = w.handle
  }
  return new Promise((resolve) => {
    const ps = `
Add-Type -Namespace Win -Name U -MemberDefinition '
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
'
$h = [long]${hwndNum}
if ($h -eq 0) { '{"found":false}'; exit }
$hwnd = [IntPtr]$h
if ([Win.U]::IsIconic($hwnd)) { [void][Win.U]::ShowWindow($hwnd, 9) }
if (-not [Win.U]::IsWindowVisible($hwnd)) { [void][Win.U]::ShowWindow($hwnd, 5) }
Start-Sleep -Milliseconds 200
[void][Win.U]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 200
if ([Win.U]::GetForegroundWindow() -ne $hwnd) {
  $tid = [Win.U]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
  $cur = [Win.U]::GetCurrentThreadId()
  [void][Win.U]::AttachThreadInput($cur, $tid, $true)
  [void][Win.U]::SetForegroundWindow($hwnd)
  [void][Win.U]::AttachThreadInput($cur, $tid, $false)
  Start-Sleep -Milliseconds 200
}
if ([Win.U]::GetForegroundWindow() -ne $hwnd) {
  [void][Win.U]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
  [void][Win.U]::BringWindowToTop($hwnd)
  [void][Win.U]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
  Start-Sleep -Milliseconds 200
}
@{ found = $true; handle = $h; iconic = [Win.U]::IsIconic($hwnd); foreground = ([Win.U]::GetForegroundWindow() -eq $hwnd) } | ConvertTo-Json -Compress
`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) return resolve({ found: false, error: String((err && err.message) || err) })
      const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
      try { resolve(JSON.parse(line)) } catch { resolve({ found: false }) }
    })
  })
}

/** 窗口出现后等它稳定，再最多试 3 轮把它带到前台（失败不影响更新）。 */
async function activateWindowWithRetry(pid, logFile, handleHint) {
  for (let i = 0; i < 3; i++) {
    await sleep(i === 0 ? 1500 : 1000)
    const r = await activateWindow(pid, handleHint)
    if (r && r.found && r.foreground) {
      appendLog(logFile, `自检：已把 DSH 窗口恢复到前台（第 ${i + 1} 次尝试）`)
      return true
    }
  }
  // 2026-10-22 但丁拍板：拉不起来就不强求，检测到后台已算成功，不再刷警告日志
  appendLog(logFile, '自检：窗口已出现，自动前置未生效（不影响更新，可从任务栏打开）')
  return false
}

/**
 * 主窗口句柄：>0 有窗口，0 进程活着但没有可见主窗口，-1 进程不存在，-2 查询失败。
 *
 * 用 PowerShell 的 MainWindowHandle —— 本机实测 Electron 主进程非 0、其余
 * renderer/gpu 子进程全是 0，所以必须按 spawn 出来的那个 pid 查，不能按进程名。
 * 只输出数字或 'nowin'/'gone'，避开中文控制台编码问题。
 */
function windowHandleOf(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !pid) return resolve(-1)
    // PowerShell 5.1 里 MainWindowHandle 是 IntPtr，不实现 IComparable，
    // 直接 `-gt 0` 会报「无法比较"0"，因为其不是 IComparable」→ 必须先转 [long]
    const ps = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $h = [long]$p.MainWindowHandle; if ($h -gt 0) { $h } else { 'nowin' } } else { 'gone' }`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 12000 }, (err, stdout) => {
      if (err) return resolve(-2)          // 查不了就当未知，退回旧逻辑，别误判失败
      const t = String(stdout || '').trim()
      if (t === 'gone') return resolve(-1)
      if (t === 'nowin') return resolve(0)
      const n = Number(t.split(/\r?\n/).pop())
      resolve(Number.isFinite(n) && n > 0 ? n : 0)
    })
  })
}

/**
 * 用 EnumWindows 找宿主的顶层窗口（Electron 主窗口类名 Chrome_WidgetWin_1）。
 *
 * 2026-10-22 实测：DSH 重启后任务栏 10 秒就有图标，但 MainWindowHandle 一直返回 0，
 * 主窗口 60 秒都没显示——窗口其实早就创建了，只是隐藏/未 show。Get-Process 的
 * MainWindowHandle 只认「可见」窗口，所以永远看不到它。这里直接枚举顶层窗口，
 * 找到就 ShowWindow(SW_SHOW)，不再干等。
 */
function findHostWindow(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !pid) return resolve({ found: false })
    const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFind {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static IntPtr Find(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p = 0;
      GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString() != "Chrome_WidgetWin_1") return true;
      if (GetWindowTextLength(h) == 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $p) { '{"found":false,"reason":"gone"}'; exit }
$h = [WinFind]::Find(${pid})
if ($h -eq [IntPtr]::Zero) {
  # 非 Electron 窗口（例如测试用的记事本）走常规句柄
  $h = [IntPtr]([long]$p.MainWindowHandle)
}
if ($h -eq [IntPtr]::Zero) { '{"found":false,"reason":"no-window"}'; exit }
$vis = [WinFind]::IsWindowVisible($h)
$ico = [WinFind]::IsIconic($h)
if (-not $vis) { [void][WinFind]::ShowWindow($h, 5) }
if ($ico) { [void][WinFind]::ShowWindow($h, 9) }
@{ found = $true; handle = [long]$h; visibleBefore = $vis; iconicBefore = $ico } | ConvertTo-Json -Compress
`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) return resolve({ found: false, error: String((err && err.message) || err) })
      const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
      try { resolve(JSON.parse(line)) } catch { resolve({ found: false }) }
    })
  })
}

/**
 * 轮询：出现新崩溃日志 = 失败；进程提前退出 = 无法确认；进程活着但窗口一直
 * 不出来（宽限期 WINDOW_GRACE_MS）= alive-but-no-window；超时无异常 = 通过。
 */
async function waitForHealthyBoot({ hostPid, logsDir, since, timeoutMs = 15000, logFile, exe, onWait }) {
  if (!logsDir) return { ok: true, skipped: true, reason: 'no-logs-dir' }
  const baseDeadline = Date.now() + timeoutMs
  let deadline = baseDeadline
  let aliveSince = 0
  let lastWindowCheck = 0
  let lastNote = 0
  let sawNoWindow = false
  let windowSeen = false
  for (;;) {
    if (Date.now() >= deadline) break
    await sleep(2000)
    const crash = findNewCrash(logsDir, since)
    if (crash) {
      const failed = parseWebBootCrash(crash.file)
      appendLog(logFile, `自检失败：${path.basename(crash.file)} 点名 ${failed.join(', ') || '（未能解析）'}`)
      return { ok: false, crashFile: crash.file, failed }
    }
    if (hostPid && !alive(hostPid)) {
      // 2026-10-21 群友事故：新起的进程 2 秒就退出，旧代码直接 return ok:true，
      // 整条安全网形同虚设。现在先等 8 秒，区分「被已有实例接管」和「真的没起来」。
      appendLog(logFile, '自检：新起的宿主进程提前退出（可能被已有实例接管，也可能启动失败），等 8 秒确认…')
      await sleep(8000)
      const crash2 = findNewCrash(logsDir, since)
      if (crash2) {
        const failed2 = parseWebBootCrash(crash2.file)
        appendLog(logFile, `自检失败：${path.basename(crash2.file)} 点名 ${failed2.join(', ') || '（未能解析）'}`)
        return { ok: false, crashFile: crash2.file, failed: failed2 }
      }
      const pids = await listSameExePids(exe)
      if (pids.length) {
        appendLog(logFile, `自检：同 exe 仍有 ${pids.length} 个进程在跑（pid=${pids.join(',')}），视为已有实例接管`)
        return { ok: true, unknown: true, reason: 'taken-over', pids }
      }
      appendLog(logFile, '自检失败：新进程提前退出，且系统里没有任何存活的 DSH 进程')
      return { ok: false, failed: [], reason: 'no-live-host' }
    }
    if (hostPid) {
      if (!aliveSince) aliveSince = Date.now()
      // 每 4 秒查一次窗口（每次要起一个 powershell，别太密）
      if (!windowSeen && Date.now() - lastWindowCheck >= 4000) {
        lastWindowCheck = Date.now()
        // 用 EnumWindows 找窗口：DSH 的窗口可能已创建但隐藏/未 show，
        // 这时 MainWindowHandle 返回 0，旧逻辑会一直干等到它自己显示（实测 60 秒+）。
        const w = await findHostWindow(hostPid)
        if (w.found) {
          windowSeen = true
          appendLog(logFile, `自检：找到宿主窗口（隐藏=${!w.visibleBefore} 最小化=${w.iconicBefore}），已请求显示`)
          // 只留在任务栏时用户以为「没起来」：稳定后多轮激活（见 activateWindowWithRetry）
          const front = await activateWindowWithRetry(hostPid, logFile, w.handle)
          if (!front) appendLog(logFile, '自检：窗口已出现，但三次都没抢到前台（可从任务栏打开）')
          break
        }
        {
          if (!sawNoWindow) {
            sawNoWindow = true
            appendLog(logFile, '自检：宿主进程活着，但窗口还没创建（继续等，最多 90 秒）')
          }
          const waitedSec = Math.round((Date.now() - aliveSince) / 1000)
          // 进度窗里实时报「已等 N 秒」：2026-10-22 但丁在 28 秒时以为卡住，手动点了图标
          if (onWait) { try { onWait(waitedSec) } catch { } }
          // 等待过程写进日志行（进度窗会实时滚出来），别让用户对着不动的窗口猜
          if (Date.now() - lastNote >= 15000) {
            lastNote = Date.now()
            appendLog(logFile, `自检：等待 DSH 窗口出现…已 ${waitedSec} 秒（进程存活）`)
          }
          const graceEnd = aliveSince + WINDOW_GRACE_MS
          if (graceEnd > deadline) deadline = graceEnd
        }
      }
    }
  }
  if (sawNoWindow && !windowSeen) {
    appendLog(logFile, `自检失败：宿主进程活着，但 ${Math.round(WINDOW_GRACE_MS / 1000)} 秒内没有出现主窗口`)
    return { ok: false, noWindow: true, failed: [], reason: 'alive-but-no-window' }
  }
  appendLog(logFile, windowSeen
    ? `自检通过：主窗口已出现（等了 ${Math.round((Date.now() - (aliveSince || Date.now())) / 1000)} 秒）`
    : `自检通过：${Math.round(timeoutMs / 1000)} 秒内没有新的启动崩溃日志`)
  return { ok: true }
}

/** 结束整棵进程树（taskkill /T）。用于卡在恢复对话框上的宿主，也用于超时的安装进程。 */
function killTree(pid, logFile, label = '宿主进程') {
  return new Promise((resolve) => {
    if (!pid) return resolve(false)
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }, (err) => {
      if (err) {
        if (!alive(pid)) return resolve(true)  // 进程已经自己退了，不算失败
        appendLog(logFile, `结束${label}失败（pid=${pid}）：${err.message}`)
        return resolve(false)
      }
      appendLog(logFile, `已结束${label}及其子进程（pid=${pid}）`)
      resolve(true)
    })
  })
}

/** 把指定包装回更新前的版本。 */
async function rollbackPackages({ queue, packages, cli, profileName, getPnpm, logFile }) {
  const done = []
  for (const p of packages) {
    // github: 装的包：queue 里只记了版本号，没有旧 tag，构造不出可靠的回退 spec
    if (String(p.spec || '').startsWith('github:') || p.isGithub) {
      done.push({ name: p.name, ok: false, err: 'github 安装的包暂不支持自动回退，请手动装回旧 tag' })
      continue
    }
    if (!p.from) { done.push({ name: p.name, ok: false, err: '没有记录旧版本' }); continue }
    const spec = `${p.name}@${p.from}`
    let r = null
    let via = null
    if (cli) {
      r = await runCliAdd(cli, profileName, spec, logFile)
      via = 'cli'
      if (!r.ok) r = null
    }
    if (!r) {
      const pm = await getPnpm()
      if (!pm) { done.push({ name: p.name, ok: false, err: '没有可用通道' }); continue }
      r = await runPnpm(pm, ['add', spec, '--config.minimum-release-age=0'], queue.profileDir, logFile)
      via = 'pnpm'
    }
    done.push({ name: p.name, to: p.from, via, ok: r.ok, err: r.ok ? null : r.err })
    if (r.ok) ensureBundles(queue.profileDir, [p.name], logFile)
  }
  return done
}

/**
 * 启动宿主体检：起得来就通过；起不来就只回退本次更新过的、且被点名的插件，
 * 然后重启再查一次。返回 health 对象（含 afterRollback）。
 */
async function startAndVerify({ queue, report, reportFile, logFile, cli, profileName, getPnpm, writeProgress, progressPid }) {
  const logsDir = queue.logsDir || null
  // 自检时长按更新包数量动态：1 个包 10 秒，每多一个 +2.5 秒，封顶 30 秒。
  // 用户反馈：固定 15 秒对单个包的更新太长、对 10 个包又太短。
  const pkgN = Math.max(1, (queue.packages || []).length)
  const checkSec = Math.min(30, Math.max(10, Math.round(10 + (pkgN - 1) * 2.5)))
  appendLog(logFile, `自检窗口：${checkSec} 秒（本次 ${pkgN} 个包）`)
  const since = Date.now()
  const started = await restartHostSafe(queue.restart, logFile)
  report.restart = started
  ;(report.restartAttempts = report.restartAttempts || []).push({ at: nowIso(), attempt: 1, ...started })
  writeJson(reportFile, report)
  if (!started.ok) return { ok: false, reason: started.reason, phase: 'restart-failed' }

  // 启动窗口期间每轮刷新一次进度窗：让用户看到「已等 N 秒」，别以为卡住去手动点
  const onBootWait = progressPid ? (sec) => {
    writeProgress({
      title: '插件更新', badge: '启动中', phase: 'verifying', step: 1, steps: PROGRESS_STEPS, percent: 100,
      detail: `DSH 正在启动，已等 ${sec} 秒（通常 20~30 秒，别手动点）…`,
      hint: '窗口出现后会自动跳到前台',
    })
  } : null
  if (progressPid) {
    writeProgress({ title: '插件更新', badge: '自检中', phase: 'verifying', step: 1, steps: PROGRESS_STEPS, percent: 100, detail: `正在等待 DSH 窗口出现（启动慢时会多等，最多 ${Math.round(WINDOW_GRACE_MS / 1000)} 秒）…`, hint: '窗口一出现就立即完成；启动失败会自动回退到更新前的版本' })
  }
  const health = await waitForHealthyBoot({ hostPid: started.pid, logsDir, since, logFile, exe: queue.restart && queue.restart.exe, timeoutMs: checkSec * 1000, onWait: onBootWait })
  health.checkedAt = nowIso()
  if (health.ok) return health
  // 进程活着但窗口没出来：不是插件崩溃，回退会误伤 —— 先杀掉重开一次。
  // 2026-10-22 群友录屏：助手报「自检通过」后 2.5 分钟仍没见到窗口；正常启动
  // 几秒到十几秒就该出窗口，90 秒已经不是「慢」，是卡住了。
  if (health.noWindow) {
    // 2026-10-22 事故：DSH 的认证 cookie 每次启动 +1 条、60 天有效，攒到 71 条
    // 时 Cookie 头超 16KB → host 拒收 → Electron welcome 认证失败 → 窗口不出现。
    // 这种情况重开没用（cookie 罐原封不动），必须先读真实报错再清 cookie。
    const hostOut = hostOutputSince(logFile)
    const authFail = /desktop welcome: Web authentication failed/i.test(hostOut)
    if (authFail) {
      health.reason = 'auth-cookie-overflow'
      appendLog(logFile, '自检：宿主报「Web authentication failed」——认证 cookie 累积超限，清理后自动重开')
    } else {
      appendLog(logFile, '自检：90 秒没有窗口 —— 结束这个卡住的进程，自动重开一次')
    }
    await killTree(started.pid, logFile, '无窗口的宿主进程')
    await sleep(2000)
    const retry = await restartHostSafe(queue.restart, logFile)
    report.restart = retry
    ;(report.restartAttempts = report.restartAttempts || []).push({ at: nowIso(), attempt: 2, retried: 'no-window', ...retry })
    if (!retry.ok) {
      health.afterRetry = { ok: false, reason: retry.reason, phase: 'restart-failed' }
      return health
    }
    if (progressPid) {
      writeProgress({
        title: 'DSH 窗口没出现', badge: '重开中', phase: 'restarting', step: 3, steps: PROGRESS_STEPS, percent: 100,
        detail: '第一次启动 90 秒没有出现窗口，已结束卡住的进程，正在重新打开…',
        hint: '若这次仍没窗口，请手动双击桌面图标',
      })
    }
    const sinceRetry = Date.now()
    const health2 = await waitForHealthyBoot({ hostPid: retry.pid, logsDir, since: sinceRetry, logFile, exe: queue.restart && queue.restart.exe, timeoutMs: checkSec * 1000, onWait: onBootWait })
    health2.checkedAt = nowIso()
    health.afterRetry = health2
    if (health2.ok) {
      health2.retried = true
      if (progressPid) {
        writeProgress({ title: '插件更新', badge: '完成', phase: 'done', step: 3, steps: PROGRESS_STEPS, percent: 100, detail: 'DSH 已重新打开（第二次启动成功）', hint: '完成' })
      }
      return health2
    }
    return health
  }

  // 失败：只看本次更新过的包，别把别的插件的问题算到这次更新头上
  const updated = new Map((queue.packages || []).map((p) => [p.name, p]))
  const culprits = (health.failed || []).filter((n) =>
    updated.has(n) || [...updated.keys()].some((u) => n === u || n.includes(u) || u.includes(n)))
  health.culprits = culprits
  if (!culprits.length) {
    appendLog(logFile, '点名的插件不属于本次更新，不做回退')
    return health
  }
  const targets = culprits
    .map((n) => updated.get(n) || [...updated.values()].find((u) => n === u.name || n.includes(u.name) || u.name.includes(n)))
    .filter(Boolean)

  appendLog(logFile, `准备回退：${targets.map((t) => `${t.name}→${t.from}`).join(', ')}`)
  if (progressPid) {
    writeProgress({ title: '启动失败', badge: '回退中', phase: 'rollingback', step: 2, steps: PROGRESS_STEPS, percent: 100, detail: `回退 ${targets.map((t) => t.name).join(', ')} → 旧版本…`, hint: '正在结束卡住的进程并装回旧版本' })
  }
  // 抢在用户点「禁用全部插件」之前结束这个卡住的进程
  await killTree(started.pid, logFile)
  await sleep(1500)
  health.rollback = await rollbackPackages({ queue, packages: targets, cli, profileName, getPnpm, logFile })
  await sleep(1500)

  if (progressPid) {
    writeProgress({ title: '已回退', badge: '重启中', phase: 'restarting', step: 3, steps: PROGRESS_STEPS, percent: 100, detail: '重新启动 DSH 并再检查一次…', hint: '请稍候，DSH 会自动打开' })
  }
  const since2 = Date.now()
  const again = await restartHostSafe(queue.restart, logFile)
  report.restart = again
  ;(report.restartAttempts = report.restartAttempts || []).push({ at: nowIso(), attempt: 2, ...again })
  if (!again.ok) {
    health.afterRollback = { ok: false, reason: again.reason, phase: 'restart-failed' }
    return health
  }
  const health2 = await waitForHealthyBoot({ hostPid: again.pid, logsDir, since: since2, logFile, exe: queue.restart && queue.restart.exe, timeoutMs: checkSec * 1000 })
  health.afterRollback = health2
  health.finalOk = health2.ok
  return health
}

// ---------- 主流程 ----------
/**
 * 更新出问题时在桌面写一份人话报告 —— DSH 起不来时，桌面是用户唯一一定会看的地方。
 * 只写摘要（失败包、自检结论、组合风险、日志路径），完整内容仍在 update.log。
 */
function writeDesktopFailureReport(report, queue, logFile) {
  try {
    const desktop = path.join(os.homedir(), 'Desktop')
    if (!fs.existsSync(desktop)) return null
    const bad = (report.results || []).filter((r) => !r.ok)
    const health = report.health || {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const lines = [
      'market-expand · 插件更新未完全成功',
      '',
      `时间：${nowIso()}`,
      `结果：${(report.results || []).length - bad.length}/${(report.results || []).length} 个成功`,
      report.error ? `错误：${report.error}` : '',
      bad.length ? '失败的包：' + bad.map((b) => `${b.name} → ${b.target}（${String(b.err || '').slice(0, 220)}）`).join('；') : '',
      health && health.ok === false
        ? (health.reason === 'auth-cookie-overflow'
          ? '启动自检：DSH 认证失败——认证 cookie 累积超过请求头上限（助手已清理 cookie，请再点一次更新或手动打开）'
          : health.noWindow
            ? '启动自检：DSH 进程在跑，但窗口没有出现（请手动打开；插件已装好）'
            : `启动自检：失败（${health.reason || (health.failed || []).join(', ') || '未知'}）`)
        : '',
      (report.risks && report.risks.length) ? '组合风险：' + report.risks.map((r) => r.note).join('；') : '',
      '',
      `完整日志：${logFile}`,
      `更新报告：${path.join(path.dirname(logFile), 'last-update.json')}`,
      `更新前备份：${queue && queue.backupDir ? queue.backupDir : '（无）'}`,
      '',
      '把这份文件和上面几个路径一起发给开发者即可。',
    ].filter(Boolean)
    const target = path.join(desktop, `market-expand-更新失败-${stamp}.txt`)
    fs.writeFileSync(target, lines.join('\r\n'), 'utf8')
    appendLog(logFile, '已在桌面写出失败报告：' + target)
    return target
  } catch (e) {
    return null
  }
}

async function main() {
  const queueFile = process.argv[2]
  if (!queueFile) { console.error('usage: node updater.mjs <queue.json>'); process.exit(2) }
  const queue = readJson(queueFile, null)
  if (!queue) { console.error('queue not readable'); process.exit(2) }
  const logFile = queue.logFile || path.join(path.dirname(queueFile), 'update.log')
  const reportFile = queue.reportFile || path.join(path.dirname(queueFile), 'last-update.json')
  appendLog(logFile, `更新助手启动 queue=${queue.id || '?'} 包数=${(queue.packages || []).length} 宿主pid=${queue.hostPid}`)

  const report = {
    id: queue.id || nowIso(),
    startedAt: nowIso(),
    finishedAt: null,
    awaitingExit: true,
    hostPid: queue.hostPid,
    results: [],
    pnpm: null,
    restart: null,
    error: null,
  }

  // 进度窗口：宿主退出后弹一个右下角原生小窗（PowerShell + WinForms，零依赖）。
  // 窗口轮询 update-progress.json，完成 2.5s / 失败 9s 后自己关闭；起不来也不影响更新。
  const progressFile = path.join(path.dirname(logFile), 'update-progress.json')
  const writeProgress = (obj) => writeJson(progressFile, { ...obj, logLines: LOG_LINES.slice(-6), at: nowIso() })
  PROGRESS_FILE = progressFile
  let progressPid = null
  const startProgressWindow = (initial) => {
    try {
      if (process.platform !== 'win32' || !fs.existsSync(PROGRESS_PS1)) return
      writeProgress(initial || { title: '插件更新', badge: '准备中', phase: 'preparing', step: 0, steps: PROGRESS_STEPS, percent: 0, detail: '正在准备更新…', hint: '完成后会自动重新打开 DSH' })
      // 2026-10-21 根因（本机穷举复现）：从宿主这种「无控制台」的 detached 进程
      // 直接 spawn powershell.exe 时，WinForms 窗口不会真正显示（连 .shown 标记都
      // 写不出来）。实测 6 种启动方式：直接 spawn / cmd start / TEMP 副本 / VBS /
      // 非 detached 全部失败，只有经 conhost.exe（Windows 自带）包一层才正常。
      const child = spawn('conhost.exe', [
        'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', PROGRESS_PS1, '-StateFile', progressFile,
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      progressPid = child.pid
      appendLog(logFile, `进度窗口已启动 pid=${child.pid}`)
    } catch (e) {
      appendLog(logFile, '进度窗口启动失败：' + (e && e.message || e))
    }
  }

  // 单实例：另一个 updater 已经在等同一个宿主退出
  const lockFile = queueFile + '.lock'
  try {
    if (fs.existsSync(lockFile)) {
      const prev = Number(fs.readFileSync(lockFile, 'utf8').trim())
      if (prev && prev !== process.pid && alive(prev)) {
        appendLog(logFile, `已有更新助手在运行（pid=${prev}），本进程退出`)
        process.exit(0)
      }
    }
    fs.writeFileSync(lockFile, String(process.pid), 'utf8')
  } catch { }

  let restarted = false
  try {
    // 1. 等宿主退出（最多 12 小时；用户可能排完队很久才关）
    const deadline = Date.now() + 12 * 3600 * 1000
    appendLog(logFile, '等待宿主退出…')
    writeJson(reportFile, { ...report, phase: 'waiting-exit' })
    while (alive(queue.hostPid) && Date.now() < deadline) await sleep(800)
    if (alive(queue.hostPid)) {
      report.error = '宿主 12 小时内没有退出，更新取消'
      report.awaitingExit = false
      appendLog(logFile, report.error)
      writeJson(reportFile, { ...report, finishedAt: nowIso() })
      return
    }
    report.awaitingExit = false
    appendLog(logFile, '宿主已退出，等待句柄释放…')
    // 窗口只在宿主退出后出现（2026-10-21 用户反馈）：排队期间由 DSH 内的面板
    // 负责反馈；提前弹窗是 TopMost，会盖住「立即重启并更新」的确认对话框。
    startProgressWindow({
      title: '插件更新', badge: '准备中', phase: 'preparing', step: 0, steps: PROGRESS_STEPS,
      percent: 0, detail: '宿主已退出，正在准备更新…', hint: '完成后会自动重新打开 DSH',
    })
    await sleep(2500)

    // 2. 准备更新通道：优先 Desktop 自带 CLI；它失败时用 pnpm 兜底（懒定位）
    writeJson(reportFile, { ...report, phase: 'installing' })
    const cli = queue.restart && queue.restart.cli && fs.existsSync(queue.restart.cli) ? queue.restart.cli : null
    const profileName = (queue.restart && queue.restart.profileName) || queue.profileName || 'desktop'
    let pnpm = null
    let pnpmTried = false
    const getPnpm = async () => {
      if (!pnpmTried) { pnpmTried = true; pnpm = await findPnpm(logFile) }
      return pnpm
    }
    appendLog(logFile, `更新通道：${cli ? 'CLI ' + cli : 'pnpm'}（profile ${profileName}）`)
    report.channel = cli ? 'cli' : 'pnpm'
    if (!cli) {
      const p = await getPnpm()
      report.pnpm = p ? { file: p.file, version: p.version } : null
      if (!p) {
        report.error = '找不到可用的 pnpm（试过 PATH、npm 全局 shim、nvm 目录），也没有桌面端 CLI'
        writeJson(reportFile, { ...report, finishedAt: nowIso() })
        return
      }
    }

    // 2.5 更新前备份组合关键文件（更新失败或被 sanitize 时能捞回来）
    backupProfileFiles(queue, logFile)

    // 3. 逐个更新
    const total = (queue.packages || []).length
    let finished = 0
    // 写锁被一个还活着的安装进程占住时，后面的包全部跳过 —— 否则每个都要白等
    // 一次官方 lockWaitMs（2 分钟）。2026-10-21 群友就因此连丢两个包。
    let lockBlocked = false
    for (const p of queue.packages || []) {
      // queue 里带 spec 就用它（github: 装的是 tag，npm 装的是 name@version）
      const spec = p.spec || `${p.name}@${p.target}`
      writeProgress({
        title: '插件更新',
        badge: '更新中',
        phase: 'installing',
        step: 0,
        steps: PROGRESS_STEPS,
        percent: Math.round((finished / total) * 100),
        detail: `${finished + 1}/${total} · ${p.name} → ${p.target}`,
        hint: '完成后会自动重新打开 DSH',
      })

      const pushFail = (kind, errText, via = 'none', r = null) => {
        report.results.push({
          name: p.name, from: p.from || null, target: p.target,
          via, ok: false, code: r && r.code != null ? r.code : null,
          out: r ? r.out : '', err: errText, reason: kind,
        })
      }

      if (lockBlocked) {
        appendLog(logFile, `  跳过 ${p.name}：profile 写锁还被别的安装进程占着`)
        pushFail('lock', '前一个包的安装进程一直占着 profile 写锁，这个包没有执行')
        finished += 1
        continue
      }

      let r = null
      let via = null
      let kind = 'failed'

      if (cli) {
        r = await runCliAdd(cli, profileName, spec, logFile)
        via = 'cli'
        if (!r.ok) {
          kind = classifyFailure(r)
          appendLog(logFile, `  CLI 失败（${kind}）：${spec}`)
          // 超时/锁占用：先等写锁空出来。超时那条已经把整棵树杀了，
          // 正常情况下锁会立刻变成「持有者已退出」，atomic-write 自己接管。
          if (kind === 'timeout' || kind === 'lock') {
            const wait = await waitProfileLockFree(queue.profileDir, { logFile, reason: `${p.name} 的残留安装进程` })
            if (!wait.free) {
              appendLog(logFile, `  写锁 ${Math.round(wait.waited / 1000)} 秒没释放（持有 pid=${wait.holder}）：本包放弃，后续包跳过`)
              lockBlocked = true
              pushFail(kind, failureText(kind, r))
              finished += 1
              continue
            }
            if (kind === 'lock') {
              appendLog(logFile, `  锁已释放，重试一次 ${spec}`)
              r = await runCliAdd(cli, profileName, spec, logFile)
              via = 'cli'
              if (!r.ok) kind = classifyFailure(r)
            }
          }
          if (!r.ok) r = null
        }
      }

      if (!r) {
        // 回退 pnpm 之前必须确认没有还活着的官方 CLI 在写同一个 profile：
        // 官方 CLI 持锁、pnpm 不持锁，两条通道并发写会把 package.json 写坏。
        const lockPid = readProfileLockPid(queue.profileDir)
        if (lockPid && alive(lockPid)) {
          appendLog(logFile, `  写锁仍被 pid=${lockPid} 占着，不回退 pnpm（并发写会弄坏 profile），本包跳过`)
          lockBlocked = true
          pushFail('lock', failureText('lock', r))
          finished += 1
          continue
        }
        const pm = await getPnpm()
        if (!pm) {
          // 只有这里才是真的「通道不可用」；超时/锁的真相已经记在 kind 里
          const why = (kind === 'timeout' || kind === 'lock') ? kind : 'channel'
          pushFail(why, failureText(why, r))
          finished += 1
          continue
        }
        r = await runPnpm(pm, ['add', spec, '--config.minimum-release-age=0'], queue.profileDir, logFile)
        via = 'pnpm'
        report.pnpm = { file: pm.file, version: pm.version }
        if (!r.ok) kind = classifyFailure(r)
      }

      report.results.push({
        name: p.name, from: p.from || null, target: p.target, via, ok: r.ok, code: r.code,
        out: r.out, err: r.ok ? '' : failureText(r.timedOut ? 'timeout' : kind, r),
        reason: r.ok ? null : (r.timedOut ? 'timeout' : kind),
      })
      if (r.ok) ensureBundles(queue.profileDir, [p.name], logFile)
      finished += 1
      writeJson(reportFile, { ...report, phase: 'installing' })
      writeProgress({
        title: '插件更新',
        badge: '更新中',
        phase: 'installing',
        step: 0,
        steps: PROGRESS_STEPS,
        percent: Math.round((finished / total) * 100),
        detail: finished >= total
          ? '全部更新完成，正在重新启动 DSH…'
          : `已完成 ${finished}/${total} · 下一个 ${(queue.packages[finished] || {}).name || ''}`,
        hint: '完成后会自动重新打开 DSH',
      })
    }

    // 3.5 组合破坏检查：有些包的 bundle patch 会改写官方 preset 的 inject 列表，
    // 或依赖自己 insert 的条目。这类失败不写 crash log，启动自检看不见 ——
    // 2026-10-21 群友的 preset 消失就是这么来的（billion-context × bili-native）。
    report.risks = checkBundleRisks(queue, logFile)
    writeJson(reportFile, report)

    // 4. 重启 + 启动自检：起不来就自动回退本次更新的包，再重启
    if (queue.restart && queue.restart.exe) {
      report.health = await startAndVerify({
        queue, report, reportFile, logFile, cli, profileName, getPnpm,
        writeProgress, progressPid,
      })
      restarted = true
      writeJson(reportFile, report)
    }
  } catch (e) {
    report.error = String(e && e.stack || e)
    appendLog(logFile, '异常：' + report.error)
  } finally {
    // 5. 先落最终状态（进度窗口据此收尾），再把宿主开回来
    try {
      report.finishedAt = nowIso()
      const okCount = report.results.filter((r) => r.ok).length
      const totalCount = report.results.length
      const failed = totalCount - okCount
      const bad = failed > 0 || !!report.error
      const healthBad = !!(report.health && report.health.ok === false)
      report.summary = `${okCount}/${totalCount} 个成功` + (report.error ? `；错误：${report.error}` : '')
      appendLog(logFile, '更新完成：' + report.summary)
      writeJson(reportFile, report)
      if (bad || healthBad) {
        report.desktopReport = writeDesktopFailureReport(report, queue, logFile)
        writeJson(reportFile, report)
      }
      if (progressPid) {
        // 失败时步骤轨只让「出错那一步」变红（step），之前完成的步骤保持绿；
        // 旧代码固定传 step:3，结果四格全红，和「正在重新打开 DSH」的文案互相矛盾。
        const noWindow = !!(report.health && report.health.noWindow)
        const failStep = healthBad ? 1 : 0
        const willRestart = !restarted && queue.restart && queue.restart.exe
        const openState = restarted ? '，DSH 已重新打开' : willRestart ? '，正在重新打开 DSH…' : ''
        writeProgress({
          title: noWindow ? 'DSH 窗口没出现' : healthBad ? '启动失败，已回退' : bad ? '更新结束（有失败）' : '插件更新完成',
          badge: noWindow ? '需手动打开' : healthBad ? '已回退' : bad ? '有失败' : '完成',
          phase: (bad || healthBad) ? 'error' : 'done',
          step: (bad || healthBad) ? failStep : 3,
          steps: PROGRESS_STEPS,
          percent: 100,
          detail: noWindow
            ? 'DSH 进程已经在跑，但窗口没有出现。插件已装好，不影响下次启动——请双击桌面的 DeepSeek Harness 手动打开。'
            : healthBad
              ? ((report.health.rollback || []).filter((x) => x.ok).length > 0
                ? `启动失败，已回退 ${(report.health.rollback || []).filter((x) => x.ok).length} 个插件并重启`
                : '启动失败，但点名的插件不属于本次更新，未做回退')
              : okCount === totalCount
                ? `${totalCount} 个插件已更新到最新${openState}`
                : `${okCount}/${totalCount} 成功，${failed} 个失败（详见 update.log）${openState}`,
          hint: noWindow
            ? '手动打开 DSH 即可，插件不用重装'
            : healthBad
              ? '已恢复到更新前的版本，请手动打开 DSH'
              : bad
                ? '失败的包见 update.log 或桌面的失败报告'
                : 'DSH 正在重新打开',
        })
      }
      // 5. 兜底重启：正常路径已在 startAndVerify 里重启并自检过
      if (!restarted && queue.restart && queue.restart.exe) {
        report.restart = await restartHostSafe(queue.restart, logFile)
        writeJson(reportFile, report)
      }
    } catch (e) { }
    try { fs.rmSync(lockFile, { force: true }) } catch { }
    try { fs.rmSync(queueFile, { force: true }) } catch { }
  }
}

// 只有直接运行才执行主流程；被 import（自检脚本/测试）时只导出工具函数。
const RUN_AS_MAIN = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return path.resolve(entry) === fileURLToPath(import.meta.url) } catch { return false }
})()

export {
  parseWebBootCrash, findNewCrash, waitForHealthyBoot, backupProfileFiles, killTree,
  checkBundleRisks, listSameExePids, windowHandleOf, startAndVerify, activateWindow,
  activateWindowWithRetry, findHostWindow,
  pruneAuthCookies, hostOutputSince, desktopUserDataDir, restartHostSafe,
  // 2026-10-22 v1.3.0：超时/写锁/窗口检测的工具函数，导出给冒烟测试用
  runFile, classifyFailure, failureText, readProfileLockPid, waitProfileLockFree,
  CLI_TIMEOUT_MS, LOCK_WAIT_MS, WINDOW_GRACE_MS,
}

if (RUN_AS_MAIN) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
