/**
 * 取消协议测试（2026-11-16 第三轮 GPT 评审的反例）
 *
 * 场景 A：助手已经把队列读进内存、还没接管锁，用户此时取消（写取消标记）。
 *         ——旧实现会"删队列+删锁"然后助手照跑。现在助手必须读到标记并停下。
 * 场景 B：锁上写着**另一个任务**的 queueId。
 *         ——旧实现只比 pid，会把别人的锁覆盖成自己的。现在必须让位退出。
 *
 * 用法：node test/cancel-protocol.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATER = path.join(HERE, '..', 'lib', 'updater.mjs')

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log('ok   ' + m) }
const bad = (m) => { fail++; console.error('FAIL: ' + m); process.exitCode = 1 }
const assert = (cond, m) => (cond ? ok(m) : bad(m))

/** 起一个 1.2 秒后自己退出的假宿主。 */
function fakeHost() {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { stdio: 'ignore', windowsHide: true })
}

function runUpdater(queueFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPDATER, queueFile], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    const timer = setTimeout(() => { child.kill(); resolve(-1) }, 90000)
    child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? -1) })
  })
}

function makeQueue(root, { id, hostPid }) {
  const logFile = path.join(root, 'update.log')
  const reportFile = path.join(root, 'last-update.json')
  const queue = {
    id,
    createdAt: new Date().toISOString(),
    profileName: 'desktop',
    hostPid,
    packages: [],
    testMode: true,
    restart: { exe: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    noProgressWindow: true,
    logFile,
    reportFile,
  }
  const queueFile = path.join(root, 'update-queue.json')
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), 'utf8')
  return { queue, queueFile, logFile, reportFile }
}

// ---------- 场景 A：取消标记已存在 → 助手停止，不执行安装/重启 ----------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cancel-'))
  const host = fakeHost()
  const { queueFile, logFile } = makeQueue(root, { id: 'test-cancel-A', hostPid: host.pid })
  // 宿主排队期间写的锁（pid=宿主）
  fs.writeFileSync(queueFile + '.lock', JSON.stringify({ pid: host.pid, queueId: 'test-cancel-A', at: Date.now() }), 'utf8')
  // 用户在助手接管前点了取消
  fs.mkdirSync(path.join(root, 'cancelled'), { recursive: true })
  fs.writeFileSync(path.join(root, 'cancelled', 'test-cancel-A.json'), JSON.stringify({ at: Date.now() }), 'utf8')

  const code = await runUpdater(queueFile)
  assert(code === 0, '[A] 助手正常退出')
  const log = fs.readFileSync(logFile, 'utf8')
  assert(log.includes('检测到取消标记'), '[A] 日志记录检测到取消标记')
  assert(!/更新通道：|正在安装|插件更新完成/.test(log), '[A] 没有进入安装流程')
  let report = null
  try { report = JSON.parse(fs.readFileSync(path.join(root, 'last-update.json'), 'utf8')) } catch { }
  assert(report && report.cancelled === true, '[A] 报告标记 cancelled=true')
  assert(!report || !report.restart, '[A] 没有重启宿主')
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用，忽略 */ }
}

// ---------- 场景 B：锁属于另一个任务 → 助手让位退出 ----------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-lock-owner-'))
  const host = fakeHost()
  const { queueFile, logFile } = makeQueue(root, { id: 'test-lock-B', hostPid: host.pid })
  fs.writeFileSync(queueFile + '.lock', JSON.stringify({ pid: host.pid, queueId: 'someone-else', at: Date.now() }), 'utf8')

  const code = await runUpdater(queueFile)
  assert(code === 0, '[B] 助手退出')
  const log = fs.readFileSync(logFile, 'utf8')
  assert(log.includes('锁属于另一个任务'), '[B] 日志说明锁属于别的任务')
  // 不能把别人的锁改成自己的
  const lock = JSON.parse(fs.readFileSync(queueFile + '.lock', 'utf8'))
  assert(lock.queueId === 'someone-else', '[B] 没有覆盖别人的锁')
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用，忽略 */ }
}


// ---------- 场景 C/D/E：锁回收、活锁拒绝、取消收尾归属（2026-11-16 GPT 第四/五轮） ----------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-lock-recover-'))
  process.env.DSH_HOME = root
  const { acquireQueueLock, releaseQueueLock, finalizeCancel } = await import('../lib/index.js')
  const store = path.join(root, 'market-expand')
  fs.mkdirSync(store, { recursive: true })
  const queueFile = path.join(store, 'update-queue.json')
  const lockFile = queueFile + '.lock'

  // C：旧助手已被杀（pid 不存在），残留锁应被新任务回收
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, queueId: 'old-task' }), 'utf8')
  const gotC = acquireQueueLock('new-task')
  assert(gotC.ok === true, '[C] 残留旧锁被新任务回收（取消后不再死锁）')
  releaseQueueLock('new-task')

  // D：持锁的另一个任务还活着 → 拒绝
  const liveHost = spawn(process.execPath, ['-e', 'setTimeout(()=>{},6000)'], { stdio: 'ignore', windowsHide: true })
  fs.writeFileSync(lockFile, JSON.stringify({ pid: liveHost.pid, queueId: 'alive-task' }), 'utf8')
  const gotD = acquireQueueLock('other-task')
  assert(gotD.ok === false && gotD.running === liveHost.pid, '[D] 活着的其他任务持锁 → 拒绝')
  try { liveHost.kill() } catch { }

  // E：取消收尾必须核对归属——等待期间已换上新任务 B，不能删 B 的队列/锁
  fs.writeFileSync(queueFile, JSON.stringify({ id: 'task-B' }), 'utf8')
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, queueId: 'task-B' }), 'utf8')
  const finE = finalizeCancel('task-A', true)
  assert(finE.superseded === true && finE.state === 'superseded', '[E] 检测到队列已换成新任务')
  assert(fs.existsSync(queueFile) && fs.existsSync(lockFile), '[E] 新任务的队列与锁都保留')

  try { fs.rmSync(root, { recursive: true, force: true }) } catch { }
}

console.log(`
${pass} 通过 / ${fail} 失败`)
