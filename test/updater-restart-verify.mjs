/**
 * 「无窗口 → 杀进程 → 自动重开一次」分支实例测试（v1.3.0）
 *
 * 用一个无窗口的 restart.exe（cmd /c ping，挂 30 秒）模拟「进程活着但窗口不出来」，
 * 走真实的 startAndVerify：第一次 6 秒宽限期 → 判定 noWindow → taskkill → 重开
 * → 第二次再判 noWindow → 返回失败并带 afterRetry。
 *
 * 不碰真实 DSH、不碰真实 profile。
 * 跑法：node test/updater-restart-verify.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-restart-'))
process.env.ME_WINDOW_GRACE_MS = '6000'
// 别碰真实的桌面 userData cookie 库（restartHostSafe 会做清理）
process.env.APPDATA = path.join(tmp, 'fake-appdata')
const { startAndVerify } = await import('../lib/updater.mjs')
const logsDir = path.join(tmp, 'logs')
fs.mkdirSync(logsDir)
const logFile = path.join(tmp, 'update.log')
const reportFile = path.join(tmp, 'last-update.json')

// 无窗口、能活 30 秒的“假宿主”
const queue = {
  id: 'restart-verify',
  profileName: 'desktop',
  profileDir: tmp,
  hostPid: 999999,
  packages: [{ name: 'pkg-x', from: '1.0.0', target: '2.0.0', spec: 'pkg-x@2.0.0' }],
  restart: { exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'ping', '-n', '30', '127.0.0.1'], cwd: tmp },
  logsDir,
  logFile,
  reportFile,
}
const report = { results: [], pnpm: null, restart: null, error: null }

const t0 = Date.now()
const health = await startAndVerify({
  queue, report, reportFile, logFile,
  cli: null, profileName: 'desktop', getPnpm: async () => null,
  writeProgress: () => {}, progressPid: null,
})
const used = Date.now() - t0

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}

console.log(`耗时 ${Math.round(used / 1000)}s`)
check('第一次判 alive-but-no-window', health.ok === false && health.noWindow === true, JSON.stringify(health))
check('确实重开了一次', Array.isArray(report.restartAttempts) && report.restartAttempts.length >= 2, JSON.stringify((report.restartAttempts || []).map((x) => x.attempt)))
check('第二次结果留在 afterRetry', !!health.afterRetry, JSON.stringify(health.afterRetry || null))
check('两次都没窗口才算失败', health.afterRetry && health.afterRetry.ok === false)

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
check('日志里有「结束卡住的进程」', /结束这个卡住的进程|结束无窗口的宿主进程/.test(log), '')
check('日志里有等待计时行', /等待 DSH 窗口出现/.test(log), '')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
