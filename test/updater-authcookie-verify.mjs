/**
 * 认证 cookie 清理 + 宿主报错读取 实例测试（v1.3.0）
 *
 * 背景：2026-10-22 桌面版因为 71 条 dsh-auth-* cookie 撑爆 16KB 请求头，
 * Electron welcome 认证失败、窗口不出现（详见事故复盘）。
 *
 * 用真实 SQLite 库验证：
 *   A. pruneAuthCookies 只删 dsh-auth-*，其他 cookie 保留，并留备份
 *   B. 重复调用幂等（第二次删 0 条）
 *   C. hostOutputSince 只取最后一次 `=== host start` 之后的输出
 *
 * 跑法（Node 24 才有 node:sqlite，用 Electron-as-node）：
 *   ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" test/updater-authcookie-verify.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { pruneAuthCookies, hostOutputSince } = await import('../lib/updater.mjs')

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}

// ---------- A/B：cookie 清理 ----------
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cookie-'))
const userData = path.join(dshHome, 'user-data')
const netDir = path.join(userData, 'Network')
fs.mkdirSync(netDir, { recursive: true })
const dbPath = path.join(netDir, 'Cookies')

{
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER)`)
  const ins = db.prepare('INSERT INTO cookies (host_key, name, value, path, expires_utc) VALUES (?,?,?,?,?)')
  for (let i = 0; i < 3; i++) ins.run('127.0.0.1', `dsh-auth-${i}`, 'v'.repeat(200), '/', 0)
  ins.run('127.0.0.1', 'other-cookie', 'keep-me', '/', 0)
  ins.run('example.com', 'dsh-auth-fake', 'not-local', '/', 0)
  db.close()
}

const logFile = path.join(dshHome, 'update.log')
const r1 = await pruneAuthCookies(userData, logFile)
check('删除 3 条 dsh-auth-*', r1.deleted === 3, JSON.stringify(r1))
check('生成了备份文件', !!r1.backup && fs.existsSync(r1.backup), r1.backup || '')

{
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT host_key, name FROM cookies ORDER BY name').all()
  db.close()
  const names = rows.map((x) => `${x.host_key}/${x.name}`)
  check('本地其他 cookie 保留', names.includes('127.0.0.1/other-cookie'), names.join(','))
  check('非本地宿主同名 cookie 保留', names.includes('example.com/dsh-auth-fake'), names.join(','))
  check('本地 dsh-auth-* 全部清掉', !names.some((n) => n.startsWith('127.0.0.1/dsh-auth-')), names.join(','))
}

const r2 = await pruneAuthCookies(userData, logFile)
check('重复清理幂等（第二次删 0 条）', r2.deleted === 0, JSON.stringify(r2))

// ---------- C：hostOutputSince ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-hostout-'))
const log = path.join(dir, 'update.log')
const hostLog = path.join(dir, 'host-stdout.log')
fs.writeFileSync(hostLog, [
  '=== host start 2026-10-22T00:00:00Z ===',
  'old output A',
  '=== host start 2026-10-22T00:09:41Z ===',
  'desktop welcome: Web authentication failed',
].join('\n') + '\n')
const out = hostOutputSince(log)
check('只取最后一次 host start 之后', out.includes('Web authentication failed') && !out.includes('old output A'), out.slice(0, 80))
check('能匹配认证失败', /desktop welcome: Web authentication failed/i.test(out))

const empty = hostOutputSince(path.join(dir, 'no-such-dir', 'x.log'))
check('文件不存在返回空串', empty === '', JSON.stringify(empty))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
