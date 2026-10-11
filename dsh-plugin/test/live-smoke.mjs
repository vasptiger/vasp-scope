/**
 * 真机冒烟：用插件自己的 sshRun + 脚本生成器打一次集群，
 * 验证「远端 → 解析 → JSON」整条链路（不安装插件也能验）。
 * 用法：ELECTRON_RUN_AS_NODE=1 "<exe>" live-smoke.mjs
 *
 * 入口从 package.json 的 main 动态解析 —— 入口文件名会随版本递增
 * （见 tools/bump-entry.mjs），写死会失效。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).main;
const host = await import(new URL('../' + MAIN, import.meta.url).href);

const CFG = new host.Config({ sshHost: 'mycluster', roots: ['/home/user/projects/demo'] });
const h = host.createHandlers(CFG);
const req = u => ({ url: u });
const res = () => ({ code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } });
const J = r => JSON.parse(r.body);
const enc = encodeURIComponent;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

console.log('=== 1. ping ===');
const r1 = res(); await h.ping(req('/plugins/dsh-vasp-panel/ping'), r1);
console.log('  ' + r1.body);
ok(J(r1).sshHost === 'mycluster', 'ping 返回 sshHost');

console.log('\n=== 2. scan /home/user/projects/demo（真 ssh）===');
const t0 = Date.now();
const r2 = res();
await h.scan(req('/plugins/dsh-vasp-panel/scan?root=' + enc('/home/user/projects/demo')), r2);
const ms = Date.now() - t0;
if (r2.code !== 200) { console.log('  ✗ HTTP ' + r2.code + '  ' + r2.body.slice(0, 300)); fail++; }
else {
  const b = J(r2);
  console.log(`  用时 ${ms} ms，${b.count} 个任务`);
  for (const t of b.tasks) {
    console.log(`    ${t.rel.padEnd(22)} OUTCAR ${(t.outcar / 1048576).toFixed(1)} MB  离子步 ${t.ionic}`);
  }
  ok(b.count >= 16, `任务数应 ≥16（实得 ${b.count}）`);
  ok(ms < 30000, `一次扫描 ${ms} ms`);
  ok(b.tasks.some(t => t.rel === 'VC/mg3' && t.ionic === 70), 'VC/mg3 应为 70 个离子步');
  // 面板只手工拉了 16 个；扫描能发现全部（含 cij 弹性常数应变序列）
  const cij = b.tasks.filter(t => t.rel.startsWith('cij/'));
  console.log(`  ── 扫描额外发现 ${cij.length} 个 cij 任务（面板里没有）`);
  ok(cij.length > 0, '应能发现 cij/ 下的任务');
}

console.log('\n=== 3. list（真 ssh）===');
const r3 = res();
await h.list(req('/plugins/dsh-vasp-panel/list?dir=' + enc('/home/user/projects/demo/VC/mg1')), r3);
if (r3.code !== 200) { console.log('  ✗ ' + r3.body.slice(0, 200)); fail++; }
else {
  const b = J(r3);
  console.log(`  ${b.count} 个文件；前 5：` + b.files.slice(0, 5).map(f => `${f.name}(${(f.size / 1024).toFixed(0)}KB)`).join(' '));
  ok(b.count > 10, '全量清单应 >10 个文件');
  ok(b.files.some(f => f.name === 'OUTCAR'), '应含 OUTCAR');
}

console.log('\n=== 4. read（真 ssh，分块）===');
const r4 = res();
await h.read(req('/plugins/dsh-vasp-panel/read?file=' + enc('/home/user/projects/demo/VC/mg1/INCAR') + '&offset=0&limit=200'), r4);
if (r4.code !== 200) { console.log('  ✗ ' + r4.body.slice(0, 200)); fail++; }
else {
  const b = J(r4);
  const head = b.text.split('\n').slice(0, 3).join(' | ');
  console.log(`  size=${b.size}  取回 ${b.text.length} 字符`);
  console.log(`  首 3 行: ${head}`);
  ok(b.text.includes('SYSTEM'), 'INCAR 内容应含 SYSTEM');
  ok(b.size > 0 && b.size < 4096, 'INCAR 大小合理');
}

console.log('\n=== 5. convergence（真 ssh）===');
const r5 = res();await h.convergence(req('/plugins/dsh-vasp-panel/convergence?dir=' + enc('/home/user/projects/demo/nd/mg/nf')), r5);
if (r5.code !== 200) { console.log('  ✗ ' + r5.body.slice(0, 200)); fail++; }
else {
  const b = J(r5);
  console.log(`  离子步 ${b.ionic.length}  力行 ${b.forces.length}  电子步 ${b.nScf}`);
  console.log(`  首末能量: ${b.ionic[0]?.[1]} → ${b.ionic[b.ionic.length - 1]?.[1]}`);
  ok(b.ionic.length === 38, `mg/nf 应为 38 个离子步（实得 ${b.ionic.length}）`);
  ok(Math.abs(b.ionic[37][1] + 371.39301) < 0.001, '末步能量应约 -371.39301');
  ok(b.nScf > 0, `/convergence 也应带电子步（实得 ${b.nScf}）`);
}

console.log('\n=== 6. task：单任务全量（真 ssh，一次往返）===');
{
  const t0 = Date.now();
  const r = res();
  await h.task(req('/plugins/dsh-vasp-panel/task?dir=' + enc('/home/user/projects/demo/VC/mg3') + '&ttl=0'), r);
  const ms = Date.now() - t0;
  if (r.code !== 200) { console.log('  ✗ ' + r.body.slice(0, 300)); fail++; }
  else {
    const b = J(r);
    console.log(`  用时 ${ms} ms   rel=${b.rel}   文件 ${b.files.length} 个   离子步 ${b.ionic.length}   力 ${b.nForces} 行`);
    console.log(`  结构: ${Object.keys(b.structures).join(', ')}`);
    const c = b.structures.CONTCAR;
    const a = Math.hypot(c.lat[0][0], c.lat[0][1], c.lat[0][2]);
    console.log(`  CONTCAR: 原子 ${c.frac.length}  元素 ${c.els.join('/')}  计数 ${c.cnt.join(' ')}  a=${a.toFixed(4)}`);
    console.log(`  INCAR: ${Object.keys(b.incar).length} 个键  SYSTEM=${b.incar.SYSTEM}  ISIF=${b.incar.ISIF}`);
    console.log(`  能量: ${b.ionic[0]?.[1]} → ${b.ionic[b.ionic.length - 1]?.[1]}`);
    ok(c.frac.length === 51, `VC/mg3 应 51 个原子（实得 ${c.frac.length}）`);
    ok(c.els.join('/') === 'Mg/O/Mn', `元素顺序应 Mg/O/Mn（实得 ${c.els.join('/')}）`);
    ok(JSON.stringify(c.cnt) === JSON.stringify([3, 32, 16]), `计数应 3 32 16（实得 ${c.cnt.join(' ')}）`);
    ok(b.ionic.length === 70, `VC/mg3 应 70 个离子步（实得 ${b.ionic.length}）`);
    ok(Math.abs(a - 8.2528) < 0.01, `a 应为 8.2528（实得 ${a.toFixed(4)}）`);
    ok(b.incar.ISIF === '3', `INCAR 的 ISIF 应为 3（实得 ${b.incar.ISIF}）`);
    ok(b.files.some(f => f.name === 'OUTCAR'), '文件清单应含 OUTCAR');
    ok(ms < 30000, `一次取单任务全量 ${ms} ms`);
  }
}

console.log('\n=== 7. 路径白名单（真 ssh 不该被调用）===');
const r6 = res();
await h.scan(req('/plugins/dsh-vasp-panel/scan?root=' + enc('/home/shared')), r6);
console.log(`  /home/shared → HTTP ${r6.code}  ${r6.body.slice(0, 120)}`);
ok(r6.code === 400, '白名单外的 root 应被拒（这也说明它不会被误用来扫 shared）');

/* 电子步（SCF）：awk 那一半没有本地单测（Windows 上没有 awk），只能在这里打真集群验。
   基准值来自远端 OSZICAR 的第一行（vasp.6.3.2）：
     DAV:   1     0.606302983290E+04    0.60630E+04   -0.21981E+05  6336   0.185E+03 */
console.log('\n=== 8. 电子步 SCF：静态单点任务（真 ssh，nd/li/nf/nf）===');
{
  const r = res();
  await h.task(req('/plugins/dsh-vasp-panel/task?dir=' + enc('/home/user/projects/demo/nd/li/nf/nf') + '&ttl=0'), r);
  if (r.code !== 200) { console.log('  ✗ ' + r.body.slice(0, 300)); fail++; }
  else {
    const b = J(r);
    const steps = [...new Set(b.scf.map(x => x[0]))];
    console.log(`  离子步 ${b.ionic.length}   电子步 ${b.nScf}   覆盖离子步 [${steps.join(',')}]`);
    console.log(`  首个电子步: E=${b.scf[0]?.[2]}  dE=${b.scf[0]?.[3]}  rms=${b.scf[0]?.[4]}  rms(c)=${b.scf[0]?.[5]}`);
    console.log(`  末个电子步: E=${b.scf.at(-1)?.[2]}  rms=${b.scf.at(-1)?.[4]}`);
    ok(b.ionic.length === 1, `这是静态单点任务（1 个离子步，实得 ${b.ionic.length}）`);
    ok(b.nScf > 5, `静态单点任务必须能抽到电子步（实得 ${b.nScf}）`);
    ok(Math.abs((b.scf[0]?.[2] ?? 0) - 6063.0298329) < 1e-3, `首个电子步 E 应与 OSZICAR 首行一致（实得 ${b.scf[0]?.[2]}）`);
    ok(Math.abs((b.scf[0]?.[4] ?? 0) - 185) < 1e-6, `首个电子步 rms 应为 185（实得 ${b.scf[0]?.[4]}）`);
    ok(b.scf.every(x => x[0] === 1), '单离子步任务的电子步都应归到第 1 个离子步');
    ok(b.scf.at(-1)[4] < 1e-2, `末个电子步 rms 应已收敛（实得 ${b.scf.at(-1)[4]}）`);
    ok(b.scf.every((x, i) => i === 0 || x[1] === b.scf[i - 1][1] + 1 || x[1] === 1), '电子步序号连续（跨离子步重置为 1）');
  }
}

console.log('\n=== 9. 电子步 × 多离子步（真 ssh，VC/mg3）===');
{
  const r = res();
  await h.task(req('/plugins/dsh-vasp-panel/task?dir=' + enc('/home/user/projects/demo/VC/mg3') + '&ttl=0'), r);
  if (r.code !== 200) { console.log('  ✗ ' + r.body.slice(0, 300)); fail++; }
  else {
    const b = J(r);
    const steps = new Set(b.scf.map(x => x[0]));
    console.log(`  离子步 ${b.ionic.length}   电子步 ${b.nScf}   覆盖 ${steps.size} 个离子步`);
    ok(steps.size === b.ionic.length, `每个离子步都应能抽到电子步（${steps.size} vs ${b.ionic.length}）`);
    ok(b.nScf > b.ionic.length, `总电子步数应远多于离子步数（${b.nScf} > ${b.ionic.length}）`);
    ok([...steps].every(s => s >= 1 && s <= b.ionic.length), 'istep 不应越界');
  }
}

console.log('\n=== 10. scan 顺带字段：元素/计数 + INCAR 子集 + 产物文件（真 ssh）===');
{
  const r = res();
  await h.scan(req('/plugins/dsh-vasp-panel/scan?root=' + enc('/home/user/projects/demo')), r);
  if (r.code !== 200) { console.log('  ✗ ' + r.body.slice(0, 200)); fail++; }
  else {
    const b = J(r);
    const n = b.tasks.length;
    const withEls = b.tasks.filter(t => t.els && t.cnt).length;
    const withInc = b.tasks.filter(t => t.inc).length;
    const withFl = b.tasks.filter(t => t.fl).length;
    console.log(`  ${n} 个任务：带元素/计数 ${withEls}，带 INCAR 子集 ${withInc}，带产物标记 ${withFl}`);
    for (const rel of ['nd/li/nf/nf', 'VC/mg3', 'cij/mno/ref', 'nd/mno/nf/dos']) {
      const t = b.tasks.find(x => x.rel === rel);
      if (t) console.log(`    ${rel.padEnd(15)} 元素 ${(t.els || '-').padEnd(10)} 计数 ${(t.cnt || '-').padEnd(10)} inc=${t.inc || '-'} fl=${t.fl || '-'}`);
    }
    ok(withEls >= n * 0.95, `元素/计数覆盖率应 ≥95%（实得 ${withEls}/${n}）`);
    ok(withInc >= n * 0.9, `INCAR 覆盖率应 ≥90%（实得 ${withInc}/${n}）`);
    /* ⚠️ 这几条是真机抓到的回归的防线：宿主脚本曾用 `tr -d '[:space:]'` 去空白，
       它把换行也删了 → 所有键粘成一行（ICHARG=2LDAU=.TRUE.IVDW=11…）→
       面板只认得出第一个键 → 类型列大面积为「—」。**只做子串匹配抓不到**，
       必须验证「一键一值」的逗号分隔结构。 */
    const incTokens = b.tasks.flatMap(t => String(t.inc || '').split(',').filter(Boolean));
    const glued = incTokens.filter(kv => kv.split('=').length !== 2);
    ok(glued.length === 0, `INCAR 子集必须是「一键一值」的逗号分隔（发现 ${glued.length} 个粘连：${glued.slice(0, 3).join(' ')}）`);
    const keysOf = rel => String((b.tasks.find(t => t.rel === rel) || {}).inc || '')
      .split(',').filter(Boolean).map(kv => kv.split('=')[0].toUpperCase());
    const staticKeys = keysOf('nd/li/nf/nf');
    ok(staticKeys.includes('NSW') && staticKeys.includes('IBRION'),
      `NSW / IBRION 必须是各自独立的键（实得 ${staticKeys.join('+')}）`);
    const relaxKeys = keysOf('VC/mg3');
    ok(relaxKeys.includes('IBRION') && relaxKeys.includes('ISIF'), `VC/mg3 的键应含 IBRION/ISIF（实得 ${relaxKeys.join('+')}）`);
    ok(relaxKeys.length >= 2, `一个任务的 INCAR 子集不该只有 1 个键（实得 ${relaxKeys.length}）`);
    const staticOne = b.tasks.find(t => t.rel === 'nd/li/nf/nf');
    ok(staticOne && /NSW=0/.test(staticOne.inc) && /IBRION=-1/.test(staticOne.inc), '静态单点任务应能看出 NSW=0 / IBRION=-1');
    const relax = b.tasks.find(t => t.rel === 'VC/mg3');
    ok(relax && /IBRION=2/.test(relax.inc), 'VC/mg3 应能看出 IBRION=2（结构优化）');
    ok(b.tasks.every(t => !t.els.includes('|') && !t.cnt.includes('|')), '字段里不该混进分隔符（串位会直接看错）');
  }
}

console.log('\n=== 11. 任务状态标记（真 ssh）：只看 OUTCAR 尾部 ===');
{
  const r = res();
  await h.scan(req('/plugins/dsh-vasp-panel/scan?root=' + enc('/home/user/projects/demo')), r);
  if (r.code !== 200) { console.log('  ✗ ' + r.body.slice(0, 200)); fail++; }
  else {
    const b = J(r);
    const n = b.tasks.length;
    const done = b.tasks.filter(t => t.done).length;
    const acc = b.tasks.filter(t => t.acc).length;
    const err = b.tasks.filter(t => t.err).length;
    const fresh = b.tasks.filter(t => t.age !== null && t.age <= 900).length;
    console.log(`  ${n} 个任务：正常收尾行 ${done}，弛豫收敛达标 ${acc}，命中错误关键字 ${err}，900s 内更新 ${fresh}`);
    const ages = b.tasks.map(t => t.age).filter(a => a !== null).sort((x, y) => x - y);
    console.log(`  静默时长：最短 ${(ages[0] / 3600).toFixed(1)} h，中位 ${(ages[ages.length >> 1] / 86400).toFixed(1)} 天，最长 ${(ages[ages.length - 1] / 86400).toFixed(1)} 天`);
    for (const rel of ['VC/mg3', 'nd/li/nf/nf', 'cij/mno/ref']) {
      const t = b.tasks.find(x => x.rel === rel);
      if (t) console.log(`    ${rel.padEnd(14)} done=${t.done} acc=${t.acc} err=${t.err} age=${(t.age / 86400).toFixed(1)} 天`);
    }
    ok(done >= n * 0.9, `大多任务应能认出正常收尾行（实得 ${done}/${n}）`);
    /* 命中错误关键字的任务：**很少**（关键字列表没写宽）；且它们都不该同时有正常收尾行。
       真机第一次跑就揪出一个真失败的：VC/mg2 —— ZBRENT 线搜索失败，
       VASP 自己打了 `I REFUSE TO CONTINUE WITH THIS SICK JOB ... BYE!!!` 然后退出。 */
    const errList = b.tasks.filter(t => t.err).map(t => t.rel);
    console.log(`  命中错误关键字的任务：${errList.length ? errList.join(', ') : '（无）'}`);
    ok(errList.length <= 2, `命中错误的任务应该很少（实得 ${errList.length}：${errList.join(', ')}）`);
    ok(b.tasks.filter(t => t.err).every(t => t.done === 0),
      '致命错误任务不该同时有正常收尾行（VASP 的「I REFUSE」类错误会直接退出）');
    ok(b.tasks.every(t => t.age !== null && t.age >= 0), '每个任务都应带回静默秒数');
    const mg3 = b.tasks.find(t => t.rel === 'VC/mg3');
    ok(mg3 && mg3.done === 1, 'VC/mg3 应已正常收尾（done=1）');
    /* 面板的判定规则照抄一遍，看真实数据会分成什么样 */
    const cls = t => !t.outcar ? 'NO_OUTPUT' : t.err ? 'ERROR' : t.done ? 'DONE' : (t.age <= 900 ? 'RUNNING' : 'ERROR');
    const dist = {};
    for (const t of b.tasks) { const c = cls(t); dist[c] = (dist[c] || 0) + 1; }
    console.log('  按面板规则算出的状态分布：' + JSON.stringify(dist));
    ok(!dist.RUNNING && !dist.NO_OUTPUT, '这批任务都不该被判成「运行中 / 未输出」');
  }
}

console.log('\n=== 12. 原始 T| 行结构（防「变量里混进换行把整行劈断」）===');
{
  /* 这个坑真踩过：`nion=$(grep -c 'F=' … || echo 0)` —— grep -c 在匹配数为 0 时退出码是 1，
     `|| echo 0` 又追加一个 0 → 变量里出现「0+换行+0」→ 整条 T| 行被劈成两半，
     后面 8 个字段（元素/计数/INCAR/产物/状态标记）全丢。
     凡是 OSZICAR 里没有 F= 行的任务都中招（shared 上 134 个）。
     挑一个**确实含这种任务**的子树来验，否则这个守卫形同虚设。 */
  const sub = '/home/shared/projects/axw/vasp6.4.2/BiOX';
  const raw = await host.sshRun('mycluster', host.scanScript(sub, 3), { timeout: 300000 });
  const lines = raw.stdout.split(/\r?\n/).filter(l => l.startsWith('T|'));
  /* 字段数：T + rel/out/osz/nion/els/cnt/inc/fl/done/acc/err/age/kp = 14 */
  const bad = lines.filter(l => l.split('|').length !== 14);
  console.log(`  ${sub} → ${lines.length} 条 T|，字段数≠14 的：${bad.length}`);
  for (const l of bad.slice(0, 3)) console.log('    ' + JSON.stringify(l.slice(0, 160)));
  ok(lines.length > 0, '子树里应扫到任务');
  ok(bad.length === 0, `每条 T| 行都必须是 14 个字段（实得 ${bad.length} 条例外）`);
  /* 该子树里就有 OSZICAR 无 F= 行的任务（nion=0）；修好前它们的字段全丢 */
  const zero = lines.filter(l => l.split('|')[4] === '0');
  ok(zero.length > 0, `该子树应含 nion=0 的任务（实得 ${zero.length}）—— 这正是会触发老 bug 的样本`);
  const withInc = zero.filter(l => l.split('|')[7]);
  console.log(`  nion=0 的任务 ${zero.length} 个，其中带 INCAR 子集的 ${withInc.length} 个`);
  ok(withInc.length > 0, 'nion=0 的任务也必须把 INCAR 子集带回来（修好前这一列是丢的）');

  console.log('\n=== 13. KPOINTS 类型（不是 x*x*x 网格 → 判为能带路径）===');
  const kps = lines.map(l => (l.split('|')[13] || '').trim());
  const tally = {}; for (const v of kps) tally[v || '(空)'] = (tally[v || '(空)'] || 0) + 1;
  console.log('  分布：' + JSON.stringify(tally));
  const badKp = kps.filter(v => !['', 'grid', 'line', 'other'].includes(v));
  ok(badKp.length === 0, `类型字段只能是 grid/line/other/空（异常 ${badKp.length} 个）`);
  /* 有 KPOINTS 的任务里，grid 与非 grid 都要能认出来（真机两者都有才算验到） */
  const hasGrid = kps.filter(v => v === 'grid').length, hasNon = kps.filter(v => v === 'line' || v === 'other').length;
  ok(hasGrid + hasNon > 0, `至少要认出一些 KPOINTS（grid=${hasGrid}，非网格=${hasNon}）`);
}

console.log('\n' + (fail === 0 ? '✅ 真机冒烟全部通过' : `❌ ${fail} 处失败`));
process.exitCode = fail ? 1 : 0;
