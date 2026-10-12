#!/usr/bin/env node
/**
 * tools/ci/checks.mjs —— 仓库自检（CI 与本地都能跑，纯 Node、不依赖 shell ✓）
 * ------------------------------------------------------------------
 * 检查项：
 *   1. 禁用词（个人数据 / 旧项目名 / 内部项目命名 / 内部口气）
 *   2. 面板副本的 <script> 能通过语法解析（new Function 只解析、不执行 ✓）
 *   3. 两半的宿主模块都能 import() 成功（导出 createHandlers ✓）
 *   4. 仓库里**不存在**本地配置文件（config.json / *.token / .ssh/）
 *
 * ⚠️ 本文件自己会"写着"禁用词 —— 两条防自伤的规矩必须遵守（都实际踩过 ✗）：
 *   a) **拆开拼**：用 J('h','cx') 这种拼接，让本文件**不出现**这些字面量 ✓
 *      （否则 ① 闸门自匹配 → 干净内容也被拒推 ✗ ② 脱敏器会把本文件的规则改坏 ✗）
 *   b) 同时把本文件列进 tools/scrub.mjs 的 SKIP_FILE ✓（双保险 ✓）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const SKIP_DIR = new Set(['.git', 'node_modules'])
const J = (...p) => p.join('')          // 拼接，避免本文件出现禁用词字面量 ✓

/* 禁用词：各项目按自己的历史增删；这里是 vasp-scope 的实际清单 ✓
   ⚠️ 注意别把"正常会出现在文档里的示例值"列进来（例如示例主机名）✗
   —— 那会造成误报（脱敏器曾把本清单改成含示例值 → CI 直接红 ✗） */
const FORBIDDEN = [
  J('h', 'cx'), J('lee', 'hpc'), J('len', 'ovo'), J('roc', 'ky'),     // 个人主机/账号
  '101.7.129.73',                                                      // 集群 IP
  J('D:', '\\', 'dsh'), J('D:', '\\\\', 'dsh'),                        // 个人路径（含**转义形式** D:\\\\dsh ✓ 以前扫不到 ✗）
  J('/home/', 'hcx'), J('/home/', 'leehpc'),
  J('vasp', 'scope'),                                                  // 旧项目名（新名 vasp-scope 不算 ✗）
  J('nd', '/li'), J('nd', '/mno'), J('cij', '/'), J('VC', '/'), J('Bi', 'OX'),  // 内部项目命名
  J('真', '机'),                                                        // 内部口气
  J('vasp-panel-', '功能清单'), J('vasp-panel-', '开发规范'),            // 内部文件名
]
/* 闸门/自检类文件会写着这些正则 → 一律排除，否则永远自匹配 ✗ */
const GATE_FILES = new Set(['tools/pre-push', 'tools/ci/checks.mjs', 'tools/scrub.mjs'])
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.md', '.yml', '.yaml', '.txt', '.bat', '.sh', '.css'])
const TEXT_NAME = new Set(['LICENSE', 'NOTICE', 'COPYING', 'pre-push', '.gitattributes', '.gitignore'])

const problems = []

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); continue }
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    if (GATE_FILES.has(rel)) continue
    if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) || TEXT_NAME.has(e.name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
console.log(`  扫描 ${files.length} 个文本文件`)

/* ① 禁用词 */
let hits = 0
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8')
  for (const w of FORBIDDEN) {
    const n = txt.split(w).length - 1
    if (n) { hits += n; problems.push(`禁用词 "${w}" × ${n} → ${path.relative(ROOT, f)}`) }
  }
}
console.log(hits ? `  ✗ 禁用词 ${hits} 处` : '  ✓ 禁用词 0 处')

/* ② 面板 <script> 语法 */
for (const p of ['standalone/public/panel.html', 'dsh-plugin/assets/panel.html']) {
  const abs = path.join(ROOT, p)
  if (!fs.existsSync(abs)) { problems.push(`缺少面板文件：${p}`); continue }
  const html = fs.readFileSync(abs, 'utf8')
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!m) { problems.push(`${p} 里找不到 <script> 块`); continue }
  try { new Function(m[1]); console.log(`  ✓ ${p} 语法通过`) }
  catch (e) { problems.push(`${p} 语法错误：${e.message}`) }
}

/* ③ 两半的宿主模块可加载 */
for (const p of ['standalone/lib/host-v7.js', 'dsh-plugin/lib/host-v7.js']) {
  const abs = path.join(ROOT, p)
  if (!fs.existsSync(abs)) { problems.push(`缺少模块：${p}`); continue }
  try {
    const mod = await import(pathToFileURL(abs).href)
    const h = mod.createHandlers({ sshHost: 'x', roots: ['/tmp'] }, { sshRun: async () => ({ code: 0, stdout: '', stderr: '' }), tokenFile: null })
    const routes = Object.keys(h).filter(k => !k.startsWith('_'))
    if (routes.length < 11) problems.push(`${p} 路由只有 ${routes.length} 条（应 ≥11）`)
    else console.log(`  ✓ ${p} 可加载（${routes.length} 条路由）`)
  } catch (e) { problems.push(`${p} 加载失败：${e.message}`) }
}

/* ④ 本地配置不许入库 */
for (const bad of ['standalone/config.json', 'dsh-plugin/config.json', 'config.json']) {
  if (fs.existsSync(path.join(ROOT, bad))) problems.push(`不该入库的本地配置：${bad}`)
}
const strays = files.filter(f => /\.token$/.test(f) || f.includes('/.ssh/'))
if (strays.length) problems.push('发现令牌/ssh 文件：' + strays.map(f => path.relative(ROOT, f)).join(', '))
console.log('  ✓ 无本地配置 / 令牌文件')

/* 汇总 */
if (problems.length) {
  console.log('\n  ❌ 自检不通过：')
  for (const p of problems) console.log('     · ' + p)
  process.exit(1)
}
console.log('\n  ✅ 仓库自检全部通过')
