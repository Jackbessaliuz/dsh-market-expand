/**
 * 桌面端本体更新分支 e2e（2026-11-07 首版；2026-11-16 重写）
 *
 * 2026-11-16 重写原因（GPT 评审）：旧版用 node.exe 当假安装器 + 读真实 app.asar + version=null，
 * 结果 ①node.exe 路径含空格，updater 用 windowsVerbatimArguments 启动 → 参数错位、退出码 1；
 * ②installDir 被推导成 node 目录 → 真去改了真实的 HKCU InstallLocation（事故）；
 * ③它只验证"接线"，没验证"假安装器把新版本装到了目标位置"。
 *
 * 现在：
 *   - 在临时目录构造**假 app.asar**（真实 asar 头格式，能读出指定版本）
 *   - 假安装器是 cmd.exe + .cmd，把"新版本 asar"复制到目标位置（旧→新，可验证）
 *   - 队列带 sha512（对 cmd.exe 现算），并开 testMode：不碰注册表 / 不杀进程 / 不清真实 cookie
 *   - 两个场景：①装出期望版本 → 成功；②装出别的版本 → 必须失败且不重启
 *
 * 用法：node test/desktop-update-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATER = path.join(HERE, '..', 'lib', 'updater.mjs')
// 用 path.join 拼绝对路径：手写反斜杠经过 shell/heredoc 容易被吃掉（本次踩过）
const CMD = path.join('C:', 'Windows', 'System32', 'cmd.exe')
const CMD_FILE = CMD.split(path.sep).join('/')  // fs 读文件用正斜杠，避免转义

const ok = (m) => console.log('ok   ' + m)
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

/** 构造一个最小但格式正确的 app.asar（头部布局与 electron asar 一致，readAsarVersion 能解析）。 */
function makeAsarWithVersion(version, outPath) {
  const pkg = Buffer.from(JSON.stringify({ name: 'fake-dsh-app', version }), 'utf8')
  const raw = Buffer.from(JSON.stringify({ files: { 'package.json': { size: pkg.length, offset: '0' } } }), 'utf8')
  const pad = (4 - (raw.length % 4)) % 4
  const header = Buffer.concat([raw, Buffer.alloc(pad, 0x20)])   // 空格补齐，JSON 仍可解析
  const pre = Buffer.alloc(16)
  pre.writeUInt32LE(4, 0)
  pre.writeUInt32LE(8 + header.length, 4)   // headerSize：数据区 = 8 + headerSize
  pre.writeUInt32LE(raw.length, 8)
  pre.writeUInt32LE(raw.length, 12)
  fs.writeFileSync(outPath, Buffer.concat([pre, header, pkg]))
}

function sha512Base64(file) {
  return createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

function writeFile(p, text) { fs.writeFileSync(p, text, 'utf8') }

/** 跑一次完整 updater 流程，返回 { report, log, root }。 */
async function runScenario({ tag, installerMakesVersion, expectedVersion }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `me-desktop-${tag}-`))
  const logFile = path.join(root, 'update.log')
  const reportFile = path.join(root, 'last-update.json')

  // 目标安装目录：resources/app.asar 先放"旧版本"
  const installDir = path.join(root, 'install')
  const resDir = path.join(installDir, 'resources')
  fs.mkdirSync(resDir, { recursive: true })
  const asarPath = path.join(resDir, 'app.asar')
  makeAsarWithVersion('0.1.0', asarPath)

  // 假安装器的产物：另一个版本的 asar，由 .cmd 复制过去
  const newAsar = path.join(root, 'new-app.asar')
  makeAsarWithVersion(installerMakesVersion, newAsar)
  const fakeInstaller = path.join(root, 'installer.cmd')
  writeFile(fakeInstaller, '@echo off\r\ncopy /Y "' + newAsar + '" "' + asarPath + '" >nul\r\nexit /b 0\r\n')

  // 假宿主：1.2 秒后自己退出（模拟用户关掉 DSH）
  const host = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { stdio: 'ignore', windowsHide: true })

  const queue = {
    id: 'test-desktop-' + tag,
    createdAt: new Date().toISOString(),
    profileName: 'desktop',
    hostPid: host.pid,
    packages: [],
    testMode: true,                       // 统一闸：不碰注册表/进程/真实 cookie
    desktopUpdate: {
      exe: CMD,
      args: ['/c', fakeInstaller],
      version: expectedVersion,           // 期望版本：装出别的必须失败
      asarPath,
      installDir,
      sha512: sha512Base64(CMD_FILE),     // 校验的真实对象是被执行的安装器
      skipKillHost: true,
      skipRegistryFix: true,
    },
    restart: { exe: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    noProgressWindow: true,
    logFile,
    reportFile,
  }
  const queueFile = path.join(root, 'queue.json')
  writeFile(queueFile, JSON.stringify(queue, null, 2))

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [UPDATER, queueFile], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    const timer = setTimeout(() => { console.error('助手 90 秒没退出'); child.kill(); resolve(-1) }, 90000)
    child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? -1) })
  })
  if (code !== 0) fail(`[${tag}] 助手退出码 ${code}`)
  let report = null
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) } catch { }
  return { report, logFile, root }
}

// ---------- 场景 1：装出期望版本 → 成功 ----------
{
  const { report, logFile } = await runScenario({ tag: 'ok', installerMakesVersion: '0.2.0', expectedVersion: '0.2.0' })
  if (!report) fail('[ok] 没写出 last-update.json')
  else {
    if (report.desktopUpdate && report.desktopUpdate.ok) ok('安装器执行 + 校验通过')
    else fail('[ok] desktopUpdate.ok 不为 true：' + JSON.stringify(report.desktopUpdate))
    if (report.desktopUpdate && report.desktopUpdate.version === '0.2.0') ok('读到安装后的真实版本：0.2.0（旧→新已换）')
    else fail('[ok] 版本不符：' + JSON.stringify(report.desktopUpdate))
    if (report.restart && report.restart.ok) ok('重启命令已拉起（fake）')
    else fail('[ok] 重启没成功：' + JSON.stringify(report.restart))
  }
  console.log('   临时目录：' + logFile)
}

// ---------- 场景 2：装出别的版本 → 必须失败且不重启 ----------
{
  const { report, logFile } = await runScenario({ tag: 'version-mismatch', installerMakesVersion: '0.3.0', expectedVersion: '0.2.0' })
  if (!report) fail('[mismatch] 没写出 last-update.json')
  else {
    if (report.desktopUpdate && report.desktopUpdate.ok === false) ok('版本不符时判失败（没有报成功）')
    else fail('[mismatch] 竟然判成功了：' + JSON.stringify(report.desktopUpdate))
    if (String((report.desktopUpdate || {}).error || '').includes('版本不对')) ok('失败原因含「版本不对」')
    else fail('[mismatch] 失败原因不明确：' + JSON.stringify(report.desktopUpdate))
    if (!report.restart) ok('失败时不重启（没有把装了一半的 DSH 开起来）')
    else fail('[mismatch] 失败后仍然重启了：' + JSON.stringify(report.restart))
  }
  console.log('   临时目录：' + logFile)
}
