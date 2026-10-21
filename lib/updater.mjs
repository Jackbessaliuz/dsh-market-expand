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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

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

/** 跑一个命令，返回 {ok, out, err}；Windows 的 .cmd/.bat 走 cmd /c。
 *
 * 实测坑：`cmd /d /s /c <带空格的路径>.cmd --version` 会在空格处截断
 * （报「'C:\Program' 不是内部或外部命令」）。正确写法是整条命令再包一层
 * 引号，并用 windowsVerbatimArguments 原样交给 cmd。 */
function runFile(file, args, opts = {}) {
  return new Promise((resolve) => {
    const isShim = /\.(cmd|bat)$/i.test(file)
    const cmdExe = process.env.ComSpec || 'cmd.exe'
    const line = isShim
      ? `""${file}" ${args.map(cmdQuote).join(' ')}"`
      : null
    const spawnFile = isShim ? cmdExe : file
    const spawnArgs = isShim ? ['/d', '/s', '/c', line] : args
    execFile(spawnFile, spawnArgs, {
      timeout: opts.timeout || 180000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: isShim,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err && (err === null),
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      })
    })
  })
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
  const r = await runFile(cli, ['plugin', '--profile', profileName, 'add', spec], { timeout: 300000 })
  const tail = (s) => String(s || '').trim().split(/\r?\n/).slice(-8).join('\n').slice(0, 1200)
  if (r.ok) appendLog(logFile, `  ok: ${tail(r.out)}`)
  else appendLog(logFile, `  FAIL(${r.code}): ${tail(r.err || r.out)}`)
  return { ok: r.ok, code: r.code, out: tail(r.out), err: tail(r.err) }
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

/** 轮询：出现新崩溃日志 = 失败；进程提前退出 = 无法确认；超时无异常 = 通过。 */
async function waitForHealthyBoot({ hostPid, logsDir, since, timeoutMs = 60000, logFile }) {
  if (!logsDir) return { ok: true, skipped: true, reason: 'no-logs-dir' }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(2000)
    const crash = findNewCrash(logsDir, since)
    if (crash) {
      const failed = parseWebBootCrash(crash.file)
      appendLog(logFile, `自检失败：${path.basename(crash.file)} 点名 ${failed.join(', ') || '（未能解析）'}`)
      return { ok: false, crashFile: crash.file, failed }
    }
    if (hostPid && !alive(hostPid)) {
      appendLog(logFile, '自检：宿主进程提前退出，无法确认启动状态')
      return { ok: true, unknown: true, reason: 'host-exited' }
    }
  }
  appendLog(logFile, '自检通过：60 秒内没有新的启动崩溃日志')
  return { ok: true }
}

/** 结束卡在恢复对话框上的宿主进程（抢在用户点「禁用全部插件」之前）。 */
function killTree(pid, logFile) {
  return new Promise((resolve) => {
    if (!pid || !alive(pid)) return resolve(false)
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }, (err) => {
      appendLog(logFile, err ? `结束宿主进程失败：${err.message}` : `已结束卡住的宿主进程 pid=${pid}`)
      resolve(!err)
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
  const since = Date.now()
  const started = restartHost(queue.restart, logFile)
  report.restart = started
  ;(report.restartAttempts = report.restartAttempts || []).push({ at: nowIso(), attempt: 1, ...started })
  writeJson(reportFile, report)
  if (!started.ok) return { ok: false, reason: started.reason, phase: 'restart-failed' }

  if (progressPid) {
    writeProgress({ title: '插件更新', badge: '自检中', phase: 'verifying', step: 1, steps: PROGRESS_STEPS, percent: 100, detail: '正在检查 DSH 是否正常启动…', hint: '若启动失败会自动回退到更新前的版本' })
  }
  const health = await waitForHealthyBoot({ hostPid: started.pid, logsDir, since, logFile })
  health.checkedAt = nowIso()
  if (health.ok) return health

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
  const again = restartHost(queue.restart, logFile)
  report.restart = again
  ;(report.restartAttempts = report.restartAttempts || []).push({ at: nowIso(), attempt: 2, ...again })
  if (!again.ok) {
    health.afterRollback = { ok: false, reason: again.reason, phase: 'restart-failed' }
    return health
  }
  const health2 = await waitForHealthyBoot({ hostPid: again.pid, logsDir, since: since2, logFile })
  health.afterRollback = health2
  health.finalOk = health2.ok
  return health
}

// ---------- 主流程 ----------
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
  const writeProgress = (obj) => writeJson(progressFile, { ...obj, at: nowIso() })
  let progressPid = null
  const startProgressWindow = () => {
    try {
      if (process.platform !== 'win32' || !fs.existsSync(PROGRESS_PS1)) return
      writeProgress({ title: '插件更新', badge: '准备中', phase: 'preparing', step: 0, steps: PROGRESS_STEPS, percent: 0, detail: '正在准备更新…', hint: '完成后会自动重新打开 DSH' })
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
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
    startProgressWindow()
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
      let r = null
      let via = null
      if (cli) {
        r = await runCliAdd(cli, profileName, spec, logFile)
        via = 'cli'
        if (!r.ok) {
          appendLog(logFile, `  CLI 没成功，回退 pnpm 重试 ${spec}`)
          r = null
        }
      }
      if (!r) {
        const pm = await getPnpm()
        if (!pm) {
          report.results.push({ name: p.name, from: p.from || null, target: p.target, via: 'none', ok: false, code: null, out: '', err: '没有可用的更新通道' })
          finished += 1
          continue
        }
        r = await runPnpm(pm, ['add', spec, '--config.minimum-release-age=0'], queue.profileDir, logFile)
        via = 'pnpm'
        report.pnpm = { file: pm.file, version: pm.version }
      }
      report.results.push({ name: p.name, from: p.from || null, target: p.target, via, ok: r.ok, code: r.code, out: r.out, err: r.err })
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
      if (progressPid) {
        writeProgress({
          title: healthBad ? '启动失败，已回退' : bad ? '更新结束（有失败）' : '插件更新完成',
          badge: healthBad ? '已回退' : bad ? '有失败' : '完成',
          phase: (bad || healthBad) ? 'error' : 'done',
          step: 3,
          steps: PROGRESS_STEPS,
          percent: 100,
          detail: healthBad
            ? ((report.health.rollback || []).filter((x) => x.ok).length > 0
              ? `启动失败，已回退 ${(report.health.rollback || []).filter((x) => x.ok).length} 个插件并重启`
              : '启动失败，但点名的插件不属于本次更新，未做回退')
            : okCount === totalCount
              ? `${totalCount} 个插件已更新到最新，正在重新启动 DSH…`
              : `${okCount}/${totalCount} 成功，${failed} 个失败（详见 update.log），正在重新启动 DSH…`,
          hint: healthBad ? '已恢复到更新前的版本，DSH 正在重新打开' : 'DSH 正在重新打开',
        })
      }
      // 5. 兜底重启：正常路径已在 startAndVerify 里重启并自检过
      if (!restarted && queue.restart && queue.restart.exe) {
        report.restart = restartHost(queue.restart, logFile)
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

export { parseWebBootCrash, findNewCrash, waitForHealthyBoot, backupProfileFiles, killTree }

if (RUN_AS_MAIN) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
