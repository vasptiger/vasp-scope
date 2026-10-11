# vaspscope

> **在浏览器里看你集群上的 VASP 计算结果。** 一个本地小服务 + 一个网页面板；可选装成 [DeepSeek Harness](https://github.com/KevPH2026/deepseek-harness-desktop) 的侧栏插件。
> 不改远端文件、不上传数据、只监听 `127.0.0.1`。

```
收敛曲线 · 能带(+高对称点) · PDOS(自旋/分元素) · NEB 能垒 · 3D 结构 · 文件与图片 · AIMD(MSD/RDF)
```

## 30 秒上手（独立版，不需要 DSH）

```bash
# 1) 需要 Node.js 18+ 和能免密登录的 ssh
ssh you@your-cluster "echo ok"        # 应当不再问密码

# 2) 复制配置并填两项
cp standalone/config.example.json standalone/config.json
#    "sshHost": "mycluster"                     ← 或 user@host
#    "roots":   ["/home/you/projects"]          ← 允许读取的白名单

# 3) 启动
node standalone/server.js             # 或双击 standalone/start.bat
# 浏览器打开 http://127.0.0.1:8787/
```

自检：`node standalone/smoke-test.mjs`（逐条打印面板、`/ping`、`/diag`、`/scan`、`/list` 状态）

## 两种用法，一个代码库

| | **独立版**（`standalone/`） | **DSH 插件版**（`dsh-plugin/`） |
|---|---|---|
| 需要什么 | Node + 系统 ssh | DeepSeek Harness |
| 面板在哪 | 浏览器标签页 | DSH 侧栏标签页 |
| 改代码生效 | 重启这个服务（秒级） | 改宿主代码要重启 DSH |
| 配置 | `config.json` | DSH 插件配置（`sshHost`/`roots`/…） |
| 适合谁 | 绝大多数人 ✓ | 已经在用 DSH 的人 |

插件安装见 [`dsh-plugin/INSTALL.md`](dsh-plugin/INSTALL.md)。仓库 GitHub topic 带 **`dsh-plugin`**，便于 DSH 的插件市场发现。

## 它能显示什么

| 页签 | 内容 |
|---|---|
| **收敛曲线** | 离子步能量/最大力；电子步 SCF `|ΔE|`/rms（双对数）；离子步切换；科学计数法 |
| **能带** | `BAND.dat`（多段自动拼接）；自旋↑/↓分栏；**X 轴高对称点**（`KLABELS` → `KPOINTS`+倒格矢 → 段界，只标字母 ✓） |
| **PDOS** | `PDOS_*`/`IPDOS_*` 分元素开关；自旋镜像；总态密度；s/p/d 三通道；强度轴刻度 |
| **能垒** | NEB/过渡态 `*.dat` 多文件；X 口径可选 + 反转；完成门槛判定；三级取数（批量 → 逐文件 → 从 image 目录算距离） |
| **3D 结构** | `CONTCAR`/`POSCAR`；球/空间填充/多面体；VESTA 配色；晶轴视角；键长判据（VESTA 字典/第一配位壳/固定阈值） |
| **文件** | 目录树（默认收起）；文本分块阅读；**图片预览**（png/jpg/gif/webp/bmp/svg） |
| **AIMD** | MSD（ps 窗口、过原点、全段+后段双 D、对照 `DIFFUSION_COEFFICIENT.dat`）；RDF 多元素对 |

全局：嵌套任务树/表格 + 搜索、任务状态五态判定、**计算类型判定**、**逐项导出**（7 类 PNG + 6 类 CSV + JSON）、多根目录下拉与**每根独立扫描深度**。

## 安全（务必读一眼）

**谁能打开面板，谁就能读到你那个 ssh 账号能读到的一切。** 面板不引入新权限：只走系统 `ssh`、只读 `roots` 白名单、不写远端、只监听 `127.0.0.1`。
细节与推荐配置见 [`SECURITY.md`](SECURITY.md)；`config.json` 已在 `.gitignore` 中，**别提交**。

## 常见问题

| 现象 | 处理 |
|---|---|
| `未找到 node` / 端口被占 | 装 Node 18+；`node standalone/server.js --port 9000` |
| 面板显示"未连接插件 · HTTP 404" | 先 `node standalone/smoke-test.mjs`；再手工 `ssh <sshHost> "ls <roots[0]>"` |
| 任务列表为空 | 检查 `roots`；VASP 目录常有 `nf/nf/nf` 尾链，把深度调大（顶栏「深度」按根记忆） |
| 只想看某一个根 | `roots` 里只保留一个 → 顶栏下拉会自动隐藏 |
| 远程读取很慢 | 深度越大越慢；给大共享目录单独设小深度 |

## 目录结构

```
standalone/     本地服务 + 面板（无 DSH 依赖，零个人数据）
  server.js         本地 HTTP 服务：面板 + 11 条数据路由
  lib/host-v7.js    路由实现（createHandlers(cfg)）
  lib/plot-script.js 远端 shell+awk 批处理脚本与其输出解析
  public/panel.html 面板本体（239 KB 单文件，无外部依赖）
dsh-plugin/     DeepSeek Harness 插件（同一份面板 + 11 条路由 + 侧栏入口）
docs/           功能清单、开发规范、补丁流程
```

## 已知未做（欢迎 PR）

- fat band / 投影能带（`PBAND_*` 12 列，线宽∝权重）
- NEB 的 3D 点位图；`COORDINATION_NUMBER` 右轴；Arrhenius（多温度 ln D vs 1/T）
- 多任务对比视图（同一图叠多条能带/收敛曲线）
- 图片目录级批处理（现在一个目录要发多次请求）

## 许可

MIT（见 [`LICENSE`](LICENSE)）。与 VASP 官方无隶属关系；"VASP" 仅用于说明所处理的文件格式。
