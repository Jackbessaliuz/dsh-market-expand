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

// ---------- market-expand 专属分组（v3：用户拍板「自动建组 + 不可删除 + 手动分配成员」） ----------
// 市场分组持久化在 <profile>/.dsh-market/state.json（dshmarket lib/hot.js readMarketState/writeMarketState）。
// market-expand 启动时保证「本地化插件」分组存在（被删则自动重建——实现不可删除语义），
// 成员由用户经市场 UI「加入插件」手动分配；market-expand 只检测分组成员。
export const GROUP_NAME = '本地化插件'
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
    return !!(state.groups && state.groups[GROUP_NAME] !== undefined)
  } catch (e) {
    return false
  }
}

/** 读取「本地化插件」分组当前成员（用户手动分配；分组不存在时返回空，**只读**）。 */
function readManagedGroupMembers() {
  try {
    const state = readMarketState()
    const members = state.groups && state.groups[GROUP_NAME]
    return Array.isArray(members) ? members : []
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
  const pa = String(a).trim().split('-')[0].split('.').map((n) => Number(n) || 0)
  const pb = String(b).trim().split('-')[0].split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
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
        .map((t) => (t.match(/(\d+\.\d+\.\d+)/) || [])[1])
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
    .map((tag) => ({ tag, v: (tag.match(/(\d+\.\d+\.\d+)/) || [])[1] }))
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
 * 给每个可更新包打风险标签（v1.3.0 红绿灯）。
 *
 * 红灯只留三类「真的可能弄坏东西」的情况：跨大版本 / 预发布版 / 会改官方预设注入。
 * GitHub 源只是慢，用黄灯；普通升级是绿。判据全部来自本地数据，不用联网。
 */
function assessUpdateRisk(d, latest) {
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
  return { level, reasons }
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
      results[i] = {
        name: d.name,
        current: d.current,
        latest,
        error: r.error || null,
        isSelf: d.isSelf,
        isGithub: !!d.isGithub,
        repo: d.repo || null,
        tag: r.tag || null,
        hasUpdate: !!(latest && cmpVer(latest, d.current) > 0),
        risk: latest ? assessUpdateRisk(d, latest) : { level: 'green', reasons: [] },
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
function updateStatus() {
  const queue = readJson(UPDATE_QUEUE, null)
  const report = readJson(UPDATE_REPORT, null)
  let running = null
  try {
    const lock = Number(String(fs.readFileSync(UPDATE_QUEUE + '.lock', 'utf8')).trim())
    if (lock > 0) {
      try { process.kill(lock, 0); running = lock } catch (e) { /* 助手已退出 */ }
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

/** 写队列 + 拉起脱离宿主的更新助手（宿主退出后它继续跑）。 */
function startUpdateJob(packages) {
  const queue = {
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
  writeJson(UPDATE_QUEUE, queue)
  try { fs.rmSync(UPDATE_REPORT, { force: true }) } catch (e) { /* 旧报告别冒充新结果 */ }
  try { fs.rmSync(UPDATE_QUEUE + '.lock', { force: true }) } catch (e) { /* 残留锁 */ }
  const env = { ...process.env }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(process.execPath, [UPDATER_JS, UPDATE_QUEUE], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: DSH_HOME,
    env,
  })
  child.unref()
  return { pid: child.pid, queue }
}

// ---------- 快照 / 回滚 ----------
function snapKeyOf(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_') }

/** 打快照：有 .git → 自动提交 dirty(如需) + tag；无 .git → 目录复制(排除 node_modules/.git) */
async function snapshotOne(name, dir, hasGit) {
  const key = snapKeyOf(name)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (hasGit) {
    const id = 'me-snap-' + ts
    // dirty 工作区先自动提交（用内联身份，不改用户全局配置）
    const st = await run('git', ['status', '--porcelain'], { cwd: dir })
    if (st.ok && st.out.trim()) {
      await run('git', ['add', '-A'], { cwd: dir })
      await run('git', ['-c', 'user.name=dsh-custom', '-c', 'user.email=dsh-custom@local', 'commit', '-m', 'me: auto-snapshot ' + ts], { cwd: dir })
    }
    const r = await run('git', ['tag', id], { cwd: dir })
    if (!r.ok) return { ok: false, error: 'git tag failed: ' + r.err }
    return { ok: true, kind: 'git', tag: id, ts }
  }
  const dst = path.join(SNAP_ROOT, key, ts)
  fs.mkdirSync(dst, { recursive: true })
  ;['node_modules', '.git', 'lib'].forEach((skip) => {
    const s = path.join(dir, skip)
    if (fs.existsSync(s)) {
      try { fs.cpSync(s, path.join(dst, skip), { recursive: true, force: true, errorOnExist: false }) } catch (e) { /* 忽略 */ }
    }
  })
  return { ok: true, kind: 'copy', dir: dst, ts }
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
  const dirs = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort()
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
  const dirs = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort()
  if (!dirs.length) return { ok: false, error: '无可用快照' }
  const src = path.join(root, dirs[dirs.length - 1])
  try {
    ;['node_modules', '.git', 'lib'].forEach((skip) => {
      const s = path.join(src, skip)
      const t = path.join(dir, skip)
      if (fs.existsSync(s)) { fs.rmSync(t, { recursive: true, force: true }); fs.cpSync(s, t, { recursive: true, force: true }) }
    })
    return { ok: true, restored: dirs[dirs.length - 1] }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
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

export function apply(ctx) {
  // 先解析当前 profile：桌面端与网页端共用同一份 link 源码，不能写死 web
  resolveProfile(ctx)
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
                group: GROUP_NAME,
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
              const body = await readBody(req)
              const memberSet = new Set(readManagedGroupMembers())
              if (memberSet.size === 0) {
                return json(res, 200, {
                  ok: true,
                  results: [],
                  group: GROUP_NAME,
                  warning: '「' + GROUP_NAME + '」分组还没有成员：请先在市场「分组」页新建一个名为「' + GROUP_NAME + '」的分组，再把本地插件加进去，然后重新检测。',
                })
              }
              let names = Array.isArray(body.names) && body.names.length ? body.names : plugins.map((p) => p.name)
              // 只检测「本地化插件」分组里的 link 插件（用户手动分配；非 link 成员跳过——走市场原生更新）
              names = names.filter((n) => memberSet.has(n) && byName(n) !== undefined)
              const results = []
              for (const p of plugins) {
                if (!names.includes(p.name)) continue
                const src = cfg.sources[p.name] || null
                results.push(await checkOne(p.name, p.dir, p.version, src && src.kind, src && src.value))
              }
              return json(res, 200, { ok: true, results, group: GROUP_NAME, members: [...memberSet] })
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
              let remote = null
              if (remotes.has('origin')) remote = 'origin'
              else if (remotes.has('upstream')) remote = 'upstream'
              else {
                const src = cfg.sources[p.name] || null
                if (src && src.kind === 'github') {
                  const url = /^https?:\/\//.test(src.value) ? src.value : 'https://github.com/' + src.value
                  await run('git', ['remote', 'add', 'upstream', url], { cwd: p.dir })
                  remote = 'upstream'
                }
              }
              if (!remote) return json(res, 200, { ok: false, code: 'manual', message: '无 git remote 且未配置 GitHub 源，请找 AI 手动升级' })
              const snap = await snapshotOne(p.name, p.dir, true)
              if (!snap.ok) return json(res, 500, snap)
              const url = (await run('git', ['remote', 'get-url', remote], { cwd: p.dir })).out.trim()
              const ls = await run('git', ['ls-remote', '--symref', url, 'HEAD'], { gitProxy: true })
              const branch = ((ls.ok && ls.out.match(/ref: refs\/heads\/(\S+)\s+HEAD/)) || [])[1] || null
              if (!branch) return json(res, 200, { ok: false, code: 'manual', message: '无法确定上游默认分支，请找 AI 手动升级' })
              // 浅拉 1 层（轻量，避免全量 fetch 卡死）→ 判断与上游有无共同历史
              try { fs.rmSync(path.join(p.dir, '.git', 'shallow.lock'), { force: true }) } catch (e) { /* 残留锁清理 */ }
              const f = await run('git', ['fetch', '--depth', '1', '--no-tags', remote, branch], { cwd: p.dir, gitProxy: true })
              if (!f.ok) return json(res, 200, { ok: false, code: 'manual', message: 'fetch 失败：' + f.err })
              const mb = await run('git', ['merge-base', 'HEAD', 'FETCH_HEAD'], { cwd: p.dir })
              if (!mb.ok || !mb.out.trim()) {
                // 与上游无共同历史（fork 后独立基线/换基线型）：自动 merge 不安全 → 直接建议手动，不折腾
                return json(res, 200, {
                  ok: false, code: 'manual-rebase',
                  message: '与上游无共同历史（fork 换基线型升级），自动合并不安全 → 建议转手动（找 AI 用 CUSTOMIZATIONS/补丁清单还原定制）',
                  conflicted: [], stat: '',
                })
              }
              // 有共同历史：完整 fetch + merge（定制随 commit 历史保留）
              const f2 = await run('git', ['fetch', remote, branch], { cwd: p.dir, gitProxy: true })
              if (!f2.ok) return json(res, 200, { ok: false, code: 'manual', message: 'fetch 失败：' + f2.err })
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

            // GET /updates —— 扫描 profile 里全部 npm 插件（含市场自己）的 latest
            // 只读：不安装、不改任何文件
            if (sub === '/updates' && method === 'GET') {
              const results = await checkAllUpdates()
              const updatable = results.filter((r) => r.hasUpdate)
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
              // 2026-10-21：客户端现在会把面板里的完整列表带上来（name/current/latest/spec）。
              // 旧逻辑在这里二次扫描再过滤，扫描抖动会让某个包静默落选——群友那次
              // 面板 11 个、第二次重扫只剩 10 个就是这么来的。有列表就用列表。
              const clientPkgs = Array.isArray(body.packages) ? body.packages : []
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
              let chosen = []
              if (clientPkgs.length) {
                for (const it of clientPkgs) {
                  const name = String(it && it.name || '')
                  const latest = String(it && it.latest || '')
                  if (!name || !latest || !names.includes(name) || !deps[name]) continue
                  const isGithub = !!(it && it.isGithub)
                  chosen.push({
                    name,
                    from: it && it.current ? String(it.current) : null,
                    target: latest,
                    spec: it && it.spec ? String(it.spec) : (isGithub ? null : `${name}@${latest}`),
                    isGithub,
                  })
                }
                // 客户端没带全的，用后台扫描补齐（只补不漏，避免静默丢包）
                const missing = names.filter((n) => !chosen.some((c) => c.name === n))
                if (missing.length) {
                  const all = await checkAllUpdates()
                  for (const r of all) {
                    if (!r.hasUpdate || !missing.includes(r.name)) continue
                    chosen.push({
                      name: r.name,
                      from: r.current,
                      target: r.latest,
                      spec: r.isGithub && r.repo && r.tag ? `github:${r.repo}#${r.tag}` : `${r.name}@${r.latest}`,
                      isGithub: !!r.isGithub,
                    })
                  }
                }
              } else {
                const all = await checkAllUpdates()
                chosen = all.filter((r) => r.hasUpdate && names.includes(r.name)).map((r) => ({
                  name: r.name,
                  from: r.current,
                  target: r.latest,
                  spec: (r.isGithub && r.repo && r.tag) ? `github:${r.repo}#${r.tag}` : `${r.name}@${r.latest}`,
                  isGithub: !!r.isGithub,
                }))
              }
              if (!chosen.length) return json(res, 400, { ok: false, error: '选中的插件都已是最新，或没有可更新版本' })
              const job = startUpdateJob(chosen)
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
              if (status.running) {
                try { process.kill(status.running, 'SIGTERM') } catch (e) { /* 已经退出 */ }
              }
              try { fs.rmSync(UPDATE_QUEUE, { force: true }) } catch (e) { /* 无队列 */ }
              try { fs.rmSync(UPDATE_QUEUE + '.lock', { force: true }) } catch (e) { /* 无锁 */ }
              try {
                writeJson(path.join(STORE_DIR, 'update-progress.json'), {
                  title: '插件更新', badge: '已取消', phase: 'canceled', step: 0,
                  steps: ['更新', '自检', '回退', '重启'], percent: 0,
                  detail: '已取消排队，DSH 不用退出了', hint: '点右上角 × 关闭本窗口',
                  logLines: [], at: new Date().toISOString(),
                })
              } catch (e) { /* 进度窗没开 */ }
              return json(res, 200, { ok: true, canceled: true })
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
