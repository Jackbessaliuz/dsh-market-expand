/**
 * CLI 失败分类单测（2026-11-16 第 2 项）
 * GPT 评审：CLI 拒绝安装不一定是通道坏了——兼容/安全策略拒绝不能降级 pnpm 绕过。
 */
import { cliFailureMayFallback } from '../lib/updater.mjs'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('ok   ' + m) }
const bad = (m) => { fail++; console.error('FAIL: ' + m); process.exitCode = 1 }
const eq = (got, want, m) => (got === want ? ok(m) : bad(`${m}（期望 ${want}，实际 ${got}）`))
const r = (text) => ({ ok: false, code: 1, out: '', err: text })

eq(cliFailureMayFallback(r('profile is managed exclusively by the Electron application'), 'failed'), true, 'Electron 独占 → 可以降级')
eq(cliFailureMayFallback(r('package already installed in this profile'), 'failed'), true, '已安装被拒 → 可以降级')
eq(cliFailureMayFallback({ ok: false, code: -1, out: '', err: 'spawn dsh ENOENT', spawnFailed: true, spawnErrno: 'ENOENT' }, 'failed'), true, 'spawnFailed + ENOENT → 可以降级')
eq(cliFailureMayFallback(r('ENOENT: dsh not found'), 'failed'), false, '仅文本里出现 dsh 不再当作 CLI 缺失')
eq(cliFailureMayFallback(r('ERR_PNPM_UNSUPPORTED_ENGINE: requires node >=24'), 'failed'), false, '引擎不兼容 → 不降级')
eq(cliFailureMayFallback(r('peer dependency mismatch: react@19 required'), 'failed'), false, 'peer 不匹配 → 不降级')
eq(cliFailureMayFallback(r('operation not permitted by security policy'), 'failed'), false, '安全策略拒绝 → 不降级')
eq(cliFailureMayFallback(r('EACCES: permission denied'), 'failed'), false, '权限拒绝 → 不降级')
eq(cliFailureMayFallback(r('ERR_PNPM_FETCH_404 no matching version'), 'unavailable'), false, '版本不存在 → 不降级')
eq(cliFailureMayFallback(r('anything'), 'timeout'), true, '超时 → 可以降级')
eq(cliFailureMayFallback(r('anything'), 'lock'), true, '写锁 → 可以降级')
eq(cliFailureMayFallback({ ok: false, code: 1, out: '', err: '' }, 'failed'), false, '无输出 → 无法分类，停止（不默认放行）')
eq(cliFailureMayFallback(null, 'failed'), false, 'null → 状态未知，不降级')
// 2026-11-16 GPT 评审：混合错误（先给放行词、后给拒绝原因）必须按拒绝处理
eq(cliFailureMayFallback(r('Electron: unsupported engine, requires Node >=24'), 'failed'), false, '混合：Electron + 引擎不兼容 → 不降级')
eq(cliFailureMayFallback(r('required peer dependency not found'), 'failed'), false, '混合：not found + peer 依赖 → 不降级')
eq(cliFailureMayFallback(r('Electron profile: permission denied'), 'failed'), false, '混合：Electron + 权限拒绝 → 不降级')
eq(cliFailureMayFallback(r('unrecognized failure: something odd'), 'failed'), false, '未知错误 → 停止（不默认放行）')
eq(cliFailureMayFallback(r('profile is managed exclusively by the Electron application'), 'failed'), true, '精确的所有权拒绝 → 可以降级')

// 2026-11-16 GPT 第三轮：被 classifyFailure 归类错、但内容明确是拒绝的样本
eq(cliFailureMayFallback(r('EPERM: operation not permitted, open package.json'), 'lock'), false, 'EPERM 被归成 lock → 仍不降级')
eq(cliFailureMayFallback({ ok: false, code: null, timedOut: true, out: '', err: 'operation not permitted by security policy' }, 'timeout'), false, '超时 + 权限拒绝 → 不降级')
eq(cliFailureMayFallback(r('ENOENT: no such file or directory, open plugin-config.json'), 'failed'), false, 'ENOENT 缺的是配置文件 → 不降级')
// 2026-11-16 GPT 第四轮：路径里含 .dsh 的 ENOENT 不能当成 CLI 缺失
eq(cliFailureMayFallback(r("ENOENT: no such file or directory, open 'C:/Users/me/.dsh/profiles/desktop/package.json'"), 'failed'), false, '缺的是 profile 配置文件 → 不降级')
// 2026-11-16 GPT 第五轮：启动失败要细分，不是所有 spawn 失败都能换通道
eq(cliFailureMayFallback({ ok: false, code: -1, out: '', err: 'spawn dsh EINVAL', spawnFailed: true, spawnErrno: 'EINVAL' }, 'failed'), false, 'spawnFailed + EINVAL → 停止')
eq(cliFailureMayFallback({ ok: false, code: -1, out: '', err: 'spawn EACCES', spawnFailed: true, spawnErrno: 'EACCES' }, 'failed'), false, 'spawnFailed + EACCES → 停止')
eq(cliFailureMayFallback({ ok: false, code: 1, out: "'dsh' 不是内部或外部命令，也不是可运行的程序", err: '', cliMissing: true }, 'failed'), true, '包装层确认命令不存在 → 可以降级')
console.log(`\n${pass} 通过 / ${fail} 失败`)
