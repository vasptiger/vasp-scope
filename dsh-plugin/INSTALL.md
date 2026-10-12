# 装成 DeepSeek Harness 插件

DSH 的插件分**两半**：宿主半边（`lib/host-v7.js`，跑在主进程，负责 ssh 取数）与客户端半边（`lib/client.js`，跑在 UI 里，负责侧栏入口）。同一份面板 `assets/panel.html` 由宿主路由提供。

## 1. 放进 DSH

任选一种：

```bash
# A) 开发模式：直接放进 profile 的插件目录（路径以你的 DSH 为准）
#    %USERPROFILE%\.dsh\profiles\<profile>\  （Linux/macOS 为 ~/.dsh/profiles/<profile>/）
#    目录名即插件 id：dsh-vasp-panel

# B) 本地 npm 安装（在 DSH 的 profile 目录里执行）
npm install <本仓库路径>/dsh-plugin
```

然后在 DSH 的 **设置 → 插件** 里启用它；若是手写配置，则把插件 id 加进 profile 的 `include:` 列表。

## 2. 重启 DSH

**这一步不能省** ✗：宿主半边是 Node ESM 模块，改动/首次加载都要重启才会生效（客户端半边可随页面刷新生效）。

## 3. 配置（DSH 插件配置里填）

```yaml
sshHost: mycluster                 # 或 user@host；推荐走 ~/.ssh/config 别名
roots:                             # 白名单：面板只能读这些目录之下
  - /home/you/projects
defaultScanRoot: /home/you/projects
scanDepth: 8                       # 1–16；也可在面板顶栏按根单独调
maxReadBytes: 524288               # 单次读取上限
maxImageBytes: 6291456             # 图片预览上限
token: ''                          # 留空=不鉴权（面板只在本机侧栏里）
```

## 4. 指向你的面板文件（客户端半边唯一需要手改的地方）

`lib/client.js` 顶部：

```js
var PANEL_PATH = 'D:\\vasp-panel\\panel.html';   // ← 改成你放 panel.html 的绝对路径
```

- 必须是**绝对路径**（DSH 会把相对路径拼到会话 cwd 上 ✗）
- 侧栏不能加载 `http://127.0.0.1:...`（外壳硬拦一切本机地址 ✗）→ 所以走**本地文件**，数据靠插件路由的 CORS 头跨域取 ✓

## 5. 用起来

侧栏底部（Settings 旁）会出现 **VASP 面板** 入口 ✓ → 点一下，面板就以标签页开进侧栏 ✓。
顶栏 `实时 · <host> · N 任务` 旁边的**下拉**可切换根目录；「深度」按根记忆 ✓。

## 自检

```bash
node --test test/host.test.mjs        # 宿主单测（路由注册等）
node test/live-smoke.mjs              # 打实测环境的联通性冒烟（需先配好 sshHost/roots）
```

面板侧还有一组离线探针（本仓库未附带），用来钉住 DOM 契约与关键口径 ✓。
