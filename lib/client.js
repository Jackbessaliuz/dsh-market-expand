/**
 * market-expand —— 插件市场补丁层（浏览器半侧）
 *
 * 两套交互：
 *  - 「⬆ 更新全部」注入「正常更新插件」分组头（没有该分组则挂第一个分组头）：
 *    扫描 profile 全部 npm 依赖的新版本，勾选后排队，退出 DSH 由助手完成更新并重开。
 *    注意：**按钮的位置与分组无关**——扫描范围是全部依赖，不需要用户先把插件分类。
 *  - 「⟳ 检测更新」注入「本地化插件」分组头：只查该分组的本地 link 插件，
 *    有更新的行显示 ⬆；链接/回滚放在检测结果浮层里。
 *
 * 分组定位用文本匹配（分组可改名，CSS module 哈希不能硬编码）。
 * 手写 bundle，无构建；client 改动刷新页面即生效（host 改动需重启）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-market-expand',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var BASE = '/market-expand'

    // 分组名匹配（市场 1.39 起分组可改名；默认「本地化插件」是用户沿用的分组名）
    var GROUP_NAME = '本地化插件'
    // 检测按钮 id（模块级常量——runCheck 状态切换用）
    var CHECK_BTN = 'me-check-btn'

    // ---------- 小工具 ----------
    function showToast(text, isError) {
      var t = document.createElement('div')
      t.textContent = text
      t.style.cssText =
        'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:999999;' +
        'background:' + (isError ? 'rgba(217,79,61,.96)' : 'rgba(20,30,50,.94)') + ';color:#fff;' +
        'padding:9px 16px;border-radius:10px;font-size:13px;font-family:inherit;' +
        'box-shadow:0 6px 22px rgba(0,0,0,.35);pointer-events:none;max-width:70vw;white-space:pre-wrap;'
      document.body.appendChild(t)
      // 错误提示往往带具体原因（组合风险那种一条就是几十字），5 秒不够读
      setTimeout(function () { t.remove() }, isError ? 9500 : 3200)
    }

    function fetchJson(url, bodyOpts) {
      var opts = bodyOpts || { method: 'GET' }
      return fetch(BASE + url, bodyOpts
        ? {
            method: bodyOpts.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(bodyOpts.body || {}),
          }
        : { method: 'GET' } 
      ).then(function (r) { return r.json() })
    }

    // ---------- 分组定位（v2：按分组名文本匹配，兼容可改名分组） ----------
    /** 找所有分组头元素（[class*="groupHead"]），返回 { head, nameEl, actionsEl, membersEl, rowEls } */
    function findGroupViews() {
      var heads = document.querySelectorAll('[class*="groupHead"]')
      var out = []
      for (var i = 0; i < heads.length; i++) {
        var head = heads[i]
        var row = head.closest('[class*="groupRow"]')
        if (!row) continue
        var nameEl = head.querySelector('[class*="groupName"]')
        var actionsEl = head.querySelector('[class*="groupActions"]') || head
        var membersEl = row.querySelector('[class*="groupMembers"]')
        var name = nameEl ? String(nameEl.textContent || '').trim() : ''
        var rowEls = membersEl ? Array.prototype.slice.call(membersEl.querySelectorAll('[class*="groupMember"]')) : []
        out.push({ head: head, row: row, nameEl: nameEl, actionsEl: actionsEl, membersEl: membersEl, name: name, rowEls: rowEls })
      }
      return out
    }

    // ---------- 小按钮工厂（与市场按钮同语言：小圆角胶囊） ----------
    function makeSmallBtn(label, title, onClick, accent) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title || label
      b.style.cssText =
        'font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));' +
        'background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;font-family:inherit;flex:none;' +
        'transition:border-color .15s,background .15s;'
      if (accent) {
        b.style.cssText += 'border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600;'
      }
      b.addEventListener('click', function (e) {
        e.stopPropagation()
        e.preventDefault()
        onClick()
      })
      return b
    }

    // ---------- 检测结果浮层（含 per-plugin 状态 + 更新/链接/回滚操作） ----------
    function memberNameOf(row) {
      var nm = row.querySelector('[class*="nm"]')
      if (nm && nm.textContent.trim()) return nm.textContent.trim()
      if (row.firstElementChild && row.firstElementChild.textContent.trim()) return row.firstElementChild.textContent.trim()
      return String(row.textContent || '').split(/\s+/)[0]
    }

    function showResults(allResults) {
      // 「无需检测」的插件不占面板 —— 只显示需要用户关注的（有源/有更新/有异常）
      var results = (allResults || []).filter(function (r) { return r.error !== 'skipped' })
      var skippedCount = (allResults || []).length - results.length
      var panel = document.createElement('div')
      panel.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:999999;width:340px;max-height:72vh;overflow-y:auto;' +
        'background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;' +
        'box-shadow:0 12px 34px rgba(0,0,0,.28);padding:12px 14px;font-family:inherit;font-size:13px;'
      var title = document.createElement('div')
      title.textContent = '本地化插件 · 更新检测'
      title.style.cssText = 'font-weight:600;margin-bottom:8px;font-size:14px;'
      panel.appendChild(title)
      if (results.length === 0) {
        var empty = document.createElement('div')
        empty.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#666);line-height:1.6;padding:4px 0 6px;'
        empty.textContent = skippedCount > 0
          ? '全部 ' + skippedCount + ' 个插件均已标记「无需检测」——没有需要关注的更新。'
          : '分组里还没有可检测的插件——请在市场「分组」页把本地链接插件加入「本地化插件」分组后重试。'
        panel.appendChild(empty)
      }
      results.forEach(function (r) {
        var row = document.createElement('div')
        row.style.cssText = 'padding:7px 0;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.08));line-height:1.5;'
        var head = document.createElement('div')
        head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;'
        var name = document.createElement('span')
        name.textContent = r.name
        name.style.cssText = 'font-weight:600;'
        head.appendChild(name)
        // 状态徽标
        if (r.error === 'no-source') {
          var badgeNS = document.createElement('span')
          badgeNS.textContent = '未设来源'
          badgeNS.style.cssText = 'background:rgba(0,0,0,.08);color:var(--dsw-alias-label-tertiary,#777);padding:2px 8px;border-radius:999px;font-size:11px;'
          head.appendChild(badgeNS)
        } else if (r.error === 'source-error') {
          var badgeSE = document.createElement('span')
          badgeSE.textContent = '源失效'
          badgeSE.style.cssText = 'background:rgba(217,79,61,.12);color:#c2410c;padding:2px 8px;border-radius:999px;font-size:11px;'
          head.appendChild(badgeSE)
        } else if (r.error === 'no-tags') {
          var badgeNT = document.createElement('span')
          badgeNT.textContent = '无版本 tag'
          badgeNT.style.cssText = 'background:rgba(217,79,61,.12);color:#c2410c;padding:2px 8px;border-radius:999px;font-size:11px;'
          head.appendChild(badgeNT)
        } else if (r.hasUpdate) {
          var badgeUP = document.createElement('span')
          badgeUP.textContent = '有更新 → v' + r.upstream
          badgeUP.style.cssText = 'background:rgba(16,185,129,.15);color:#059669;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;'
          head.appendChild(badgeUP)
        } else {
          var badgeOK = document.createElement('span')
          badgeOK.textContent = '已最新 v' + r.current
          badgeOK.style.cssText = 'background:rgba(0,0,0,.05);color:var(--dsw-alias-label-secondary,#555);padding:2px 8px;border-radius:999px;font-size:11px;'
          head.appendChild(badgeOK)
        }
        row.appendChild(head)
        var sub = document.createElement('div')
        sub.textContent =
          r.error === 'no-source'
            ? '点「⊞ 链接」配置检测源，或点「⏭ 无需检测」跳过'
            : '当前 v' + r.current + (r.upstream ? ' → 上游 v' + r.upstream : r.error === 'source-error' ? '（源无法访问，请检查地址）' : r.error === 'no-tags' ? '（源正常但无版本 tag，请找 AI 人工确认）' : '')
        sub.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-top:2px;'
        row.appendChild(sub)
        // 操作行：有更新 → ⬆ 更新；总是 → ⊞ 链接 / ↩ 回滚
        var ops = document.createElement('div')
        ops.style.cssText = 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;'
        if (r.hasUpdate) {
          var upBtn = makeSmallBtn('⬆ 更新 ' + r.upstream, '升级到上游最新版（自动快照→合并→校验；冲突自动转建议手动）', (function (n) {
            return function () { confirmUpgrade(n) }
          })(r.name), true)
          ops.appendChild(upBtn)
        }
        var linkBtn = makeSmallBtn('⊞ 链接', '添加/修改检测源，或点「⏭ 无需检测」跳过（npm 包名 或 GitHub 仓库地址）', (function (n) {
          return function () { promptSource(n) }
        })(r.name))
        ops.appendChild(linkBtn)
        if (r.error !== 'skipped') {
          var rbBtn = makeSmallBtn('↩ 回滚', '回滚到最近一次更新前的快照（保留 3 份）', (function (n) {
            return function () { confirmRollback(n) }
          })(r.name))
          ops.appendChild(rbBtn)
        }
        row.appendChild(ops)
        panel.appendChild(row)
      })
      var closeBtn = document.createElement('button')
      closeBtn.textContent = '隐藏'
      closeBtn.style.cssText =
        'width:100%;margin-top:10px;height:28px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.2));' +
        'border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;font-family:inherit;'
      closeBtn.addEventListener('click', function () { panel.remove() })
      panel.appendChild(closeBtn)
      document.body.appendChild(panel)
    }

    // ---------- 检测：检测范围 =「本地化插件」分组成员（host 端按 state.json 分组决定） ----------
    // 检测按钮状态反馈（与保存按钮同款）：点击 → 「检测中…」（禁用防连点）→ 完成恢复「⟳ 检测更新」
    var checking = false
    function setCheckBtnState(label, disabled) {
      var btn = document.getElementById(CHECK_BTN)
      if (!btn) return
      btn.textContent = label
      btn.disabled = disabled || false
      btn.style.opacity = disabled ? '0.6' : '1'
    }
    function runCheck() {
      if (checking) return
      checking = true
      setCheckBtnState('检测中…', true)
      // 不传 names：host 端 /check 默认 = 本地化插件分组成员 ∩ link 插件（用户手动分配的结果）
      fetchJson('/check', { method: 'POST', body: {} })
        .then(function (r) {
          if (r && r.ok) {
            showResults(r.results || [])
            // 行内更新箭头：只给有更新的行显示 ⬆
            applyUpdateArrows(r.results || [])
          } else {
            showToast('检测失败：' + ((r && r.error) || '未知错误'), true)
          }
        })
        .catch(function (e) { showToast('检测异常：' + e, true) })
        .finally(function () {
          checking = false
          setCheckBtnState('⟳ 检测更新', false)
        })
    }

    /** 行内箭头：有更新的行尾部出现 ⬆（无更新不显示）；重复检测时清理旧的再打 */
    var ARROW_ATTR = 'data-me-has-update'
    function applyUpdateArrows(results) {
      var views = findGroupViews()
      var target = null
      for (var i = 0; i < views.length; i++) {
        if (views[i].name === GROUP_NAME) { target = views[i]; break }
      }
      if (!target) return
      var resultByName = {}
      results.forEach(function (r) { resultByName[r.name] = r })
      target.rowEls.forEach(function (row) {
        var nm = memberNameOf(row)
        var old = row.querySelector('[' + ARROW_ATTR + ']')
        if (old) old.remove()
        if (!nm) return
        var r = resultByName[nm]
        if (r && r.hasUpdate && !r.error) {
          var btn = makeSmallBtn('⬆ ' + (r.upstream || '更新'), '检测到上游 v' + (r.upstream || '') + '，点此升级', (function (n) {
            return function () { confirmUpgrade(n) }
          })(nm), true)
          btn.setAttribute(ARROW_ATTR, '1')
          btn.style.cssText += ';border-color:rgba(16,185,129,.55);color:#059669;'
          row.appendChild(btn)
        }
      })
    }

    // ---------- 交互 ----------
    /** 检测源设置对话框（自定义，替代原生 prompt）：输入框 + 左下角「⏭ 无需检测」 */
    function promptSource(name) {
      var overlay = document.createElement('div')
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;'
      var box = document.createElement('div')
      box.style.cssText =
        'width:min(420px,86vw);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;padding:16px 18px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.4);font-family:inherit;font-size:13px;'
      var title = document.createElement('div')
      title.textContent = '插件「' + name + '」的检测源'
      title.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:8px;'
      var desc = document.createElement('div')
      desc.textContent = '· npm 包名（如 dsh-pet）\n· GitHub 仓库（如 PC2005-cloud/dsh-pet）\n· 留空 = 清除当前源 · 或点「⏭ 无需检测」跳过它'
      desc.style.cssText = 'font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#666);margin-bottom:10px;white-space:pre-line;'
      var input = document.createElement('input')
      input.type = 'text'
      input.placeholder = 'npm 包名 或 GitHub 仓库地址'
      input.style.cssText =
        'width:100%;box-sizing:border-box;height:34px;padding:0 10px;border-radius:8px;font-size:13px;font-family:inherit;' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:transparent;color:inherit;outline:none;'
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') okBtn.click() })
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:14px;'
      function close() { overlay.remove() }
      function toast(msg, isErr) { close(); showToast(msg, isErr) }
      var noneBtn = document.createElement('button')
      noneBtn.type = 'button'
      noneBtn.textContent = '⏭ 无需检测'
      noneBtn.title = '标记为「无需检测更新」——自研/本地插件用这个，检测时显示灰色跳过徽标'
      noneBtn.style.cssText =
        'height:30px;padding:0 12px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.25));' +
        'background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;font-family:inherit;'
      noneBtn.addEventListener('click', function () {
        fetchJson('/source', { method: 'POST', body: { name: name, kind: 'skip' } })
          .then(function (r) {
            if (r && r.ok) toast(name + '：已标记「无需检测」')
            else toast('保存失败：' + ((r && r.error) || ''), true)
          })
          .catch(function (e) { toast('保存异常：' + e, true) })
      })
      var right = document.createElement('div')
      right.style.cssText = 'display:flex;gap:8px;'
      var cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.textContent = '取消'
      cancelBtn.style.cssText =
        'height:32px;padding:0 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));' +
        'background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:13px;cursor:pointer;font-family:inherit;'
      cancelBtn.addEventListener('click', close)
      var okBtn = document.createElement('button')
      okBtn.type = 'button'
      okBtn.textContent = '确定'
      okBtn.style.cssText =
        'height:32px;padding:0 18px;border-radius:8px;border:1px solid var(--dsw-alias-brand-primary,#4f6ef7);' +
        'background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font-size:13px;cursor:pointer;font-family:inherit;'
      okBtn.addEventListener('click', function () {
        var val = String(input.value || '').trim()
        if (!val) {
          fetchJson('/source', { method: 'POST', body: { name: name, action: 'clear' } })
            .then(function () { toast(name + '：已清除检测源') })
            .catch(function (e) { toast('清除异常：' + e, true) })
          return
        }
        var kind = /github\.com|^[\w.-]+\/[\w.-]+$/.test(val) ? 'github' : 'npm'
        fetchJson('/source', { method: 'POST', body: { name: name, kind: kind, value: val } })
          .then(function (r) {
            if (r && r.ok) toast(name + '：检测源已保存（' + kind + '）——点「检测更新」试试')
            else toast('保存失败：' + ((r && r.error) || ''), true)
          })
          .catch(function (e) { toast('保存异常：' + e, true) })
      })
      right.appendChild(cancelBtn)
      right.appendChild(okBtn)
      row.appendChild(noneBtn)
      row.appendChild(right)
      box.appendChild(title)
      box.appendChild(desc)
      box.appendChild(input)
      box.appendChild(row)
      overlay.appendChild(box)
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
      document.body.appendChild(overlay)
      setTimeout(function () { input.focus() }, 30)
    }

    function confirmRollback(name) {
      if (!window.confirm('回滚「' + name + '」到最近一次更新前的快照？\n回滚后请重启 DSH 生效。')) return
      fetchJson('/rollback', { method: 'POST', body: { name: name } })
        .then(function (r) {
          if (r && r.ok) showToast(name + '：已回滚（' + (r.restored || '') + '），请重启 DSH 生效')
          else showToast('回滚失败：' + ((r && r.error) || '无可用快照'), true)
        })
    }

    function confirmUpgrade(name) {
      if (!window.confirm('升级「' + name + '」到上游最新版？\n流程：自动快照 → 拉取上游 → git 合并（定制保留）→ 校验；\n冲突/大改则自动中止并转「建议手动」。')) return
      fetchJson('/upgrade', { method: 'POST', body: { name: name } })
        .then(function (r) {
          if (r && r.ok) showToast(name + '：' + (r.message || '升级完成'))
          else if (r && r.code === 'conflict-manual') {
            showToast(
              name + '：⚠️ 冲突/大改，已中止并保留快照 → 建议转手动（找 AI 评估）\n' +
              ((r.stat || '') + '\n冲突文件：' + ((r.conflicted || []).join(', ') || '无')),
              true,
            )
          } else {
            showToast(name + '：' + ((r && r.message) || (r && r.error) || '失败'), true)
          }
        })
        .catch(function (e) { showToast('升级异常：' + e, true) })
    }

    // ---------- 全量更新入口（2026-10-21） ----------
    // 为什么需要它：官方桌面端里市场更新自己必然失败（remove 把自己摘掉了，上游 #900），
    // 设置页没有更新入口（#909），运行中的 desktop profile 被 Electron 独占 →
    // 唯一的路是「退出 DSH 后 pnpm add」。这里把那三步做成一次点击。
    var UPDATE_BTN = 'me-update-btn'
    var updateBusy = false

    /**
     * 注入「⬆ 更新全部」。
     * 2026-10-21 用户反馈：按钮原来按「正常更新插件」分组找、没有就取 DOM 里的第一个
     * groupHead（DOM 顺序≠视觉顺序），结果挂到了「未分组」而不是第一个分组
     * 「本地化插件」——第一次用的人根本找不到。现在直接挂在「本地化插件」分组头，
     * 紧挨「⟳ 检测更新」。
     */
    function injectUpdateButton() {
      var views = findGroupViews()
      if (!views.length) return
      var target = null
      for (var i = 0; i < views.length; i++) {
        if (views[i].name === GROUP_NAME) { target = views[i]; break }
      }
      if (!target) target = views[0]
      if (!target || !target.actionsEl) return
      if (target.actionsEl.querySelector('#' + UPDATE_BTN)) return
      var btn = makeSmallBtn('⬆ 更新全部', '扫描 profile 里所有 npm 插件的新版本；排队后完全退出 DSH，助手会自动更新（右下角有进度窗）并重新打开', runUpdateCheck, true)
      btn.id = UPDATE_BTN
      var check = target.actionsEl.querySelector('#' + CHECK_BTN)
      if (check && check.parentNode === target.actionsEl) target.actionsEl.insertBefore(btn, check)
      else target.actionsEl.appendChild(btn)
      refreshUpdateButton()
    }

    /**
     * 按钮状态 + 上次报告提示。
     * 2026-10-21 修：旧版只读一次状态，用户重启时任务还在跑 → 按钮停在「已排队」，
     * 更新完成后也不会自己变回来（用户以为没更新）。现在有任务就每 4 秒轮询，
     * 任务结束自动恢复成「⬆ 更新全部」。
     */
    var statusPolling = false
    function refreshUpdateButton() {
      if (statusPolling) return
      statusPolling = true
      var tick = function () {
        fetchJson('/update-status')
          .then(function (r) {
            if (!r || !r.ok) { window.setTimeout(tick, 8000); return }
            var btn = document.getElementById(UPDATE_BTN)
            if (btn) {
              if (r.running) {
                var nPkgs = (r.queue && Array.isArray(r.queue.packages)) ? r.queue.packages.length : 0
                btn.textContent = nPkgs ? '⏳ 已排队 ' + nPkgs + ' 个' : '⏳ 等待退出更新'
                btn.title = '更新任务进行中：点这里看排队详情；退出 DSH 后助手会自动更新并重新打开'
              } else {
                btn.textContent = '⬆ 更新全部'
                btn.title = '扫描 profile 里所有 npm 插件的新版本；排队后完全退出 DSH，助手会自动更新（右下角有进度窗）并重新打开'
              }
            }
            // 上次报告只提示一次（同一份报告不重复弹）
            if (r.report && r.report.finishedAt) {
              var key = 'me-update-report-' + (r.report.id || r.report.finishedAt)
              var shown = false
              try { shown = window.sessionStorage && sessionStorage.getItem(key) === '1' } catch (e) { }
              if (!shown) {
                try { sessionStorage.setItem(key, '1') } catch (e) { }
                var counts = (r.report.results || []).filter(function (x) { return x.ok }).length
                var total = (r.report.results || []).length
                var failed = total - counts
                var health = r.report.health
                var risks = Array.isArray(r.report.risks) ? r.report.risks : []
                if (risks.length) {
                  // 组合破坏检查命中：这类问题不写 crash log，但可能让 Agent 预设消失
                  showToast('上次更新发现组合风险：' + risks[0].note + (risks.length > 1 ? '（共 ' + risks.length + ' 条，点「更新全部」查日志）' : ''), true)
                } else if (health && health.ok === false) {
                  // 更新成功但启动失败 → 助手已自动回退
                  var rolled = (health.rollback || []).filter((x) => x.ok).length
                  showToast(rolled > 0
                    ? '上次更新后 DSH 启动失败，已自动回退 ' + rolled + ' 个插件'
                    : '上次更新后 DSH 启动失败（不是本次更新的插件导致的，未回退）', true)
                } else if (total > 0) {
                  if (failed === 0) showToast('上次更新完成：' + counts + ' 个插件已更新到最新')
                  else showToast('上次更新：' + counts + '/' + total + ' 成功，' + failed + ' 个失败（点「更新全部」查看日志）', true)
                }
              }
            }
            // 还在跑就继续轮询；跑完自动停
            if (r.running) window.setTimeout(tick, 4000)
            else statusPolling = false
          })
          .catch(function () { window.setTimeout(tick, 8000) })
      }
      tick()
    }

    /** 扫描 → 面板：可更新项勾选 → 排队。已有排队任务时直接显示排队面板。 */
    function runUpdateCheck() {
      if (updateBusy) return
      updateBusy = true
      var btn = document.getElementById(UPDATE_BTN)
      if (btn) { btn.textContent = '扫描中…'; btn.disabled = true; btn.style.opacity = '0.6' }
      var restoreBtn = function () {
        updateBusy = false
        var b = document.getElementById(UPDATE_BTN)
        if (b) { b.textContent = '⬆ 更新全部'; b.disabled = false; b.style.opacity = '1' }
      }
      var queuedShown = false
      var queuedCount = 0
      fetchJson('/update-status')
        .then(function (st) {
          // 已经有排队中的任务：不要再报 409 错，直接把排队面板摆出来
          if (st && st.ok && st.running) {
            queuedShown = true
            queuedCount = (st.queue && Array.isArray(st.queue.packages)) ? st.queue.packages.length : 0
            showWaitingPanel(st)
            return null
          }
          return fetchJson('/updates').then(function (r) {
            if (!r || !r.ok) { showToast('扫描失败：' + ((r && r.error) || '未知错误'), true); return }
            showUpdatePanel(r)
          })
        })
        .catch(function (e) { showToast('扫描异常：' + e, true) })
        .then(function () {
          updateBusy = false
          if (queuedShown) {
            var qb = document.getElementById(UPDATE_BTN)
            if (qb) { qb.textContent = queuedCount ? '⏳ 已排队 ' + queuedCount + ' 个' : '⏳ 等待退出更新'; qb.disabled = false; qb.style.opacity = '1' }
            return
          }
          restoreBtn()
        })
    }

    function showUpdatePanel(data) {
      var items = (data && data.updatable) || []
      var panel = document.createElement('div')
      panel.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:999999;width:380px;max-height:76vh;overflow-y:auto;' +
        'background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;' +
        'box-shadow:0 12px 34px rgba(0,0,0,.28);padding:12px 14px;font-family:inherit;font-size:13px;'
      var title = document.createElement('div')
      title.textContent = '插件更新 · ' + (data.profile || '')
      title.style.cssText = 'font-weight:600;margin-bottom:4px;font-size:14px;'
      panel.appendChild(title)
      var note = document.createElement('div')
      note.textContent = items.length
        ? '勾选要更新的插件。点「更新并重启」后：现在排队 → 你完全退出 DSH（托盘图标右键 → 退出）→ 助手自动 pnpm add → 完成后自动重新打开 DSH。'
        : '全部插件都已是最新。'
      note.style.cssText = 'font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);margin-bottom:8px;'
      panel.appendChild(note)

      if (!items.length) {
        var okRow = document.createElement('div')
        okRow.textContent = '✓ 没有需要更新的版本'
        okRow.style.cssText = 'padding:10px 0;color:#059669;font-size:13px;'
        panel.appendChild(okRow)
      }

      var checked = {}
      items.forEach(function (it) {
        checked[it.name] = true
        var row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.08));'
        var cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = true
        cb.style.cssText = 'margin:3px 0 0;flex:none;cursor:pointer;'
        cb.addEventListener('change', function () {
          checked[it.name] = cb.checked
          updateSubmitLabel()
        })
        var info = document.createElement('div')
        info.style.cssText = 'min-width:0;line-height:1.5;'
        var nm = document.createElement('div')
        nm.textContent = it.name + (it.isSelf ? '（市场本身）' : '')
        nm.style.cssText = 'font-weight:600;word-break:break-all;'
        var ver = document.createElement('div')
        ver.textContent = 'v' + it.current + ' → v' + it.latest
        ver.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-top:1px;'
        info.appendChild(nm)
        info.appendChild(ver)
        row.appendChild(cb)
        row.appendChild(info)
        panel.appendChild(row)
      })

      var submitBtn = null
      function selectedNames() {
        return items.filter(function (it) { return checked[it.name] }).map(function (it) { return it.name })
      }
      function updateSubmitLabel() {
        if (!submitBtn) return
        var n = selectedNames().length
        submitBtn.textContent = n ? '更新 ' + n + ' 个并重启 DSH' : '未选择插件'
        submitBtn.disabled = n === 0
        submitBtn.style.opacity = n === 0 ? '0.5' : '1'
      }

      var ops = document.createElement('div')
      ops.style.cssText = 'display:flex;gap:8px;margin-top:12px;'
      if (items.length) {
        submitBtn = document.createElement('button')
        submitBtn.type = 'button'
        submitBtn.style.cssText =
          'flex:1;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-brand-primary,#4f6ef7);' +
          'background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font-size:13px;cursor:pointer;font-family:inherit;font-weight:600;'
        submitBtn.addEventListener('click', function () {
          var names = selectedNames()
          if (!names.length) return
          var lines = items.filter(function (it) { return checked[it.name] })
            .map(function (it) { return '· ' + it.name + '  ' + it.current + ' → ' + it.latest })
          var msg = '将更新以下 ' + names.length + ' 个插件：\n\n' + lines.join('\n') +
            '\n\n流程：现在排队 → 你完全退出 DSH（托盘图标右键 → 退出）→ 右下角弹出进度窗口 → 自动 pnpm add → 完成后自动重新打开 DSH。\n\n继续？'
          if (!window.confirm(msg)) return
          submitBtn.textContent = '排队中…'
          submitBtn.disabled = true
          var chosen = items.filter(function (it) { return checked[it.name] })
          var payload = chosen.map(function (it) {
            return {
              name: it.name,
              current: it.current,
              latest: it.latest,
              // 与 host 端 checkAllUpdates 同规则：github 装的是 tag，npm 装的是 name@version
              spec: (it.isGithub && it.repo && it.tag) ? 'github:' + it.repo + '#' + it.tag : it.name + '@' + it.latest,
              isGithub: !!it.isGithub,
            }
          })
          fetchJson('/update', { method: 'POST', body: { names: names, packages: payload } })
            .then(function (r) {
              if (r && r.ok) {
                panel.remove()
                showWaitingPanel({ running: r.job.helperPid, queue: { id: r.job.id, packages: r.job.packages } })
                showToast('已排队 ' + (r.queued || names.length) + ' 个插件。\n现在请完全退出 DSH：托盘图标右键 → 退出。\n右下角进度窗会一直显示进度（DSH 关掉它也还在）。')
                var b = document.getElementById(UPDATE_BTN)
                if (b) { b.textContent = '⏳ 已排队 ' + (r.queued || names.length) + ' 个' }
              } else {
                showToast('排队失败：' + ((r && r.error) || '未知错误'), true)
                submitBtn.textContent = '更新 ' + names.length + ' 个并重启 DSH'
                submitBtn.disabled = false
              }
            })
            .catch(function (e) {
              showToast('排队异常：' + e, true)
              submitBtn.disabled = false
            })
        })
        ops.appendChild(submitBtn)
      }
      var closeBtn = document.createElement('button')
      closeBtn.textContent = '隐藏'
      closeBtn.style.cssText =
        'height:32px;padding:0 14px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.2));' +
        'border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;font-family:inherit;'
      closeBtn.addEventListener('click', function () { panel.remove() })
      ops.appendChild(closeBtn)
      panel.appendChild(ops)
      updateSubmitLabel()
      document.body.appendChild(panel)
    }

    // ---------- 已排队面板（2026-10-21 首日事故新增） ----------
    // 群友点完更新后界面毫无变化，他反复点、第二次被 409 拒。排队成功必须
    // 当场把「排了什么、接下来做什么、怎么取消」摆在眼前。
    function showWaitingPanel(status) {
      refreshUpdateButton()
      var q = (status && status.queue) || {}
      var pkgs = Array.isArray(q.packages) ? q.packages : []
      var panel = document.createElement('div')
      panel.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:999999;width:400px;max-height:70vh;overflow-y:auto;' +
        'background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;' +
        'box-shadow:0 12px 34px rgba(0,0,0,.28);padding:12px 14px;font-family:inherit;font-size:13px;'
      var title = document.createElement('div')
      title.textContent = pkgs.length ? '已排队 · ' + pkgs.length + ' 个插件' : '已排队'
      title.style.cssText = 'font-weight:600;margin-bottom:6px;font-size:14px;color:#ffc53d;'
      panel.appendChild(title)
      var note = document.createElement('div')
      note.textContent = '现在只需要完全退出 DSH（托盘图标右键 → 退出）。退出后助手会自动更新，并在完成后重新打开 DSH；右下角进度窗全程显示进度，DSH 关掉它也还在。'
      note.style.cssText = 'font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#555);margin-bottom:8px;'
      panel.appendChild(note)
      if (pkgs.length) {
        var list = document.createElement('div')
        list.style.cssText = 'font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#777);max-height:26vh;overflow-y:auto;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-top:6px;'
        pkgs.forEach(function (p) {
          var row = document.createElement('div')
          row.textContent = '· ' + p.name + '  ' + (p.from ? p.from + ' → ' : '') + p.target
          list.appendChild(row)
        })
        panel.appendChild(list)
      }
      var ops = document.createElement('div')
      ops.style.cssText = 'display:flex;gap:6px;margin-top:12px;'
      var cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.textContent = '取消排队'
      cancelBtn.style.cssText =
        'height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));' +
        'background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;font-family:inherit;'
      cancelBtn.addEventListener('click', function () {
        cancelBtn.textContent = '取消中…'
        cancelBtn.disabled = true
        fetchJson('/update-cancel', { method: 'POST' })
          .then(function (r) {
            panel.remove()
            showToast('已取消排队，DSH 不用退出了')
            var b = document.getElementById(UPDATE_BTN)
            if (b) b.textContent = '⬆ 更新全部'
          })
          .catch(function (e) { showToast('取消失败：' + e, true); cancelBtn.disabled = false; cancelBtn.textContent = '取消排队' })
      })
      var logBtn = document.createElement('button')
      logBtn.type = 'button'
      logBtn.textContent = '查看日志'
      logBtn.style.cssText = cancelBtn.style.cssText
      logBtn.addEventListener('click', function () { showLogPanel() })
      // 「立即重启并更新」：省掉去托盘右键退出那一步（2026-10-21 用户要求）
      var quitBtn = document.createElement('button')
      quitBtn.type = 'button'
      quitBtn.textContent = '⚡ 立即重启并更新'
      quitBtn.style.cssText =
        'height:30px;padding:0 10px;border-radius:8px;border:1px solid #ffc53d;' +
        'background:#ffc53d;color:#1c1c1c;font-size:12px;cursor:pointer;font-family:inherit;font-weight:600;'
      quitBtn.addEventListener('click', function () {
        if (!window.confirm('DSH 会立刻退出：\n· 正在跑的任务会中断\n· 更新助手会在退出后自动更新，并把 DSH 重新打开\n\n继续？')) return
        quitBtn.textContent = '正在退出…'
        quitBtn.disabled = true
        quitBtn.style.opacity = '0.7'
        fetchJson('/quit-host', { method: 'POST' })
          .then(function (r) {
            if (!r || !r.ok) {
              showToast('退出失败：' + ((r && r.error) || '未知错误'), true)
              quitBtn.textContent = '⚡ 立即重启并更新'
              quitBtn.disabled = false
              quitBtn.style.opacity = '1'
            }
          })
          .catch(function (e) {
            showToast('退出异常：' + e, true)
            quitBtn.disabled = false
            quitBtn.textContent = '⚡ 立即重启并更新'
          })
      })
      var closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.textContent = '隐藏'
      closeBtn.style.cssText = cancelBtn.style.cssText + 'margin-left:auto;'
      closeBtn.addEventListener('click', function () { panel.remove() })
      ops.appendChild(cancelBtn)
      ops.appendChild(logBtn)
      ops.appendChild(quitBtn)
      ops.appendChild(closeBtn)
      panel.appendChild(ops)
      var hint = document.createElement('div')
      hint.textContent = '退出后如果 10 分钟没反应：点「查看日志」，把内容发给开发者。'
      hint.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:8px;'
      panel.appendChild(hint)
      document.body.appendChild(panel)
    }

    // ---------- 日志浮层：更新助手日志尾部（DSH 还能用时的便利入口） ----------
    function showLogPanel() {
      fetchJson('/update-log')
        .then(function (r) {
          var text = (r && r.tail) || '（没有日志）'
          var overlay = document.createElement('div')
          overlay.style.cssText = 'position:fixed;inset:0;z-index:9999999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;'
          var box = document.createElement('div')
          box.style.cssText =
            'width:min(760px,92vw);max-height:78vh;display:flex;flex-direction:column;' +
            'background:var(--dsw-alias-bg-overlay,#fff);border-radius:12px;padding:14px;box-shadow:0 16px 40px rgba(0,0,0,.4);font-family:inherit;'
          var head = document.createElement('div')
          head.textContent = '更新日志 · ' + ((r && r.logFile) || '')
          head.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:8px;word-break:break-all;'
          var pre = document.createElement('pre')
          pre.textContent = text
          pre.style.cssText = 'flex:1;overflow:auto;margin:0;padding:10px;border-radius:8px;background:rgba(0,0,0,.06);font-family:Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all;'
          var ops = document.createElement('div')
          ops.style.cssText = 'display:flex;gap:8px;margin-top:10px;justify-content:flex-end;'
          var copyBtn = document.createElement('button')
          copyBtn.textContent = '复制全部'
          copyBtn.style.cssText = 'height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-brand-primary,#4f6ef7);background:transparent;color:var(--dsw-alias-brand-primary,#4f6ef7);font-size:12px;cursor:pointer;font-family:inherit;'
          copyBtn.addEventListener('click', function () {
            try {
              navigator.clipboard.writeText(text)
              copyBtn.textContent = '已复制'
            } catch (e) { showToast('复制失败，请手动选中', true) }
          })
          var closeBtn = document.createElement('button')
          closeBtn.textContent = '隐藏'
          closeBtn.style.cssText = 'height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;font-family:inherit;'
          closeBtn.addEventListener('click', function () { overlay.remove() })
          overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove() })
          ops.appendChild(copyBtn)
          ops.appendChild(closeBtn)
          box.appendChild(head)
          box.appendChild(pre)
          box.appendChild(ops)
          overlay.appendChild(box)
          document.body.appendChild(overlay)
        })
        .catch(function (e) { showToast('读取日志失败：' + e, true) })
    }

    // ---------- 注入检测按钮（只注入「本地化插件」分组头 groupActions） ----------
    function injectCheckButton() {
      var views = findGroupViews()
      for (var i = 0; i < views.length; i++) {
        var v = views[i]
        if (v.name !== GROUP_NAME) continue
        if (v.actionsEl.querySelector('#' + CHECK_BTN)) continue
        var btn = makeSmallBtn('⟳ 检测更新', '检测「' + GROUP_NAME + '」分组所有插件的更新（按各自配置的 npm/GitHub 源）；无更新不显示箭头', runCheck, true)
        btn.id = CHECK_BTN
        v.actionsEl.appendChild(btn)
      }
    }

    // ---------- 行内「⊞ 链接」按钮（每次成员行常驻：配检测源 → 检测才有意义） ----------
    // 用户拍板：只有「本地化插件」分组成员行注入；更新箭头保持检测后按需显示；回滚留在浮层。
    var LINK_ATTR = 'data-me-link-injected'
    function injectRowLinkButtons() {
      var views = findGroupViews()
      for (var i = 0; i < views.length; i++) {
        var v = views[i]
        if (v.name !== GROUP_NAME) continue
        v.rowEls.forEach(function (row) {
          if (row.getAttribute(LINK_ATTR)) return
          var nm = memberNameOf(row)
          if (!nm) return
          var linkBtn = makeSmallBtn('⊞ 链接', '添加/修改检测源（npm 包名 或 GitHub 仓库地址）', (function (n) {
            return function () { promptSource(n) }
          })(nm))
          linkBtn.setAttribute(LINK_ATTR, '1')
          row.appendChild(linkBtn)
          row.setAttribute(LINK_ATTR, '1')        })
      }
    }

    // ---------- 启动：市场页面挂载后注入 ----------
    function boot() {
      injectCheckButton()
      injectRowLinkButtons()
      injectUpdateButton()
      if (!document.getElementById(CHECK_BTN)) {
        // 市场页未打开/分组未出现：低频重试
        window.setTimeout(boot, 1500)
      }
      var busy = false
      var mo = new window.MutationObserver(function () {
        if (busy) return
        busy = true
        injectCheckButton()
        injectRowLinkButtons()
        injectUpdateButton()
        busy = false
      })
      mo.observe(document.body, { childList: true, subtree: true })
      window.addEventListener('pagehide', function () { mo.disconnect() })
    }

    // ---------- 设置-通用设置「DSH 版本」行（2026-09-03 用户拍板：纯检测，不自动安装） ----------
    function DshUpdateSetting() {
      var React = require('react')
      var useState = React.useState
      var h = React.createElement
      var [state, setState] = useState({ phase: 'idle' })
      function check() {
        setState({ phase: 'loading' })
        fetchJson('/dsh-update')
          .then(function (r) {
            if (r && r.ok) setState({ phase: 'done', data: r })
            else setState({ phase: 'error', msg: (r && r.error) || '未知错误' })
          })
          .catch(function (e) { setState({ phase: 'error', msg: String(e) }) })
      }
      var status = null
      if (state.phase === 'loading') {
        status = h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#888)' } }, '检测中…')
      } else if (state.phase === 'done' && state.data) {
        var d = state.data
        if (d.hasUpdate) {
          var tag = ''
          if (d.tags) {
            for (var k in d.tags) {
              if (String(d.tags[k]) === String(d.latestVersion)) { tag = k; break }
            }
          }
          status = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', {
              style: {
                fontSize: 12, fontWeight: 700, color: '#4ade80',
                background: 'rgba(16,185,129,.28)', padding: '2px 9px', borderRadius: 999,
                textShadow: '0 0 6px rgba(74,222,128,.35)',
                boxShadow: '0 0 0 1px rgba(74,222,128,.4)',
              },
            }, '有更新 → v' + d.latestVersion + (tag ? ' (' + tag + ')' : '')),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary,#666)' } },
              '只读检测，不会自动安装；升级前请自行确认兼容性'),
          )
        } else {
          status = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', {
              style: {
                fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary,#666)',
                background: 'rgba(0,0,0,.06)', padding: '2px 9px', borderRadius: 999,
              },
            }, '已是最新'),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } },
              'tags: ' + (d.tags ? Object.keys(d.tags).map(function (t2) { return t2 + '=' + d.tags[t2] }).join(' · ') : '—')),
          )
        }
      } else if (state.phase === 'error') {
        status = h('span', { style: { fontSize: 12, color: '#c2410c' } }, '检测失败: ' + state.msg)
      } else {
        status = h('span', {
          style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' },
          title: '点「检测更新」查看 npm dist-tags',
        }, '只读检测 npm dist-tags(latest/next/alpha),不安装任何东西')
      }
      return h('div', {
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '2px 0' },
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'DSH 版本'),
          h('div', { style: { fontSize: 11, marginTop: 2, color: 'var(--dsw-alias-label-tertiary,#888)' } },
            '当前 v' + (state.data && state.data.current ? state.data.current : '…') + ' · 发现新版本时只提示,不自动更新'),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flex: 'none' } },
          h('button', {
            type: 'button',
            onClick: check,
            disabled: state.phase === 'loading',
            style: {
              height: 28, padding: '0 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12, border: '1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16))',
              background: 'transparent', color: 'var(--dsw-alias-label-primary,#222)',
              opacity: state.phase === 'loading' ? 0.55 : 1,
            },
          }, state.phase === 'loading' ? '检测中…' : '检测更新'),
          status,
        ),
      )
    }

    function apply(ctx) {
      // 设置-通用设置「DSH 版本」行（slots 注入；失败不影响市场分组增强）
      try {
        var slots = ctx.get('slots')
        if (slots !== undefined) {
          slots.inject('settings.general.item', function () {
            return slots.register(
              { name: 'settings.general.item', id: 'dsh-update-check', order: 90 },
              DshUpdateSetting,
            )
          })
        }
      } catch (e) { /* 忽略 */ }
      window.setTimeout(boot, 800)
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
