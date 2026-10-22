/**
 * 「把 DSH 窗口从任务栏恢复到前台」实例测试（v1.3.0）
 *
 * 2026-10-22 但丁反馈：自动拉起的 DSH 只留在任务栏，要点一下才出现。
 * 用记事本复现：启动 → 最小化 → activateWindow → 检查是否恢复。
 *
 * 跑法：node test/updater-activate-verify.mjs
 */
import { spawn, execFileSync } from 'node:child_process'

const { activateWindow } = await import('../lib/updater.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const decl = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'`
const run = (code) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true }).trim()

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}

const np = spawn('notepad.exe', [], { stdio: 'ignore' })
await sleep(2000)
const pid = np.pid
console.log(`notepad pid = ${pid}`)

try {
  // 1. 最小化
  run(`${decl}
$p = Get-Process -Id ${pid}
[void][W.U]::ShowWindow([IntPtr][long]$p.MainWindowHandle, 6)
Start-Sleep -Milliseconds 500
`)
  const before = run(`${decl}
$p = Get-Process -Id ${pid}
"iconic=" + [W.U]::IsIconic([IntPtr][long]$p.MainWindowHandle)
`)
  check('最小化后 IsIconic=true', before.includes('iconic=True'), before)

  // 2. activateWindow（返回 {found, foreground, ...}）
  const r = await activateWindow(pid)
  check('activateWindow 找到窗口', !!(r && r.found), JSON.stringify(r))
  check('activateWindow 报告已在前台', !!(r && r.foreground), JSON.stringify(r))

  await sleep(1200)
  const probe = () => run(`${decl}
$p = Get-Process -Id ${pid}
$h = [IntPtr][long]$p.MainWindowHandle
"iconic=" + [W.U]::IsIconic($h) + " fg=" + ([W.U]::GetForegroundWindow() -eq $h)
`)
  let after = probe()
  // 焦点切换偶尔慢一拍，再等一轮确认（避免偶发 FAIL）
  if (!after.includes('fg=True')) { await sleep(1200); after = probe() }
  check('恢复后 IsIconic=false', after.includes('iconic=False'), after)
  check('已置于前台', after.includes('fg=True'), after)
} finally {
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
