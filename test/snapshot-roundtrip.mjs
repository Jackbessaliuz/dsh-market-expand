/**
 * 快照 / 回滚往返测试（2026-11-16）
 *
 * 为什么单独写：GPT 评审指出「快照实际不完整、回滚等于假保险」，而这两个函数没有
 * 任何测试覆盖。这里直接 import 插件实现，做真实的「备份 → 改坏 → 恢复」：
 *   ①无 git 插件：完整目录复制（package.json / lib / assets 都要在）→ 改坏 → 回滚恢复
 *   ②git 插件：dirty 工作区先提交、确认 commit 成功才打 tag → 回滚到 tag
 *
 * 会写入真实的 SNAP_ROOT（~/.dsh/market-expand/snapshots），但只用唯一测试名，
 * 跑完自删；不碰任何真实插件的快照。
 *
 * 用法：node test/snapshot-roundtrip.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { snapshotOne, rollbackOne, snapKeyOf, SNAP_ROOT } from '../lib/index.js'

const ok = (m) => console.log('ok   ' + m)
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg))

const uniq = Date.now().toString(36)

// ---------- ① 无 git：完整目录复制 + 恢复 ----------
{
  const name = '_e2e-snap-copy-' + uniq
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-snap-copy-'))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const v = 1\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'assets', 'logo.txt'), 'logo-v1', 'utf8')

  const snap = await snapshotOne(name, dir, false)
  assert(snap.ok, '[copy] 快照成功')
  assert(snap.kind === 'copy', '[copy] 走的是目录复制分支')
  for (const rel of ['package.json', 'lib/index.js', 'assets/logo.txt']) {
    assert(fs.existsSync(path.join(snap.dir, rel)), `[copy] 快照包含 ${rel}（旧实现会漏掉）`)
  }

  // 改坏：版本升了、lib 改了、assets 删了
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '2.0.0' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const v = 2\n', 'utf8')
  fs.rmSync(path.join(dir, 'assets', 'logo.txt'), { force: true })

  const rb = await rollbackOne(name, dir, false)
  assert(rb.ok, '[copy] 回滚成功')
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
  assert(v === '1.0.0', '[copy] package.json 已恢复到 1.0.0')
  const lib = fs.readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8')
  assert(lib.includes('v = 1'), '[copy] lib/index.js 已恢复')
  assert(fs.existsSync(path.join(dir, 'assets', 'logo.txt')), '[copy] assets/logo.txt 已恢复')

  fs.rmSync(path.join(SNAP_ROOT, snapKeyOf(name)), { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------- ② git：dirty 先提交、commit 成功才 tag ----------
{
  const name = '_e2e-snap-git-' + uniq
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-snap-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')

  // 制造 dirty 工作区（未提交的改动）
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.5.0' }), 'utf8')

  const snap = await snapshotOne(name, dir, true)
  assert(snap.ok, '[git] 快照成功')
  assert(snap.kind === 'git' && !!snap.tag, '[git] 打了 tag：' + (snap.tag || '（无）'))
  assert(!!snap.commit, '[git] 记录了 commit：' + (snap.commit || '（无）'))
  const tagVer = JSON.parse(git('show', snap.tag + ':package.json')).version
  assert(tagVer === '1.5.0', '[git] dirty 改动已进快照（tag 里是 1.5.0）')
  const status = git('status', '--porcelain').trim()
  assert(status === '', '[git] 提交后工作区干净')

  // 再改坏，然后用 reset --hard 回到快照
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }), 'utf8')
  git('reset', '--hard', snap.tag)
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
  assert(back === '1.5.0', '[git] reset --hard 回到快照版本 1.5.0')

// ---------- ③ 半成品快照不能被回滚选中（2026-11-16 GPT 评审补充） ----------
{
  const name = '_e2e-snap-partial-' + uniq
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-snap-partial-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
  const key = snapKeyOf(name)
  const root = path.join(SNAP_ROOT, key)
  const tsOk = '2026-01-01T00-00-01'
  const tsBad = '2026-01-01T00-00-02'
  fs.mkdirSync(path.join(root, tsOk), { recursive: true })
  fs.writeFileSync(path.join(root, tsOk, 'package.json'), JSON.stringify({ name, version: '0.9.0' }), 'utf8')
  fs.writeFileSync(path.join(root, tsOk, '.me-complete'), '{}', 'utf8')
  fs.mkdirSync(path.join(root, tsBad + '.partial'), { recursive: true })
  fs.writeFileSync(path.join(root, tsBad + '.partial', 'package.json'), JSON.stringify({ name, version: '9.9.9' }), 'utf8')
  const rb = await rollbackOne(name, dir, false)
  assert(rb.ok, '[partial] 回滚成功')
  assert(rb.restored === tsOk, '[partial] 选中的是完整快照，不是更新的半成品')
  const ver = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
  assert(ver === '0.9.0', '[partial] 恢复的是完整快照的内容（0.9.0，不是 9.9.9）')
  // 只剩半成品时应报无可用快照
  fs.rmSync(path.join(root, tsOk), { recursive: true, force: true })
  const rb2 = await rollbackOne(name, dir, false)
  assert(rb2.ok === false, '[partial] 只剩半成品时报「无可用快照」')
  // 旧格式（有 package.json 但没有完成标记）不再自动进入恢复
  fs.mkdirSync(path.join(root, '2026-01-01T00-00-03'), { recursive: true })
  fs.writeFileSync(path.join(root, '2026-01-01T00-00-03', 'package.json'), JSON.stringify({ name, version: '8.8.8' }), 'utf8')
  const rb3 = await rollbackOne(name, dir, false)
  assert(rb3.ok === false && String(rb3.error).includes('旧格式'), '[legacy] 只有 package.json 的旧快照不会被自动恢复')
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
}

  fs.rmSync(dir, { recursive: true, force: true })
}
