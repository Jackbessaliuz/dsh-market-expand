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
  parseAllowBuildsKey, ensureAllowBuild,
  githubSpecToTarball, restoreDependencySpec,
  selectRetryTargets,
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
  assert.equal(classifyFailure({ err: 'ERR_PNPM_FETCH_404  Not found' }), 'unavailable')
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

test('v1.3.1：allowBuilds 与网络失败单独分类，不再混成「没有可用的更新通道」', () => {
  const gitPrepare = {
    err: 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED: Failed to prepare git-hosted package fetched from "https://codeload.github.com/o/r/tar.gz/abc": The git-hosted package "pkg@1.2.3" needs to execute build scripts but is not in the "allowBuilds"',
  }
  assert.equal(classifyFailure(gitPrepare), 'allow-builds')
  assert.match(failureText('allow-builds', gitPrepare), /allowBuilds/)
  assert.equal(classifyFailure({ err: 'Command failed with exit code 128: git -c core.longpaths=true fetch --depth 1 origin abc' }), 'network')
  assert.match(failureText('network', { err: 'exit code 128' }), /GitHub/)
  // 普通 npm 源失败仍归 failed（404 从 v1.4.0 起单列 unavailable）
  assert.equal(classifyFailure({ err: 'ERR_PNPM_META_FETCH_FAIL 网络抖动' }), 'failed')
})

test('v1.3.1：从报错里解析出精确放行 key；解析不出返回 null', () => {
  const key = parseAllowBuildsKey('Failed to prepare git-hosted package fetched from "https://codeload.github.com/Phant0Meow/dsh-meow-memory/tar.gz/d531575e": The git-hosted package "meow-memory@0.31.1" needs to execute build scripts but is not in the "allowBuilds"')
  assert.equal(key, 'meow-memory@https://codeload.github.com/Phant0Meow/dsh-meow-memory/tar.gz/d531575e')
  assert.equal(parseAllowBuildsKey('some unrelated error'), null)
  assert.equal(parseAllowBuildsKey('allowBuilds mentioned but no url/pkg'), null)
})

test('v1.3.1：放行写入只追加、保留旧键、重复不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-allow-'))
  const file = path.join(dir, 'pnpm-workspace.yaml')
  fs.writeFileSync(file, 'packages:\n  - .\n\nallowBuilds:\n  "old-pkg@https://codeload.github.com/a/b/tar.gz/111": true\n')
  const r1 = ensureAllowBuild(dir, 'new-pkg@https://codeload.github.com/a/b/tar.gz/222')
  assert.equal(r1.added, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /old-pkg@/, '旧键必须保留，回滚才装得上')
  assert.match(text, /new-pkg@/)
  const r2 = ensureAllowBuild(dir, 'new-pkg@https://codeload.github.com/a/b/tar.gz/222')
  assert.equal(r2.added, false, '重复放行不应再写')
  assert.equal(fs.readFileSync(file, 'utf8'), text)
})

test('v1.3.1：没有 pnpm-workspace.yaml 时能新建 allowBuilds 段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-allow2-'))
  const r = ensureAllowBuild(dir, 'pkg@https://codeload.github.com/a/b/tar.gz/333')
  assert.equal(r.added, true)
  const text = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(text, /^allowBuilds:/m)
  assert.match(text, /pkg@https:\/\/codeload\.github\.com/)
})

test('v1.3.1：github spec 能解析成 codeload 快照地址，解析不出返回 null', () => {
  assert.deepEqual(githubSpecToTarball('github:Phant0Meow/dsh-meow-memory#d531575e'), {
    owner: 'Phant0Meow', repo: 'dsh-meow-memory', ref: 'd531575e',
    url: 'https://codeload.github.com/Phant0Meow/dsh-meow-memory/tar.gz/d531575e',
  })
  assert.equal(githubSpecToTarball('git+https://github.com/o/r.git#v1.2.3').url, 'https://codeload.github.com/o/r/tar.gz/v1.2.3')
  // 无 ref / #path: / #semver: 都不兜底，避免猜错版本
  assert.equal(githubSpecToTarball('github:o/r'), null)
  assert.equal(githubSpecToTarball('github:o/r#path:/sub'), null)
  assert.equal(githubSpecToTarball('github:o/r#semver:^1.0.0'), null)
  assert.equal(githubSpecToTarball('pkg@1.2.3'), null)
})

test('v1.3.1：codeload 装完把依赖声明还原成 github spec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-codeload-'))
  const file = path.join(dir, 'package.json')
  fs.writeFileSync(file, JSON.stringify({
    name: 'probe',
    dependencies: { 'some-pkg': 'https://codeload.github.com/o/r/tar.gz/abc', other: '1.0.0' },
  }, null, 2))
  const r = restoreDependencySpec(dir, 'some-pkg', 'github:o/r#abc')
  assert.equal(r.restored, true)
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(pkg.dependencies['some-pkg'], 'github:o/r#abc')
  assert.equal(pkg.dependencies.other, '1.0.0', '其他依赖不能被碰')
  // 已经是目标 spec 时不重复写
  assert.equal(restoreDependencySpec(dir, 'some-pkg', 'github:o/r#abc').restored, false)
})

test('v1.4.0：第二轮只重试可适配的失败（版本不存在不浪费一次）', () => {
  const pkgs = [{ name: 'ok' }, { name: 'net' }, { name: 'gone' }, { name: 'allow' }, { name: 'boom' }]
  const results = [
    { name: 'ok', ok: true, reason: null },
    { name: 'net', ok: false, reason: 'network' },
    { name: 'gone', ok: false, reason: 'unavailable' },
    { name: 'allow', ok: false, reason: 'allow-builds' },
    { name: 'boom', ok: false, reason: 'failed' },
  ]
  assert.deepEqual(selectRetryTargets(pkgs, results).map((p) => p.name), ['net', 'allow', 'boom'])
  // 没有结果 / 空队列都不炸
  assert.equal(selectRetryTargets(undefined, undefined).length, 0)
  assert.equal(selectRetryTargets([], []).length, 0)
})

test('v1.4.0：版本不存在有独立文案，不再混进「未知错误」', () => {
  assert.equal(classifyFailure({ err: 'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for x@9.9.9' }), 'unavailable')
  assert.match(failureText('unavailable', { err: '404' }), /不存在|换源/)
})
