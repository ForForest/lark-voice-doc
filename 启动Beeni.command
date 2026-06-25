#!/bin/bash
# 双击这个文件就能启动 Beeni 语音画板（不用开终端敲命令）。
# 第一次用：右键 → 打开（绕过 macOS 未签名提示）；之后双击即可。
cd "$(dirname "$0")" || exit 1

echo "▶ 启动 Beeni 语音画板…"
echo "  目录: $(pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "✗ 没找到 npm。请先装 Node.js (https://nodejs.org)。"
  echo "  按回车关闭。"; read -r; exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖（只这一次）…"
  npm install || { echo "✗ 依赖安装失败。按回车关闭。"; read -r; exit 1; }
fi

# 没有 .env 也照启 —— 第一次启动会自动弹出「首次配置」窗口让你填 API key。
# 构建 + 启动药丸（Electron 会自己拉起后端服务）。
npm run pill

echo ""
echo "Beeni 已退出。按回车关闭这个窗口。"
read -r
