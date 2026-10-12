#!/usr/bin/env node
/**
 * VASP 任务面板 · 独立服务版（不依赖 DSH / Cordis）
 * ---------------------------------------------------------------
 * 作用：把面板 HTML 与全部数据路由跑在一个**本地 HTTP 服务**里，
 *       浏览器打开 http://127.0.0.1:<port>/ 即可使用，功能与 DSH 插件版一致。
 *
 * 用法：
 *   node server.js                      # 用同目录 config.json，默认端口 8787
 *   node server.js --port 9000
 *   node server.js --config D:\path\config.json
 *
 * 数据通道：调用系统 ssh（Windows 10+ 自带 / Linux / macOS 自带）读取远端 VASP 目录。
 * 复用的是与插件版**完全相同**的路由实现： ./lib/host-v7.js 的 createHandlers(cfg)
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandlers } from './lib/host-v7.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const PORT = Number(argOf('--port', process.env.VASP_PANEL_PORT || 8787))
const CFG_PATH = argOf('--config', path.join(HERE, 'config.json'))
const PANEL = path.join(HERE, 'public', 'panel.html')

function die(msg) { console.error('[vasp-panel] ' + msg); process.exit(2) }

if (!fs.existsSync(CFG_PATH)) {
  die('缺少配置文件：' + CFG_PATH + '\n' +
      '  请把 config.example.json 复制成 config.json，填好 sshHost 与 roots 后重试。')
}
let cfg
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }
catch (e) { die('config.json 不是合法 JSON：' + e.message) }

if (!cfg.sshHost) die('config.json 里必须填 sshHost（例如 user@host，或 ~/.ssh/config 里的别名）')
if (!Array.isArray(cfg.roots) || !cfg.roots.length) die('config.json 里必须填 roots（允许访问的远端根目录白名单，至少一项）')
if (!fs.existsSync(PANEL)) die('缺少面板文件：' + PANEL)

/* 与插件版同一套路由： plot / diag / ping / panel / hello / scan / list / read / convergence / task / img */
const handlers = createHandlers(cfg)
const ROUTES = Object.keys(handlers).filter(k => !k.startsWith('_') && typeof handlers[k] === 'function')

const srv = http.createServer((req, res) => {
  let seg = '/'
  try { seg = new URL(req.url || '/', 'http://localhost').pathname } catch (_) {}
  /* 兼容两种调用方式：
     · 面板在 http 同源下用根路径： /ping  /scan  /read ...
     · 面板里也可能带 DSH 的插件前缀（写死在 UI 文案/自检里）： /plugins/dsh-vasp-scope/ping ... */
  const name = seg.replace(/^\/+/, '')
    .replace(/^plugins\/dsh-vasp-scope\/?/, '')
    .split('/')[0]

  /* 面板本体： / 或 /panel */
  if (name === '' || name === 'panel' || name === 'index.html') {
    try {
      const html = fs.readFileSync(PANEL)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    } catch (e) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('面板读取失败：' + e.message) }
  }

  const fn = handlers[name]
  if (typeof fn !== 'function') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ error: '未知路由', route: name, routes: ROUTES }))
  }
  try { fn(req, res) }
  catch (e) {
    try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String((e && e.message) || e) })) } catch (_) {}
  }
})

srv.on('error', e => die('端口 ' + PORT + ' 启动失败：' + ((e && e.message) || e) + '\n  （可能已被占用，换 --port 9000 试试）'))

srv.listen(PORT, '127.0.0.1', () => {
  console.log('------------------------------------------------------------')
  console.log('[vasp-panel] 独立服务已启动')
  console.log('  面板地址 : http://127.0.0.1:' + PORT + '/')
  console.log('  配置文件 : ' + CFG_PATH)
  console.log('  sshHost  : ' + cfg.sshHost)
  console.log('  roots    : ' + cfg.roots.join('  ,  '))
  console.log('  路由     : ' + ROUTES.join(', '))
  console.log('------------------------------------------------------------')
  console.log('浏览器打开上面的地址即可（Ctrl+C 停止服务）')
})
