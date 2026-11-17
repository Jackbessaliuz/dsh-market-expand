/**
 * 「成功口径」单元测试（2026-11-16 第三组）
 *
 * 覆盖 GPT 评审里第三组的四件事：
 *   ①预发布版本必须能被正确比较（旧 semverGt 用 split('-')[0] 把后缀吃掉）
 *   ②宿主 stdout 的「web boot: N entry did not activate」必须能解析出未激活插件
 *   ③五层状态：安装 / 组合 / 启动 / 激活 / 功能（不能把"没验"说成"通过"）
 *   ④激活失败要映射到 boot=false + activate=false
 *
 * 用法：node test/selfcheck-stages.mjs
 */
import { semverGt, cmpVer } from '../lib/index.js'
import { parseActivationFailure, summarizeStages } from '../lib/updater.mjs'

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log('ok   ' + m) }
const bad = (m) => { fail++; console.error('FAIL: ' + m); process.exitCode = 1 }
const eq = (a, b, m) => (a === b ? ok(m) : bad(`${m}（期望 ${b}，实际 ${a}）`))

// ---------- ① 预发布版本比较 ----------
eq(semverGt('1.5.0-beta.1', '1.5.0'), -1, '预发布 < 同号正式版')
eq(semverGt('1.5.0', '1.5.0-beta.1'), 1, '正式版 > 同号预发布')
eq(semverGt('1.5.0-beta.1', '1.4.2'), 1, '更高版的预发布 > 旧正式版')
eq(semverGt('1.5.0-rc.1', '1.5.0-beta.2'), 1, 'rc > beta')
eq(semverGt('1.5.0-alpha.1', '1.5.0-beta.1'), -1, 'alpha < beta')
eq(cmpVer('1.5.0', '1.5.0'), 0, '同版本相等')
eq(semverGt('v1.4.2', '1.4.1'), 1, '带 v 前缀也能比')

// ---------- ② 激活失败解析 ----------
const sample = [
  '=== host start 2026-11-16T00:00:00.000Z ===',
  '[dsh-memory-semantic] tools registered',
  'Error: web boot: 2 entries did not activate',
  'dsh-memo: import failed: SyntaxError: Unexpected token <',
  '    at file:///G:/x/lib/main.js:12437:15',
  'dsh-shot-render: failed to activate: service missing',
  '    at file:///G:/y/lib/client.js:1:1',
].join('\n')
const act = parseActivationFailure(sample)
if (!act) bad('没有解析出激活失败')
else {
  eq(act.count, 2, '解析出 N=2')
  eq(act.names.length, 2, '解析出 2 个插件名')
  if (act.names.includes('dsh-memo')) ok('包含 dsh-memo')
  else bad('缺少 dsh-memo：' + JSON.stringify(act.names))
  if (act.names.includes('dsh-shot-render')) ok('包含 dsh-shot-render')
  else bad('缺少 dsh-shot-render：' + JSON.stringify(act.names))
}
eq(parseActivationFailure('[正常启动] 没有报错'), null, '没有失败日志时返回 null（不误报）')

// ---------- ③④ 五层状态 ----------
const stOk = summarizeStages({
  results: [{ ok: true }, { ok: true }],
  risks: [],
  health: { ok: true, windowSeen: true, activate: 'no-failure-log' },
})
eq(stOk.install.ok, true, '安装层：2/2 通过')
eq(stOk.install.text, '安装 2/2', '安装层文案')
eq(stOk.compose.ok, true, '组合层：无风险')
eq(stOk.boot.ok, true, '启动层：通过')
eq(stOk.activate.ok, null, '激活层：无失败日志 ≠ 验证通过（保持 null）')
eq(stOk.functional.ok, null, '功能层：未验证（null）')

const stAct = summarizeStages({
  results: [{ ok: true }],
  risks: [],
  health: { ok: false, reason: 'activation-failed', activationFailed: ['dsh-bad'] },
})
eq(stAct.boot.ok, false, '激活失败 → 启动层判失败')
eq(stAct.activate.ok, false, '激活层判失败')
if (stAct.activate.text.includes('dsh-bad')) ok('激活层点名插件')
else bad('激活层没点名：' + stAct.activate.text)

const stUnknown = summarizeStages({
  results: [{ ok: true }],
  risks: [{ note: '会改 preset inject' }],
  health: { ok: null, reason: 'taken-over', unknown: true },
})
eq(stUnknown.boot.ok, null, '同名进程接管 → 启动层未知（不折叠成通过）')
eq(stUnknown.compose.ok, false, '有组合风险 → 组合层不通过')


// ---------- ⑤ 恢复层与「检查没执行」（2026-11-16 GPT 评审补充） ----------
{
  const empty = summarizeStages({})
  eq(empty.compose.ok, null, '没有 risks 记录 → 组合检查未执行（不是「无风险」）')
  const recOk = summarizeStages({
    results: [{ ok: true }],
    risks: [],
    health: { ok: false, rollback: [{ ok: true }, { ok: true }], afterRollback: { ok: true } },
  })
  eq(recOk.recovery.ok, true, '回退全部成功且恢复启动 → 恢复层通过')
  eq(recOk.boot.ok, false, '升级的启动结果仍是失败（与恢复结果分开记）')
  const recBad = summarizeStages({
    results: [{ ok: true }],
    risks: [],
    health: { ok: false, rollback: [{ ok: true }, { ok: false }], afterRollback: { ok: true } },
  })
  eq(recBad.recovery.ok, false, '回退有失败项 → 恢复层不通过')
  const recUnknown = summarizeStages({
    results: [{ ok: true }],
    risks: [],
    health: { ok: false, rollback: [{ ok: true }] },
  })
  eq(recUnknown.recovery.ok, null, '回退成功但没有恢复后检查 → 恢复层未知')
}
console.log(`\n${pass} 通过 / ${fail} 失败`)
