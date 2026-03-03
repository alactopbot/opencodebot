#!/bin/bash

# 脚本说明：用于在后台启动 OpenCodeBot 服务
# 日志会输出到 ~/.opencodebot/output.log 文件

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

# 确保 ~/.opencodebot 目录存在
mkdir -p ~/.opencodebot

nohup node "$SCRIPT_DIR/dist/index.js" > ~/.opencodebot/output.log 2>&1 &

echo "OpenCodeBot started in the background."
echo "You can view the log by running: tail -f ~/.opencodebot/output.log"
