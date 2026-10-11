/**
 * /plot 的服务端脚本 + 输出解析。
 *
 * 为什么单独一个文件：上一轮我把 shell 脚本嵌进 host-v7.js 的模板字面量里，
 * `${bn#I}`、反引号、多层引号互相打架，直接把宿主弄成"加载失败"。
 * 这里改成**普通文件 + 纯字符串拼接**（不用模板字面量、不出现 ${），可独立 import 验证。
 *
 * 形态：**单行 `; ` 拼接的纯 ASCII 脚本** —— 宿主 sshRun 是 `ssh host <script>` 传参，
 * 实测多行脚本经 argv 传输时换行会被吃掉（导致 `B: unbound variable`）。
 */

/** 能带抽稀：体积超过 thinAboveBytes 时每 thin 个 k 点取 1 个（"能看出形状就行"）。 */
export function plotScript(dir, opts = {}) {
  const thin = Math.max(1, parseInt(opts.thin || 2, 10) || 2);
  const thinAboveBytes = Math.max(0, parseInt(opts.thinAboveBytes || 200000, 10) || 200000);
  const thinPdos = Math.max(1, parseInt(opts.thinPdos || 3, 10) || 3);   // PDOS 每 3 个能量点取 1
  const d = String(dir).replace(/'/g, "'\\''");   // 单引号转义（防注入/防路径带引号）
  const S = [];

  S.push("D='" + d + "'");
  S.push('[ -d "$D" ] || { echo __NODIR__; exit 0; }');
  /* 子目录探测：DOS 产物常在 dos/DOS/energy 下（真机 /home/user/.../nf/nf/nf/dos 就是这样） */
  S.push('SUB="$D"; for s in dos DOS energy; do if [ -d "$D/$s" ] && ls "$D/$s"/*.dat >/dev/null 2>&1; then SUB="$D/$s"; break; fi; done; echo "@DIR $SUB"');

  /* 能带：空行分块（# 跳过）→ 大文件抽稀 → 块内按 k 升序 → 输出 k up dn 三列 */
  S.push('B=""; [ -f "$SUB/BAND.dat" ] && B="$SUB/BAND.dat"; [ -z "$B" ] && [ -f "$D/BAND.dat" ] && B="$D/BAND.dat"');
  S.push('if [ -n "$B" ]; then echo @BAND; THIN=1; '
    + '[ $(stat -c%s "$B" 2>/dev/null || echo 0) -gt ' + thinAboveBytes + ' ] && THIN=' + thin + '; '
    + 'awk -v thin=$THIN \'/^[[:space:]]*#/{next} /^[[:space:]]*$/{blk++;n=0;next} NF>=3{n++; if(n%thin)next; '
    + 'printf "%d|%.6g|%.6g|%.6g\\n", blk, $1, $2, (NF>=4?$3:$2)}\' "$B" '
    + "| sort -t'|' -k1,1n -k2,2g "
    + "| awk -F'|' '{ if($1!=p){ if(NR>1) print \"\"; p=$1 } printf \"%.6g %.6g %.6g\\n\", $2, $3, $4 }'; fi");

  /* 高对称点：KLABELS（k label）优先，否则 KLINES.dat（只有 k） */
  S.push('if [ -f "$SUB/KLABELS" ]; then echo @MARKS; cat "$SUB/KLABELS" 2>/dev/null; '
    + 'elif [ -f "$SUB/KLINES.dat" ]; then echo @MARKS; cat "$SUB/KLINES.dat" 2>/dev/null; fi');

  /* PDOS：11 列 → 4 列（E,s,p,d；自旋↓取绝对值）；有同名 PDOS_ 就跳过 IPDOS_（积分 DOS 不该覆盖微分）
     ⚠️ 不再只匹配 PDOS_ 与 IPDOS_ 前缀：也收「元素+自旋直连」的命名（Liup.dat / Odown.dat / MnUP.dat / Fe-DW.dat），
        以及 SUM / A71 这类非元素名的 PDOS_ 文件。判据与面板 pdosOwner() 对齐（面板会再用任务元素复核一次）。 */
  S.push('FL="$SUB"/*.dat; [ "$SUB" != "$D" ] && FL="$FL $D"/*.dat; for f in $FL; do [ -f "$f" ] || continue; bn=$(basename "$f"); '
    + 'case "$bn" in fe.dat|BAND.dat|KLINES.dat|KLINES|TDOS.dat|ITDOS.dat|neb.dat|PBAND_*|REFORMATTED_*) continue ;; esac; '
    + 'case "$bn" in PDOS*|IPDOS*) ;; *) echo "$bn" | grep -qiE \'^[A-Za-z]{1,3}[_-]?(up|down|dw|dn)\\.dat$\' || continue ;; esac; '
    + 'case "$bn" in IPDOS_*) [ -f "$SUB/${bn#I}" ] && continue ;; esac; echo "@PDOS $bn"; '
    + 'awk -v tp=' + thinPdos + ' \'$1 ~ /^-?[0-9]/ && NF>=11 { k++; if(k%tp)next; e=$1; s=$2; p=$3+$4+$5; d=$6+$7+$8+$9+$10; '
    + 'printf "%.6g %.6g %.6g %.6g\\n", e, s, p, d }\' "$f"; done');

  /* 能垒：任务目录里的其它 .dat（排除 VASPKIT 的 BAND/KLINES/TDOS/PDOS/fe.dat）→ 前三列（标号/累计距离/能垒） */
  S.push('FL2="$D"/*.dat; [ "$SUB" != "$D" ] && FL2="$FL2 $SUB"/*.dat; for f in $FL2; do [ -f "$f" ] || continue; bn=$(basename "$f"); '
    + 'case "$bn" in BAND.dat|KLINES.dat|KLINES|TDOS.dat|ITDOS.dat|fe.dat|PDOS_*|IPDOS_*|PBAND_*|REFORMATTED_*) continue ;; esac; '
    + 'echo "@NEB $bn"; awk \'NF>=3 && $1 ~ /^-?[0-9]/{print $1, $2, $3}\' "$f" | head -300; done');

  S.push('echo __END__');
  return S.join('; ');   // **单行**
}

/** plotScript 的输出 → { dir, band, marks, pdos:[{name,text}], neb:[{name,text}] }（面板复用已有解析器） */
export function parsePlotOutput(txt) {
  const out = { dir: '', band: '', marks: '', pdos: [], neb: [] };
  let sec = null, cur = null;
  for (const ln of String(txt === undefined || txt === null ? '' : txt).split(/\r?\n/)) {
    if (ln === '__NODIR__') return null;
    if (ln === '__END__') break;
    if (ln.indexOf('@DIR ') === 0) { out.dir = ln.slice(5).trim(); sec = null; continue; }
    if (ln === '@BAND') { sec = 'band'; out.band = ''; continue; }
    if (ln === '@MARKS') { sec = 'marks'; out.marks = ''; continue; }
    if (ln.indexOf('@PDOS ') === 0) { cur = { name: ln.slice(6).trim(), text: '' }; out.pdos.push(cur); sec = 'pdos'; continue; }
    if (ln.indexOf('@NEB ') === 0) { cur = { name: ln.slice(5).trim(), text: '' }; out.neb.push(cur); sec = 'neb'; continue; }
    if (sec === 'band' || sec === 'marks') out[sec] += ln + '\n';
    else if ((sec === 'pdos' || sec === 'neb') && cur) cur.text += ln + '\n';
  }
  return out;
}
