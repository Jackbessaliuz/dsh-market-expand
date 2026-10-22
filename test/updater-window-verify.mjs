/**
 * 窗口检测实例测试（v1.3.0）
 *
 * 用真实进程验证 waitForHealthyBoot 的三条路径，不需要重启 DSH：
 *   A. 真进程、无窗口 → 等满宽限期后判 alive-but-no-window
 *   B. 真窗口进程（记事本）→ 判定通过
 *   C. 进程已退出且没有同 exe 实例 → no-live-host
 *
 * 宽限期用 ME_WINDOW_GRACE_MS 缩到 6 秒，正式运行时是 90 秒。
 * 跑法：node test/updater-window-verify.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

process.env.ME_WINDOW_GRACE_MS = '6000'
const { waitForHealthyBoot, windowHandleOf, WINDOW_GRACE_MS } = await import('../lib/updater.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-win-'))
const logsDir = path.join(tmp, 'logs')
fs.mkdirSync(logsDir)
const logFile = path.join(tmp, 'update.log')

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}

console.log(`宽限期 = ${WINDOW_GRACE_MS} ms（正式 90000）`)

// ---------- A. 真进程、无窗口 ----------
{
  console.log('\n[A] 无窗口进程')
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const h = await windowHandleOf(child.pid)
  check('windowHandleOf 对无窗口进程返回 0', h === 0, `got ${h}`)

  const t0 = Date.now()
  const r = await waitForHealthyBoot({ hostPid: child.pid, logsDir, since: Date.now(), timeoutMs: 3000, logFile })
  const used = Date.now() - t0
  check('判为 alive-but-no-window', r.ok === false && r.noWindow === true && r.reason === 'alive-but-no-window', JSON.stringify(r))
  check('等待时长 ≥ 宽限期', used >= WINDOW_GRACE_MS, `${Math.round(used / 1000)}s`)
  child.kill()
}

// ---------- B. 真窗口进程 ----------
{
  console.log('\n[B] 有窗口的进程（记事本）')
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2000)
  const h = await windowHandleOf(np.pid)
  check('windowHandleOf 对记事本返回窗口句柄', h > 0, `got ${h}`)

  const r = await waitForHealthyBoot({ hostPid: np.pid, logsDir, since: Date.now(), timeoutMs: 6000, logFile })
  check('有窗口判为通过', r.ok === true, JSON.stringify(r))
  spawnSync('taskkill', ['/PID', String(np.pid), '/T', '/F'], { windowsHide: true })
}

// ---------- C. 进程退出 ----------
{
  console.log('\n[C] 进程启动后立刻退出')
  const quick = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  await sleep(800)
  const r = await waitForHealthyBoot({
    hostPid: quick.pid, logsDir, since: Date.now(), timeoutMs: 6000, logFile,
    exe: path.join(tmp, 'no-such-exe.exe'),   // 保证查不到「同 exe 存活进程」
  })
  check('判为 no-live-host', r.ok === false && r.reason === 'no-live-host', JSON.stringify(r))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
