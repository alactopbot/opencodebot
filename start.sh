#!/bin/bash

# 脚本说明：用于在后台启动 OpenCodeBot 服务
# 用法：./start.sh [config文件路径]
# 示例：./start.sh ~/.opencodebot/coding-bot/config.json
# 不传参数时默认使用 ~/.opencodebot/config.json

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR" || exit 1

echo "Building OpenCodeBot..."
npm run build

if [ $? -ne 0 ]; then
    echo "Build failed. Please check the errors above."
    exit 1
fi

echo "Starting OpenCodeBot..."

# 解析配置文件路径，推导 home 目录
CONFIG_PATH="${1:-$HOME/.opencodebot/config.json}"
CONFIG_PATH="$(realpath "$CONFIG_PATH")"
OPENCODEBOT_HOME="$(dirname "$CONFIG_PATH")"

# 确保 home 目录存在
mkdir -p "$OPENCODEBOT_HOME"

nohup node "$SCRIPT_DIR/dist/index.js" "$CONFIG_PATH" > "$OPENCODEBOT_HOME/output.log" 2>&1 &

echo "OpenCodeBot started in the background."
echo "Config: $CONFIG_PATH"
echo "You can view the log by running: tail -f $OPENCODEBOT_HOME/output.log"
