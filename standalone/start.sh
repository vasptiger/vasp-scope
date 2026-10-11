#!/usr/bin/env bash
# VASP 任务面板 · 独立版启动器（Linux / macOS）
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo "  VASP 任务面板 - 独立版"
echo "============================================================"

command -v node >/dev/null 2>&1 || { echo "[错误] 未找到 node，请先安装 Node.js 18+： https://nodejs.org/"; exit 1; }
command -v ssh  >/dev/null 2>&1 || echo "[警告] 未找到 ssh 命令，面板无法读取远端文件。"

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "[提示] 已生成 config.json，请填写 sshHost 与 roots 后重新运行："
  echo "       ${EDITOR:-vi} config.json"
  exit 0
fi

PORT="${VASP_PANEL_PORT:-8787}"
echo "面板地址: http://127.0.0.1:${PORT}/"
echo "(Ctrl+C 停止)"
exec node server.js --port "$PORT"
