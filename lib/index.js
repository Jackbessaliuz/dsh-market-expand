/**
 * market-expand —— 插件市场补丁层（Host 半侧）
 * 职责：
 *  1. 本地 link 插件：读当前 profile 的 `link:` 依赖，按各自配置的 npm/GitHub 源检测更新；
 *  2. 全量 npm 插件：扫描 profile 所有依赖的 registry 最新版，排队后由脱离宿主的
 *     `updater.mjs` 在 DSH 退出后完成安装/回退，并把宿主重新拉起；
 *  3. 启动自检：重启后查 `crash-*-web-boot.log`，发现崩溃就回退「本次更新过且被点名」的包；
 *  4. 快照/回滚：有 .git 的插件打 tag（me-snap-<ts>）+ 无 .git 的目录复制，保留最近 3 份；
 *  5. HTTP 端点（/market-expand/*）供浏览器半侧调用。
 * 手写 bundle，无构建步骤；依赖仅 Node 内置 + child_process（npm/git 子进程）。
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
/**
 * 当前插件跑在哪个 profile —— 必须问宿主，不能写死。
 *
 * 2026-10-21 修：这段一直是 `profiles/web` 硬编码（插件当年只在 3080 网页端
 * 用）。桌面端（Electron）把同一个 link 插件也挂进了 desktop profile，硬编码
 * 会让「检测更新/更新」去改错 profile——正是 dshmarket #639 踩过的坑。
 * 解析顺序：launcher 的 profileContext 服务 → argv 的 --profile → web 兜底。
 */
let PROFILE_NAME = 'web'
let PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE_NAME)
let PROFILE_PKG = path.join(PROFILE_DIR, 'package.json')

// 2026-11-16（GPT 评审）：面板扫描结果缓存。
// /update 只认这份**后端计划**，不再信任前端传来的 latest/spec ——
// 过期面板或被改动的前端数据不能改变安装目标；同一份结果也消除了"重扫丢包"。
let SCAN_CACHE = { at: 0, map: new Map() }
const SCAN_CACHE_TTL_MS = 15 * 60 * 1000

function resolveProfile(ctx) {
  let name = ''
  let dir = ''
  try {
    const pc = ctx.get('profileContext')
    if (pc && typeof pc.name === 'string' && pc.name.trim()) {
      name = pc.name.trim()
      if (typeof pc.dir === 'string' && pc.dir.trim()) dir = pc.dir.trim()
    }
  } catch (e) { /* 服务不存在 = 旧宿主 */ }
  if (!name) {
    const argv = process.argv
    const i = argv.indexOf('--profile')
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) name = argv[i + 1]
  }
  if (!name) name = 'web'
  if (!dir) dir = path.join(DSH_HOME, 'profiles', name)
  PROFILE_NAME = name
  PROFILE_DIR = dir
  PROFILE_PKG = path.join(dir, 'package.json')
  MARKET_STATE_FILE = path.join(dir, '.dsh-market', 'state.json')
}
const STORE_DIR = path.join(DSH_HOME, 'market-expand')
const CONFIG_FILE = path.join(STORE_DIR, 'config.json')
const SNAP_ROOT = path.join(STORE_DIR, 'snapshots')
// ---------- 全量插件更新（2026-10-21 新增） ----------
// 宿主运行中改不了自己的 node_modules（市场自更新 #900、设置页无更新入口 #909、
// 运行中的 desktop profile 被 Electron 独占），唯一可靠的路是「退出后 pnpm add」。
// 这里负责排队 + 拉起脱离宿主的更新助手，updater.mjs 负责宿主退出后真正执行。
const UPDATE_QUEUE = path.join(STORE_DIR, 'update-queue.json')
const UPDATE_REPORT = path.join(STORE_DIR, 'last-update.json')
const UPDATE_LOG = path.join(STORE_DIR, 'update.log')
const UPDATER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'updater.mjs')
const KEEP_SNAPSHOTS = 3
// ---------- 桌面端本体更新（2026-11-07 新增） ----------
// 官方 electron-updater 负责「下包 + 校验」，但最后一步「宿主退出后安装」经常
// 卡在 graceful teardown（Host did not complete graceful task tear down）。
// 包其实已经完整下在 pending 里，所以我们只补那一步：宿主退出后静默安装 + 重启。
const DESKTOP_UPDATER_DIR = path.join(os.homedir(), 'AppData', 'Local', '@deepseek-aidsh-desktop-updater')

// ---------- market-expand 专属分组（v3：用户拍板「自动建组 + 不可删除 + 手动分配成员」） ----------
// 市场分组持久化在 <profile>/.dsh-market/state.json（dshmarket lib/hot.js readMarketState/writeMarketState）。
// market-expand 启动时保证「本地化插件」分组存在（被删则自动重建——实现不可删除语义），
// 成员由用户经市场 UI「加入插件」手动分配；market-expand 只检测分组成员。
export const GROUP_NAME = '本地化插件'
/** 2026-11-14：检测范围扩展到「自创插件」——但丁把自研的 link 插件单独归到了这个分组，
 *  只管「本地化插件」会让那 9 个插件永远检测不到更新。两个分组取并集。 */
export const GROUP_NAMES = ['本地化插件', '自创插件']
let MARKET_STATE_FILE = path.join(PROFILE_DIR, '.dsh-market', 'state.json')
/** 读市场状态（与 dshmarket lib/hot.js readMarketState 同结构；失败返回空基座）。 */
function readMarketState() {
  try {
    const state = JSON.parse(fs.readFileSync(MARKET_STATE_FILE, 'utf8'))
    if (state !== null && typeof state === 'object' && !Array.isArray(state)) {
      if (state.groups !== null && typeof state.groups === 'object' && !Array.isArray(state.groups)
        && Array.isArray(state.groupOrder)) {
        return state
      }
      // 兼容：groups 有效但 groupOrder 缺失/非数组 → 归一化
      if (state.groups !== null && typeof state.groups === 'object' && !Array.isArray(state.groups)) {
        state.groupOrder = Object.keys(state.groups)
        return state
      }
    }
  } catch (e) { /* 文件缺失/损坏 = 空基座 */ }
  return { disabled: [], groups: {}, groupOrder: [], notes: {} }
}

/**
 * 「本地化插件」分组是否存在（**只读**）。
 *
 * 2026-10-21 用户拍板：插件**不再写 state.json**。这个文件是多写者共享的
 * （市场的长生命周期 marketState 内存对象 + 我们直接读写文件），两边互不同步会
 * 造成 groups / groupOrder 错位——用户看到"分组还在，但点分配到报分组不存在"。
 * 现在建组与清理孤儿分组都交给用户或单独脚本（_tools\市场分组修复.zip）。
 */
function managedGroupExists() {
  try {
    const state = readMarketState()
    return GROUP_NAMES.some((gid) => !!(state.groups && state.groups[gid] !== undefined))
  } catch (e) {
    return false
  }
}

/** 读取受管分组（「本地化插件」＋「自创插件」）的当前成员，取并集（用户手动分配；**只读**）。 */
function readManagedGroupMembers() {
  try {
    const state = readMarketState()
    const out = []
    for (const gid of GROUP_NAMES) {
      const members = state.groups && state.groups[gid]
      if (Array.isArray(members)) out.push(...members)
    }
    return [...new Set(out)]
  } catch (e) {
    return []
  }
}

// ---------- 基础工具 ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return fallback }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
}
function loadConfig() { return readJson(CONFIG_FILE, { sources: {}, lastCheck: {} }) }
function saveConfig(cfg) { writeJson(CONFIG_FILE, cfg) }

/** 简易 semver 比较：仅支持 x.y.z（忽略 pre-release 尾部），返回 1/0/-1 */
function semverGt(a, b) {
  // 2026-11-16（GPT 评审）：旧实现用 split('-')[0] 把预发布后缀直接吃掉，
  // 导致 v1.5.0-beta.1 与 v1.5.0 分不出高低（评估红绿灯、挑最高 tag 都会受影响）。
  // 改用 cmpVer（alpha<beta<rc<正式），并归一化成 -1/0/1 —— cmpVer 返回的是差值，
  // 调用点全在判断 === 1，不归一化会静默失效。
  const r = cmpVer(String(a).trim().replace(/^v/i, ''), String(b).trim().replace(/^v/i, ''))
  return r > 0 ? 1 : r < 0 ? -1 : 0
}

/** 执行子进程（Promise 化）。超时 60s；opts.gitProxy=true 时按环境变量给 git 加代理参数。
 *
 * 代理**绝不写死**：别人机器上不一定有本地代理端口。取值顺序＝
 * `DSH_GIT_PROXY` → `HTTPS_PROXY`/`https_proxy` → `HTTP_PROXY`/`http_proxy`；
 * 一个都没有就直连（不传任何 -c）。`DSH_GIT_INSECURE=1` 时才放宽 TLS 校验
 * （自签/中间人证书环境用，默认不放宽）。
 */
function gitProxyArgs() {
  const proxy = process.env.DSH_GIT_PROXY
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy) return []
  const args = [
    '-c', `http.proxy=${proxy}`,
    '-c', `https.proxy=${proxy}`,
    '-c', 'http.version=HTTP/1.1',
  ]
  if (process.env.DSH_GIT_INSECURE === '1') {
    args.push('-c', 'http.sslBackend=openssl', '-c', 'http.sslVerify=false')
  }
  return args
}

/** 从 `~/.dsh/.env` 补齐代理变量（宿主不一定把它们注入进程环境）。 */
function loadHomeEnv() {
  try {
    const f = path.join(DSH_HOME, '.env')
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch (e) { /* 没有 .env 就直连，不是错误 */ }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const execOpts = {
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
      cwd: opts.cwd,
    }
    const realArgs = opts.gitProxy ? gitProxyArgs().concat(args) : args
    execFile(cmd, realArgs, execOpts, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      if (!err) return resolve({ ok: true, out })
      const msg = String(stderr || err.message || '')
      resolve({ ok: false, err: msg.slice(0, 300) })
    })
  })
}

// ---------- 插件清单与源 ----------
/**
 * 读取本地开发插件清单 → [{ name, dir, version, hasGit, exists, from }]
 *
 * 【2026-09-19 但丁拍板「一劳永逸」】两个来源合并：
 *  ① profile 的 `link:` 依赖声明（权威名单，也能覆盖"声明了但没落地"的情形）；
 *  ② **直接扫 profile 的 node_modules，把符号链接／Junction 也算进来**。
 * 起因：实测 node_modules 里有 11+ 个链接插件，而 dependencies 里只声明了 4 个 →
 * 缺声明的那几个在 UI 上点「保存检测源」会被判成「未知插件」（/source 返回 404）。
 * ⚠️ 2026-09-20 注：这个修复曾在 09-19 13:02 打过一次，当晚 17:28「恢复源码」时被旧版覆盖丢失，
 * 此处按同样思路重打（备份 `index.js.bak-20260920-before-linkfix-redo`）。
 */
function listLinkPlugins() {
  const pkg = readJson(PROFILE_PKG, {})
  const deps = pkg.dependencies || {}
  const out = []
  const seen = new Set()

  const push = (name, dir, from) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    const exists = fs.existsSync(dir)
    const p = exists ? readJson(path.join(dir, 'package.json'), {}) : {}
    out.push({
      name,
      dir,
      version: String(p.version || '0.0.0'),
      hasGit: exists && fs.existsSync(path.join(dir, '.git')),
      exists, // 悬空链接（目标已被删）标 false，UI 可据此提示
      from,
    })
  }

  // ① profile 的 link: 声明
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    push(name, path.resolve(SPEC_TO_DIR(spec)), 'deps')
  }

  // ② 扫 node_modules 里的符号链接／Junction（含 @scope/ 一层）
  const nm = path.join(PROFILE_DIR, 'node_modules')
  const scan = (dir, prefix) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.bin' || e.name === '.pnpm') continue
      const full = path.join(dir, e.name)
      if (prefix === '' && e.name.startsWith('@')) { scan(full, e.name + '/'); continue }
      let isLink = false
      try { isLink = fs.lstatSync(full).isSymbolicLink() } catch { continue }
      if (!isLink) continue
      let real = full
      try { real = fs.realpathSync(full) } catch { /* 悬空链接：保留原路径，exists 会是 false */ }
      push(prefix + e.name, real, 'node_modules')
    }
  }
  scan(nm, '')

  return out
}
function SPEC_TO_DIR(spec) {
  // link:G:/xxx 或 link:C:/xxx —— 统一为正斜杠路径
  return spec.slice('link:'.length)
}

/** 检测一个插件：npm 源 = npm view version；github 源 = git ls-remote --tags 最高 semver tag；
 * kind='skip' = 用户标记「无需检测」(自研插件本地开发,无市场更新)。 */
async function checkOne(name, dir, version, kind, value) {
  const cfg = loadConfig()
  if (!kind) {
    return { name, current: version, upstream: null, hasUpdate: false, error: 'no-source' }
  }
  if (kind === 'skip') {
    cfg.lastCheck[name] = { ts: Date.now(), current: version, upstream: null, hasUpdate: false, error: 'skipped' }
    saveConfig(cfg)
    return { name, current: version, upstream: null, hasUpdate: false, error: 'skipped' }
  }
  if (!value) {
    return { name, current: version, upstream: null, hasUpdate: false, error: 'no-source' }
  }
  let upstream = null
  let error = null
  if (kind === 'npm') {
    const r = await run('npm', ['view', value, 'version', '--json'])
    if (r.ok) {
      try { upstream = JSON.parse(r.out) } catch (e) { upstream = r.out.replace(/^"|"$/g, '') }
      upstream = String(upstream || '').trim()
    } else error = 'source-error'
  } else if (kind === 'github') {
    const url = /^https?:\/\//.test(value) ? value : 'https://github.com/' + value
    const r = await run('git', ['ls-remote', '--tags', url], { gitProxy: true })
    if (r.ok) {
      const tags = r.out.split('\n')
        .map((l) => l.split('refs/tags/')[1])
        .filter(Boolean)
        .map((t) => t.replace(/\^\{\}$/, ''))
        .map((t) => (t.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) || [])[1])
        .filter(Boolean)
      if (tags.length) upstream = tags.sort((a, b) => semverGt(a, b))[tags.length - 1]
      else error = 'no-tags'
    } else error = 'source-error'
  } else {
    error = 'source-error'
  }
  const hasUpdate = upstream && semverGt(upstream, version) === 1
  cfg.lastCheck[name] = { ts: Date.now(), current: version, upstream, hasUpdate, error }
  saveConfig(cfg)
  return { name, current: version, upstream, hasUpdate, error }
}

// ---------- DSH 本体更新检测（2026-09-03 新增：设置-通用设置「DSH 更新」） ----------
/** 解析版本号（含 pre-release：alpha/beta/rc），返回 {maj,min,pat,preName,preNum,pre} */
function parseVer(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  const pre = (m[4] || '').match(/^([a-zA-Z]+)(?:\.(\d+))?$/)
  return { maj: +m[1], min: +m[2], pat: +m[3], preName: pre ? pre[1] : '', preNum: pre ? +(pre[2] || 0) : -1, pre: !!m[4] }
}
/** 版本比较：a>b → 1；a<b → -1；= → 0。pre 排序 alpha<beta<rc<正式 */
function cmpVer(a, b) {
  const pa = parseVer(a)
  const pb = parseVer(b)
  if (!pa || !pb) return String(a) === String(b) ? 0 : (pa ? 1 : -1)
  if (pa.maj !== pb.maj) return pa.maj - pb.maj
  if (pa.min !== pb.min) return pa.min - pb.min
  if (pa.pat !== pb.pat) return pa.pat - pb.pat
  const rank = (n) => (n === 'alpha' ? 0 : n === 'beta' ? 1 : n === 'rc' ? 2 : 3)
  const ra = rank(pa.preName)
  const rb = rank(pb.preName)
  if (ra !== rb) return ra - rb
  if (!pa.preName) return 0
  return pa.preNum - pb.preNum
}
/** 当前运行中的 DSH 版本：npm root -g 读包；失败回退常见全局路径 */
async function currentDshVersion() {
  const r = await run('npm', ['root', '-g'])
  if (r.ok) {
    const p = readJson(path.join(r.out.trim().split(/\r?\n/)[0], '@deepseek-ai', 'dsh', 'package.json'), {})
    if (p.version) return String(p.version)
  }
  const fallback = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const p2 = readJson(fallback, {})
  return p2.version || 'unknown'
}
/** 检测 DSH 更新：只读 npm dist-tags，不安装任何东西。
 * 优先走 npm CLI；npm 不在 PATH（execFile spawn ENOENT）时降级为 HTTP 直连 registry
 * packument（官方 npmjs / 用户配置的 registry），零进程依赖。 */
async function checkDshUpdate() {
  const current = await currentDshVersion()
  let tags = null
  let error = null
  let detail = null
  async function viaHttp(registryUrl) {
    const uri = String(registryUrl || '').replace(/\/$/, '') + '/@deepseek-ai%2fdsh'
    try {
      const res = await fetch(uri, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json', 'user-agent': 'dsh-market-expand/0.1.0' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return null
      const p = await res.json()
      return p && p['dist-tags'] ? p['dist-tags'] : null
    } catch (e) {
      detail = String(e && e.message || e)
      return null
    }
  }
  const r = await run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'])
  if (r.ok) {
    try { tags = JSON.parse(r.out) } catch (e) { error = 'parse-error' }
  } else if (String(r.err || '').includes('ENOENT')) {
    // npm 不在 PATH：HTTP 直连兜底（先用户配置的 registry，再官方）
    tags = await viaHttp(process.env.npm_config_registry || 'https://registry.npmjs.org')
    if (!tags) tags = await viaHttp('https://registry.npmjs.org')
    if (!tags) error = detail && detail.includes('abort') ? 'source-timeout' : 'source-error'
  } else {
    error = 'source-error'
    detail = r.err
  }
  let hasUpdate = false
  let latestVersion = current
  const entries = []
  if (tags) {
    for (const [tag, version] of Object.entries(tags)) entries.push({ tag, version: String(version) })
    hasUpdate = entries.some((e) => cmpVer(e.version, current) > 0)
    const sorted = entries.map((e) => e.version).sort((a, b) => cmpVer(b, a))
    if (sorted.length) latestVersion = sorted[0]
  }
  return { ok: true, current, tags, hasUpdate, latestVersion, error, detail, at: Date.now() }
}

// ---------- 全量插件更新：扫描 / 排队 / 状态 ----------
/** profile 里的依赖（排除 link:/file:/workspace:/portal:），附已装真实版本。
 *  `github:` / `git+https:` 装的包也收进来——它们没有 npm 版本号可查，改比 git tag（2026-10-21 新增）。 */
function listNpmDeps() {
  const pkg = readJson(PROFILE_PKG, {})
  const deps = pkg.dependencies || {}
  const out = []
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string') continue
    if (/^(link|file|workspace|portal):/.test(spec)) continue
    const installed = readJson(path.join(PROFILE_DIR, 'node_modules', name, 'package.json'), {})
    const isGithub = /^(github:|git\+https?:|git\+ssh:)/.test(spec)
    out.push({
      name,
      spec,
      isGithub,
      repo: isGithub ? githubRepoOf(spec) : null,
      current: String(installed.version || String(spec).replace(/^[~^<>=v\s]+/, '').split(/\s+/)[0] || ''),
      isSelf: name === 'dshmarket' || name === 'dsh-market',
    })
  }
  return out
}

/** `github:owner/repo#ref`、`git+https://github.com/owner/repo` → `owner/repo`；认不出返回 null。 */
function githubRepoOf(spec) {
  const s = String(spec)
    .replace(/^github:/, '')
    .replace(/^git\+https?:\/\/github\.com\//, '')
    .replace(/^git\+ssh:\/\/git@github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/#.*$/, '')
  return /^[^/\s]+\/[^/\s]+$/.test(s) ? s : null
}

/** GitHub 仓库的最高 semver tag（与「检测更新」同一判定口径）。 */
async function gitLatestTag(repo) {
  const r = await run('git', ['ls-remote', '--tags', `https://github.com/${repo}`], { gitProxy: true })
  if (!r.ok) return { error: 'source-error' }
  const pairs = r.out.split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter(Boolean)
    .map((t) => t.replace(/\^\{\}$/, ''))
    // 2026-11-16（GPT 评审）：必须带上预发布后缀，否则 v1.5.0-beta.1 会被截成 1.5.0，
    // 后面的「预发布版」红灯判断永远看不到 -beta.1。
    .map((tag) => ({ tag, v: (tag.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) || [])[1] }))
    .filter((x) => x.v)
  if (!pairs.length) return { error: 'no-tags' }
  pairs.sort((a, b) => semverGt(a.v, b.v))
  const best = pairs[pairs.length - 1]
  return { version: best.v, tag: best.tag }
}

/** registry 上的 latest 版本（HTTP 直连，不依赖 npm CLI）。scoped 包的 / 要编码。 */
async function registryLatest(name) {
  const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '')
  const uri = `${registry}/${String(name).replace(/\//g, '%2F')}/latest`
  try {
    const r = await fetch(uri, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-market-expand/update-check' },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return { error: 'HTTP ' + r.status }
    const j = await r.json()
    return { version: String(j.version || '') }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

/**
 * 给每个可更新包打风险标签（v1.3.0 红绿灯；v1.4.0 加白灯）。
 *
 * 红灯只留三类「真的可能弄坏东西」的情况：跨大版本 / 预发布版 / 会改官方预设注入。
 * GitHub 源只是慢，用黄灯；普通升级是绿。
 * **白灯**＝新版本发布不足 24 小时（pnpm 默认 minimumReleaseAge 窗口，市场显示「新版等待中」），
 * 和红灯一样默认不勾——不是不能更，是社区还没验证过。
 */
function assessUpdateRisk(d, latest, publishedAt) {
  const reasons = []
  let level = 'green'
  const red = (t) => { reasons.push(t); level = 'red' }
  const yellow = (t) => { reasons.push(t); if (level === 'green') level = 'yellow' }
  if (d.isGithub) yellow('GitHub 源，可能要几分钟')
  const curM = String(d.current || '').split('.')[0]
  const newM = String(latest || '').split('.')[0]
  if (curM && newM && curM !== newM) red('跨大版本，可能有破坏性变更')
  if (/-/.test(String(latest || ''))) red('预发布版，没有兼容承诺')
  // 组合风险：已装版本的 bundle patch 是否改官方 preset 的 inject
  try {
    const dir = path.join(PROFILE_DIR, 'node_modules', d.name)
    const manifest = readJson(path.join(dir, 'package.json'), null)
    const desc = manifest && manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
    const files = Array.isArray(desc) ? desc : desc ? [desc] : []
    for (const rel of files) {
      const f = path.join(dir, rel)
      if (!fs.existsSync(f)) continue
      const text = fs.readFileSync(f, 'utf8')
      if (/- id:\s*preset-/.test(text) && /^\s*inject:/m.test(text)) {
        red('会改动官方预设注入')
        break
      }
    }
  } catch { /* 读不到就不判 */ }
  // 白灯：发布不足 24h。红灯优先级更高——两个都中就保留红，并在原因里补一句。
  const YOUNG_MS = 24 * 60 * 60 * 1000
  if (publishedAt && Number.isFinite(publishedAt) && Date.now() - publishedAt < YOUNG_MS) {
    const hours = Math.max(1, Math.round((Date.now() - publishedAt) / 3600000))
    if (level === 'red') {
      reasons.push(`发布仅 ${hours} 小时`)
    } else {
      level = 'waiting'
      reasons.push(`新版本发布仅 ${hours} 小时，市场也在等（24 小时等待期）`)
    }
  }
  // 2026-11-16 但丁拍板：不要写"不代表安全"这类防御性免责话术——绿灯就是没发现问题。
  return { level, reasons }
}

/**
 * npm 包的发布时间（ms），取不到返回 null。
 * 只对「确实有更新」的包调用（通常两三个），完整 packument 有 time 字段，
 * 别对所有依赖都拉——那会把一次扫描变成几十次大请求。
 */
async function npmPublishTime(name, version) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    const j = await r.json()
    const t = j && j.time && j.time[version]
    const ms = t ? Date.parse(t) : NaN
    return Number.isFinite(ms) ? ms : null
  } catch { return null }
}


/** 并发扫全部依赖 → 有更新的排在前面。 */
async function checkAllUpdates() {
  const deps = listNpmDeps()
  if (!deps.length) return []
  const results = new Array(deps.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < deps.length) {
      const i = cursor++
      const d = deps[i]
      // npm 包查 registry latest；github: 装的包查仓库最高 semver tag
      const r = (d.isGithub && d.repo) ? await gitLatestTag(d.repo) : await registryLatest(d.name)
      const latest = r.version || null
      // v1.4.0：白灯判据——只对真正有更新的 npm 包查发布时间（github 源没有这个窗口）
      const hasUpdate = !!(latest && cmpVer(latest, d.current) > 0)
      let publishedAt = null
      if (hasUpdate && !d.isGithub) publishedAt = await npmPublishTime(d.name, latest)
      results[i] = {
        name: d.name,
        current: d.current,
        latest,
        error: r.error || null,
        isSelf: d.isSelf,
        isGithub: !!d.isGithub,
        repo: d.repo || null,
        tag: r.tag || null,
        publishedAt,
        hasUpdate,
        // 2026-11-16：查不到上游版本 ≠ 普通升级（绿）。给「信息不足」独立级别，
        // 面板显示灰灯且默认不勾——读不到就不判成安全。
        risk: latest
          ? assessUpdateRisk(d, latest, publishedAt)
          : { level: 'unknown', reasons: [r.error ? '查询失败：' + r.error : '拿不到上游版本'] },
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, deps.length) }, worker))
  return results
}

/** 重启宿主所需的启动信息：Electron 打包应用 exe 即本体；开发模式才带 app 路径。 */
function hostRestartConfig() {
  const exe = process.execPath
  const args = process.defaultApp && process.argv[1] ? [process.argv[1]] : []
  // Desktop 自带的 CLI：官方从 rc.2 起只接受 Desktop 自己的 carrier 管理 desktop
  // profile，且必须完全退出——更新助手正好在退出之后跑，所以这条路可用，且
  // 它会维护 dsh.profile.bundles（比裸 pnpm 更完整）。
  let cli = null
  try {
    const candidates = [
      path.join(path.dirname(exe), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      path.join(path.dirname(exe), 'resources', 'runtime', 'cli', 'bin', 'dsh'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) { cli = c; break }
    }
  } catch (e) { /* 非 Electron 部署没有这条入口 */ }
  return { exe, args, cwd: path.dirname(exe), cli, profileName: PROFILE_NAME }
}

/** 当前更新任务状态：排队中的队列、助手是否还活着、上次报告。 */
/**
 * 进程三态探测（2026-11-16 GPT 第五轮）：
 *   'alive'   —— 探测成功，进程还在
 *   'dead'    —— 明确不存在（ESRCH）
 *   'unknown' —— 权限不足或其他错误：**不能当成已退出**，对应的锁必须保留
 * 旧代码把"kill 抛异常"一律当死，EPERM 会导致误回收别人正在用的锁。
 */
function processState(pid) {
  const n = Number(pid)
  if (!n || n <= 0) return 'dead'
  try { process.kill(n, 0); return 'alive' } catch (e) {
    const code = String((e && e.code) || '').toUpperCase()
    return code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

function updateStatus() {
  const queue = readJson(UPDATE_QUEUE, null)
  const report = readJson(UPDATE_REPORT, null)
  let running = null
  try {
    const raw = String(fs.readFileSync(UPDATE_QUEUE + '.lock', 'utf8')).trim()
    // 兼容旧格式（纯 pid）与新格式（JSON）
    let lock = 0
    if (raw.startsWith('{')) { try { lock = Number(JSON.parse(raw).pid) || 0 } catch { lock = 0 } }
    else lock = Number(raw) || 0
    if (lock > 0) {
      // unknown 也按"在跑"处理（保守：无法确认退出就不当作没有任务）
      if (processState(lock) !== 'dead') running = lock
    }
  } catch (e) { /* 没有锁 = 没有在跑的助手 */ }
  return { queue, running, report }
}

/**
 * 桌面端崩溃日志目录：启动失败（插件没激活）会在这里写 crash-<ts>-web-boot.log。
 * 更新助手用它做「重启后自检」——文件格式见 updater.mjs 的 parseWebBootCrash。
 */
function desktopLogsDir() {
  if (process.platform !== 'win32') return null
  const appData = process.env.APPDATA
  if (!appData) return null
  return path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs')
}

/**
 * 原子抢队列锁（2026-11-16 GPT 评审）。
 * 旧实现是「先读锁判活、再写锁」，两个窗口同时点更新都能通过检查；启动任务时还会
 * 直接删锁，把正在跑的助手锁删掉。现在用 `wx`（排他创建）抢锁：
 *   - 抢到 → 写入 {pid, queueId, at}
 *   - 已存在且持锁进程活着 → 拒绝
 *   - 已存在但持锁进程已死 → 删掉重试一次（过期锁）
 * 锁的"持有者"随任务阶段变化：宿主排队期间是宿主 pid，助手接管后换成助手 pid。
 */
function acquireQueueLock(queueId) {
  const lock = UPDATE_QUEUE + '.lock'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx')
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, queueId: queueId || null, at: Date.now() })) } finally { fs.closeSync(fd) }
      return { ok: true }
    } catch (e) {
      if (e && e.code !== 'EEXIST') return { ok: false, error: '建锁失败：' + ((e && e.message) || e) }
      let holder = 0
      let holderQid = null
      try {
        const raw = String(fs.readFileSync(lock, 'utf8')).trim()
        if (raw.startsWith('{')) {
          const j = JSON.parse(raw)
          holder = Number(j.pid) || 0
          holderQid = j.queueId || null
        } else holder = Number(raw) || 0
      } catch { holder = 0 }
      // 锁属于**另一个任务**：不能再接管（2026-11-16 GPT 第三轮：旧实现只比 pid，
      // 会让旧助手覆盖新任务的锁）
      if (holderQid && queueId && holderQid !== queueId) {
        // 2026-11-16（GPT 第四轮）：锁属于别的任务时，先看持锁者是否还活着——
        // 旧实现一律拒绝，取消后残留的旧锁会让后续更新永远排不上（死锁）。
        const stHolder = processState(holder)
        if (stHolder !== 'dead') {
          return {
            ok: false,
            running: holder,
            error: stHolder === 'alive'
              ? '队列锁属于另一个更新任务（' + holderQid + '）'
              : '无法确认持锁进程（' + holder + '）是否已退出，保留锁并拒绝抢占',
          }
        }
        try { fs.rmSync(lock, { force: true }) } catch { /* 删不掉下一轮再试 */ }
        continue
      }
      if (holder === process.pid) {
        // 同一宿主进程已持有锁：队列还在等就不能再开一个任务（2026-11-16 GPT 评审：
        // 旧实现会删自己的锁再抢成功，等于放行并发任务）
        const q = readJson(UPDATE_QUEUE, null)
        if (q && q.id && q.id !== queueId) {
          return { ok: false, running: holder, error: '已有一个排队中的任务，先取消它或退出 DSH 完成它' }
        }
      } else if (holder) {
        const st = processState(holder)
        if (st !== 'dead') {
          return {
            ok: false,
            running: holder,
            error: st === 'alive'
              ? '已有一个更新任务在等待宿主退出（pid=' + holder + '）'
              : '无法确认持锁进程（' + holder + '）是否已退出，保留锁并拒绝抢占',
          }
        }
      }
      try { fs.rmSync(lock, { force: true }) } catch { }
    }
  }
  return { ok: false, error: '队列锁竞争失败，请稍后再试' }
}

/** 写队列 + 拉起脱离宿主的更新助手（宿主退出后它继续跑）。 */
function startUpdateJob(packages, opts = {}) {
  const queue = {
    // 2026-11-16：执行第三方构建脚本是敏感权限，默认关闭，必须前端明确勾选才放开
    autoApproveBuilds: opts.autoApproveBuilds === true,
    id: 'upd-' + Date.now().toString(36),
    createdAt: new Date().toISOString(),
    profileName: PROFILE_NAME,
    profileDir: PROFILE_DIR,
    hostPid: process.pid,
    packages,
    restart: hostRestartConfig(),
    logsDir: desktopLogsDir(),
    backupDir: path.join(STORE_DIR, 'pre-update'),
    logFile: UPDATE_LOG,
    reportFile: UPDATE_REPORT,
  }
  // 原子抢锁（不再"先检查再写"、也不再删别人的锁）
  const lock = acquireQueueLock(queue.id)
  if (!lock.ok) return { error: lock.error, running: lock.running }
  writeJson(UPDATE_QUEUE, queue)
  try { fs.rmSync(UPDATE_REPORT, { force: true }) } catch (e) { /* 旧报告别冒充新结果 */ }
  const env = { ...process.env }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  let child = null
  try {
    child = spawn(process.execPath, [UPDATER_JS, UPDATE_QUEUE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: DSH_HOME,
      env,
    })
  } catch (e) {
    // 拉起失败就释放锁，否则这个 profile 会一直显示"已有任务在等待"（2026-11-16）
    releaseQueueLock(queue.id)
    return { error: '拉起更新助手失败：' + ((e && e.message) || e) }
  }
  child.on('error', () => { try { releaseQueueLock(queue.id) } catch { } })
  child.unref()
  return { pid: child.pid, queue }
}

/**
 * 读官方更新器 pending 目录里「已下载、待安装」的桌面端本体更新包。
 * 没有就返回 null —— 没下完 / 已装完 / 从没检测到更新，长得都一样。
 */
/**
 * 读指定安装目录里 app.asar 的版本号（同步，失败返回 null）。
 * Electron 的 asar 补丁会把 .asar 当虚拟目录（statSync 返回 size=0、readSync ENOENT），
 * 所以这里**临时**关掉 process.noAsar 再读——同步函数内没有 await，不会被并发插队，
 * 读完立刻恢复，不影响宿主自己加载插件。
 */
function readAsarVersionSafe(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) return null
  const prev = process.noAsar
  process.noAsar = true
  try {
    const fd = fs.openSync(asarPath, 'r')
    try {
      const head = Buffer.alloc(16)
      fs.readSync(fd, head, 0, 16, 0)
      const headerSize = head.readUInt32LE(4)
      const jsonSize = head.readUInt32LE(12)
      const jsonBuf = Buffer.alloc(jsonSize)
      fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
      const json = JSON.parse(jsonBuf.toString('utf8'))
      const entry = json.files && json.files['package.json']
      if (!entry) return null
      const off = 8 + headerSize + Number(entry.offset ?? 0)
      const size = Number(entry.size ?? 0)
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, off)
      return JSON.parse(buf.toString('utf8')).version || null
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return null
  } finally {
    process.noAsar = prev
  }
}

function readPendingDesktopUpdate(baseDir = DESKTOP_UPDATER_DIR) {
  const pendingDir = path.join(baseDir, 'pending')
  const info = readJson(path.join(pendingDir, 'update-info.json'), null)
  if (!info || !info.fileName) return null
  const exe = path.join(pendingDir, String(info.fileName))
  let stat = null
  try { stat = fs.statSync(exe) } catch (e) { return null }
  // deepseek-harness-0.2.2-rc.1-win-x64.exe → 0.2.2-rc.1
  const m = String(info.fileName).match(/^deepseek-harness-(.+?)-win-/i)
  return {
    exe,
    fileName: String(info.fileName),
    version: m ? m[1] : null,
    sha512: info.sha512 ? String(info.sha512) : null,
    sizeBytes: stat.size,
    downloadedAt: stat.mtime.toISOString(),
  }
}

/** 排入「安装桌面端本体更新」任务：写队列 + 拉起脱离宿主的助手（与插件更新共用同一个 updater.mjs）。 */
function startDesktopUpdateJob(pending) {
  const queue = {
    id: 'desk-' + Date.now().toString(36),
    createdAt: new Date().toISOString(),
    profileName: PROFILE_NAME,
    profileDir: PROFILE_DIR,
    hostPid: process.pid,
    packages: [],
    desktopUpdate: pending,
    restart: hostRestartConfig(),
    logsDir: desktopLogsDir(),
    backupDir: null,
    logFile: UPDATE_LOG,
    reportFile: UPDATE_REPORT,
  }
  // 2026-11-16（GPT 评审）：桌面更新入口也要走同一把原子锁，不能另开一条写队列/删锁的路
  const lock = acquireQueueLock(queue.id)
  if (!lock.ok) return { error: lock.error, running: lock.running }
  writeJson(UPDATE_QUEUE, queue)
  try { fs.rmSync(UPDATE_REPORT, { force: true }) } catch (e) { /* 旧报告别冒充新结果 */ }
  const env = { ...process.env }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  let child = null
  try {
    child = spawn(process.execPath, [UPDATER_JS, UPDATE_QUEUE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: DSH_HOME,
      env,
    })
  } catch (e) {
    releaseQueueLock(queue.id)
    return { error: '拉起更新助手失败：' + ((e && e.message) || e) }
  }
  // spawn 的失败也可能通过 'error' 事件异步报出来（同步 try/catch 接不住）
  child.on('error', () => { try { releaseQueueLock(queue.id) } catch { } })
  child.unref()
  return { pid: child.pid, queue }
}

/** 释放队列锁：只有锁属于这个任务（或属于当前宿主且没有 queueId）才删。 */
function releaseQueueLock(queueId) {
  const lock = UPDATE_QUEUE + '.lock'
  try {
    const raw = String(fs.readFileSync(lock, 'utf8')).trim()
    let pid = 0
    let qid = null
    if (raw.startsWith('{')) { const j = JSON.parse(raw); pid = Number(j.pid) || 0; qid = j.queueId || null }
    else pid = Number(raw) || 0
    if (qid && queueId && qid !== queueId) return false   // 不是这个任务的锁
    if (pid && pid !== process.pid) {
      // 2026-11-16（GPT 第四轮）：对方已退出（取消强杀后的残留锁）可以回收，
      // 只有"人还活着"才不能碰——否则取消后锁永远清不掉。
      // 只有明确"已退出"才回收；unknown（权限等）一律保留锁
      if (processState(pid) !== 'dead') return false
    }
    fs.rmSync(lock, { force: true })
    return true
  } catch { return false }
}

/** 取消标记路径：按任务 ID 落文件，助手读到就停（2026-11-16 GPT 第三轮）。 */
/**
 * 取消收尾（2026-11-16 GPT 第五轮）：只有队列/锁仍属于这个任务时才清理。
 * 等待助手退出期间，用户可能已经排入新任务 B —— 绝不能删 B 的队列和锁。
 */
function finalizeCancel(qid, terminated) {
  const nowQ = readJson(UPDATE_QUEUE, null)
  const superseded = !!(nowQ && nowQ.id && nowQ.id !== qid)
  let lockReleased = false
  if (!superseded) {
    try { fs.rmSync(UPDATE_QUEUE, { force: true }) } catch (e) { /* 无队列 */ }
    lockReleased = releaseQueueLock(qid)
  }
  const state = superseded ? 'superseded'
    : (terminated && lockReleased ? 'confirmed' : (terminated ? 'waiting-lock' : 'waiting-helper'))
  return { state, terminated, lockReleased, superseded }
}

function cancelMarkerPath(queueId) {
  return path.join(STORE_DIR, 'cancelled', String(queueId) + '.json')
}

// ---------- 快照 / 回滚 ----------
function snapKeyOf(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_') }

/**
 * 打快照。
 *  - 有 .git：先把 dirty 工作区提交（**必须确认 commit 成功**），再打 tag；
 *    2026-11-16（GPT 评审）：旧实现 commit 失败被忽略、照样打 tag，工作区改动根本不在快照里。
 *  - 无 .git：**完整目录复制**（只排除 node_modules / .git）。
 *    旧实现只复制 node_modules/.git/lib —— 根目录 package.json、配置、assets 全漏，
 *    复制异常还被 catch 静默吞掉，等于"假快照"。
 */
async function snapshotOne(name, dir, hasGit) {
  const key = snapKeyOf(name)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (hasGit) {
    const id = 'me-snap-' + ts
    const st = await run('git', ['status', '--porcelain'], { cwd: dir })
    if (!st.ok) return { ok: false, error: '读不到 git 状态，未打快照：' + st.err }
    if (st.out.trim()) {
      const add = await run('git', ['add', '-A'], { cwd: dir })
      if (!add.ok) return { ok: false, error: 'git add 失败，未打快照：' + add.err }
      const commit = await run('git', ['-c', 'user.name=dsh-custom', '-c', 'user.email=dsh-custom@local', 'commit', '-m', 'me: auto-snapshot ' + ts], { cwd: dir })
      if (!commit.ok) return { ok: false, error: 'git commit 失败（改动没进快照），未打 tag：' + commit.err }
      // 复核：提交后工作区必须干净，否则说明还有没进快照的改动
      const st2 = await run('git', ['status', '--porcelain'], { cwd: dir })
      if (!st2.ok || st2.out.trim()) {
        return { ok: false, error: '提交后工作区仍有改动，快照不完整，未打 tag' }
      }
    }
    const r = await run('git', ['tag', id], { cwd: dir })
    if (!r.ok) return { ok: false, error: 'git tag failed: ' + r.err }
    const head = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })
    return { ok: true, kind: 'git', tag: id, commit: (head.out || '').trim(), ts }
  }
  const dst = path.join(SNAP_ROOT, key, ts)
  // 2026-11-16（GPT 评审）：先写 .partial，校验通过再原子发布成正式快照。
  // 否则复制中途失败留下的残缺目录，回滚时会被当成"最新快照"选中。
  const tmp = dst + '.partial'
  const skipTop = new Set(['node_modules', '.git'])
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    fs.cpSync(dir, tmp, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (src) => {
        const rel = path.relative(dir, src)
        if (!rel) return true
        return !skipTop.has(rel.split(path.sep)[0])
      },
    })
    // 复核：源目录有 package.json 就必须出现在快照里（防"复制了个空壳"）
    if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(tmp, 'package.json'))) {
      fs.rmSync(tmp, { recursive: true, force: true })
      return { ok: false, error: '快照缺少 package.json，目录复制不完整（已丢弃半成品）' }
    }
    // 完成标记：回滚/清理只认带标记的快照
    fs.writeFileSync(path.join(tmp, '.me-complete'), JSON.stringify({ ts, at: new Date().toISOString() }), 'utf8')
    fs.renameSync(tmp, dst)
    return { ok: true, kind: 'copy', dir: dst, ts }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不掩盖主错误 */ }
    return { ok: false, error: '目录复制失败（快照不完整，已丢弃半成品）：' + String((e && e.message) || e) }
  }
}

/** 目录快照是否完整（有完成标记；兼容旧版无标记但有 package.json 的快照）。 */
function isCompleteCopySnapshot(fullPath) {
  try {
    if (!fs.statSync(fullPath).isDirectory()) return false
    if (path.basename(fullPath).endsWith('.partial')) return false
    // 2026-11-16（GPT 第三轮）：只认完成标记。旧规则接受"有 package.json"，
    // 但上一版"复制完 package.json 后中途失败"的残留也满足它 → 会被当成完整快照恢复。
    return fs.existsSync(path.join(fullPath, '.me-complete'))
  } catch { return false }
}

/** 保留最近 K 份快照：git 模式按 tag 名排序（me-snap-<ts>），copy 模式按目录名排序 */
async function pruneSnapshots(name, hasGit, dir) {
  const key = snapKeyOf(name)
  if (hasGit) {
    const r = await run('git', ['tag', '--list', 'me-snap-*'], { cwd: dir })
    if (!r.ok) return
    const tags = r.out.split('\n').filter(Boolean).sort()
    for (const t of tags.slice(0, Math.max(0, tags.length - KEEP_SNAPSHOTS))) {
      await run('git', ['tag', '-d', t], { cwd: dir })
    }
    return
  }
  const root = path.join(SNAP_ROOT, key)
  if (!fs.existsSync(root)) return
  const dirs = fs.readdirSync(root)
    .filter((d) => !d.endsWith('.partial') && isCompleteCopySnapshot(path.join(root, d)))
    .sort()
  for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_SNAPSHOTS))) {
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }) } catch (e) { }
  }
}

async function rollbackOne(name, dir, hasGit) {
  const key = snapKeyOf(name)
  if (hasGit) {
    const r = await run('git', ['tag', '--list', 'me-snap-*'], { cwd: dir })
    if (!r.ok || !r.out.trim()) return { ok: false, error: '无可用快照 git tag' }
    const tags = r.out.split('\n').filter(Boolean).sort()
    const target = tags[tags.length - 1]
    const res = await run('git', ['reset', '--hard', target], { cwd: dir })
    return res.ok ? { ok: true, restored: target } : { ok: false, error: res.err }
  }
  const root = path.join(SNAP_ROOT, key)
  if (!fs.existsSync(root)) return { ok: false, error: '无可用快照（目录备份不存在）' }
  const allDirs = fs.readdirSync(root)
    .filter((d) => !d.endsWith('.partial') && fs.statSync(path.join(root, d)).isDirectory())
    .sort()
  const dirs = allDirs.filter((d) => isCompleteCopySnapshot(path.join(root, d)))
  if (!dirs.length) {
    return {
      ok: false,
      error: allDirs.length
        ? '只有旧格式快照（没有完成标记，完整性未确认），不会自动恢复：' + allDirs.join(', ') + '——需要手动核对'
        : '无可用快照',
    }
  }
  const src = path.join(root, dirs[dirs.length - 1])
  try {
    // 2026-11-16：完整恢复快照内容（旧实现只恢复 node_modules/.git/lib，package.json 等从未回滚过）
    fs.cpSync(src, dir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (s) => {
        const rel = path.relative(src, s)
        if (!rel) return true
        return !new Set(['node_modules', '.git']).has(rel.split(path.sep)[0])
      },
    })
    return { ok: true, restored: dirs[dirs.length - 1], note: '快照里没有的文件保持原样（不删）' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// ---------- HTTP 服务 ----------
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')) } catch (e) { resolve({}) }
    })
  })
}

export const name = 'dsh-market-expand'
export const inject = ['webServer']

/**
 * 启动自愈（2026-11-19）：实测 DSH 启动时会把卸载项的 InstallLocation 写回它认的
 * 旧路径（甚至会指向已删除的工作区目录）。启动时检查一次：当前值不存在或落在
 * 工作区里 → 改成 process.execPath 所在目录；值有效就不动（只纠正坏值）。
 */
function isWorkspacePath(p) {
  return /^[a-z]:\\大肥鱼生产基地(\\|$)/i.test(String(p || ''))
}

function ensureRegistryLocationOnBoot() {
  if (process.platform !== 'win32') return
  const exeDir = path.dirname(process.execPath)
  if (!/^DeepSeek Harness\.exe$/i.test(path.basename(process.execPath))) return
  const logFile = path.join(STORE_DIR, 'update.log')
  const writeLog = (msg) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}` + String.fromCharCode(10)) } catch (e) { /* ignore */ } }
  const base = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  execFile('reg', ['query', base], { windowsHide: true, timeout: 20000 }, (err, out) => {
    if (err) return
    const subs = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => /CurrentVersion\\Uninstall\\[^\\]+$/i.test(x))
    for (const full of subs) {
      execFile('reg', ['query', full, '/v', 'DisplayName'], { windowsHide: true, timeout: 15000 }, (e1, o1) => {
        if (e1 || !/DeepSeek Harness/i.test(String(o1 || ''))) return
        execFile('reg', ['query', full, '/v', 'InstallLocation'], { windowsHide: true, timeout: 15000 }, (e2, o2) => {
          if (e2) return
          const m = String(o2 || '').match(/InstallLocation\s+REG_SZ\s+(.+)/i)
          const cur = m ? m[1].trim() : ''
          const bad = !cur || !fs.existsSync(cur) || isWorkspacePath(cur)
          if (!bad) return
          execFile('reg', ['add', full, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', exeDir, '/f'], { windowsHide: true, timeout: 15000 }, (e3) => {
            writeLog(e3 ? `启动自愈失败：${(e3 && e3.message) || e3}` : `启动自愈：InstallLocation ${cur || '(空)'} → ${exeDir}`)
          })
        })
      })
    }
  })
}

export function apply(ctx) {
  // 先解析当前 profile：桌面端与网页端共用同一份 link 源码，不能写死 web
  resolveProfile(ctx)
  // 2026-11-19：启动自愈——把被写坏的注册表 InstallLocation 纠回当前安装目录
  try { ensureRegistryLocationOnBoot() } catch (e) { /* 自愈失败不影响插件加载 */ }
  // 代理变量可能只写在 ~/.dsh/.env 里，启动时补进进程环境
  loadHomeEnv()
  // v1.2.4 起：不再自动建组/写 state.json（见 managedGroupExists 的注释）

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/market-expand',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://localhost')
            const sub = url.pathname.replace(/^\/market-expand/, '') || '/'
            const method = req.method || 'GET'
            const plugins = listLinkPlugins()
            const cfg = loadConfig()
            const byName = (name) => plugins.find((p) => p.name === name)

            // GET /state —— 插件清单 + 配置源 + 各自快照概况 + 受管分组
            if (sub === '/state' && method === 'GET') {
              const members = readManagedGroupMembers()
              return json(res, 200, {
                ok: true,
                group: GROUP_NAMES.join(' / '),
                members,
                plugins: plugins.map((p) => ({
                  name: p.name,
                  dir: p.dir,
                  version: p.version,
                  hasGit: p.hasGit,
                  inGroup: members.includes(p.name),
                  source: cfg.sources[p.name] || null,
                  lastCheck: cfg.lastCheck[p.name] || null,
                })),
              })
            }

            // POST /source {name, kind:'npm'|'github'|'skip', value, action:'set'|'clear'}
            if (sub === '/source' && method === 'POST') {
              const body = await readBody(req)
              const name = String(body.name || '')
              if (!byName(name)) return json(res, 404, { ok: false, error: '未知插件' })
              if (body.action === 'clear') {
                delete cfg.sources[name]
                saveConfig(cfg)
                return json(res, 200, { ok: true })
              }
              const kind = String(body.kind || '')
              const value = String(body.value || '').trim()
              if (kind === 'skip') {
                cfg.sources[name] = { kind: 'skip' }
                saveConfig(cfg)
                return json(res, 200, { ok: true })
              }
              if (!['npm', 'github'].includes(kind) || !value) return json(res, 400, { ok: false, error: 'kind 或 value 无效' })
              cfg.sources[name] = { kind, value }
              saveConfig(cfg)
              return json(res, 200, { ok: true })
            }

            // POST /check {names?: [..]} —— 批量检测（缺省 = 本地化插件分组成员 ∩ link 插件）
            if (sub === '/check' && method === 'POST') {
              await readBody(req)
              // 2026-11-14 最终定（但丁第三次校正）：
              //   「⟳ 检测更新」**只**管「本地化插件」分组里、配了有效检测源的 link 插件 ——
              //   它们的更新市场检测不到，才需要 expand 来查。
              //   全部 npm 依赖归「⬆ 更新全部」管（那是另一套流程，别混进来，否则两按钮效果一样）；
              //   自创插件（无上游）既不检测也不显示。
              const memberSet = new Set(readManagedGroupMembers())
              const cfg2 = loadConfig()
              const results = []
              for (const p of plugins) {
                if (!memberSet.has(p.name)) continue
                const s = cfg2.sources[p.name] || null
                if (!s || !s.kind || s.kind === 'skip') continue
                const r = await checkOne(p.name, p.dir, p.version, s.kind, s.value)
                results.push({ ...r, kind: 'link' })
              }
              return json(res, 200, { ok: true, results, checked: results.length })
            }

            // POST /snapshot {name} —— 打快照（更新前调用；git tag 或目录备份）
            if (sub === '/snapshot' && method === 'POST') {
              const body = await readBody(req)
              const p = byName(String(body.name || ''))
              if (!p) return json(res, 404, { ok: false, error: '未知插件' })
              const r = await snapshotOne(p.name, p.dir, p.hasGit)
              if (r.ok) await pruneSnapshots(p.name, p.hasGit, p.dir)
              return json(res, 200, r)
            }

            // POST /rollback {name} —— 回滚到最近快照
            if (sub === '/rollback' && method === 'POST') {
              const body = await readBody(req)
              const p = byName(String(body.name || ''))
              if (!p) return json(res, 404, { ok: false, error: '未知插件' })
              const r = await rollbackOne(p.name, p.dir, p.hasGit)
              return json(res, 200, { ...r, restartHint: true })
            }

            // POST /upgrade {name} —— 升级流水线：快照 → fetch 上游 → merge（定制保留）→ 校验；冲突转「建议手动」
            if (sub === '/upgrade' && method === 'POST') {
              const body = await readBody(req)
              const p = byName(String(body.name || ''))
              if (!p) return json(res, 404, { ok: false, error: '未知插件' })
              if (!p.hasGit) return json(res, 200, { ok: false, code: 'manual', message: '插件无 git 仓库，请找 AI 手动升级' })
              const rr = await run('git', ['remote', '-v'], { cwd: p.dir })
              const remotes = new Set()
              ;(rr.out || '').split('\n').forEach((l) => { const m = l.match(/^(\S+)\t\S+ \(fetch\)/); if (m) remotes.add(m[1]) })
              // 2026-11-16（GPT 评审）：合并源必须跟检测源一致。
              // 旧逻辑优先 origin —— 如果 origin 是自己的 fork、检测源配的是上游，就会
              // "检测上游、合并自己"。现在：配了 GitHub 检测源 → 用它（固定 remote 名 me-upstream）；
              // 没配才退回 upstream / origin。
              let remote = null
              const src0 = cfg.sources[p.name] || null
              if (src0 && src0.kind === 'github') {
                const url = /^https?:\/\//.test(src0.value) ? src0.value : 'https://github.com/' + src0.value
                const cur = await run('git', ['remote', 'get-url', 'me-upstream'], { cwd: p.dir })
                if (cur.ok && cur.out.trim()) {
                  if (cur.out.trim() !== url) await run('git', ['remote', 'set-url', 'me-upstream', url], { cwd: p.dir })
                } else {
                  const add = await run('git', ['remote', 'add', 'me-upstream', url], { cwd: p.dir })
                  if (!add.ok) return json(res, 500, { ok: false, code: 'manual', message: '配置合并源失败：' + add.err })
                }
                remote = 'me-upstream'
              } else if (remotes.has('upstream')) remote = 'upstream'
              else if (remotes.has('origin')) remote = 'origin'
              if (!remote) return json(res, 200, { ok: false, code: 'manual', message: '未配置 GitHub 检测源、也没有 upstream/origin —— 先配检测源，或找 AI 手动升级' })
              const snap = await snapshotOne(p.name, p.dir, true)
              if (!snap.ok) return json(res, 500, snap)
              const url = (await run('git', ['remote', 'get-url', remote], { cwd: p.dir })).out.trim()
              const ls = await run('git', ['ls-remote', '--symref', url, 'HEAD'], { gitProxy: true })
              const branch = ((ls.ok && ls.out.match(/ref: refs\/heads\/(\S+)\s+HEAD/)) || [])[1] || null
              if (!branch) return json(res, 200, { ok: false, code: 'manual', message: '无法确定上游默认分支，请找 AI 手动升级' })
              // 2026-11-16（GPT 评审）：不再用 --depth 1 试探。浅拉后 merge-base 拿不到
              // 共同祖先，会被误判成"无共同历史"，所有 fork 都转手动。直接完整 fetch。
              try { fs.rmSync(path.join(p.dir, '.git', 'shallow.lock'), { force: true }) } catch (e) { /* 残留锁清理 */ }
              const shallowCheck = await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: p.dir })
              if (shallowCheck.ok && shallowCheck.out.trim() === 'true') {
                const unf = await run('git', ['fetch', '--unshallow', remote, branch], { cwd: p.dir, gitProxy: true })
                if (!unf.ok) return json(res, 200, { ok: false, code: 'manual', message: '仓库是浅克隆，补全历史失败：' + unf.err })
              }
              const f = await run('git', ['fetch', '--no-tags', remote, branch], { cwd: p.dir, gitProxy: true })
              if (!f.ok) return json(res, 200, { ok: false, code: 'manual', message: 'fetch 失败：' + f.err })
              const mb = await run('git', ['merge-base', 'HEAD', 'FETCH_HEAD'], { cwd: p.dir })
              if (!mb.ok || !mb.out.trim()) {
                // 完整 fetch 之后仍找不到共同祖先 = 真的换过基线，自动合并不安全
                return json(res, 200, {
                  ok: false, code: 'manual-rebase',
                  message: '与上游无共同历史（fork 换基线型升级），自动合并不安全 → 建议转手动（找 AI 用 CUSTOMIZATIONS/补丁清单还原定制）',
                  conflicted: [], stat: '',
                })
              }
              const m = await run('git', ['merge', '--no-edit', 'FETCH_HEAD'], { cwd: p.dir })
              if (!m.ok) {
                const st = await run('git', ['status', '--porcelain'], { cwd: p.dir })
                const conflicted = (st.out || '').split('\n')
                  .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\b/.test(l.trim()))
                  .map((l) => l.slice(3))
                  .filter(Boolean)
                const stat = await run('git', ['diff', '--stat', 'FETCH_HEAD'], { cwd: p.dir })
                await run('git', ['merge', '--abort'], { cwd: p.dir })
                return json(res, 200, {
                  ok: false, code: 'conflict-manual',
                  message: 'merge 冲突，已中止并保留快照；请找 AI 评估（可回滚）',
                  conflicted, stat: (stat.out || '').slice(0, 1200),
                })
              }
              await pruneSnapshots(p.name, true, p.dir)
              const after = readJson(path.join(p.dir, 'package.json'), {}).version || p.version
              return json(res, 200, { ok: true, before: p.version, after, message: '升级完成（' + p.version + ' → ' + after + '）：请重启 DSH；异常可点「↩ 回滚」' })
            }

            // GET /dsh-update —— DSH 本体更新检查（只读 dist-tags；不安装）
            if (sub === '/dsh-update' && method === 'GET') {
              return json(res, 200, await checkDshUpdate())
            }

            // GET /desktop-update-pending —— 只读：官方更新器有没有下好但没装上的包
            if (sub === '/desktop-update-pending' && method === 'GET') {
              const pending = readPendingDesktopUpdate()
              // 2026-11-14：pending 里的包装完后不会自己消失，所以每次点都还在问"要不要装"。
              // 这里比对一下当前安装目录里的真实版本，已经同版本就直接告诉用户「已是最新」。
              let current = null
              try {
                const hostExe = (hostRestartConfig() || {}).exe
                if (hostExe) current = readAsarVersionSafe(path.join(path.dirname(String(hostExe)), 'resources', 'app.asar'))
              } catch (e) { current = null }
              const already = !!(current && pending && pending.version && String(current).trim() === String(pending.version).trim())
              return json(res, 200, {
                ok: true,
                pending,
                current,
                already,
                dir: DESKTOP_UPDATER_DIR,
                hint: pending
                  ? (already
                      ? `当前已经是 ${current}，这个包（${pending.version}）就是它，不用再装。`
                      : `检测到已下载待安装的 ${pending.version || pending.fileName}（${(pending.sizeBytes / 1048576).toFixed(0)} MB）。可以一键安装：DSH 退出后自动装好并重新打开。`)
                  : '没有已下载待安装的桌面端更新包。',
              })
            }

            // POST /desktop-update —— 排入「装桌面端本体」任务，宿主退出后静默安装并重启
            if (sub === '/desktop-update' && method === 'POST') {
              const pending = readPendingDesktopUpdate()
              if (!pending) {
                return json(res, 404, {
                  ok: false,
                  error: '没有已下载待安装的更新包。先在 DSH 自己的更新提示里点一次更新（让它把包下下来），再回来点这里。',
                })
              }
              const status = updateStatus()
              if (status.running) {
                return json(res, 409, {
                  ok: false,
                  error: '已有一个更新助手在等待宿主退出，请先退出 DSH 完成它',
                  running: status.running,
                  queue: status.queue,
                })
              }
              const job = startDesktopUpdateJob(pending)
              if (job.error) return json(res, 409, { ok: false, error: job.error, running: job.running || null })
              return json(res, 200, {
                ok: true,
                job: { id: job.queue.id, helperPid: job.pid, target: pending.version, exe: pending.fileName },
                hint: '已排入队列。点「立即重启并更新」或手动退出 DSH，助手会静默安装 ' + (pending.version || pending.fileName) + ' 并在装完后自动重新打开；右下角进度窗会显示进度。',
              })
            }

            // GET /updates —— 扫描 profile 里全部 npm 插件（含市场自己）的 latest
            // 只读：不安装、不改任何文件
            if (sub === '/updates' && method === 'GET') {
              const results = await checkAllUpdates()
              const updatable = results.filter((r) => r.hasUpdate)
              // 保存本次扫描结果：/update 用它当唯一安装计划来源（2026-11-16）
              SCAN_CACHE = { at: Date.now(), map: new Map(updatable.map((r) => [r.name, r])) }
              return json(res, 200, {
                ok: true,
                profile: PROFILE_NAME,
                profileDir: PROFILE_DIR,
                results,
                updatable,
                restartable: true,
              })
            }

            // POST /update {names, packages?} —— 排入更新队列并拉起脱离宿主的助手
            // 助手在宿主退出后跑 pnpm add，完成后再把宿主开回来
            if (sub === '/update' && method === 'POST') {
              const body = await readBody(req)
              const names = Array.isArray(body.names) ? body.names.map(String) : []
              // 2026-11-16（GPT 评审）：安装目标只认**后端计划**。
              // 前端只提供「用户勾了哪些名字」；latest / spec / current 一律用后端扫描结果，
              // 避免过期面板或被改动的前端数据直接把安装目标改掉。
              // 同一份扫描结果还消除了「面板 11 个、点更新后重扫只剩 10 个」的静默丢包。
              if (!names.length) return json(res, 400, { ok: false, error: '没有选择要更新的插件' })
              const status = updateStatus()
              if (status.running) {
                return json(res, 409, {
                  ok: false,
                  error: '已有一个更新助手在等待宿主退出，请先退出 DSH 完成它',
                  running: status.running,
                  queue: status.queue,
                })
              }
              const deps = (readJson(path.join(PROFILE_DIR, 'package.json'), {}) || {}).dependencies || {}
              let plan = SCAN_CACHE.map
              if (!plan.size || Date.now() - SCAN_CACHE.at > SCAN_CACHE_TTL_MS) {
                const all = await checkAllUpdates()
                plan = new Map(all.filter((r) => r.hasUpdate).map((r) => [r.name, r]))
                SCAN_CACHE = { at: Date.now(), map: plan }
              }
              const chosen = []
              const staleNames = []
              for (const name of names) {
                // 2026-11-16（GPT 第三轮）：选中项已被卸载/移出 deps 也要算缺失，
                // 否则"选了 A、B，B 已卸载"会被静默跳过、只装 A。
                if (!deps[name]) { staleNames.push(name); continue }
                const r = plan.get(name)
                if (!r || !r.latest) { staleNames.push(name); continue }
                chosen.push({
                  name,
                  from: r.current,
                  target: r.latest,
                  spec: (r.isGithub && r.repo && r.tag) ? `github:${r.repo}#${r.tag}` : `${name}@${r.latest}`,
                  isGithub: !!r.isGithub,
                })
              }
              // 2026-11-16（GPT 评审）：只拦"一个都没有"不够——选了 A、B 而后台只剩 A 时，
              // 旧实现会静默只装 A。现在只要有选中项对不上，就整体拒绝、让用户重新确认。
              if (!chosen.length || staleNames.length) {
                return json(res, 400, {
                  ok: false,
                  error: (staleNames.length
                    ? '这些包在最新扫描里没有可更新版本（面板可能已过期）：' + staleNames.join(', ') + '——请重新扫描后再点更新'
                    : '没有可更新的包——请重新扫描后再点更新'),
                })
              }
              // 2026-11-16：构建脚本许可只认用户在面板里的明确勾选
              const job = startUpdateJob(chosen, { autoApproveBuilds: body.allowBuilds === true })
              if (job.error) {
                return json(res, 409, { ok: false, error: job.error, running: job.running || null })
              }
              return json(res, 200, {
                ok: true,
                job: { id: job.queue.id, packages: job.queue.packages, helperPid: job.pid },
                queued: chosen.length,
                requested: names.length,
                hint: '已排入更新队列（' + chosen.length + ' 个）。请完全退出 DSH（托盘图标右键 → 退出），更新助手会自动更新并在完成后重新打开 DSH；右下角进度窗会一直显示进度。',
              })
            }

            // POST /update-cancel —— 取消排队中的更新任务
            if (sub === '/update-cancel' && method === 'POST') {
              const status = updateStatus()
              const q = status.queue || {}
              const qid = String(q.id || '')
              if (!qid) return json(res, 200, { ok: true, canceled: true, state: 'noop' })

              // ① 先落取消标记（协作信号：助手读到就自己停）
              try {
                fs.mkdirSync(path.join(STORE_DIR, 'cancelled'), { recursive: true })
                writeJson(cancelMarkerPath(qid), { at: Date.now(), by: process.pid })
              } catch (e) {
                return json(res, 500, { ok: false, error: '取消标记写入失败，任务没有被取消：' + ((e && e.message) || e) })
              }

              // ② 助手已接管时：先给它 2 秒自己看到标记退出；没退再强杀。
              //   Windows 的 SIGTERM 是硬终止，不能指望被杀进程做清理 —— 所以先用协作信号。
              const helperPid = (status.running && status.running !== process.pid) ? status.running : 0
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              let terminated = !helperPid
              if (helperPid) {
                for (let i = 0; i < 8 && !terminated; i++) {
                  await sleep(250)
                  if (processState(helperPid) === 'dead') terminated = true
                }
                if (!terminated) {
                  try { process.kill(helperPid, 'SIGTERM') } catch (e) {
                    // 只有明确 ESRCH 才算已退出；权限等错误 = 未知，继续等
                    if (String((e && e.code) || '').toUpperCase() === 'ESRCH') terminated = true
                  }
                  for (let i = 0; i < 10 && !terminated; i++) {
                    await sleep(150)
                    if (processState(helperPid) === 'dead') terminated = true
                  }
                }
              }

              // ③ 收尾前重新读队列：等待期间可能已经排入新任务 B —— 绝不能删 B 的文件
              const fin = finalizeCancel(qid, terminated)
              const { state, lockReleased, superseded } = fin
              try {
                if (state !== 'superseded') {
                  writeJson(path.join(STORE_DIR, 'update-progress.json'), {
                    title: '插件更新',
                    badge: state === 'confirmed' ? '已取消' : '取消中',
                    phase: state === 'confirmed' ? 'canceled' : 'verifying',
                    step: 0,
                    steps: ['更新', '自检', '回退', '重启'], percent: 0,
                    detail: state === 'confirmed'
                      ? '已取消排队，DSH 不用退出了'
                      : '取消请求已发出，正在等更新助手退出（锁暂时保留）',
                    hint: '点右上角 × 关闭本窗口', logLines: [], at: new Date().toISOString(),
                  })
                }
              } catch (e) { /* 进度窗没开 */ }
              return json(res, 200, {
                ok: true,
                canceled: true,
                state,
                terminated,
                lockReleased,
                superseded,
                warn: state === 'confirmed' ? undefined : '取消尚未完全确认，请稍后再确认状态',
              })
            }

            // POST /quit-host —— 立即退出桌面端，让排队的更新助手开始干活
            // 注意：更新助手自己也是同名的 exe 进程（ELECTRON_RUN_AS_NODE 起的），
            // 必须按 lock 里的 pid 排除它，否则会把自己一起杀掉。
            if (sub === '/quit-host' && method === 'POST') {
              if (process.platform !== 'win32' || !/\.exe$/i.test(process.execPath)) {
                return json(res, 400, { ok: false, error: '当前宿主不是 Windows 桌面端，无法自动退出' })
              }
              const st = updateStatus()
              if (!st.running) {
                return json(res, 400, { ok: false, error: '当前没有排队中的更新任务，不需要退出' })
              }
              const helperPid = st.running
              const exeName = path.basename(process.execPath)
              try {
                fs.appendFileSync(UPDATE_LOG, `[${new Date().toISOString()}] 用户点击「立即重启并更新」：准备退出 ${exeName}（保留助手 pid=${helperPid}）\n`, 'utf8')
              } catch (e) { /* 日志写不进去不影响退出 */ }
              // 先回 HTTP 再动手，给前端留出显示「正在退出…」的时间
              setTimeout(() => {
                execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (err, out) => {
                  const pids = []
                  if (!err) {
                    for (const line of String(out || '').split(/\r?\n/)) {
                      const m = line.match(/^"([^"]+)","(\d+)"/)
                      if (m && m[1].toLowerCase() === exeName.toLowerCase()) pids.push(Number(m[2]))
                    }
                  }
                  const targets = pids.filter((pid) => pid !== helperPid && pid !== process.pid)
                  targets.push(process.pid) // 宿主自己最后也退出
                  for (const pid of targets) {
                    execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 20000 }, () => { })
                  }
                })
              }, 1200)
              return json(res, 200, {
                ok: true,
                exe: exeName,
                helperPid,
                hint: '正在退出 DSH，更新助手会在退出后自动更新并重新打开',
              })
            }

            // GET /update-status —— 队列/助手/上次报告
            if (sub === '/update-status' && method === 'GET') {
              const st = updateStatus()
              return json(res, 200, {
                ok: true,
                profile: PROFILE_NAME,
                running: st.running,
                queue: st.queue,
                report: st.report,
                logFile: UPDATE_LOG,
              })
            }

            // GET /update-log —— 更新助手日志尾部（排查用）
            if (sub === '/update-log' && method === 'GET') {
              let text = ''
              try { text = fs.readFileSync(UPDATE_LOG, 'utf8') } catch (e) { /* 没日志 */ }
              return json(res, 200, { ok: true, logFile: UPDATE_LOG, tail: text.split(/\r?\n/).slice(-120).join('\n') })
            }

            // GET /snapshots?name= —— 列出快照（调试用）
            if (sub === '/snapshots' && method === 'GET') {
              const p = byName(String(url.searchParams.get('name') || ''))
              if (!p) return json(res, 404, { ok: false })
              if (p.hasGit) {
                const r = await run('git', ['tag', '--list', 'me-snap-*'], { cwd: p.dir })
                return json(res, 200, { ok: true, kind: 'git', snapshots: r.ok ? r.out.split('\n').filter(Boolean).sort() : [] })
              }
              const root = path.join(SNAP_ROOT, snapKeyOf(p.name))
              return json(res, 200, {
                ok: true, kind: 'copy',
                snapshots: fs.existsSync(root) ? fs.readdirSync(root).sort() : [],
              })
            }

            json(res, 404, { ok: false, error: 'not-found' })
          } catch (e) {
            json(res, 500, { ok: false, error: String(e && e.message || e) })
          }
        },
      }),
    'market-expand: /market-expand routes',
  )
}

// 2026-11-16：导出快照/回滚实现，供 test/snapshot-roundtrip.mjs 做「备份→改坏→恢复」往返验证。
// 宿主只认 name/apply/inject，多导出几个符号没有副作用。
export { snapshotOne, rollbackOne, pruneSnapshots, snapKeyOf, SNAP_ROOT, semverGt, cmpVer, acquireQueueLock, releaseQueueLock, finalizeCancel }
// semverGt 一并导出：test/selfcheck-stages.mjs 用它验证预发布版本比较（2026-11-16）
