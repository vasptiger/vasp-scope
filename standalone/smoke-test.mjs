#!/usr/bin/env node
/**
 * 自检脚本：确认服务在跑、路由都能响应、ssh 通道可用。
 * 用法： node smoke-test.mjs [--port 8787]
 */
const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const PORT = Number(argOf('--port', process.env.VASP_PANEL_PORT || 8787))
const B = `http://127.0.0.1:${PORT}`

const post = async (p) => {
  const t0 = Date.now()
  try {
    const r = await fetch(B + p, { method: 'POST' })
    const txt = await r.text()
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, len: txt.length, txt }
  } catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, len: 0, txt: String((e && e.message) || e) } }
}

const line = (name, r, extra = '') =>
  console.log(`  ${r.ok ? '✓' : '✗'} ${name.padEnd(14)} HTTP ${String(r.status).padEnd(3)} ${String(r.ms + ' ms').padEnd(8)} ${String(r.len + ' B').padEnd(10)} ${extra}`)

console.log('============================================================')
console.log(' VASP 面板 · 独立版自检  ' + B)
console.log('============================================================')

const html = await post('/')
line('面板 HTML', html, html.ok && /<title>/.test(html.txt) ? '含标题 ✓' : '内容可疑 ✗')

const ping = await post('/ping')
line('/ping', ping, ping.ok ? ping.txt.slice(0, 80) : ping.txt.slice(0, 120))

const diag = await post('/diag')
let routes = []
try { routes = JSON.parse(diag.txt).routes || [] } catch (_) {}
line('/diag', diag, '已注册路由: ' + (routes.join(', ') || '(解析失败)'))

const scan = await post('/scan?maxDepth=2&ttl=0')
line('/scan (深度2)', scan, scan.ok ? '返回 ' + scan.len + ' B' : scan.txt.slice(0, 160))

const list = await post('/list')
line('/list', list, '')

console.log('------------------------------------------------------------')
if (!ping.ok && !scan.ok) {
  console.log(' 结论：数据通路不可用 —— 请检查 config.json 的 sshHost / roots，')
  console.log('       并先在命令行手动试一次：  ssh <sshHost> "ls <roots[0]>"')
} else {
  console.log(' 结论：面板与数据通路正常。浏览器打开 ' + B + '/ 即可使用。')
}
