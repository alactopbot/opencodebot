#!/bin/bash

# 脚本说明：用于停止 OpenCodeBot 服务

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Stopping OpenCodeBot..."

# 使用完整路径查找进程，避免与其他项目冲突
PID=$(pgrep -f "$SCRIPT_DIR/dist/index.js")

if [ -z "$PID" ]; then
    echo "OpenCodeBot is not running."
else
    kill $PID
    echo "OpenCodeBot (PID: $PID) has been stopped."
fi
