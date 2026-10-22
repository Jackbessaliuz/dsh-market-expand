/**
 * updater.mjs 冒烟测试（v1.2.5）
 *
 * 只测这次改动的行为，不碰真实 profile：
 *   1. 失败分类（超时 / 锁占用 / 普通）
 *   2. 失败文案保留真实错误
 *   3. profile 锁的读取与「持有者已退出」判定
 *   4. runFile 超时后杀整棵进程树（cmd → node 孙进程）—— 2026-10-21 群友事故的根因
 *
 * 跑法：node --test test/updater-smoke.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  runFile, classifyFailure, failureText, readProfileLockPid, waitProfileLockFree,
  windowHandleOf, CLI_TIMEOUT_MS, WINDOW_GRACE_MS,
} from '../lib/updater.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-smoke-'))

test('CLI 超时上限与官方 idleTimeoutMs 对齐（10 分钟）', () => {
  assert.equal(CLI_TIMEOUT_MS, 600000)
})

test('失败分类：超时 / 锁占用 / 普通失败', () => {
  assert.equal(classifyFailure({ timedOut: true, err: '' }), 'timeout')
  assert.equal(classifyFailure({
    err: 'Error: atomic-write: timed out waiting for the writer lock at C:\\Users\\x\\.dsh\\profiles\\desktop\\package.json.lock',
  }), 'lock')
  assert.equal(classifyFailure({ err: 'ERR_PNPM_FETCH_404  Not found' }), 'failed')
  assert.equal(classifyFailure(null), 'failed')
})

test('失败文案不再吞掉真实错误', () => {
  const lock = failureText('lock', { err: 'atomic-write: timed out waiting for the writer lock at ...' })
  assert.match(lock, /写锁/)
  assert.match(lock, /原始错误/)
  const timeout = failureText('timeout', { err: 'Command failed' })
  assert.match(timeout, /600 秒/)
  const channel = failureText('channel', null)
  assert.match(channel, /没有可用的更新通道/)
  const plain = failureText('failed', { err: 'ERR_PNPM 乱七八糟' })
  assert.equal(plain, 'ERR_PNPM 乱七八糟')
})

test('profile 锁：读 PID / 无锁返回 0', () => {
  assert.equal(readProfileLockPid(tmp), 0)
  const lock = path.join(tmp, 'package.json.lock')
  fs.writeFileSync(lock, String(process.pid))
  assert.equal(readProfileLockPid(tmp), process.pid)
  fs.writeFileSync(lock, '999999999')
  assert.equal(readProfileLockPid(tmp), 999999999)
  fs.rmSync(lock, { force: true })
})

test('profile 锁：持有者活着要等，持有者已退出直接放行', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'lock-'))
  const lock = path.join(dir, 'package.json.lock')

  fs.writeFileSync(lock, String(process.pid))
  const busy = await waitProfileLockFree(dir, { maxMs: 600 })
  assert.equal(busy.free, false)
  assert.equal(busy.holder, process.pid)

  fs.writeFileSync(lock, '999999999')
  const dead = await waitProfileLockFree(dir, { maxMs: 600 })
  assert.equal(dead.free, true, '持锁进程已退出 → 应判为空闲，让 atomic-write 自己接管')
})

test('runFile 正常命令不受影响', async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeout: 20000 })
  assert.equal(r.ok, true)
  assert.equal(r.timedOut, false)
  assert.equal(r.out.trim(), 'hi')
})

test('runFile 超时会杀掉整棵进程树（cmd → node 孙进程）', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tree-'))
  const marker = path.join(dir, 'grandchild.txt')
  const childScript = path.join(dir, 'grandchild.cjs')
  fs.writeFileSync(childScript, `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'alive')},3000)`)
  const bat = path.join(dir, 'run.bat')
  fs.writeFileSync(bat, `@echo off\r\nnode "${childScript}"\r\n`)

  const r = await runFile(bat, [], { timeout: 1200 })
  assert.equal(r.timedOut, true, '应当判为超时')
  assert.equal(r.ok, false)

  await new Promise((res) => setTimeout(res, 4500))
  assert.equal(fs.existsSync(marker), false, '孙进程应被 taskkill /T 杀掉，不能留下持锁的孤儿进程')
})

test('窗口检测：活着的无窗口进程 = 0，不存在的 pid = -1', async () => {
  assert.equal(WINDOW_GRACE_MS, 90000)
  const self = await windowHandleOf(process.pid)
  assert.equal(self, 0, 'node 测试进程没有主窗口，应返回 0')

  const gone = await windowHandleOf(999999)
  assert.equal(gone, -1, '不存在的 pid 应返回 -1')
})
