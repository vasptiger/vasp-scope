/**
 * dsh-vasp-panel · 浏览器半边（手写，无需打包）—— 待合并版（暂存）
 *
 * 契约（与 dsh-better-sidebar / dsh-vaspflow 一致）：
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => module.exports })
 *   module.exports 上必须有 `apply`；`inject` 里写的是 **cordis 服务名**（不是包名）。
 *
 * 侧栏常驻入口：用外壳自己的槽位 API，挂到
 *   sidebar.footer.action —— “Optional actions beside Settings at the sidebar foot”
 *   （replaceRisk: none；外壳传给内容组件的唯一 owner prop 是 wide：侧栏是否宽态）
 * 之所以不用「自绘 DOM + MutationObserver」那套：槽位是外壳渲染的座位，
 * 不用猜 class 名、不用自愈重试，折叠态（wide=false）由外壳交给我们处理，失败面更小。
 *
 * 点击动作 = 把本地面板文件开成侧栏里的一个标签页：
 *   ctx.get('betterSidebar').openFile({ sessionId }, PANEL_PATH)
 *   其中 PANEL_PATH 来自插件配置 panelPath（仓库里不写死绝对路径 ✗）；
 *   没配就向宿主 GET /plugins/dsh-vasp-panel/ping 索取 panelPath ✓
 * 为什么不是打开 http://127.0.0.1:19387/plugins/dsh-vasp-panel/panel：
 *   侧栏浏览器（better-sidebar 的网页 tab）硬编码拦掉一切本机地址，
 *   所以入口只负责「把本地面板文件开进侧栏」，面板自身用 file:// / 沙箱 iframe 渲染，
 *   靠插件路由的 CORS 头跨域取数（宿主半边已发 access-control-allow-origin: *）。
 *
 * 安全：apply() 整体 try/catch —— 本文件任何异常都不许冒泡到外壳，
 *      否则会像 v0.1.0 那样把整页拖挂。
 *
 * 已在隔离探针 dsh-vasp-panel-probe 上验证通过（2026-10-08）：
 *   宿主/客户端两半都加载、槽位占用 active:true、入口渲染、页面不挂、点击开进侧栏。
 */
(function () {
  var ID = 'dsh-vasp-panel';
  var PANEL_PATH = 'assets/panel.html';   // 面板主交付物（绝对路径更稳：外壳会把相对路径拼到会话 cwd 上）
  var ENTRY_ATTR = 'data-dsh-vasppanel-entry';

  try {
    window.__ModuleLoader__.load({
      id: ID,
      factory: function (require) {
        var module = { exports: {} };
        var exports = module.exports;
        try { Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' }); } catch (_) { /* noop */ }

        var React = null;
        try { React = require('react'); } catch (_) { React = null; }

        /** 可选取服务：拿不到就返回 null，绝不因为服务迟到/缺失而抛。 */
        function svc(ctx, name) {
          try {
            var v = ctx.get(name);
            return v === undefined ? null : v;
          } catch (_) { return null; }
        }

        /** 把面板开进当前会话的侧栏（打不开就安静降级，只留一条 console 线索）。 */
        function openPanel(ctx) {
          try {
            var bs = svc(ctx, 'betterSidebar');
            if (!bs || typeof bs.openFile !== 'function') {
              try { console.warn('[dsh-vasp-panel] 需要 dsh-better-sidebar 才能把面板开进侧栏'); } catch (_) { /* noop */ }
              return;
            }
            var snap = null;
            try { snap = bs.getSnapshot(); } catch (_) { /* noop */ }
            var sessionId = snap && snap.sessionId;
            if (!sessionId) {
              try { console.warn('[dsh-vasp-panel] 当前没有活动会话，先选一个会话再点'); } catch (_) { /* noop */ }
              return;
            }
            bs.openFile({ sessionId: sessionId }, PANEL_PATH, 'VASP 任务面板');
          } catch (e) {
            try { console.error('[dsh-vasp-panel] 打开面板失败:', e); } catch (_) { /* noop */ }
          }
        }

        /* 侧栏底部入口的图标（VASP 收敛曲线意象），16px 线性图标，跟随 currentColor。 */
        var ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
          'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M2 13V3M2 13h12"/><path d="M4 11l3-4 2.5 3L14 5"/><circle cx="7" cy="7" r="1"/></svg>';

        /** 入口组件：外壳在侧栏底部渲染它，唯一 owner prop 是 wide。 */
        function makeEntry(ctx) {
          return function VaspPanelEntry(props) {
            var wide = !!(props && props.wide);
            if (!React) return null;                       // 没有 React 就不渲染，绝不抛
            var style = {
              display: 'flex',
              alignItems: 'center',
              justifyContent: wide ? 'flex-start' : 'center',
              gap: '8px',
              width: wide ? '100%' : '32px',
              height: '32px',
              padding: wide ? '0 8px' : '0',
              background: 'none',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              color: 'var(--dsw-alias-label-secondary, #454d5f)',
              font: 'inherit',
              fontSize: '13px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            };
            var icon = React.createElement('span', {
              key: 'icon',
              style: { display: 'inline-flex', flex: 'none' },
              dangerouslySetInnerHTML: { __html: ICON },
            });
            var kids = wide ? [icon, React.createElement('span', { key: 'label' }, 'VASP 面板')] : [icon];
            var buttonProps = {
              type: 'button',
              title: 'VASP 任务面板（远程集群 · SSH）',
              'aria-label': 'VASP 任务面板',
              className: 'dsh-vasppanel-entry',
              style: style,
              onClick: function () { openPanel(ctx); },
            };
            buttonProps[ENTRY_ATTR] = '';
            return React.createElement('button', buttonProps, kids);
          };
        }

        function apply(ctx, config) {
    /* 面板路径优先取插件配置 panelPath ✓ —— 仓库里**不写死任何绝对路径** ✗
       （写死过：先是作者机器路径 ✗，后来被我改成不存在的路径 ✗）
       没配就退化成相对路径，外壳会拼到会话 cwd —— 只作兜底 ✓ */
    try {
      if (config && typeof config.panelPath === 'string' && config.panelPath.trim()) PANEL_PATH = config.panelPath.trim();
      else {
        /* 兜底：向宿主讨真实路径 ✓（宿主用 HERE/../assets/panel.html 算出 ✓，与 /panel 同一算法）
           —— 侧栏的网页 tab 拦本机地址 ✗，所以这里只能拿"文件路径"，不能拿 URL ✓ */
        console.warn('[dsh-vasp-panel] 未配置 panelPath，改为向宿主索取…');
        try {
          fetch('/plugins/dsh-vasp-panel/ping')
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.panelPath) PANEL_PATH = j.panelPath; })
            .catch(function () { /* noop */ });
        } catch (_) { /* noop */ }
      }
    } catch (_) { /* noop */ }
          try {
            var slots = svc(ctx, 'slots');
            if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return function () {};
            var entry = makeEntry(ctx);
            /* slots.inject：槽位还没声明就先等着（外壳的侧栏是异步挂载的），
               声明之后再 register；控件的生命周期交给 ctx.effect 管。 */
            ctx.effect(function () {
              return slots.inject('sidebar.footer.action', function () {
                return slots.register({
                  name: 'sidebar.footer.action',
                  id: 'vasp-panel',          // 自己的格子：不覆盖外壳自带的 cordis-panel
                  order: 60,
                  label: 'VASP 面板',
                }, entry);
              });
            }, ID + ': sidebar footer entry');
          } catch (e) {
            try { console.error('[dsh-vasp-panel] client half failed:', e); } catch (_) { /* noop */ }
          }
          return function () { /* 槽位注册由 ctx.effect 负责回收 */ };
        }

        exports.name = ID + '-client';
        exports.inject = ['slots'];      // 只硬依赖外壳自带的 slots；betterSidebar 走可选访问
        exports.apply = apply;
        return module.exports;
      },
    });
  } catch (e) {
    try { console.error('[dsh-vasp-panel] ModuleLoader.load failed:', e); } catch (_) { /* noop */ }
  }
})();
