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
    # 找到所有由 opencodebot 启动的 opencode 子进程
    OPENCODE_PIDS=$(pgrep -P $PID -f opencode 2>/dev/null)

    kill $PID
    echo "OpenCodeBot (PID: $PID) has been stopped."

    if [ -n "$OPENCODE_PIDS" ]; then
        for CPID in $OPENCODE_PIDS; do
            kill $CPID 2>/dev/null && echo "Opencode process (PID: $CPID) has been stopped."
        done
    fi
fi
