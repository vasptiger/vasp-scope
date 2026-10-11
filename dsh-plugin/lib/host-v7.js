/**
 * dsh-vasp-panel · 宿主半边
 *
 * 把【远程集群】上的 VASP 任务目录经 SSH 暴露成 HTTP 路由。
 *
 * 与 dsh-vaspflow 的关键差别：它在宿主里用 node:fs 扫【本地】目录；
 * 这里的任务是远程的，所以走 ssh，并且**按给定路径读取** ——
 * 这样对 /home/shared 那种 `user:user:--x`（可进入、不可枚举）的 ACL 也成立：
 * 给精确路径能读，不依赖列目录。
 *
 * 路由（前缀 /plugins/dsh-vasp-panel/*）：
 *   GET  /ping                             → { ok, sshHost, roots }
 *   GET  /panel                            → 面板 HTML（assets/panel.html）
 *   POST /scan?root=&maxDepth=             → root 下所有含 OUTCAR 的任务目录
 *   GET  /list?dir=                        → 某目录的全量文件清单（不设白名单）
 *   GET  /read?file=&offset=&limit=         → 分块读文件（base64，二进制安全）
 *   GET  /convergence?dir=                 → 该任务的 OSZICAR+OUTCAR 收敛序列（含电子步 SCF）
 *
 * 设计约束：一次 ssh 往返约 1 秒，所以
 *   · 所有远端操作合并成【一次】ssh（base64 → bash 通道，已验证稳定）
 *   · 结果在宿主侧带 TTL 缓存
 *
 * @module dsh-vasp-panel
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, posix } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-vasp-panel';
export const inject = [];

export const Config = z.object({
  sshHost: z.string().default(''),
  roots: z.array(z.string()).default(['/home/user/projects/demo']),
  defaultScanRoot: z.string().default('/home/user/projects/demo'),
  maxReadBytes: z.number().default(512 * 1024),
  /* 访问令牌。命名路由天然绕过 DSH fallback 的鉴权，所以必须自己来。
     留空 = 明确选择不鉴权（仅适合纯本地调试）。 */
  token: z.string().default(''),
});

const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
const ROUTE = '/plugins/dsh-vasp-panel';
const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 工具

/* 面板常从 file:// 打开（DSH 侧栏浏览器只吃 file://，http://127.0.0.1 被 CSP 挡），
   此时 fetch 的 origin 是 "null"，必须显式放行 CORS 才读得到数据。 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS });
  res.end(text);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, ...CORS });
  res.end(body);
}

function parseQuery(url) {
  const q = String(url ?? '').split('?')[1] ?? '';
  const out = {};
  for (const kv of q.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? '' : kv.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); }
    catch { out[k] = v; }
  }
  return out;
}

/** 路径安全：必须是绝对路径、不含 ..、且落在 roots 白名单之下。 */
function safePath(p, roots) {
  if (typeof p !== 'string' || p === '') return null;
  const norm = posix.normalize(p);
  if (!norm.startsWith('/')) return null;
  if (norm.includes('..')) return null;
  const ok = roots.some(r => {
    const rr = posix.normalize(r).replace(/\/+$/, '');
    return norm === rr || norm.startsWith(rr + '/');
  });
  return ok ? norm : null;
}

/**
 * 鉴权。
 *
 * 背景：`webServer.register()` 的命名路由**天然绕过** DSH fallback（SPA）那层的鉴权
 * —— 实测 `GET /` 返回 401，而 `GET /plugins/dsh-vasp-panel/ping` 返回 200。
 * 本插件的路由能读集群文件、且持有 SSH key，所以这层必须自己补。
 *
 * 两道关：
 *   1. Host 必须是回环（防 DNS rebinding / 外部代理把请求转进来）
 *   2. 配了 token 就必须带对（`?token=` 或请求头 `x-vasp-token`）
 *
 * 无 `req.headers` 时跳过第 1 关（单测直接喂 {url} 的场景）。
 */
/**
 * 令牌来源，按优先级：
 *   1. 插件配置 `token`（正常路径）
 *   2. 包内 `assets/token.txt`（每次请求现读）
 *
 * 为什么要第 2 条：profile 的**组合层会缓存 bundle patch 的内容** —— 换入口文件名能让
 * 新代码生效（实测注入令牌成功），但配置里的新字段不会跟着更新（实测 sshHost/roots 是
 * 旧值、新增的 token 为空）。有了文件来源，改令牌不必重启 DSH。
 */
export function tokenOf(cfg, tokenFile) {
  if (cfg && cfg.token) return cfg.token;
  if (tokenFile === null) return '';            // 测试用：显式关掉文件来源
  try { return readFileSync(tokenFile || join(HERE, '..', 'assets', 'token.txt'), 'utf8').trim(); }
  catch { return ''; }
}

export function authOk(req, cfg, tokenFile) {
  const h = req && req.headers;
  if (h) {
    const host = String(h.host || '');
    if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  }
  const want = tokenOf(cfg, tokenFile);
  if (!want) return true;                       // 未配令牌 = 明确选择不鉴权
  const got = (h && h['x-vasp-token']) || parseQuery(req.url).token || '';
  return got === want;
}

/** 把令牌注入面板 HTML —— 这样从插件路由打开时，面板能自动拿到令牌。 */
function injectToken(html, token) {
  if (!token) return html;
  const tag = `<script>window.__VASP_TOKEN__=${JSON.stringify(token)}</script>`;
  return html.includes('<script>') ? html.replace('<script>', tag + '<script>') : html.replace('</head>', tag + '</head>');
}

/** 一次 ssh 往返：把脚本 base64 后喂给远端 bash（这是本仓已验证的传输方式）。 */
export function sshRun(host, script, { timeout = 90000 } = {}) {
  return new Promise(resolve => {
    if (!host) { resolve({ code: 1, stdout: '', stderr: 'sshHost 未配置' }); return; }
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    execFile('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=12',
      '-o', 'ServerAliveInterval=15',
      host, `echo ${b64} | base64 -d | bash`,
    ], { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
    }));
  });
}

/** 极简 TTL 缓存。 */
export function makeCache(ttlMs) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return null; if (Date.now() - e.t > ttlMs) { m.delete(k); return null; } return e.v; },
    set(k, v) { m.set(k, { t: Date.now(), v }); return v; },
    clear() { m.clear(); },
    size() { return m.size; },
  };
}

// ------------------------------------------------------------------ 远端脚本

/** 扫描：列出 root 下所有含 OUTCAR 的目录（= VASP 任务）。
 *
 *  每行顺带回「元素顺序 / 计数 / INCAR 子集 / 关键产物文件 / 状态标记」——
 *  面板的「元素顺序 · 计数」列、「计算类型」识别（KIND_DEFS）与「状态」列都要用它们，
 *  而这些原本只有 `/task`（点开某个任务）才取，于是扫描阶段这些列全是空的 / 恒为「待检查」。
 *  全部塞进同一次 ssh 往返，**不增加往返次数**。 */
export function scanScript(root, maxDepth) {
  const r = root.replace(/'/g, `'\\''`);
  return `
set -u
ROOT='${r}'
[ -d "$ROOT" ] || { echo "__NOROOT__"; exit 0; }
trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
find "$ROOT" -maxdepth ${maxDepth} -name OUTCAR -printf '%h\\n' 2>/dev/null | sort | while read -r d; do
  rel="\${d#$ROOT/}"
  osz=0; out=0
  [ -f "$d/OSZICAR" ] && osz=$(stat -c%s "$d/OSZICAR" 2>/dev/null)
  [ -f "$d/OUTCAR"  ] && out=$(stat -c%s "$d/OUTCAR"  2>/dev/null)
  # ⚠️ 这里不能用 grep -c … 接 || echo 0：grep -c 在**匹配数为 0 时退出码是 1**（不是错误），
  #    || echo 0 会再追加一个 0 → 变量里出现「0 + 换行 + 0」→ 整条 T| 行被换行劈成两半，
  #    后面所有字段（元素/计数/INCAR/产物/状态标记）全丢。真机 shared 上 134 个任务中招。
  nion=$(grep -c 'F=' "$d/OSZICAR" 2>/dev/null || true)
  nion=\${nion:-0}
  # 元素顺序 / 计数：CONTCAR 优先（最新），退 POSCAR。
  # VASP5：第 6 行 = 元素符号、第 7 行 = 计数；VASP4：第 6 行直接就是计数（元素从 POTCAR 的 TITEL 行补）
  sf=''
  [ -f "$d/POSCAR"  ] && sf="$d/POSCAR"
  [ -f "$d/CONTCAR" ] && sf="$d/CONTCAR"
  els=''; cnt=''
  if [ -n "$sf" ]; then
    l6=$(trim "$(sed -n '6p' "$sf" 2>/dev/null)")
    l7=$(trim "$(sed -n '7p' "$sf" 2>/dev/null)")
    case "$l6" in
      [0-9]*) cnt=$(printf '%s' "$l6" | tr -s '[:space:]' ' ') ;;
      *) els=$(printf '%s' "$l6" | tr -s '[:space:]' ' ')
         cnt=$(printf '%s' "$l7" | tr -s '[:space:]' ' ') ;;
    esac
  fi
  [ -n "$els" ] || els=$(trim "$(grep -m 20 'TITEL' "$d/POTCAR" 2>/dev/null | awk '{print $4}' | tr '\\n' ' ')")
  # 计算类型只用这一小撮 INCAR 键（面板 KIND_DEFS 的全部依据）。
  # ⚠️ 去空白必须用 **sed 逐行**做，不能用 tr -d '[:space:]' —— tr 把换行也删掉，
  #    于是所有键粘成一行（真机实测 ICHARG=2LDAU=.TRUE.IVDW=11IBRION=2NSW=100ISIF=2），
  #    面板的 parseINCAR 只认得出第一个键 → 绝大多数任务判不出类型、类型列显示「—」。
  I="$d/INCAR"; [ -f "$I" ] || I="$d/../INCAR"; K="$d/KPOINTS"; [ -f "$K" ] || K="$d/../KPOINTS"; inc=$(grep -iE '^[[:space:]]*(IBRION|NSW|ISIF|LORBIT|LELF|IMAGES|LCLIMB|ICHARG|LOPTICS|LDAU|IVDW|NFREE)[[:space:]]*=' "$I" 2>/dev/null | sed 's/[#!].*//' | sed 's/[[:space:]]//g' | tr '\\n' ',')
  fl=''
  for f in CHGCAR CHG DOSCAR; do [ -f "$d/$f" ] && fl="$fl$f,"; done
  # KPOINTS 类型（按用户要求：**不是 x*x*x 自动网格**就算能带路径）。
  #   第 2 行 = 0        → 自动网格（Auto/Gamma/Monkhorst + "5 5 5"）→ grid
  #   前 8 行有 L / Line-mode → 能带路径 → line
  #   其它（显式 k 点列表等）→ other（面板按"非网格"当能带）
  #   没有 KPOINTS → 空
  kp=''
  if [ -f "$K" ]; then
    kp=$(head -8 "$K" 2>/dev/null | sed 's/[#!].*//' | awk '
      BEGIN { n = 0 }
      { gsub(/^[ \\t]+|[ \\t]+$/, ""); L[n++] = $0 }
      END {
        for (i = 0; i < n; i++) if (tolower(L[i]) ~ /^l(ine)?[-_ ]?mode$/ || tolower(L[i]) == "l") { print "line"; exit }
        gsub(/[ \\t]+/, " ", L[1])
        if (L[1] == "0") { print "grid"; exit }
        if (L[1] ~ /^[0-9]+$/) { print "other"; exit }
        for (i = 1; i < n; i++) if (L[i] ~ /^[0-9]+ [0-9]+ [0-9]+/) { print "grid"; exit }
        if (n > 0) print "other"; else print ""
      }')
  fi
  # 状态标记：**只看 OUTCAR 尾部 200 KB** —— 大 OUTCAR 全文 grep 会把扫描拖死，
  # 而 VASP 的正常收尾行与致命错误都出现在末尾。一次 awk 同时数三个标记。
  tailbuf=$(tail -c 200000 "$d/OUTCAR" 2>/dev/null)
  read done_ acc_ err_ <<< "$(printf '%s' "$tailbuf" | awk '
    /General timing and accounting/ { d = 1 }
    /reached required accuracy/      { a = 1 }
    /VERY BAD NEWS|Error EDDDAV|ZBRENT: fatal error|I REFUSE TO CONTINUE|internal error|BAD TERMINATION|Fatal error|LAPACK.*failed|not enough space|Unable to open/ { e = 1 }
    END { printf "%d %d %d", d+0, a+0, e+0 }')"
  mt=$(stat -c%Y "$d/OUTCAR" 2>/dev/null || echo 0)
  age=$(( $(date +%s) - mt ))
  echo "T|\$rel|\$out|\$osz|\$nion|\$els|\$cnt|\$inc|\$fl|\$done_|\$acc_|\$err_|\$age|\$kp"
done
echo "__END__"
`;
}

/** 列目录：全量文件（不设白名单），带 size 与 mtime。 */
export function listScript(dir) {
  const d = dir.replace(/'/g, `'\\''`);
  return `
set -u
D='${d}'
[ -d "$D" ] || { echo "__NODIR__"; exit 0; }
find "$D" -maxdepth 1 -type f -printf '%f|%s|%T@\\n' 2>/dev/null | sort
echo "__END__"
`;
}

/** 分块读：tail -c 跳过 offset，再 head -c 截 limit，base64 回传（二进制安全）。 */
export function readScript(file, offset, limit) {
  const f = file.replace(/'/g, `'\\''`);
  return `
set -u
F='${f}'
[ -f "$F" ] || { echo "__NOFILE__"; exit 0; }
sz=$(stat -c%s "$F" 2>/dev/null || echo 0)
echo "SIZE|\$sz"
tail -c +${offset + 1} "$F" 2>/dev/null | head -c ${limit} | base64 -w0
echo ""
echo "__END__"
`;
}

/**
 * 电子步（SCF）抽取：OSZICAR 的 `DAV:` / `RMM:` / `CG :` 行
 *   → `S <离子步> <电子步> <E> <dE> <rms> <rms(c)>`
 *
 * 为什么要它：**静态单点任务（NSW=0）只有 1 个离子步**，离子步曲线等于空图 ——
 * 它们真正能看的是电子步 SCF 收敛。面板的「电子步 SCF」口径要的就是这组数据
 * （内嵌快照里那 904 个电子步是当初手工抽的，实时链路一直没抽 → 一律显示空图）。
 *
 * 三个必须小心的地方：
 *   1. 离子步边界 = OSZICAR 的汇总行（`      1 F= ...`；MD 是 `T= ...`）。
 *      电子步行排在汇总行**之前**，所以 istep 从 1 起、遇到汇总行才 +1。
 *   2. 算法标记后可能跟多个空格（`DAV:   1`），也可能不跟（`CG :`）——
 *      先剥掉「字母+冒号+空白」前缀再按空白切列，列位置才稳定。
 *   3. 列含义（VASP 5/6 一致）：`迭代号 E dE d_eps ncg rms [rms(c)]`。
 *      面板画图用 dE（左轴 |ΔE|）与 rms（右轴 SCF 残差），CSV 另带 rms(c)。
 */
const SCF_AWK = `awk '
  BEGIN { istep = 1 }
  /^ *[0-9]+ +[FT]=/ { istep++; next }
  /^[A-Za-z]+ *:/ {
    line = $0
    sub(/^[A-Za-z]+ *: */, "", line)
    sub(/^[ \\t]+/, "", line)
    n = split(line, a, /[ \\t]+/)
    if (n < 3) next
    if (a[2] !~ /^[-+0-9.]/) next
    if (a[3] !~ /^[-+0-9.]/) next
    rms  = (n >= 6 && a[6] ~ /^[-+0-9.]/) ? a[6] : "null"
    rmsc = (n >= 7 && a[7] ~ /^[-+0-9.]/) ? a[7] : "null"
    printf "S %d %d %s %s %s %s\\n", istep, a[1], a[2], a[3], rms, rmsc
  }
' `;

/** 收敛序列：与本地抽取脚本同源（OSZICAR 离子步能量 + 电子步 SCF + OUTCAR 的 FORCES 行）。 */
export function convScript(dir) {
  const d = dir.replace(/'/g, `'\\''`);
  return `
set -u
D='${d}'
[ -d "$D" ] || { echo "__NODIR__"; exit 0; }
awk '
  /^ *[0-9]+ +F=/ {
    n++; line=$0
    sub(/^ *[0-9]+ +F= */,"",line)
    split(line,a," "); E=a[1]
    printf "I %d %s\\n", n, E
  }
' "$D/OSZICAR" 2>/dev/null
${SCF_AWK}"$D/OSZICAR" 2>/dev/null
awk '/FORCES: max atom, RMS/ { printf "F %s %s\\n", $(NF-1), $NF }' "$D/OUTCAR" 2>/dev/null
echo "__END__"
`;
}

// ------------------------------------------------------------------ 单任务全量 + 解析

/** 一次 ssh 取回单个任务的全部内容（分节输出，Node 侧解析）。 */
export function taskScript(dir) {
  const d = dir.replace(/'/g, `'\\''`);
  return `
set -u
D='${d}'
[ -d "$D" ] || { echo "__NODIR__"; exit 0; }
# 每个标记前先补一个换行：VASP 写出的 INCAR/CONTCAR 末尾常常【没有换行符】，
# 直接用 echo 打标记会黏在文件最后一行上（实测 "#LORBIT = 11@FILE CONTCAR"），
# 于是解析器永远找不到标记、整节内容被吞掉。
printf '\\n@FILES\\n'
find "$D" -maxdepth 1 -type f -printf '%f|%s|%T@\\n' 2>/dev/null | sort
for f in INCAR KPOINTS CONTCAR POSCAR; do
  S="$D/$f"
  if [ ! -f "$S" ]; then case "$f" in INCAR|KPOINTS) [ -f "$D/../$f" ] && S="$D/../$f" ;; esac; fi
  [ -f "$S" ] || continue
  printf '\\n@FILE %s\\n' "$f"
  cat "$S" 2>/dev/null
done
printf '\\n@CONV\\n'
awk '/^ *[0-9]+ +F=/ { n++; l=$0; sub(/^ *[0-9]+ +F= */,"",l); split(l,a," "); printf "I %d %s\\n", n, a[1] }' "$D/OSZICAR" 2>/dev/null
awk '/FORCES: max atom, RMS/ { printf "F %s %s\\n", $(NF-1), $NF }' "$D/OUTCAR" 2>/dev/null
printf '\\n@SCF\\n'
${SCF_AWK}"$D/OSZICAR" 2>/dev/null
printf '\\n__END__\\n'
`;
}

/** 图片白名单：扩展名 → MIME（面板直接拼 data URL 显示） */
export const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
export function imgMime(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && IMG_MIME[m[1]]) || null;
}
/** 整文件 base64 原样回传（**宿主不解码**：二进制图片经文本解码必然坏掉）；超过上限直接拒绝 */
export function imgScript(file, maxBytes) {
  const f = file.replace(/'/g, `'\\''`);
  return `
set -u
F='${f}'
[ -f "$F" ] || { echo "__NOFILE__"; exit 0; }
sz=$(stat -c%s "$F" 2>/dev/null || echo 0)
if [ "$sz" -gt ${maxBytes} ]; then echo "TOOBIG|$sz"; exit 0; fi
echo "SIZE|\$sz"
base64 -w0 "$F"
echo ""
echo "__END__"
`;
}const r6 = v => Math.round(v * 1e6) / 1e6;

/** VASP 结构文件 → { lat, els, cnt, frac }（与面板 STRUCTS 的字段一致）。 */
export function parseVasp(txt) {
  const L = String(txt).split(/\r?\n/);
  const scale = parseFloat((L[1] ?? '1').trim().split(/\s+/)[0]) || 1;
  const lat = [2, 3, 4].map(k => (L[k] ?? '').trim().split(/\s+/).slice(0, 3).map(Number));
  for (const row of lat) {
    if (row.length < 3) throw new Error('晶格行解析失败：缺少 3 个分量');
    for (const v of row) if (!Number.isFinite(v)) throw new Error('晶格行解析失败');
  }
  const latS = lat.map(row => row.map(v => v * scale));
  let k = 5, names = null;
  const t5 = (L[5] ?? '').trim().split(/\s+/);
  if (t5[0] && !/^[-+\d.]/.test(t5[0])) { names = t5; k = 6; }
  const cnt = (L[k] ?? '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
  if (!cnt.length) throw new Error('计数行解析失败');
  k += 1;
  if ((L[k] ?? '').trim().slice(0, 1).toLowerCase() === 's') k += 1;   // Selective dynamics
  const mode = (L[k] ?? '').trim().slice(0, 1).toLowerCase();
  if (mode !== 'd' && mode !== 'c') throw new Error('未找到 Direct/Cartesian');
  k += 1;
  const tot = cnt.reduce((a, b) => a + b, 0);
  let frac = [];
  for (let j = 0; j < tot; j++) {
    const raw = L[k + j];
    if (raw === undefined) throw new Error(`坐标行不足：计数说 ${tot} 个原子，实际只有 ${j} 行`);
    const p = raw.trim().split(/\s+/).slice(0, 3).map(Number);
    if (p.length < 3 || p.some(v => !Number.isFinite(v))) {
      throw new Error(`第 ${j + 1} 行坐标解析失败: ${raw.trim().slice(0, 60)}`);
    }
    frac.push(p);
  }
  if (mode === 'c') {
    // 笛卡尔 → 分数：解 x·lat = r。用 3×3 逆矩阵。
    const m = latS, det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (!det) throw new Error('晶格奇异');
    const inv = [
      [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
      [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
      [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det],
    ];
    frac = frac.map(r => [0, 1, 2].map(j => r[0] * inv[j][0] + r[1] * inv[j][1] + r[2] * inv[j][2]));
  }
  const els = names ?? cnt.map((_, j) => 'X' + j);
  return {
    lat: latS.map(row => row.map(r6)),
    els: els.map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()),
    cnt, frac: frac.map(r => r.map(r6)),
  };
}

/** INCAR → 键值表 */
export function parseIncar(txt) {
  const o = {};
  for (let line of String(txt).split(/\r?\n/)) {
    line = line.split('#')[0].split('!')[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) o[m[1].toUpperCase()] = m[2].trim();
  }
  return o;
}

/** 把 taskScript 的文本输出解析成面板可直接用的对象。 */
export function parseTaskOutput(stdout) {
  /* 容错：VASP 写出的文件末尾常常没有换行符，脚本打的标记可能黏在上一行尾部
     （实测 "#LORBIT = 11@FILE CONTCAR"）。这里先强行在每个标记前断行，
     即使脚本侧漏了补换行也能正确切分。 */
  const lines = String(stdout)
    .replace(/(@FILES|@FILE |@CONV|@SCF|__END__)/g, '\n$1')
    .split(/\r?\n/);
  const files = [], txt = {}, ionic = [], forces = [], scf = [];
  let sec = null, cur = null, buf = [];
  const flushFile = () => { if (cur) txt[cur] = buf.join('\n'); buf = []; cur = null; };
  for (const ln of lines) {
    if (ln === '__NODIR__') return null;
    if (ln === '@FILES') { sec = 'files'; continue; }
    if (ln.startsWith('@FILE ')) { flushFile(); sec = 'file'; cur = ln.slice(6).trim(); continue; }
    if (ln === '@CONV') { flushFile(); sec = 'conv'; continue; }
    if (ln === '@SCF') { flushFile(); sec = 'scf'; continue; }
    if (ln === '__END__') { flushFile(); sec = null; continue; }
    if (sec === 'files') {
      const p = ln.split('|');
      if (p.length >= 3) files.push({ name: p[0], size: +p[1] || 0, mtime: Math.round(+p[2] || 0) });
    } else if (sec === 'file') {
      buf.push(ln);
    } else if (sec === 'conv') {
      if (ln.startsWith('I ')) { const p = ln.split(' '); ionic.push([+p[1], parseFloat(p[2])]); }
      else if (ln.startsWith('F ')) { const p = ln.split(' '); forces.push([parseFloat(p[1]), parseFloat(p[2])]); }
    } else if (sec === 'scf') {
      /* 面板的 scf 行格式：[离子步, 电子步, E, dE, rms, rms(c)]（缺列用 null）。
         'F ' 行本来应该落在 @CONV 分节里（脚本顺序如此），这里也接一手：
         分节边界一旦被挪动，力数据不该跟着丢（这个回归真机冒烟抓到过一次）。 */
      if (ln.startsWith('F ')) { const p = ln.split(' '); forces.push([parseFloat(p[1]), parseFloat(p[2])]); continue; }
      if (ln.startsWith('S ')) {
        const p = ln.split(' ');
        const istep = +p[1], iel = +p[2], E = parseFloat(p[3]), dE = parseFloat(p[4]);
        const num = s => (s === undefined || s === 'null' || s === '' ? null : parseFloat(s));
        const rms = num(p[5]), rmsc = num(p[6]);
        if (Number.isFinite(istep) && Number.isFinite(iel) && Number.isFinite(E)) {
          scf.push([istep, iel, E, Number.isFinite(dE) ? dE : null, Number.isFinite(rms) ? rms : null, Number.isFinite(rmsc) ? rmsc : null]);
        }
      }
    }
  }
  const structures = {};
  for (const name of ['CONTCAR', 'POSCAR']) {
    if (!txt[name]) continue;
    try { structures[name] = { f: name, ...parseVasp(txt[name]) }; } catch { /* 解析失败就跳过 */ }
  }
  // 收敛：把 OSZICAR 能量与 OUTCAR 力按离子步对齐成面板的 ionic 格式 [step,E,maxF,rmsF]
  const ionicRows = ionic.map(([n, E], i) => {
    const f = forces[i] ?? [null, null];
    return [n, E, f[0], f[1]];
  });
  return {
    files, structures,
    incar: txt.INCAR ? parseIncar(txt.INCAR) : {},
    ionic: ionicRows, forces, nForces: forces.length,
    scf, nScf: scf.length,
    /* 文件原文（面板要用来做输入检查、KPOINTS 判定、绘图）—— 与 /read 同源，只是顺路带回 */
    texts: txt,
    kp: kpointsKind(txt.KPOINTS),
  };
}

/**
 * KPOINTS → 类型。按用户要求：**不是 x*x*x 自动网格**就算能带路径。
 *   'grid'  自动网格（第 2 行 0 + Auto/Gamma/Monkhorst 或 "x y z" 三整数）
 *   'line'  line-mode（L / Line-mode）—— 能带路径
 *   'other' 显式 k 点列表等（非网格）—— 也按能带算
 *   ''      没有 KPOINTS / 空文件
 */
export function kpointsKind(txt) {
  const L = String(txt ?? '').split(/\r?\n/)
    .map(s => s.replace(/[#!].*$/, '').trim());
  if (!L.some(s => s !== '')) return '';
  for (const ln of L.slice(0, 8)) if (/^l(ine)?[-_ ]?mode$/i.test(ln) || /^l$/i.test(ln)) return 'line';
  const l2 = (L[1] ?? '').replace(/\s+/g, ' ').trim();
  if (l2 === '0') return 'grid';
  if (/^\d+$/.test(l2)) return 'other';
  for (const ln of L.slice(1, 8)) if (/^\d+ \d+ \d+/.test(ln.replace(/\s+/g, ' ').trim())) return 'grid';
  return 'other';
}

// ------------------------------------------------------------------ 路由处理器（可单测）

export function createHandlers(cfg, deps = {}) {
  const run = deps.sshRun ?? sshRun;
  const tokenFile = 'tokenFile' in deps ? deps.tokenFile : undefined;
  const cache = makeCache(15000);
  const roots = (cfg.roots && cfg.roots.length) ? cfg.roots : ['/home/user/projects/demo'];

  const handlers = {
    /* 批量取数：一条 ssh 把能带/高对称点/PDOS/能垒压成紧凑文本（老面板仍走 /read，互不影响）。
       脚本见 lib/plot-script.js —— 刻意独立成文件，避免把 shell 引号嵌进本文件的模板字面量。 */
    async plot(req, res) {
      const q = parseQuery(req.url);
      const dir = safePath(q.dir, roots);
      if (!dir) { json(res, 400, { error: 'dir 不在白名单内' }); return; }
      const r = await run(cfg.sshHost, plotScript(dir), { timeout: 300000 });
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: String(r.stderr || '').slice(0, 300) }); return; }
      const parsed = parsePlotOutput(r.stdout);
      if (!parsed) { json(res, 404, { error: '远端目录不存在', dir: dir }); return; }
      json(res, 200, Object.assign({ dir: dir, cached: false }, parsed));
    },

    /* 自诊断：路由注册结果 + 环境。放在第一位，保证它自己一定注册得上。 */
    async diag(_req, res) {
      json(res, 200, {
        plugin: name, version: 1,
        sshHost: cfg.sshHost || '', roots,
        host: process.platform, node: process.version,
        routes: (handlers._reg && handlers._reg.ok) || [],
        failed: (handlers._reg && handlers._reg.bad) || [],
        cacheEntries: cache.size(),
      });
    },

    async ping(_req, res) {
      json(res, 200, { ok: true, plugin: name, version: 1, sshHost: cfg.sshHost || '', roots });
    },

    async panel(_req, res) {
      const p = join(HERE, '..', 'assets', 'panel.html');
      if (!existsSync(p)) { text(res, 404, 'assets/panel.html 不存在'); return; }
      text(res, 200, readFileSync(p, 'utf8'), 'text/html; charset=utf-8');
    },

    /* 最小对照页：用来判定"侧栏浏览器能否加载本插件的页面"。
       纯 HTML、无脚本。若这个也空白 → 是侧栏的加载/沙箱限制，与本面板无关。 */
    async hello(_req, res) {
      text(res, 200, [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<title>plugin-embed-probe</title></head>',
        '<body style="margin:0;font:16px/1.6 Arial,sans-serif;background:#ffe680;color:#111">',
        '<div style="padding:24px">',
        '<h1 style="margin:0 0 8px">探针页已加载 ✅</h1>',
        '<p>如果你看到这块黄色区域，说明<b>侧栏浏览器可以加载本插件的路由</b>，',
        '那么面板空白就是面板自身的问题（体积/脚本/超时）。</p>',
        '<p>如果这里也是空白，说明是侧栏的加载或沙箱限制。</p>',
        '</div></body></html>',
      ].join(''), 'text/html; charset=utf-8');
    },

    async scan(req, res) {
      const q = parseQuery(req.url);
      const root = safePath(q.root || cfg.defaultScanRoot, roots);
      if (!root) { json(res, 400, { error: 'root 不在白名单内', roots }); return; }
      /* 深度：默认 **8**（用户定的口径）。再深能多找到几条 nf/nf/nf 尾链，但大根（真机 shared）
       扫描时间会成倍增长甚至撞超时 —— 所以默认回到 8，上限留 16 供临时加深。 */
      const depth = Math.min(16, Math.max(1, parseInt(q.maxDepth ?? '8', 10) || 8));
      const key = `scan:${root}:${depth}`;
      const hit = cache.get(key);
      if (hit) { json(res, 200, { ...hit, cached: true }); return; }
      /* ⚠️ 必须显式给足超时：sshRun 默认只有 90 s，而深度 16 扫大根（真机 shared）
        实测会超过 90 s → ssh 被杀 → 502「ssh 失败」，表现就是"切换根失败"。 */
      const r = await run(cfg.sshHost, scanScript(root, depth), { timeout: 900000 });
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: r.stderr.slice(0, 400) }); return; }
      if (r.stdout.includes('__NOROOT__')) { json(res, 404, { error: '远端目录不存在', root }); return; }
      const tasks = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        if (!line.startsWith('T|')) continue;
        const p = line.split('|');
        /* els/cnt = 结构文件里的元素顺序与计数；inc = 判定计算类型的那几个 INCAR 键；
           fl = 关键产物文件（CHGCAR/CHG/DOSCAR）；
           done/acc/err/age = 判定任务状态的标记（正常收尾行 / 收敛达标 / 错误关键字 /
           OUTCAR 静默秒数）；kp = KPOINTS 类型（grid/line/other/空）—— 非 grid 判为能带。
           全部是纯增量字段。 */
        tasks.push({
          rel: p[1], outcar: +p[2] || 0, oszicar: +p[3] || 0, ionic: +p[4] || 0,
          els: p[5] || '', cnt: p[6] || '', inc: p[7] || '', fl: p[8] || '',
          done: +p[9] || 0, acc: +p[10] || 0, err: +p[11] || 0,
          /* age 空串必须给 null，不能给 0 —— 0 会被面板当成「刚刚更新」= 正在运行。 */
          age: (p[12] === undefined || p[12] === '') ? null : (Number.isFinite(+p[12]) ? +p[12] : null),
          kp: (p[13] || '').trim(),
        });
      }
      const body = { root, count: tasks.length, tasks, cached: false };
      cache.set(key, body);
      json(res, 200, body);
    },

    async list(req, res) {
      const q = parseQuery(req.url);
      const dir = safePath(q.dir, roots);
      if (!dir) { json(res, 400, { error: 'dir 不在白名单内' }); return; }
      const key = `list:${dir}`;
      const hit = cache.get(key);
      if (hit) { json(res, 200, { ...hit, cached: true }); return; }
      const r = await run(cfg.sshHost, listScript(dir));
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: r.stderr.slice(0, 400) }); return; }
      if (r.stdout.includes('__NODIR__')) { json(res, 404, { error: '远端目录不存在', dir }); return; }
      const files = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        if (!line.includes('|') || line.startsWith('__')) continue;
        const p = line.split('|');
        if (p.length < 3) continue;
        files.push({ name: p[0], size: +p[1] || 0, mtime: Math.round(+p[2] || 0) });
      }
      const body = { dir, count: files.length, files, cached: false };
      cache.set(key, body);
      json(res, 200, body);
    },

    /* 图片：整文件 base64 原样回传（不经过 utf8 解码），面板拼 data URL 显示 */
    async img(req, res) {
      const q = parseQuery(req.url);
      const file = safePath(q.file, roots);
      if (!file) { json(res, 400, { error: 'file 不在白名单内' }); return; }
      const mime = imgMime(file);
      if (!mime) { json(res, 400, { error: '不是受支持的图片格式', file }); return; }
      const maxBytes = cfg.maxImageBytes || 6291456;
      const r = await run(cfg.sshHost, imgScript(file, maxBytes), { timeout: 180000 });
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: r.stderr.slice(0, 300) }); return; }
      if (r.stdout.includes('__NOFILE__')) { json(res, 404, { error: '远端文件不存在', file }); return; }
      const big = r.stdout.match(/^TOOBIG\|(\d+)/m);
      if (big) { json(res, 413, { error: '图片太大', size: +big[1], maxBytes }); return; }
      /* ⚠️ 先截到 __END__ 再拼 base64：标题行之后还有一行 "__END__"，
         拼进来会多出 "END" 三个**合法** base64 字符（下划线被字符集过滤掉），
         长度变成 %4=3 → 浏览器 atob 抛 "not correctly encoded"（Node 宽容所以看不出来）。 */
      const body = r.stdout.includes('__END__') ? r.stdout.slice(0, r.stdout.indexOf('__END__')) : r.stdout;
      const lines = body.split(/\r?\n/);
      const size = lines[0].startsWith('SIZE|') ? +lines[0].slice(5) : null;
      const b64 = lines.slice(1).join('').replace(/[^A-Za-z0-9+/=]/g, '');
      json(res, 200, { file, size, mime, b64 });
    },
    async read(req, res) {
      const q = parseQuery(req.url);
      const file = safePath(q.file, roots);
      if (!file) { json(res, 400, { error: 'file 不在白名单内' }); return; }
      const offset = Math.max(0, parseInt(q.offset ?? '0', 10) || 0);
      const limit = Math.min(cfg.maxReadBytes || 524288, Math.max(1, parseInt(q.limit ?? '65536', 10) || 65536));
      const r = await run(cfg.sshHost, readScript(file, offset, limit), { timeout: 180000 });
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: r.stderr.slice(0, 400) }); return; }
      if (r.stdout.includes('__NOFILE__')) { json(res, 404, { error: '远端文件不存在', file }); return; }
      /* ⚠️ 先截到 __END__ 再拼 base64：标题行之后还有一行 "__END__"，
         拼进来会多出 "END" 三个**合法** base64 字符（下划线被字符集过滤掉），
         长度变成 %4=3 → 浏览器 atob 抛 "not correctly encoded"（Node 宽容所以看不出来）。 */
      const body = r.stdout.includes('__END__') ? r.stdout.slice(0, r.stdout.indexOf('__END__')) : r.stdout;
      const lines = body.split(/\r?\n/);
      const size = lines[0].startsWith('SIZE|') ? +lines[0].slice(5) : null;
      const b64 = lines.slice(1).join('').replace(/[^A-Za-z0-9+/=]/g, '');
      let data = '';
      try { data = Buffer.from(b64, 'base64').toString('utf8'); } catch { data = ''; }
      json(res, 200, { file, offset, limit, size, bytes: b64.length * 3 / 4 | 0, text: data });
    },

    async convergence(req, res) {
      const q = parseQuery(req.url);
      const dir = safePath(q.dir, roots);
      if (!dir) { json(res, 400, { error: 'dir 不在白名单内' }); return; }
      const key = `conv:${dir}`;
      const hit = cache.get(key);
      if (hit) { json(res, 200, { ...hit, cached: true }); return; }
      const r = await run(cfg.sshHost, convScript(dir));
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: r.stderr.slice(0, 400) }); return; }
      const ionic = [], forces = [], scf = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        if (line.startsWith('I ')) { const p = line.split(' '); ionic.push([+p[1], parseFloat(p[2])]); }
        else if (line.startsWith('F ')) { const p = line.split(' '); forces.push([parseFloat(p[1]), parseFloat(p[2])]); }
        else if (line.startsWith('S ')) {
          const p = line.split(' ');
          const num = s => (s === undefined || s === 'null' || s === '' ? null : parseFloat(s));
          const rms = num(p[5]), rmsc = num(p[6]);
          scf.push([+p[1], +p[2], parseFloat(p[3]), parseFloat(p[4]),
                    Number.isFinite(rms) ? rms : null, Number.isFinite(rmsc) ? rmsc : null]);
        }
      }
      const body = { dir, ionic, forces, scf, nScf: scf.length, cached: false };
      cache.set(key, body);
      json(res, 200, body);
    },

    /* 单任务全量：文件清单 + CONTCAR/POSCAR（已解析）+ 收敛 + INCAR。
       一次 ssh 拿完，面板侧不用再写 VASP 解析器。 */
    async task(req, res) {
      const q = parseQuery(req.url);
      const dir = safePath(q.dir, roots);
      if (!dir) { json(res, 400, { error: 'dir 不在白名单内' }); return; }
      const ttl = +q.ttl >= 0 ? +q.ttl : 15000;          // 面板可用 ttl=0 强制绕过缓存
      const key = `task:${dir}`;
      if (ttl > 0) {
        const hit = cache.get(key);
        if (hit) { json(res, 200, { ...hit, cached: true }); return; }
      }
      const r = await run(cfg.sshHost, taskScript(dir), { timeout: 300000 });
      if (r.code !== 0) { json(res, 502, { error: 'ssh 失败', detail: r.stderr.slice(0, 400) }); return; }
      const parsed = parseTaskOutput(r.stdout);
      if (!parsed) { json(res, 404, { error: '远端目录不存在', dir }); return; }
      const body = { dir, rel: dir.replace(/^.*\/(nd|VC)\//, '$1/'), ...parsed, cached: false };
      if (ttl > 0) cache.set(key, body);
      json(res, 200, body);
    },
  };
  /* ---- 鉴权包装：放在最后，包住所有路由（含 /panel） ---- */
  for (const sub of Object.keys(handlers)) {
    if (sub.startsWith('_')) continue;
    const fn = handlers[sub];
    handlers[sub] = async (req, res) => {
      if (!authOk(req, cfg, tokenFile)) {
        json(res, 401, {
          error: 'authentication required',
          hint: '带上 ?token=<插件令牌>，或请求头 x-vasp-token',
        });
        return;
      }
      if (sub === 'panel') {
        const p = join(HERE, '..', 'assets', 'panel.html');
        if (!existsSync(p)) { text(res, 404, 'assets/panel.html 不存在'); return; }
        text(res, 200, injectToken(readFileSync(p, 'utf8'), cfg.token || ''), 'text/html; charset=utf-8');
        return;
      }
      return fn(req, res);
    };
  }
  handlers._cache = cache;
  return handlers;
}

// ------------------------------------------------------------------ 插件入口

export function apply(ctx, config) {
  const cfg = config ?? {};
  const h = createHandlers(cfg);

  let registered = false;
  const registerWebSurface = () => {
    if (registered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    registered = true;
    /* 逐条容错：某一条注册失败不能让后面的也注册不上（曾经因此整条 /task 消失且无任何提示）。 */
    const ok = [], bad = [];
    for (const [sub, fn] of Object.entries(h)) {
      if (sub.startsWith('_')) continue;
      try {
        ctx.effect(() => webServer.register({
          kind: 'exact',
          path: `${ROUTE}/${sub}`,
          handler: (req, res) => fn(req, res),
        }), `dsh-vasp-panel: ${sub} route`);
        ok.push(sub);
      } catch (e) {
        bad.push(`${sub}: ${(e && e.message) || String(e)}`);
      }
    }
    h._reg = { ok, bad };
    if (bad.length && ctx.logger) ctx.logger.warn(`dsh-vasp-panel: ${bad.length} 条路由注册失败 → ${bad.join(' | ')}`);
  };

  registerWebSurface();
  ctx.on('internal/service', serviceName => {
    if (WEB_SERVER_KEYS.includes(serviceName)) registerWebSurface();
  });
  ctx.logger.info('dsh-vasp-panel: host half active (ssh bridge)');
}

import { plotScript, parsePlotOutput } from './plot-script.js';
