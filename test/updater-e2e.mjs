/**
 * updater.mjs 端到端演练（v1.2.5）
 *
 * 用假 CLI + 假 profile 把主循环真跑一遍，验证 2026-10-21 群友那个故障链
 * 已经被切断：第一个包装到一半超时 → 被杀掉 → 后面的包不能再被它的写锁拖死。
 *
 * 全程不碰真实 profile，也不装任何真包：
 *   - CLI 换成 root/fake.cmd（第一次装死 + 占锁，第二次直接成功）
 *   - HOME / APPDATA 指到临时目录，桌面报告写不出去
 *   - PATH 精简 + PNPM_PATH 置空，确保兜底通道不可用（复现群友的"没有 pnpm"）
 *
 * 跑法：node --test test/updater-e2e.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATER = path.join(HERE, '..', 'lib', 'updater.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('端到端：慢包超时被杀后，后面的包不再被写锁拖死', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-e2e-'))

  // 只拷 updater.mjs，不拷 progress-window.ps1 → 不会弹进度窗
  const runnerDir = path.join(root, 'runner')
  fs.mkdirSync(runnerDir)
  const runner = path.join(runnerDir, 'updater.mjs')
  fs.copyFileSync(UPDATER, runner)

  const profile = path.join(root, 'profile')
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'fake-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2))

  const okMarker = path.join(root, 'pkg-b-installed.txt')
  const ghostMarker = path.join(root, 'ghost.txt')
  const countFile = path.join(root, 'count.txt')

  // 假 CLI：第一次模拟慢安装（占住写锁、不退出），第二次直接成功
  const fakeCli = path.join(root, 'fake-cli.cjs')
  fs.writeFileSync(fakeCli, `
const fs = require('fs')
const path = require('path')
const root = ${JSON.stringify(root)}
const profile = ${JSON.stringify(profile)}
const countFile = ${JSON.stringify(countFile)}
let n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0
n += 1
fs.writeFileSync(countFile, String(n))
if (n === 1) {
  fs.writeFileSync(path.join(profile, 'package.json.lock'), String(process.pid))
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(ghostMarker)}, 'alive') }, 4000)
  setInterval(() => {}, 1000)
} else {
  fs.writeFileSync(${JSON.stringify(okMarker)}, 'ok')
  process.exit(0)
}
`)

  const cli = path.join(root, 'fake.cmd')
  fs.writeFileSync(cli, `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`)

  const queueFile = path.join(root, 'queue.json')
  const queue = {
    id: 'e2e',
    profileName: 'desktop',
    profileDir: profile,
    hostPid: 999999,
    packages: [
      { name: 'pkg-a', from: '1.0.0', target: '2.0.0', spec: 'pkg-a@2.0.0' },
      { name: 'pkg-b', from: '1.0.0', target: '2.0.0', spec: 'pkg-b@2.0.0' },
    ],
    // 只给 cli、不给 exe → 走 CLI 通道但不会真的重启宿主
    restart: { cli },
    logFile: path.join(root, 'update.log'),
    reportFile: path.join(root, 'last-update.json'),
  }
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), 'utf8')

  const env = {
    ...process.env,
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'appdata'),
    USERPROFILE: path.join(root, 'home'),
    PNPM_PATH: '',
    ME_CLI_TIMEOUT_MS: '1500',
    PATH: 'C:\\Windows\\System32;C:\\Windows',
  }
  const proc = spawnSync(process.execPath, [runner, queueFile], { env, timeout: 90000, encoding: 'utf8' })

  const log = fs.existsSync(queue.logFile) ? fs.readFileSync(queue.logFile, 'utf8') : '(无日志)'
  assert.ok(fs.existsSync(queue.reportFile), '应当写出 last-update.json\n' + log)
  const report = JSON.parse(fs.readFileSync(queue.reportFile, 'utf8'))
  const a = report.results.find((x) => x.name === 'pkg-a')
  const b = report.results.find((x) => x.name === 'pkg-b')

  assert.ok(a, 'pkg-a 应当有结果\n' + log)
  assert.equal(a.ok, false, 'pkg-a 应当超时失败\n' + log)
  assert.equal(a.reason, 'timeout')
  assert.match(String(a.err), /更新超时/)

  assert.ok(b, 'pkg-b 应当有结果\n' + log)
  assert.equal(b.ok, true, 'pkg-b 不能被 pkg-a 的残留锁拖死\n' + log)
  assert.equal(b.via, 'cli')
  assert.equal(fs.existsSync(okMarker), true, '第二次假 CLI 应当真的执行了')

  // 等过 ghost 的 4 秒窗口：如果进程树没杀干净，它会写出来
  await sleep(5000)
  assert.equal(fs.existsSync(ghostMarker), false, '超时的安装进程应当被 taskkill /T 杀掉')

  assert.equal(proc.status, 0, 'updater 应当正常退出\n' + log)
})
