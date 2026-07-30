// 黑猫智记AI · shadow-patch（MAIN world, document_start）
// 小红书把真正的「发布」按钮放在 <xhs-publish-btn> 的【closed shadow DOM】里，
// 普通 JS（elementFromPoint / querySelector）取不到内部按钮，只能靠 chrome.debugger 坐标点击，
// 但坐标点击在「比特浏览器多账号并行发布」场景下目标标签页常被后台化，Input 事件被合并/丢弃，
// 导致 CDP 报 ok 却点不中（按钮毫无反应）。
//
// 本补丁在页面脚本创建 shadow 之前，把 xhs-publish-btn 的 attachShadow 强制为 mode:'open'，
// 这样扩展就能直接定位内部红色「发布」按钮并真实点击（synthetic 事件同样能触发 React onClick，
// 且不受标签页是否前台影响）。只针对 XHS-PUBLISH-BTN，避免影响无关组件。
(function () {
  try {
    if (window.__xhsShadowPatched) return;
    window.__xhsShadowPatched = true;
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const tag = (this.tagName || '').toUpperCase();
      if (tag === 'XHS-PUBLISH-BTN') {
        try {
          // 强制 open：保留原参数仅覆盖 mode（delegatesFocus 等照原样）
          return orig.call(this, Object.assign({}, init, { mode: 'open' }));
        } catch (e) {
          try { return orig.call(this, init); } catch (e2) { return null; }
        }
      }
      return orig.call(this, init);
    };
    console.log('[黑猫] attachShadow 补丁已注入（强制 xhs-publish-btn shadow 为 open）');
  } catch (e) {}
})();
