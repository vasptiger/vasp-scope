/**
 * dsh-vasp-scope 宿主半边测试。
 *
 * 不需要真的连集群：`createHandlers(cfg, { sshRun })` 允许注入假的 ssh 执行器，
 * 于是可以断言"远端返回什么文本 → 路由吐什么 JSON"。
 * 也不需要真装插件：`apply()` 用桩 ctx 驱动，断言它注册了哪些路由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as host from '../lib/host-v7.js';

/* 测试默认关掉「读 assets/token.txt」这个令牌来源（tokenFile: null），
   否则本地一旦写了令牌文件，所有不带令牌的用例都会（正确地）变成 401。 */
const mk = (cfg, deps = {}) => host.createHandlers(cfg, { tokenFile: null, ...deps });

const CFG = {
  sshHost: 'mycluster',
  roots: ['/home/user/projects/demo'],
  defaultScanRoot: '/home/user/projects/demo',
  maxReadBytes: 4096,
};

function fakeRes() {
  return {
    code: 0, headers: null, body: '',
    writeHead(c, h) { this.code = c; this.headers = h; },
    end(b) { this.body = b ?? ''; },
  };
}
const req = url => ({ url });
const bodyOf = res => JSON.parse(res.body);
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------- 契约

test('package.json：不能带 UTF-8 BOM（JSON.parse 会直接失败，插件就装不起来）', () => {
  /* 这个坑真踩过：Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
     而 DSH 读清单走 JSON.parse → 带 BOM 直接抛。命令行改清单后必跑这条。 */
  const raw = readFileSync(new URL('../package.json', import.meta.url));
  assert.ok(!(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF), 'package.json 带 UTF-8 BOM');
  const j = JSON.parse(raw.toString('utf8'));
  assert.equal(j.name, 'dsh-vasp-scope');
  assert.equal(j.main, 'lib/host-v7.js');
  assert.equal(j.exports['./client'], './lib/client.js', 'exports 指向客户端半边');
  assert.equal(j.dsh.client.platform, 'web');
});

test('导出契约：name / inject / Config / apply', () => {
  assert.equal(host.name, 'dsh-vasp-scope');
  assert.deepEqual(host.inject, []);
  assert.equal(typeof host.apply, 'function');
  assert.equal(typeof host.Config, 'function', 'Config 应是 schemastery 的工厂');
  const cfg = new host.Config({});
  assert.deepEqual(cfg.roots, ['/home/user/projects/demo']);
  assert.equal(cfg.maxReadBytes, 512 * 1024);
});

// ---------------------------------------------------------------- 路径安全

test('路径白名单：拒绝越界与相对路径', async () => {
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout: '', stderr: '' }) });
  for (const bad of ['/etc/passwd', '/home/user/projects/demo/../../etc', 'relative/path', '/home/user']) {
    const res = fakeRes();
    await h.scan(req('/plugins/dsh-vasp-scope/scan?root=' + encodeURIComponent(bad)), res);
    assert.equal(res.code, 400, `应拒绝: ${bad}`);
  }
  const res = fakeRes();
  await h.list(req('/plugins/dsh-vasp-scope/list?dir=' + encodeURIComponent('/home/user/projects/demoX')), res);
  assert.equal(res.code, 400, '前缀相似但不在白名单内的目录也要拒绝');
});

// ---------------------------------------------------------------- scan

test('scan：解析远端 T| 行，并带 TTL 缓存', async () => {
  let calls = 0;
  const sshRun = async (hostName, script) => {
    calls++;
    assert.ok(script.includes("ROOT='/home/user/projects/demo'"), '脚本应带 root');
    /* 深度：实测环境的 nf/nf/nf 链有十几层 → 默认 16、上限 32（用户要求「钻到最后一级」） */
    assert.ok(script.includes('-maxdepth 8'), '默认深度 8');
    return { code: 0, stdout: 'T|demo/sys1|4525465|1930|1\nT|proj2/mg3|12916079|67659|70\n__END__\n', stderr: '' };
  };
  const h = mk(CFG, { sshRun });
  const r1 = fakeRes();
  await h.scan(req('/plugins/dsh-vasp-scope/scan'), r1);
  const b1 = bodyOf(r1);
  assert.equal(r1.code, 200);
  assert.equal(b1.count, 2);
  assert.equal(b1.tasks[0].rel, 'demo/sys1');
  assert.equal(b1.tasks[1].ionic, 70);
  assert.equal(b1.cached, false);

  const r2 = fakeRes();
  await h.scan(req('/plugins/dsh-vasp-scope/scan'), r2);
  assert.equal(bodyOf(r2).cached, true, '第二次应命中缓存');
  assert.equal(calls, 1, '缓存命中不应再走 ssh');
});

test('scan：远端无此目录 → 404', async () => {
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout: '__NOROOT__\n', stderr: '' }) });
  const res = fakeRes();
  await h.scan(req('/plugins/dsh-vasp-scope/scan'), res);
  assert.equal(res.code, 404);
});

/* 扫描必须顺带回「元素顺序 / 计数 / INCAR 子集 / 关键产物文件 / 状态标记」——
   面板的「元素顺序·计数」列、「计算类型」与「状态」列要用它们。缺了这些，
   未点开的任务整列是空的、状态恒为「待检查」（用户实测报过：看不出是结构优化还是电荷）。 */
test('scan：带回元素/计数/INCAR 子集/产物文件/状态标记（面板不必等点开任务）', async () => {
  const stdout = [
    'T|demo/sys1|4525465|1930|1|Li O Mn|1 32 16|ICHARG=11,NSW=0,IBRION=-1,|CHGCAR,DOSCAR,|1|1|0|120',
    'T|proj2/mg3|12916079|67659|70|Mg O Mn|3 32 16|IBRION=2,NSW=60,ISIF=3,|CHGCAR,|0|1|0|86400',
    'T|err/x|200|100|3|O Mn|32 16|||1|0|1|999999',
    'T|noage/x|200|100|0|O Mn|32 16||CHGCAR,|1|0|0|',
    'T|empty/x|100|0|0|||||0|0|0|5',
    '__END__',
  ].join('\n');
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout, stderr: '' }) });
  const res = fakeRes();
  await h.scan(req('/plugins/dsh-vasp-scope/scan'), res);
  const b = bodyOf(res);
  assert.equal(b.tasks[0].els, 'Li O Mn');
  assert.equal(b.tasks[0].cnt, '1 32 16');
  assert.equal(b.tasks[0].inc, 'ICHARG=11,NSW=0,IBRION=-1,');
  assert.equal(b.tasks[0].fl, 'CHGCAR,DOSCAR,');
  /* 状态标记 */
  assert.deepEqual([b.tasks[0].done, b.tasks[0].acc, b.tasks[0].err, b.tasks[0].age],
    [1, 1, 0, 120], '正常收尾 + 收敛达标 + 2 分钟前更新');
  assert.deepEqual([b.tasks[1].done, b.tasks[1].acc, b.tasks[1].err, b.tasks[1].age],
    [0, 1, 0, 86400], '没有收尾行 + 一天没更新 → 面板会判成未正常结束');
  assert.deepEqual([b.tasks[2].done, b.tasks[2].acc, b.tasks[2].err, b.tasks[2].age],
    [1, 0, 1, 999999], '有收尾行但也有错误关键字（错误优先，由面板判）');
  assert.equal(b.tasks[3].age, null, 'age 字段为空串时必须给 null（给 0 会被当成「正在运行」）');
  assert.equal(b.tasks[4].fl, '', '没有产物文件时该字段为空串');
  assert.deepEqual([b.tasks[4].els, b.tasks[4].cnt, b.tasks[4].inc, b.tasks[4].fl], ['', '', '', ''],
    '字段全空时不能把后面的字段串位');
  assert.equal(b.tasks[4].ionic, 0);
});

test('scanScript：包含元素/计数/INCAR/产物/状态标记的抽取，且不额外增加 ssh 往返', () => {
  const s = host.scanScript('/home/user/projects/demo', 6);
  assert.ok(s.includes("sed -n '6p'"), '应读结构文件第 6 行（元素或 VASP4 计数）');
  assert.ok(s.includes("sed -n '7p'"), '应读第 7 行（VASP5 计数）');
  assert.ok(s.includes('TITEL'), 'VASP4 格式应从 POTCAR 的 TITEL 补元素');
  assert.ok(/IBRION\|NSW\|ISIF/.test(s), '应 grep 判定计算类型要用的 INCAR 键');
  /* 去空白必须逐行（sed）：`tr -d '[:space:]'` 会把换行也删掉 → 键全粘成一行 →
     面板只认得出第一个键 → 类型列大面积「—」（实测环境重现过一次，39 个里只对了 5 个）。
     只检查**真正的命令行**（注释里也会提到这个坑，别被自己的注释绊倒）。 */
  const incLine = s.split('\n').find(l => l.includes('inc=$(')) || '';   // v60：回退定义与 inc 同行，不再要求行首
  assert.ok(incLine.includes("sed 's/[[:space:]]//g'"), 'inc 那一行应逐行 sed 去空白');
  assert.ok(!incLine.includes('tr -d'), 'inc 那一行不能用 tr -d 去空白（它连换行一起删，键会粘连）');
  assert.ok(s.includes('I="$d/../INCAR"'), 'INCAR 缺失时应回上一级取（NEB image 目录里没有 INCAR）');
  assert.ok(s.includes('K="$d/../KPOINTS"'), 'KPOINTS 缺失时应回上一级取（NEB image 目录里没有 KPOINTS）');
  assert.ok(incLine.includes("tr '\\n' ','"), '键之间应以逗号分隔');
  /* nion 不能用 `grep -c … || echo 0`：grep -c 在匹配数为 0 时退出码是 1（不是错误），
     `|| echo 0` 会追加第二个 0 → 变量里混进换行 → 整条 T| 行被劈成两半、
     后面 8 个字段全丢（实测环境 shared 上 134 个任务中过招）。 */
  const nionLine = s.split('\n').find(l => l.trim().startsWith('nion=$(grep -c')) || '';
  assert.ok(nionLine.includes('|| true'), 'nion 那行应该用 || true 吞掉退出码');
  assert.ok(!nionLine.includes('|| echo 0'), 'nion 那行不能用 || echo 0（匹配数为 0 时会多打印一个 0）');
  assert.ok(s.includes('nion=${nion:-0}'), 'nion 的另一处赋值要单独兜底缺省值');
  assert.ok(s.includes('CHGCAR CHG DOSCAR'), '应探测关键产物文件');
  /* 状态标记：必须只读 OUTCAR 尾部（大文件全文 grep 会把扫描拖死） */
  assert.ok(s.includes('tail -c 200000'), '状态标记应只读 OUTCAR 尾部 200 KB');
  assert.ok(s.includes('General timing and accounting'), '缺「正常收尾行」判据');
  assert.ok(s.includes('reached required accuracy'), '缺「弛豫收敛达标」判据');
  assert.ok(s.includes('VERY BAD NEWS') && s.includes('ZBRENT: fatal error'), '缺致命错误关键字');
  assert.ok(s.includes('I REFUSE TO CONTINUE'), '缺 VASP 的「我不干了」关键字（实测环境 proj2/mg2 就是这样死的）');
  assert.ok(s.includes('stat -c%Y'), '缺 OUTCAR mtime（判断还在不在写）');
  assert.equal((s.match(/^find /gm) || []).length, 1, '仍然只有一次 find（一次往返）');
  assert.equal((s.match(/tail -c 200000/g) || []).length, 1, '每个任务只 tail 一次 OUTCAR');
  /* KPOINTS 类型（按用户要求：不是 x*x*x 自动网格 → 能带路径）。
     宿主侧算好，T| 行尾多一个字段；面板据此判能带，不必为每个任务多读一个文件。 */
  assert.ok(s.includes("head -8 \"$K\""), '应只读 KPOINTS 前 8 行判类型');
  assert.ok(/line\|exit/.test(s.replace(/\s+/g, '')) || s.includes('Line-mode'), '缺 line-mode 判据');
  assert.ok(/\|\\\$kp"/.test(s) || s.includes('|$kp"'), 'T| 行尾应带上 kp 字段');
});

test('kpointsKind：网格 / line-mode / 显式列表 / 缺文件', () => {
  const grid = 'Automatic mesh\n0\nGamma\n5 5 5\n0 0 0\n';
  const grid2 = 'K-POINTS\n0\nMonkhorst-Pack\n3 3 3\n0 0 0\n';
  const line = 'K-Path for band\n40\nLine-mode\nReciprocal\n0 0 0 ! G\n0.5 0 0 ! X\n';
  const line2 = 'band\n20\nL\nReciprocal\n0.0 0.0 0.0 1\n0.5 0.0 0.0 1\n';
  const explicit = 'Explicit list\n4\nReciprocal\n0 0 0 1\n0.25 0 0 1\n0.5 0 0 1\n0.75 0 0 1\n';
  assert.equal(host.kpointsKind(grid), 'grid', 'Gamma + 5 5 5 应为网格');
  assert.equal(host.kpointsKind(grid2), 'grid', 'Monkhorst-Pack + 3 3 3 应为网格');
  assert.equal(host.kpointsKind(line), 'line', 'Line-mode 应为能带路径');
  assert.equal(host.kpointsKind(line2), 'line', '简写 L 也要认（VASP 两种写法都收）');
  assert.equal(host.kpointsKind(explicit), 'other', '显式 k 点列表不是 x*x*x 网格 → other（面板按能带算）');
  assert.equal(host.kpointsKind(''), '', '空 → 空');
  assert.equal(host.kpointsKind('   \n\n'), '', '全空白 → 空');
  /* 注释行不能干扰判定（"0 0 0 ! G" 里的注释已剥掉） */
  assert.equal(host.kpointsKind('T\n0\nGamma\n1 1 1\n0 0 0 ! gamma\n'), 'grid', '带注释的网格仍是网格');
});

// ---------------------------------------------------------------- list

test('list：全量文件清单（不设白名单）', async () => {
  const sshRun = async () => ({
    code: 0, stderr: '',
    stdout: 'CONTCAR|5704|1790489152.99\nINCAR|1308|1790484325.86\n4473.user.log|48587|1790489152.99\n__END__\n',
  });
  const h = mk(CFG, { sshRun });
  const res = fakeRes();
  await h.list(req('/plugins/dsh-vasp-scope/list?dir=' + encodeURIComponent('/home/user/projects/demo/proj2/mg1')), res);
  const b = bodyOf(res);
  assert.equal(b.count, 3);
  assert.deepEqual(b.files.map(f => f.name), ['CONTCAR', 'INCAR', '4473.user.log']);
  assert.equal(b.files[2].size, 48587);
  assert.equal(typeof b.files[0].mtime, 'number');
});

// ---------------------------------------------------------------- read

test('read：base64 解码 + offset/limit 生效 + 上限封顶', async () => {
  const payload = 'INCAR 内容\nEDIFFG = -0.02\n';
  let seen = '';
  const sshRun = async (h2, script) => {
    seen = script;
    return { code: 0, stderr: '', stdout: 'SIZE|24512532\n' + b64(payload) + '\n__END__\n' };
  };
  const h = mk(CFG, { sshRun });
  const res = fakeRes();
  await h.read(req('/plugins/dsh-vasp-scope/read?file=' + encodeURIComponent('/home/user/projects/demo/a/OUTCAR') + '&offset=100&limit=99999'), res);
  const b = bodyOf(res);
  assert.equal(b.text, payload, 'base64 应解回原文');
  assert.equal(b.size, 24512532);
  assert.ok(seen.includes('tail -c +101'), 'offset=100 应转成 tail -c +101');
  assert.ok(seen.includes('head -c 4096'), 'limit 应被 maxReadBytes=4096 封顶');
});

test('read：文件不存在 → 404', async () => {
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout: '__NOFILE__\n', stderr: '' }) });
  const res = fakeRes();
  await h.read(req('/plugins/dsh-vasp-scope/read?file=' + encodeURIComponent('/home/user/projects/demo/a/X')), res);
  assert.equal(res.code, 404);
});

// ---------------------------------------------------------------- convergence

test('convergence：解析 I/F 行', async () => {
  const sshRun = async () => ({
    code: 0, stderr: '',
    stdout: 'I 1 -370.16437\nI 2 -370.89224\nF 2.372811 1.453200\nF 1.643887 0.901000\n__END__\n',
  });
  const h = mk(CFG, { sshRun });
  const res = fakeRes();
  await h.convergence(req('/plugins/dsh-vasp-scope/convergence?dir=' + encodeURIComponent('/home/user/projects/demo/demo/mg/nf')), res);
  const b = bodyOf(res);
  assert.equal(b.ionic.length, 2);
  assert.deepEqual(b.ionic[1], [2, -370.89224]);
  assert.equal(b.forces.length, 2);
  assert.equal(b.forces[0][0], 2.372811);
});

// ---------------------------------------------------------------- ssh 失败

test('ssh 失败 → 502 且带上 stderr 摘要', async () => {
  const h = mk(CFG, { sshRun: async () => ({ code: 255, stdout: '', stderr: 'Permission denied (publickey)' }) });
  const res = fakeRes();
  await h.scan(req('/plugins/dsh-vasp-scope/scan'), res);
  assert.equal(res.code, 502);
  assert.match(bodyOf(res).detail, /Permission denied/);
});

test('未配置 sshHost 时 sshRun 明确报错', async () => {
  const r = await host.sshRun('', 'echo hi');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /sshHost/);
});

// ---------------------------------------------------------------- apply

test('apply：桩 ctx 下注册全部路由', () => {
  const registered = [];
  const services = [];
  const ctx = {
    get: k => (k === 'webServer' ? { register: opt => { registered.push(opt.path); return () => {}; } } : undefined),
    effect: (fn, label) => { fn(); return () => {}; },
    on: (ev, fn) => { services.push([ev, fn]); },
    logger: { info() {} },
  };
  host.apply(ctx, new host.Config({}));
  const want = ['diag', 'ping', 'panel', 'hello', 'scan', 'list', 'read', 'convergence', 'task', 'plot', 'img']
    .map(s => '/plugins/dsh-vasp-scope/' + s);
  for (const w of want) assert.ok(registered.includes(w), '缺少路由 ' + w);
  assert.equal(registered.length, want.length);
  assert.equal(services[0][0], 'internal/service', '应监听 internal/service 以等待 webServer 就绪');
});

test('apply：webServer 后到时靠 internal/service 事件补注册', () => {
  let ws;
  const registered = [];
  const handlers = {};
  const ctx = {
    get: k => (k === 'webServer' ? ws : undefined),
    effect: (fn) => { fn(); return () => {}; },
    on: (ev, fn) => { handlers[ev] = fn; },
    logger: { info() {} },
  };
  host.apply(ctx, new host.Config({}));
  assert.equal(registered.length, 0, '首次没有 webServer，不应注册');
  ws = { register: opt => { registered.push(opt.path); return () => {}; } };
  handlers['internal/service']('webServer');
  assert.equal(registered.length, 11, '服务就绪后应补齐 11 条路由');
  handlers['internal/service']('webServer');
  assert.equal(registered.length, 11, '不应重复注册');
});

// ---------------------------------------------------------------- ping / panel

test('ping 返回配置摘要', async () => {
  const h = mk(CFG, {});
  const res = fakeRes();
  await h.ping(req('/plugins/dsh-vasp-scope/ping'), res);
  const b = bodyOf(res);
  assert.equal(b.ok, true);
  assert.equal(b.sshHost, 'mycluster');
  assert.deepEqual(b.roots, ['/home/user/projects/demo']);
});

// ---------------------------------------------------------------- 结构解析

const POSCAR_DIRECT = [
  'Mg Mn O', '1.0',
  '  8.2528 0.0000 0.0000',
  '  0.0000 8.3074 0.0000',
  '  0.0000 0.0000 8.4270',
  'Mg Mn O', '1 1 1', 'Direct',
  '  0.100000 0.200000 0.300000',
  '  0.400000 0.500000 0.600000',
  '  0.700000 0.800000 0.900000',
].join('\n');

const POSCAR_CART = [
  'Mg1 O1', '1.0',
  '  2.0 0.0 0.0',
  '  0.0 2.0 0.0',
  '  0.0 0.0 2.0',
  'Mg O', '1 1', 'Cartesian',
  '  1.0 0.0 0.0',
  '  0.0 2.0 0.0',
].join('\n');

test('parseVasp：Direct 保留分数坐标', () => {
  const s = host.parseVasp(POSCAR_DIRECT);
  assert.deepEqual(s.cnt, [1, 1, 1]);
  assert.deepEqual(s.els, ['Mg', 'Mn', 'O']);
  assert.equal(s.lat.length, 3);
  assert.ok(Math.abs(s.lat[0][0] - 8.2528) < 1e-9);
  assert.deepEqual(s.frac[0], [0.1, 0.2, 0.3]);
  assert.equal(s.frac.length, 3);
});

test('parseVasp：Cartesian 会被换算成分数坐标', () => {
  const s = host.parseVasp(POSCAR_CART);
  // 笛卡尔 (1,0,0) / 边长 2 → 分数 0.5
  assert.ok(Math.abs(s.frac[0][0] - 0.5) < 1e-9, '笛卡尔→分数换算错误');
  assert.ok(Math.abs(s.frac[0][1] - 0) < 1e-9);
  // (0,2,0) / 2 → 1.0
  assert.ok(Math.abs(s.frac[1][1] - 1.0) < 1e-9);
});

test('parseVasp：坏输入要抛错而不是静默返回垃圾', () => {
  assert.throws(() => host.parseVasp('x\ny\nz\n'), /晶格|计数|Direct/);
});

test('parseIncar：键值表', () => {
  const o = host.parseIncar('SYSTEM = surface\nISIF = 3   # 备注\nEDIFFG = -0.02 ! 注释\n\n# 整行注释\nENCUT=500\n');
  assert.equal(o.SYSTEM, 'surface');
  assert.equal(o.ISIF, '3');
  assert.equal(o.EDIFFG, '-0.02');
  assert.equal(o.ENCUT, '500');
});

// ---------------------------------------------------------------- task 路由

const TASK_OUT = [
  '@FILES', 'CONTCAR|5704|1790489152.99', 'INCAR|1308|1790484325.86', '@FILE INCAR',
  'SYSTEM = surface', 'ISIF = 3', '@FILE CONTCAR', POSCAR_DIRECT, '@CONV',
  'I 1 -370.16437', 'I 2 -370.89224', 'F 2.372811 1.453200', 'F 1.643887 0.901000',
  '@SCF',
  'S 1 1 -370.16437 12.5 1.20E+02 null',
  'S 1 2 -370.89224 -0.72787 3.40E+00 null',
  'S 2 1 -370.89224 -0.10000 8.00E-03 null',
  '__END__', '',
].join('\n');

test('parseTaskOutput：分节解析 + 能量与力对齐', () => {
  const o = host.parseTaskOutput(TASK_OUT);
  assert.equal(o.files.length, 2);
  assert.equal(o.files[0].name, 'CONTCAR');
  assert.equal(o.incar.SYSTEM, 'surface');
  assert.ok(o.structures.CONTCAR, '应解析出 CONTCAR');
  assert.equal(o.structures.CONTCAR.cnt.reduce((a, b) => a + b, 0), 3);
  assert.equal(o.ionic.length, 2);
  // 面板用的 [step, E, maxF, rmsF]
  assert.deepEqual(o.ionic[0], [1, -370.16437, 2.372811, 1.4532]);
  assert.deepEqual(o.ionic[1], [2, -370.89224, 1.643887, 0.901]);
});

test('parseTaskOutput：远端目录不存在 → null', () => {
  assert.equal(host.parseTaskOutput('__NODIR__\n'), null);
});

// ------------------------------------------------- 电子步（SCF）：静态单点唯一能看的曲线

/* 电子步抽取的输出契约：`S <离子步> <电子步> <E> <dE> <rms> <rms(c)>`。
   awk 那一半没法在 Windows 上单测（本机没有 awk），它由 live-smoke.mjs 打真集群验证；
   这里对应的真实 OSZICAR 输入（vasp.6.3.2，demo/sys1/nf/nf）留作对照：
     DAV:   1     0.606302983290E+04    0.60630E+04   -0.21981E+05  6336   0.185E+03
     DAV:   2     0.496072884585E+03   -0.55670E+04   -0.51797E+04  6336   0.564E+02
           1 F= -.484062419722E+03 E0= -.484062419722E+03  d E =-.484062E+03
     DAV:   1    -0.484062419722E+03   -0.10000E+01   -0.10000E+01  7000   0.120E-02   0.300E-02
     DAV:   2    -0.484062419900E+03   -0.17800E-06   -0.17800E-06  7000   0.618E-04
           2 F= -.484062419900E+03 E0= -.484062419900E+03  d E =-.178000E-06 */
const SCF_LINES = [
  'S 1 1 0.606302983290E+04 0.60630E+04 0.185E+03 null',
  'S 1 2 0.496072884585E+03 -0.55670E+04 0.564E+02 null',
  'S 2 1 -0.484062419722E+03 -0.10000E+01 0.120E-02 0.300E-02',
  'S 2 2 -0.484062419900E+03 -0.17800E-06 0.618E-04 null',
].join('\n');

test('电子步抽取：taskScript / convScript 都要带 @SCF 分节，且 istep 从 1 起', () => {
  assert.ok(host.taskScript('/x').includes('@SCF'), 'taskScript 缺 @SCF 分节');
  const cs = host.convScript('/x');
  assert.ok(cs.includes('BEGIN { istep = 1 }'), 'convScript 的电子步抽取未初始化 istep');
  assert.ok(cs.includes('/^[A-Za-z]+ *:/'), 'convScript 缺少算法标记（DAV:/CG :）匹配');
});

test('parseTaskOutput：电子步按离子步分组，列序 [离子步,电子步,E,dE,rms,rms(c)]，缺列 null', () => {
  const out = ['@FILES', '@CONV', 'I 1 -484.062419722', 'I 2 -484.0624199', '@SCF', SCF_LINES, '__END__'].join('\n');
  const o = host.parseTaskOutput(out);
  assert.equal(o.nScf, 4, '应抽到 4 个电子步');
  assert.deepEqual(o.scf[0].slice(0, 2), [1, 1], '第 1 个离子步的第 1 个电子步');
  assert.ok(Math.abs(o.scf[0][2] - 6063.0298329) < 1e-6, `E=${o.scf[0][2]}`);
  assert.ok(Math.abs(o.scf[0][3] - 6063.0) < 1e-6, `dE=${o.scf[0][3]}`);
  assert.ok(Math.abs(o.scf[0][4] - 185.0) < 1e-6, `rms=${o.scf[0][4]}`);
  assert.equal(o.scf[0][5], null, '第 1 个离子步没有 rms(c) → null');
  assert.deepEqual(o.scf[1].slice(0, 2), [1, 2], '同一离子步的第 2 个电子步');
  assert.deepEqual(o.scf[2].slice(0, 2), [2, 1], '离子步边界应跟着 F= 汇总行翻页');
  assert.ok(Math.abs(o.scf[2][5] - 0.003) < 1e-9, `第 2 步带 rms(c)=${o.scf[2][5]}`);
  assert.equal(o.scf[3][5], null, '同一离子步第 2 个电子步没有 rms(c)');
  assert.equal(o.scf[3][4], 6.18e-5, 'rms 要按科学计数法解析');
  assert.equal(o.ionic.length, 2, '电子步不该干扰离子步');
});

test('convergence 路由：也把电子步 scf 返回给调用方', async () => {
  const stdout = ['I 1 -484.062419722', 'S 1 1 -484.062419722 -1.0 0.12 null',
                  'S 1 2 -484.062419900 -1.78e-7 6.18e-05 null', 'F 0.1 0.05', '__END__'].join('\n');
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout, stderr: '' }) });
  const res = fakeRes();
  await h.convergence(req('/plugins/dsh-vasp-scope/convergence?dir=' + encodeURIComponent('/home/user/projects/demo/demo/sys1/nf/nf')), res);
  assert.equal(res.code, 200);
  const b = bodyOf(res);
  assert.equal(b.nScf, 2);
  assert.deepEqual(b.scf[0], [1, 1, -484.062419722, -1.0, 0.12, null]);
  assert.equal(b.ionic.length, 1);
  assert.equal(b.forces.length, 1);
});

test('task 路由：注入假 ssh，校验返回结构', async () => {
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout: TASK_OUT, stderr: '' }) });
  const res = fakeRes();
  await h.task(req('/plugins/dsh-vasp-scope/task?dir=' + encodeURIComponent('/home/user/projects/demo/demo/mg/nf')), res);
  assert.equal(res.code, 200);
  const b = bodyOf(res);
  assert.equal(b.rel, 'demo/mg/nf');
  assert.equal(b.files.length, 2);
  assert.ok(b.structures.CONTCAR);
  assert.equal(b.ionic.length, 2);
  // 面板的实时路径要用 j.scf 填 CONV（否则静态单点任务在「电子步 SCF」口径下永远是空图）
  assert.equal(b.nScf, 3, '/task 必须带上电子步');
  assert.deepEqual(b.scf[0], [1, 1, -370.16437, 12.5, 120, null]);
  /* 加了 @SCF 分节之后，力数据不许丢：ionic 行的后两列就是 maxF/rmsF。
     （实测环境冒烟抓到过一次回归：FORCES 的 awk 被放到了 @SCF 后面 → 力全丢。） */
  assert.equal(b.nForces, 2, '力数据不许因为新增分节而丢失');
  assert.deepEqual(b.ionic[0], [1, -370.16437, 2.372811, 1.4532]);
  assert.deepEqual(b.ionic[1], [2, -370.89224, 1.643887, 0.901]);
});

test('task 路由：老面板（不认识 scf）也照样能用 —— 多出来的字段是纯增量', async () => {
  const h = mk(CFG, { sshRun: async () => ({ code: 0, stdout: TASK_OUT, stderr: '' }) });
  const res = fakeRes();
  await h.task(req('/plugins/dsh-vasp-scope/task?dir=' + encodeURIComponent('/home/user/projects/demo/demo/mg/nf')), res);
  const b = bodyOf(res);
  assert.equal(b.ionic.length, 2, 'ionic 结构未变');
  assert.deepEqual(Object.keys(b).filter(k => /scf/i.test(k)), ['scf', 'nScf'], '只新增 scf/nScf 两个键');
});

test('task 路由：ttl=0 绕过缓存', async () => {
  let calls = 0;
  const h = mk(CFG, { sshRun: async () => { calls++; return { code: 0, stdout: TASK_OUT, stderr: '' }; } });
  const url = '/plugins/dsh-vasp-scope/task?dir=' + encodeURIComponent('/home/user/projects/demo/demo/mg/nf') + '&ttl=0';
  await h.task(req(url), fakeRes());
  await h.task(req(url), fakeRes());
  assert.equal(calls, 2, 'ttl=0 时不应命中缓存');
});

test('CORS：响应必须带 access-control-allow-origin（面板从 file:// 取数）', async () => {
  const h = mk(CFG, {});
  const res = fakeRes();
  await h.ping(req('/plugins/dsh-vasp-scope/ping'), res);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

// ---------------------------------------------------------------- 回归：末尾无换行符

test('回归：标记黏在上一行末尾也要能切分（INCAR 末尾没有换行符）', () => {
  // 实测环境实测到的样子：INCAR 最后一行紧跟 @FILE CONTCAR，中间没有换行符
  const glued = [
    '@FILES', 'CONTCAR|5924|1.0', '@FILE INCAR', 'SYSTEM = surface',
    'ISIF = 3   # 末行没有换行符，标记会黏上来@FILE CONTCAR',
    ...POSCAR_DIRECT.split('\n'), '@CONV', 'I 1 -370.16437', 'F 0.01 0.02', '__END__', '',
  ].join('\n');
  const o = host.parseTaskOutput(glued);
  assert.ok(o.structures.CONTCAR, 'CONTCAR 必须被解析出来（曾经被 INCAR 的尾巴整节吞掉）');
  assert.deepEqual(o.structures.CONTCAR.cnt, [1, 1, 1]);
  assert.equal(o.incar.SYSTEM, 'surface');
  assert.equal(o.incar.ISIF, '3', '黏连那行里的键值也不该丢');
  assert.equal(o.files.length, 1);
  assert.equal(o.ionic.length, 1);
});

test('taskScript：每个标记前都先补换行（printf 而非裸 echo）', () => {
  const s = host.taskScript('/home/user/projects/demo/proj2/mg3');
  assert.ok(s.includes("printf '\\n@FILES\\n'"), '@FILES 前应补换行');
  assert.ok(s.includes("printf '\\n@FILE %s\\n' \"$f\""), '@FILE 前应补换行');
  assert.ok(s.includes("printf '\\n@CONV\\n'"), '@CONV 前应补换行');
  assert.ok(s.includes("printf '\\n__END__\\n'"), '__END__ 前应补换行');
  assert.ok(!/^echo "@FILE/m.test(s), '不应再用裸 echo 打标记（会被无换行结尾的文件吞掉）');
});

// ---------------------------------------------------------------- 鉴权

const CFG_TOKEN = { ...CFG, token: 'T0KEN-abc123' };
const reqH = (url, headers) => ({ url, headers });

test('鉴权：未配令牌时不拦截（向后兼容）', async () => {
  const h = mk(CFG, {});
  const res = fakeRes();
  await h.ping(req('/plugins/dsh-vasp-scope/ping'), res);
  assert.equal(res.code, 200);
});

test('鉴权：配了令牌 → 不带令牌一律 401', async () => {
  const h = mk(CFG_TOKEN, {});
  for (const url of ['/ping', '/scan', '/list?dir=/x', '/read?file=/x', '/task?dir=/x', '/panel', '/diag', '/hello']) {
    const res = fakeRes();
    await h[url.split('?')[0].slice(1) === '' ? 'ping' : url.split('?')[0].slice(1)](req('/plugins/dsh-vasp-scope' + url), res);
    assert.equal(res.code, 401, `应拦截: ${url}`);
    const b = bodyOf(res);
    assert.equal(b.error, 'authentication required');
    assert.match(b.hint, /token/);
  }
});

test('鉴权：?token= 正确则放行', async () => {
  const h = mk(CFG_TOKEN, {});
  const res = fakeRes();
  await h.ping(req('/plugins/dsh-vasp-scope/ping?token=T0KEN-abc123'), res);
  assert.equal(res.code, 200);
});

test('鉴权：请求头 x-vasp-token 正确则放行（面板用的是这条）', async () => {
  const h = mk(CFG_TOKEN, {});
  const res = fakeRes();
  await h.ping(reqH('/plugins/dsh-vasp-scope/ping', { 'x-vasp-token': 'T0KEN-abc123' }), res);
  assert.equal(res.code, 200);
});

test('鉴权：令牌错误 → 401', async () => {
  const h = mk(CFG_TOKEN, { sshRun: async () => ({ code: 0, stdout: '', stderr: '' }) });
  for (const bad of ['?token=wrong', '?token=', '?token=T0KEN-abc12']) {
    const res = fakeRes();
    await h.scan(req('/plugins/dsh-vasp-scope/scan' + bad), res);
    assert.equal(res.code, 401, `应拦截: ${bad}`);
  }
});

test('鉴权：非回环 Host 一律拒绝（防 DNS rebinding），即使令牌正确', async () => {
  const h = mk(CFG_TOKEN, {});
  for (const badHost of ['evil.com', 'evil.com:19387', '192.168.1.5:19387']) {
    const res = fakeRes();
    await h.ping(reqH('/plugins/dsh-vasp-scope/ping?token=T0KEN-abc123', { host: badHost, 'x-vasp-token': 'T0KEN-abc123' }), res);
    assert.equal(res.code, 401, `应拒绝 Host: ${badHost}`);
  }
  for (const goodHost of ['127.0.0.1:19387', 'localhost:19387', '[::1]:19387']) {
    const res = fakeRes();
    await h.ping(reqH('/plugins/dsh-vasp-scope/ping', { host: goodHost, 'x-vasp-token': 'T0KEN-abc123' }), res);
    assert.equal(res.code, 200, `应放行 Host: ${goodHost}`);
  }
});

test('鉴权：/panel 也受保护，且带令牌时把令牌注入页面', async () => {
  const h = mk(CFG_TOKEN, {});
  const deny = fakeRes();
  await h.panel(req('/plugins/dsh-vasp-scope/panel'), deny);
  assert.equal(deny.code, 401, '/panel 不该裸奔');

  const okRes = fakeRes();
  await h.panel(req('/plugins/dsh-vasp-scope/panel?token=T0KEN-abc123'), okRes);
  assert.equal(okRes.code, 200);
  assert.match(okRes.body, /window\.__VASP_TOKEN__="T0KEN-abc123"/, '应注入令牌');
  assert.match(okRes.body, /<html/, '注入后仍是完整面板');
});

test('鉴权：解算器 authOk 直测', () => {
  // 第三参 tokenFile=null：关掉文件来源，只测配置来源
  assert.equal(host.authOk({ url: '/x' }, { token: '' }, null), true, '无令牌配置 → 放行');
  assert.equal(host.authOk({ url: '/x' }, { token: 'k' }, null), false, '有配置无令牌 → 拒');
  assert.equal(host.authOk({ url: '/x?token=k' }, { token: 'k' }, null), true);
  assert.equal(host.authOk({ url: '/x', headers: { host: 'evil.com' } }, { token: '' }, null), false, '非回环 Host → 拒');
  // 文件来源：tokenFile 指向一个**测试自己创建的临时文件**
  // ⚠️ 以前这里写死了作者机器上的绝对路径 ✗ → CI 的 Linux 上文件不存在 → readFileSync 抛错 → 三档 Node 全红 ✗
  //    （本地 Windows 恰好存在，所以一直没暴露 ✓）
  const tmpTok = join(tmpdir(), 'vasp-scope-token-' + process.pid + '.txt');
  writeFileSync(tmpTok, 'T0KEN-file-abc\n');
  assert.equal(host.authOk({ url: '/x' }, { token: '' }, tmpTok), false, '文件来源应有令牌 → 拒');
  assert.equal(host.authOk({ url: '/x?token=T0KEN-file-abc' }, { token: '' }, tmpTok), true, '文件来源 + 正确令牌 → 放行');
});


