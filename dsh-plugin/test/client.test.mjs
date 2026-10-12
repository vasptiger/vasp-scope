/**
 * dsh-vasp-scope · 浏览器半边（lib/client.js）单测 —— DOM / 服务桩，不需要浏览器。
 *
 * 桩的规矩：**同一个 id 必须返回同一个对象**（这个坑犯过三次）。
 * 运行：node --test test/client.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLIENT = new URL('../lib/client.js', import.meta.url);
const PANEL = 'D:\\dsh\\vasp-panel.html';

/* ------------------------------------------------------------------ 桩 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useEffect: (fn) => fn(),
  useState: (v) => [v, () => {}],
};

const openFileCalls = [];
const betterSidebar = {
  version: '0.24.1',
  features: ['openFile', 'stateSubscription'],
  getSnapshot: () => ({ sessionId: 'S1', state: {} }),
  openFile: (...args) => openFileCalls.push(args),
};

const slotInject = [];
const slotRegister = [];
const slots = {
  inject: (key, cb) => { slotInject.push({ key, cb }); return () => {}; },
  register: (opts, comp) => { slotRegister.push({ opts, comp }); return () => {}; },
};

const consoleErrors = [];
const consoleWarns = [];
let capturedLoad = null;

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
defineGlobal('window', { __ModuleLoader__: { load: (o) => { capturedLoad = o; } } });
defineGlobal('navigator', { userAgent: 'node-test' });
defineGlobal('console', { log: console.log.bind(console), error: (...a) => consoleErrors.push(a), warn: (...a) => consoleWarns.push(a) });

await import(CLIENT.href + '?t=' + Date.now());

const mod = capturedLoad.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('unexpected require: ' + name);
});

/** 造一个 cordis ctx 桩：services 里给什么就 ctx.get 到什么。 */
function makeCtx(services) {
  return {
    get: (n) => services[n],
    effect: (cb) => { cb(); return () => {}; },
    on: () => () => {},
  };
}
/** 跑一次 apply 并把槽位声明补上，返回注册进去的组件。 */
function mountWith(services) {
  mod.apply(makeCtx(services));
  const inject = slotInject[slotInject.length - 1];
  inject.cb();                                   // 槽位声明 → register
  return { inject, entry: slotRegister[slotRegister.length - 1] };
}

/* ------------------------------------------------------------------ 契约 */
test('模块契约：id = 包名，导出 apply / inject / name', () => {
  assert.equal(capturedLoad.id, 'dsh-vasp-scope');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual([...mod.inject], ['slots']);   // inject 写的是 cordis 服务名
  assert.equal(mod.name, 'dsh-vasp-scope-client');
});

test('源码自检：两条外壳硬规矩（__ModuleLoader__ 包装 + 整体 try/catch）', () => {
  const src = readFileSync(CLIENT, 'utf8');
  assert.ok(src.includes('window.__ModuleLoader__.load'), '缺 __ModuleLoader__.load 包装');
  assert.ok(src.includes('try {') && src.includes('catch'), '缺 try/catch 兜底');
});

/* ------------------------------------------------------------------ 挂载 */
test('挂载：注册进外壳槽位 sidebar.footer.action，用自己的 id/order', () => {
  const { inject, entry } = mountWith({ slots, betterSidebar });
  assert.equal(inject.key, 'sidebar.footer.action');
  assert.equal(entry.opts.name, 'sidebar.footer.action');
  assert.equal(entry.opts.id, 'vasp-panel');       // 自己的格子，不覆盖外壳的 cordis-panel
  assert.equal(entry.opts.order, 60);
  assert.equal(typeof entry.comp, 'function');
});

test('渲染：宽态 = 图标 + 文字；窄态（56px 轨道）= 只留图标', () => {
  const { entry } = mountWith({ slots, betterSidebar });
  const wide = entry.comp({ wide: true });
  assert.equal(wide.type, 'button');
  assert.equal(wide.props['data-dsh-vasppanel-entry'], '');
  assert.ok(wide.children.some((c) => Array.isArray(c.children) && c.children[0] === 'VASP 面板'));

  const narrow = entry.comp({ wide: false });
  assert.equal(narrow.children.length, 1);
});

/* ------------------------------------------------------------------ 点击 */
test('点击：用当前 sessionId 把面板绝对路径开进侧栏', () => {
  openFileCalls.length = 0;
  const { entry } = mountWith({ slots, betterSidebar });
  entry.comp({ wide: true }).props.onClick();
  assert.equal(openFileCalls.length, 1);
  assert.deepEqual(openFileCalls[0][0], { sessionId: 'S1' });
  assert.equal(openFileCalls[0][1], PANEL);
  assert.equal(openFileCalls[0][2], 'VASP 任务面板');
  assert.equal(consoleErrors.length, 0);
});

test('降级：没有 betterSidebar 时不抛、不开面板，只留一条 warn', () => {
  openFileCalls.length = 0;
  consoleWarns.length = 0;
  const { entry } = mountWith({ slots });
  assert.doesNotThrow(() => entry.comp({ wide: true }).props.onClick());
  assert.equal(openFileCalls.length, 0);
  assert.ok(consoleWarns.length >= 1);
});

test('降级：没有活动会话时不抛、不硬开面板', () => {
  openFileCalls.length = 0;
  const noSession = { version: '0.24.1', getSnapshot: () => ({ sessionId: undefined }), openFile: () => openFileCalls.push(1) };
  const { entry } = mountWith({ slots, betterSidebar: noSession });
  assert.doesNotThrow(() => entry.comp({ wide: true }).props.onClick());
  assert.equal(openFileCalls.length, 0);
});

test('极端：连 slots 都没有时 apply 静默返回（绝不冒泡到外壳）', () => {
  assert.doesNotThrow(() => mod.apply(makeCtx({})));
});

test('极端：require("react") 失败时组件返回 null，不抛', () => {
  const isolated = capturedLoad.factory(() => { throw new Error('no react'); });
  slotInject.length = 0;
  slotRegister.length = 0;
  isolated.apply(makeCtx({ slots, betterSidebar }));
  slotInject[slotInject.length - 1].cb();
  const entry = slotRegister[slotRegister.length - 1];
  assert.equal(entry.comp({ wide: true }), null);
});
