/**
 * 桌面端本体更新分支端到端测试（2026-11-07）
 *
 * 真的完整跑一次 updater.mjs：
 *   假宿主进程退出 → 助手接管 → 执行「假安装器」→ 读 app.asar 真实版本 → 拉起重启命令
 *
 * 安全约定：不碰真实 pending 包、不 taskkill（skipKillHost）、不弹进度窗、不装任何东西。
 * 用法：node test/desktop-update-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATER = path.join(HERE, '..', 'lib', 'updater.mjs')
// 安装目录 2026-11-08 已从 G:\大肥鱼生产基地\DSH desktop 搬到 G:\DSH desktop，两个都试
const ASAR_CANDIDATES = [
  'G:\\DSH desktop\\resources\\app.asar',
  'G:\\大肥鱼生产基地\\DSH desktop\\resources\\app.asar',
]
const ASAR = ASAR_CANDIDATES.find((p) => fs.existsSync(p)) || ASAR_CANDIDATES[0]

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-desktop-update-'))
const logFile = path.join(root, 'update.log')
const reportFile = path.join(root, 'last-update.json')
const marker = path.join(root, 'installed.marker')
const fakeInstaller = path.join(root, 'fake-installer.mjs')
const queueFile = path.join(root, 'queue.json')

fs.writeFileSync(
  fakeInstaller,
  `import fs from 'node:fs'\nimport path from 'node:path'\n` +
  `fs.writeFileSync(${JSON.stringify(marker)}, 'ok ' + new Date().toISOString())\n`,
  'utf8',
)

const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1 }
const ok = (msg) => console.log('ok   ' + msg)

// 1. 假宿主：1.2 秒后自己退出（模拟用户关掉 DSH）
const host = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { stdio: 'ignore', windowsHide: true })

// 2. 写队列 —— 宿主还活着，助手启动后会等它退出
const queue = {
  id: 'test-desktop-update',
  createdAt: new Date().toISOString(),
  profileName: 'desktop',
  hostPid: host.pid,
  packages: [],
  desktopUpdate: {
    exe: process.execPath,          // 用 node 当「安装器」
    args: [fakeInstaller],          // 它写个标记文件就退出 0
    version: null,                  // 不比对版本：本测试只验骨架
    asarPath: ASAR,                 // 读真实 asar，顺便验 readAsarVersion
    skipKillHost: true,             // 千万别真去 taskkill node.exe
  },
  restart: { exe: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
  noProgressWindow: true,
  logFile,
  reportFile,
}
fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), 'utf8')

// 3. 跑助手，等它自己退出
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [UPDATER, queueFile], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  const timer = setTimeout(() => { console.error('助手 90 秒没退出'); child.kill(); resolve(-1) }, 90000)
  child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? -1) })
})
if (code !== 0) fail('助手退出码 ' + code)
else ok('助手正常退出')

// 4. 断言
if (fs.existsSync(marker)) ok('假安装器被执行过')
else fail('假安装器没有被执行')

let report = null
let reportRaw = ''
try { reportRaw = fs.readFileSync(reportFile, 'utf8'); report = JSON.parse(reportRaw) } catch { }

if (!report) fail('没写出 last-update.json')
else {
  if (report.desktopUpdate && report.desktopUpdate.ok) ok('报告记录安装成功')
  else fail('desktopUpdate.ok 不为 true：' + JSON.stringify(report.desktopUpdate))
  if (report.desktopUpdate && report.desktopUpdate.version) ok('读到安装后的 asar 版本：' + report.desktopUpdate.version)
  else fail('没读到 asar 版本（readAsarVersion 有问题）')
  if (report.restart && report.restart.ok) ok('重启命令已拉起（fake）')
  else fail('重启没成功：' + JSON.stringify(report.restart))
}

console.log('\n临时目录：' + root)
try {
  const text = fs.readFileSync(logFile, 'utf8')
  console.log('\n--- update.log（尾部 14 行）---')
  console.log(text.split(/\r?\n/).filter(Boolean).slice(-14).join('\n'))
} catch { }
