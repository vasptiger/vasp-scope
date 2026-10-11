# vaspscope

**在浏览器里看你集群上的 VASP 计算结果。** 一个本地小服务 + 一个单文件网页面板，
数据全靠 **系统 ssh 实时读远端文件** —— 不写远端、不上传、只监听 `127.0.0.1`。

一次 ssh 取回：**收敛曲线 · 能带(带高对称点) · PDOS(自旋/分元素) · NEB 能垒 · 3D 结构 · 文件与图片 · AIMD(MSD/RDF)**，
每一页都能单独导出 PNG / CSV。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](#安装)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6f42c1.svg)](dsh-plugin/INSTALL.md)

> **English:** vaspscope is a local web dashboard for inspecting VASP calculation results over SSH —
> band structure (with high-symmetry labels), PDOS, convergence, NEB barriers, 3D structures, files/images and AIMD (MSD/RDF).
> Zero upload, read-only, loopback-only. Also ships as a [DeepSeek Harness](https://github.com/KevPH2026/deepseek-harness-desktop) sidebar plugin.

## 文档速览

- [30 秒上手](#30-秒上手)
- [为什么用它](#为什么用它) / [什么情况下别用它](#什么情况下别用它)（先看这两节更省时间）
- [它能显示什么](#它能显示什么)
- [两种形态](#两种形态一个代码库) · [安装](#安装) · [配置](#配置)
- [自检与测试](#自检与测试) · [常见问题](#常见问题)
- [安全模型](SECURITY.md) · [未做与计划](#未做与计划) · [许可](#许可)

## 30 秒上手

前置：**Node.js 18+**，以及一个能**免密登录**的 ssh 账号（配置见 FAQ）。

```bash
# 1) 先确认免密 ssh 通了
ssh you@your-cluster "echo ok"

# 2) 配置：只填两项
cd standalone
cp config.example.json config.json
#   "sshHost": "mycluster"                    ← 或 user@host
#   "roots":   ["/home/you/projects"]         ← 允许读取的目录白名单

# 3) 启动
node server.js            # Windows 也可以直接双击 start.bat
# 浏览器打开 http://127.0.0.1:8787/
```

自检：`node smoke-test.mjs` —— 逐条报告面板、`/ping`、`/diag`、`/scan`、`/list` 是否正常。

## 为什么用它

- **一次 ssh 取全部**：宿主半边用**一条**远端脚本（shell + awk）把能带、高对称点、PDOS、能垒一次性压成紧凑文本，
  而不是逐个文件拉取 —— 在慢速跨网链路上差别很大。
- **口径对着脚本走，不是对着感觉走**：能带 X 轴优先级是 `KLABELS` → `KPOINTS`+倒格矢 → 段界；
  PDOS 直接画文件里的**有符号值**（自旋下为负）；能垒 X 支持累加距离/逐步差值/序号并标明口径。
  这些取舍都写在 [docs/](docs/) 里，可复查。
- **面板是单文件**：`public/panel.html` 一个文件、零外部依赖、无构建步骤 —— 想改就改，改完刷新即见效。
- **不碰你的数据**：只读、只监听本机、无遥测；远端文件一个字节都不写（见 [SECURITY.md](SECURITY.md)）。
- **两种用法同一套代码**：不想装 DSH 就用独立版；已经在用 [DeepSeek Harness](https://github.com/KevPH2026/deepseek-harness-desktop) 就装成侧栏插件。

## 什么情况下别用它

- **你要的是分析而不是查看**：算有效质量、投影能带积分、扩散系数的统计与拟合 —— 那是
  [py4vasp](https://github.com/materialsproject/py4vasp) / [pymatgen](https://github.com/materialsproject/pymatgen) / [sumo](https://github.com/SMTG-Bham/sumo) 的活。
  vaspscope 只做"看得清、导得出"，不做二次计算。
- **数据就在本地磁盘**：直接看文件或用本地可视化工具更合适，为本地目录跑一层 ssh 是绕远路。
- **需要多人协作 / 权限分级**：它没有账号体系，只有"本机 `127.0.0.1` + 可选 token"。
- **需要 fat band / 投影能带**：**还没做**（见 [未做与计划](#未做与计划)）。
- **需要免装 Node 的单文件可执行版**：**还没做**（目前是 `node server.js`）。

## 它能显示什么

| 页签 | 内容 |
|---|---|
| **收敛曲线** | 离子步能量 / 最大力；电子步 SCF `\|ΔE\|` / rms（双对数）；离子步切换；科学计数法开关 |
| **能带** | `BAND.dat`（多段自动拼接）；自旋 ↑/↓ 分栏；**X 轴高对称点**（`KLABELS` → `KPOINTS`+倒格矢 → 段界，只标字母） |
| **PDOS** | `PDOS_*` / `IPDOS_*` 分元素开关；自旋镜像；总态密度；s/p/d 三通道；强度轴刻度 |
| **能垒** | NEB / 过渡态 `*.dat` 多文件；X 口径可选 + 反转；完成门槛判定；三级取数（批量 → 逐文件 → 从 image 目录算距离） |
| **3D 结构** | `CONTCAR` / `POSCAR`；球 / 空间填充 / 多面体；VESTA 配色；晶轴视角；键长判据（VESTA 字典 / 第一配位壳 / 固定阈值） |
| **文件** | 目录树（默认收起）；文本分块阅读（大文件不卡）；**图片预览**（png/jpg/gif/webp/bmp/svg） |
| **AIMD** | MSD（ps 窗口、过原点、全段+后段双 D、对照 `DIFFUSION_COEFFICIENT.dat`）；RDF 多元素对 |

全局：嵌套任务树 / 表格 + 搜索、任务状态五态判定、**计算类型判定**（单点 / 结构优化 / AIMD / NEB …）、
**逐项导出**（7 类 PNG + 6 类 CSV + 全量 JSON）、多根目录下拉与**每根独立扫描深度**。

## 两种形态，一个代码库

| | **独立版** `standalone/` | **DSH 插件版** `dsh-plugin/` |
|---|---|---|
| 依赖 | Node + 系统 ssh | [DeepSeek Harness](https://github.com/KevPH2026/deepseek-harness-desktop) |
| 面板位置 | 浏览器标签页 | DSH 侧栏标签页 |
| 改代码生效 | 重启该服务（秒级） | 改宿主代码需重启 DSH |
| 适合 | 绝大多数人 | 已经在用 DSH 的人 |

插件安装见 [dsh-plugin/INSTALL.md](dsh-plugin/INSTALL.md)。仓库 topic 带 **`dsh-plugin`**，便于插件市场发现。

## 安装

**独立版（Windows / macOS / Linux）**

```bash
git clone https://github.com/<you>/vaspscope
cd vaspscope/standalone
cp config.example.json config.json     # 填 sshHost 与 roots
node server.js                          # Windows: 双击 start.bat
```

需要 Node.js 18+（<https://nodejs.org/>）；ssh 用系统自带的（Windows 10/11 在「设置 → 应用 → 可选功能」里装 OpenSSH 客户端）。

**DSH 插件版**

```bash
# 放进 DSH profile 的插件目录，或在 profile 里 npm install <本仓库>/dsh-plugin
# 然后在 设置 → 插件 里启用，并重启 DSH（宿主半边是 ESM 模块，必须重启）
```

细节（含 `PANEL_PATH` 要指到你自己的面板文件）见 [dsh-plugin/INSTALL.md](dsh-plugin/INSTALL.md)。

## 配置

```jsonc
{
  "sshHost": "mycluster",                    // user@host，或 ~/.ssh/config 里的别名（推荐）
  "roots": ["/home/you/projects"],           // 白名单：面板只能读这些目录之下
  "defaultScanRoot": "/home/you/projects",   // 点「刷新」默认扫哪个
  "maxDepth": 8,                             // 扫描深度 1–16（VASP 常有 nf/nf/nf 尾链）
  "maxReadBytes": 524288,                    // 单次读取上限
  "maxImageBytes": 6291456,                  // 图片预览上限 6 MB
  "token": ""                                // 留空 = 不鉴权（服务只监听 127.0.0.1）
}
```

命令行临时覆盖：`node server.js --port 9000 --config D:\path\config.json`

## 自检与测试

```bash
node standalone/smoke-test.mjs               # 端到端连通性自检（面板 HTML + 5 条路由）
node --test dsh-plugin/test/host.test.mjs    # 宿主半边单测（路由注册等）
node dsh-plugin/test/live-smoke.mjs          # 打真机的冒烟（需先配好 sshHost / roots）
```

> 开发期还有一组**离线探针**（DOM 契约 + 关键绘图口径的断言），用于回归；未随仓库发布。

## 常见问题

<details>
<summary><b>怎么配免密 ssh？</b></summary>

```bash
ssh-keygen -t ed25519
ssh-copy-id you@your-cluster     # Windows 可手工把 ~/.ssh/id_ed25519.pub 追加到远端 ~/.ssh/authorized_keys
ssh you@your-cluster "echo ok"   # 不再问密码即成功
```
更省事：把主机 / 端口 / 密钥写进 `~/.ssh/config`，`sshHost` 直接填那个别名。
</details>

<details>
<summary><b>面板说「未连接插件 · HTTP 404」</b></summary>

先跑 `node standalone/smoke-test.mjs`；再手工验证通道：`ssh <sshHost> "ls <roots[0]>"`。
另外注意：要从 `http://127.0.0.1:8787/` 打开，而不是直接双击 `public/panel.html`（后者是 `file://`，取不到数）。
</details>

<details>
<summary><b>任务列表是空的</b></summary>

检查 `roots` 是否写对；VASP 任务常在 `nf/nf/nf` 这类深链下，把顶栏「深度」调大（每个根各自记忆）。
</details>

<details>
<summary><b>只想看某一个目录 / 怎么切换目录</b></summary>

`roots` 只留一个 → 顶栏下拉会自动隐藏；留多个 → 用下拉切换，切换期间状态灯显示「取数中…」。
</details>

<details>
<summary><b>读取很慢</b></summary>

深度越大越慢：给大目录设小深度、只给课题目录设大深度。首屏只需一次 `/scan` + 一次首个任务取数。
</details>

## 与其它工具的关系

| 工具 | 它擅长什么 | 与 vaspscope 的关系 |
|---|---|---|
| [VASPKIT](https://vaspkit.com/) | 命令行后处理、生成绘图数据 | **互补**：能读它产生的 `PDOS_*` 口径；fat band 支持待做 |
| [VESTA](https://jp-minerals.org/vesta/) | 晶体结构与电荷密度三维可视化 | **互补**：结构页配色与键长字典参考了 VESTA 的习惯 |
| [py4vasp](https://github.com/materialsproject/py4vasp) / [sumo](https://github.com/SMTG-Bham/sumo) | Python 分析与出版级出图 | **分工**：统计/拟合/正式出图用它们；"打开就看、随手导出"用 vaspscope |
| [VTST tools](https://theory.cm.utexas.edu/vtsttools/) | NEB 能量与距离提取 | **口径一致**：能垒页的取数与 X 口径按其脚本语义实现 |
| [DeepSeek Harness](https://github.com/KevPH2026/deepseek-harness-desktop) | 桌面 Agent 环境 | **宿主**：插件版把面板开进它的侧栏 |

## 安全

**谁能打开这个面板，谁就能读到你那个 ssh 账号能读到的一切** —— 面板不引入新权限：
只走系统 `ssh`、只读 `roots` 白名单、不写远端、只监听 `127.0.0.1`。
完整边界与推荐配置见 [SECURITY.md](SECURITY.md)；`config.json` 已在 `.gitignore` 中，**别提交**。
漏洞请走私密渠道报告（见 SECURITY.md）。

## 未做与计划

- [ ] **fat band / 投影能带**（`PBAND_*` 12 列，线宽 ∝ 权重）
- [ ] NEB 的 **3D 点位图**；`COORDINATION_NUMBER` 右轴；Arrhenius（多温度 ln D vs 1/T）
- [ ] **多任务对比**（同一图叠多条能带 / 收敛曲线）
- [ ] 图片目录级批处理（现在一个目录要发多次请求）
- [ ] **CI**（GitHub Actions 跑上面的测试）
- [ ] **演示模式**：内置假数据，无需集群即可试用（也便于出图做截图）

欢迎 PR / issue；如果这个面板帮你省了事，给个 ⭐ 就是最好的支持。

## 许可

MIT，见 [LICENSE](LICENSE)。与 VASP 官方（维也纳大学 / VASP Software GmbH）无隶属关系；
"VASP" 仅用于说明所处理的文件格式。
