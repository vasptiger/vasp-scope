# VASP 任务面板 · 独立版（不依赖 DSH）

把 [DeepSeek Harness](https://github.com/KevPH2026/deepseek-harness-desktop) 插件版的 VASP 面板做成**一个本地小服务**：
双击启动 → 浏览器打开 → 直接看集群上的 VASP 计算结果。
**本包不含任何个人数据**（没有真实主机名、路径、令牌、密钥）。

---

## 一、它能做什么

| 页签 | 功能 |
|---|---|
| **收敛图表** | 离子步能量 / 最大力；电子步 SCF \|ΔE\| / rms（双对数）；离子步切换；科学计数法开关 |
| **能带** | `BAND.dat`（多段自动拼接）；自旋↑/↓ 分栏；**X 轴高对称点**（`KLABELS` → `KPOINTS`+倒格矢 → 段界；只标字母）；Y 固定 ±6；曲线裁剪到坐标框 |
| **PDOS** | `PDOS_*` / `IPDOS_*` 分元素开关；自旋镜像（直接画文件值）；总态密度 `TDOS.dat`；s/p/d 三通道；强度轴刻度；Y 由数据自适应（下界 −10） |
| **能垒** | NEB / 过渡态 `*.dat` 多文件；X 口径 5 种 + 反转；完成门槛判定；三级取数（批量 → 逐文件 → 从 image 目录算距离） |
| **3D 结构** | `CONTCAR`/`POSCAR`；球 / 空间填充 / 多面体；VESTA 配色；晶轴视角 + 旋转 + 复位；键长判据（VESTA 字典 / 第一配位壳 / 固定阈值） |
| **文件** | 文件列表（分类/大小/时间）；文本分块阅读；**图片预览**（png/jpg/gif/webp/bmp/svg） |
| **AIMD** | MSD（ps 窗口、过原点、全段+后段双 D、对照 VASPKIT `DIFFUSION_COEFFICIENT.dat`）；RDF（多元素对）；页内切换 |
| **全局** | 嵌套任务树 + 表格 + 搜索；任务状态判定（5 态）；计算类型判定；**逐项导出**（7 类 PNG + 6 类 CSV + JSON） |

数据全部**实时从集群读**（一条 ssh），本地不落盘、不缓存任务数据（只有 15 秒的接口缓存）。

---

## 二、准备工作（一次性）

1. **安装 Node.js 18+** → <https://nodejs.org/>（安装后命令行里 `node -v` 能出版本号即可）
2. **配置免密 ssh**（面板靠系统 `ssh` 读远端文件）
   - Windows 10/11：设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」
   - 生成/上传公钥（只需一次）：
     ```bash
     ssh-keygen -t ed25519
     ssh-copy-id user@your-cluster.example.edu      # Windows 可用 type 公钥内容 + 手工追加到 ~/.ssh/authorized_keys
     ssh user@your-cluster.example.edu "echo ok"    # 应当不再询问密码
     ```
   - 或者把主机/端口/密钥写进 `~/.ssh/config`，之后 `sshHost` 直接填那个**别名**：
     ```
     Host mycluster
       HostName your-cluster.example.edu
       User yourname
       Port 22
       IdentityFile ~/.ssh/id_ed25519
     ```
3. **确认远端目录可读**：`ssh <sshHost> "ls <你的 VASP 根目录>"`

## 三、启动（三步）

**Windows**
1. 双击 `start.bat`
2. 第一次运行会自动生成 `config.json` 并打开记事本 → 填 `sshHost` 与 `roots` → 保存
3. 再次双击 `start.bat` → 浏览器自动打开 <http://127.0.0.1:8787/>

**Linux / macOS**
```bash
./start.sh                 # 首次会生成 config.json，填好后再次运行
# 或手动：
cp config.example.json config.json && $EDITOR config.json
node server.js
```

**自检（可选，另开一个终端）**
```bash
node smoke-test.mjs
```
会逐条打印：面板 HTML、`/ping`、`/diag`（已注册路由）、`/scan`、`/list` 的状态；若数据通路不通，会提示你先手工试 `ssh <sshHost> "ls <roots[0]>"`。

## 四、`config.json` 要填什么

```jsonc
{
  "sshHost": "mycluster",                       // 或 user@host
  "roots": ["/path/to/your/vasp/projects"],     // 安全白名单：只能读这些目录下面
  "defaultScanRoot": "/path/to/your/vasp/projects",
  "maxDepth": 8,                                // 扫描深度 1–16
  "maxReadBytes": 524288,                       // 单次读取上限
  "maxImageBytes": 6291456,                     // 图片上限 6 MB
  "token": ""                                   // 留空 = 不鉴权（服务只监听 127.0.0.1）
}
```

## 五、日常使用

- 左侧 **任务树**：按目录层级展开（默认收起），点一下选中任务；也可切到 **表格** 视图排序
- 顶部 **刷新**：重新扫描远端目录（不做轮询）
- 右侧 **任务事实 / 计算类型判定**：这个任务是什么类型、跑了多少离子步、有没有收敛证据
- **导出 ▾**：每个页签都能单独导出 PNG（2× 白底）或 CSV；也可导出「全部任务 + 数据」JSON
- 深链（可收藏/分享，注意别把带 `token` 的链接外发）：
  `?tab=band&task=<任务路径片段>`、`?scfstep=3`、`?zoom=1.5`

## 六、常见问题

| 现象 | 处理 |
|---|---|
| `[错误] 未找到 node` | 装 Node.js 18+ 后重开命令行 |
| 启动报“端口 8787 被占用” | `node server.js --port 9000`（start.sh 支持 `VASP_PANEL_PORT=9000`） |
| 面板显示“插件未连接 / 读取失败” | 先跑 `node smoke-test.mjs`；再用 `ssh <sshHost> "ls <roots[0]>"` 手工验证 ssh |
| 任务列表为空 | 检查 `roots` 是否写对、`maxDepth` 是否够（VASP 常有 `nf/nf/nf` 尾链） |
| 想限制访问 | 给 `token` 填一个随机串，之后用 `http://127.0.0.1:8787/?token=<值>` 打开 |
| 想换端口/配置文件 | `node server.js --port 9000 --config D:\path\config.json` |

## 七、目录结构

```
vasp-panel-standalone/
├─ server.js              # 本地 HTTP 服务：面板 + 11 条数据路由（node:http）
├─ config.example.json    # 配置模板（复制成 config.json 使用）
├─ start.bat / start.sh   # 一键启动
├─ smoke-test.mjs         # 自检
├─ lib/
│  ├─ host-v7.js          # 与 DSH 插件版相同的路由实现（createHandlers(cfg)）
│  └─ plot-script.js      # 远端 shell 脚本（一次 ssh 取全部谱图）+ 输出解析
└─ public/panel.html      # 面板本体（与 DSH 版同一套 UI）
```

## 八、与 DSH 插件版的差别

| | 独立版（本包） | DSH 插件版 |
|---|---|---|
| 依赖 | 只要 Node + 系统 ssh | 需要 DeepSeek Harness |
| 面板位置 | 浏览器标签页 | DSH 侧栏 |
| 改宿主代码生效 | **重启这个服务即可**（秒级） | 需要重启 DSH |
| 配置 | `config.json`（改完重启服务） | `cordis.patch.yml`（改完要重启 DSH） |
| 图片预览 | 同（canvas 解码） | 受侧栏 `img-src` 限制（已用 canvas 绕过） |
| 权限 | 本机 127.0.0.1，可选 token | 同 |

## 九、许可与致谢

- 面板与路由实现：MIT（与本项目一致）
- 远端批处理脚本（`lib/plot-script.js`）为纯 shell + awk，无第三方依赖
- 面板口径参考了常用 VASP 后处理工具（VASPKIT 的输出格式、VESTA 的配色与键长字典、VTST/Henkelman 组的 NEB 距离口径）
