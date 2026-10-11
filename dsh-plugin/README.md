# dsh-vasp-panel

VASP 任务面板的 **DSH 插件**形态。宿主半边通过 **SSH 读远程集群**上的 VASP 任务目录；
浏览器半边在 **DSH 侧栏底部（"设置"旁边）挂一个常驻入口**，点一下就把面板文件
开成侧栏里的一个标签页 —— 不用每次去文件树里找 `D:\vasp-panel\panel.html`。

## 侧栏常驻入口（浏览器半边 `lib/client.js`）

| 环节 | 做法 |
|---|---|
| 挂载点 | 外壳自带的槽位 `sidebar.footer.action`（"Optional actions beside Settings at the sidebar foot"，`replaceRisk: none`），用 `ctx.slots.inject(...)` 等声明、再 `ctx.slots.register(...)` |
| 折叠态 | 外壳把唯一 owner prop `wide` 传进来：`wide=true` 显示"图标 + VASP 面板"，`false`（56px 轨道）只显示图标 |
| 点击动作 | `ctx.get('betterSidebar').openFile({ sessionId }, 'D:\\dsh\\vasp-panel.html')` → 面板作为侧栏标签页打开（同路径自动去重，不会开成两个） |
| 为什么不是打开 URL | 侧栏浏览器硬编码拦掉一切本机地址，所以入口只把**本地面板文件**开进侧栏；面板在**不透明源沙箱 iframe**里渲染，靠下面这套 CORS 头跨域取数 |
| 依赖 | `dsh-better-sidebar`（提供 `ctx.betterSidebar`）。缺了它入口会安静降级（console.warn），**不会报错、不会拖挂页面** |
| 容错 | `apply()` 与 factory 整体 try/catch；`slots`/`betterSidebar` 都用可选访问，任何异常都不冒泡到外壳 |

> 这套客户端半边先在**隔离探针** `dsh-vasp-panel-probe` 上验证过（宿主/客户端两半加载、
> 槽位占用 `active:true`、入口渲染、点击开进侧栏、页面不挂），确认无误后才合并到这里。

## 与 dsh-vaspflow 的关键差别

| | dsh-vaspflow | dsh-vasp-panel |
|---|---|---|
| 数据来源 | **本地** `node:fs` 扫本地目录 | **远程 SSH**，按给定路径读 |
| 目录枚举 | 依赖 `readdir` | 枚举可选；**给精确路径就能读** |
| 适用 ACL | 需可读目录 | 也适用于 `--x`（可进入、不可枚举），如 `/home/shared` |
| 前端 | React + antd + three（需打包） | **单文件 HTML 走 iframe**，无需打包 |

## 路由（前缀 `/plugins/dsh-vasp-panel/*`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/diag` | 自诊断：路由注册结果 + 环境 |
| GET | `/ping` | `{ ok, sshHost, roots }` |
| GET | `/panel` | 面板 HTML（`assets/panel.html`） |
| POST | `/scan?root=&maxDepth=` | root 下所有含 `OUTCAR` 的任务目录，每行顺带：OUTCAR/OSZICAR 字节数、离子步数、**元素顺序 + 计数**（结构文件第 6/7 行，VASP4 从 POTCAR 的 TITEL 补）、**判定计算类型要用的 INCAR 子集**、**关键产物文件**（CHGCAR/CHG/DOSCAR）、**状态标记**（`done`/`acc`/`err`/`age`） |
| GET | `/list?dir=` | 某目录的**全量**文件清单（不设白名单） |
| GET | `/read?file=&offset=&limit=` | 分块读文件，base64 回传（二进制安全） |
| GET | `/convergence?dir=` | OSZICAR 离子步能量 + **电子步 SCF** + OUTCAR 的 `FORCES: max atom, RMS` |
| GET | `/task?dir=&ttl=` | 单任务全量（文件清单 + 结构 + **收敛（离子步 + 电子步）** + INCAR），一次 ssh 拿完 |

### 收敛数据的两个口径（面板的「口径」下拉）

| 口径 | 数据来源 | 取数脚本 |
|---|---|---|
| **离子步** | OSZICAR 的 `N F= ...` 汇总行 → 能量 E；OUTCAR 的 `FORCES: max atom, RMS` → 最大力/RMS 力，按离子步对齐 | `awk /^ *[0-9]+ +F=/` + `awk /FORCES: max atom, RMS/` |
| **电子步（SCF）** | OSZICAR 的 `DAV:` / `RMM:` / `CG :` 行 → `[离子步, 电子步, E, dE, rms, rms(c)]` | `awk /^[A-Za-z]+ *:/`（先剥算法前缀再按空白切列） |

> **为什么必须有电子步**：静态单点任务（`NSW=0`）只有 **1 个离子步**，离子步曲线等于空图；
> 它们真正能看的是 SCF 收敛。面板遇到单离子步任务会**自动切到电子步口径** ——
> 所以宿主半边不抽电子步时，这批任务会一律显示「无收敛数据（需 OSZICAR + OUTCAR）」（v19 修掉）。
>
> `/task` 的响应里是两个独立字段：`ionic: [[step, E, maxF, rmsF], …]` 与
> `scf: [[istep, iel, E, dE, rms, rms(c)], …]`；旧面板不认识 `scf` 也不受影响（纯增量）。
> 电子步抽取的 awk 没法在 Windows 上单测（本机没有 awk），所以它由
> `test/live-smoke.mjs` 打真集群验证（会核对 OSZICAR 首行数值）。

### 任务状态（五态）

面板的「状态」列/色点由 `/scan` 带回的 **OUTCAR 尾部标记**判出来（**只读尾部 200 KB**——
大 OUTCAR 全文 grep 会把扫描拖死；VASP 的正常收尾行与致命错误都在末尾）：

| 面板状态 | 判据 |
|---|---|
| `NO_OUTPUT_EVIDENCE` 未发现计算输出 | OUTCAR 是 0 字节 |
| `ERROR_DETECTED` 检测到错误 | 尾部命中 `VERY BAD NEWS` / `Error EDDDAV` / `ZBRENT: fatal error` / `I REFUSE TO CONTINUE` / `BAD TERMINATION` / `Fatal error` / `LAPACK…failed` / `not enough space` / `Unable to open`；**或**没有收尾行且已停止写入 |
| `TASK_COMPLETED` 任务完成 | 尾部有 `General timing and accounting`（VASP 正常收尾）。另有 `acc` 标记 `reached required accuracy`（弛豫收敛达标） |
| `RUNNING` 正在运行 | 没有收尾行，但 OUTCAR 在 900 s 内还被更新过（`age` = 距 mtime 的秒数） |
| `UNKNOWN` 待检查 | 兜底；内嵌快照（老数据只有 `acc`）仍按 `acc` 判，行为不变 |

真机实测（`/home/user/projects/demo` 39 个任务）：**完成 38 · 错误 1** —— 那个错误任务是
`VC/mg2`：`ZBRENT: fatal error in bracketing` → VASP 自己打了
`I REFUSE TO CONTINUE WITH THIS SICK JOB ... BYE!!!` 就退出了（没有收尾行），
在旧面板里它一直显示「待检查」。

> 局限：只看尾部 200 KB，所以"错误行出现得很早、之后又写了 >200 KB 正常输出"的任务会漏判（实际极少）。
> `RUNNING` 用 900 s 静默窗口，簇上 mtime 有滞后时可能把刚跑完的算成运行中（最多 15 分钟）。

**安全边界**：`root` / `dir` / `file` 必须是绝对路径、不含 `..`、且落在配置的 `roots` 白名单下。
`/home/shared` 默认会被 400 拒绝。

**性能**：一次 ssh 往返约 1.2 s（实测扫 30 个任务）。所有远端操作合并成**一次** ssh
（脚本 base64 后喂给远端 bash），结果带 15 s TTL 缓存。

## 配置

```yaml
- insert:
    - id: vasp-panel
      name: dsh-vasp-panel
      config:
        sshHost: mycluster                      # ~/.ssh/config 里的别名，或 user@host
        roots: ['/home/user/projects/demo']        # 路径白名单（安全边界）
        defaultScanRoot: /home/user/projects/demo
        maxReadBytes: 524288
```

## 安装

```bash
dsh plugin --profile desktop add <本目录>
```

或手工：在 profile 的 `package.json` 里加依赖 + 把 `dsh-vasp-panel` 加进
`dsh.profile.bundles`，然后 `pnpm install`。

> ⚠️ 本机 `C:` 只剩 ~70 MB，pnpm 安装会 `ENOSPC`。装之前需要先腾空间。

## 测试

```bash
# 宿主半边单测（32 项，不需要连集群：sshRun / tokenFile 可注入）
node --test test/host.test.mjs

# 浏览器半边单测（20 项，DOM/服务桩；不需要浏览器）
node --test test/client.test.mjs

# 真机冒烟（会真连 sshHost）
node test/live-smoke.mjs
```

真机冒烟实测：`/home/user/projects/demo` 下 **30 个** VASP 任务（1216 ms），
其中 14 个是 `cij/mno` 弹性常数应变序列 —— 这些在只手工拉了 16 个的面板里是没有的。
