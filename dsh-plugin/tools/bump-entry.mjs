/**
 * 把当前入口复制成 host-v<N+1>.js，并同步改 package.json 的 main 与测试的 import。
 *
 * 为什么需要它：DSH 禁用→启用插件只是重新 import 同一个 URL，Node 的 ESM 按 URL
 * 缓存模块，所以**改了代码不换文件名，运行中的进程永远拿不到新代码**
 * （实测：新增的 /hello 路由在文件里存在，但进程一直返回 404）。
 *
 * 用法：node tools/bump-entry.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(root, 'lib');

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = String(pkg.main).replace(/^\.\//, '');          // lib/host-v2.js
const m = cur.match(/^(.*?)(\d+)\.js$/);
if (!m) { console.error(`main 不是版本化文件名，无法递增: ${cur}`); process.exit(1); }
const [, prefix, numStr] = m;
const next = `${prefix}${Number(numStr) + 1}.js`;
const curAbs = join(root, cur), nextAbs = join(root, next);

if (!existsSync(curAbs)) { console.error(`入口不存在: ${curAbs}`); process.exit(1); }
if (existsSync(nextAbs)) { console.error(`目标已存在（先删或再递增）: ${nextAbs}`); process.exit(1); }

writeFileSync(nextAbs, readFileSync(curAbs));
pkg.main = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 测试里的 import 也要跟着走
const tPath = join(root, 'test', 'host.test.mjs');
if (existsSync(tPath)) {
  const t = readFileSync(tPath, 'utf8').replace(
    /from '\.\.\/lib\/host-v\d+\.js'/, `from '../lib/${next.replace(/^lib\//, '')}'`);
  writeFileSync(tPath, t);
  console.log(`  测试 import → ../${next}`);
}

// 清掉旧的版本化入口，避免 lib 里堆一堆
const keep = next.replace(/^lib\//, '');
for (const f of readdirSync(lib)) {
  if (/^host-v\d+\.js$/.test(f) && f !== keep) {
    try { unlinkSync(join(lib, f)); console.log(`  清理旧入口 lib/${f}`); } catch {}
  }
}

console.log(`  入口 ${cur} → ${next}`);
