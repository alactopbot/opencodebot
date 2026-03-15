#!/bin/bash

# 脚本说明：用于停止 OpenCodeBot 服务
# 用法：
#   ./stop.sh          - 停止所有 OpenCodeBot 实例
#   ./stop.sh <PID>    - 停止指定 PID 的 OpenCodeBot 实例

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 停止指定 PID 的进程
stop_process() {
    local PID=$1
    
    # 验证 PID 是否存在且属于 OpenCodeBot
    if ! ps -p $PID > /dev/null 2>&1; then
        echo "Process (PID: $PID) not found."
        return 1
    fi
    
    if ! ps -p $PID -o cmd= | grep -q "$SCRIPT_DIR/dist/index.js"; then
        echo "Process (PID: $PID) is not an OpenCodeBot instance."
        return 1
    fi
    
    # 找到该实例启动的所有 opencode 子进程
    OPENCODE_PIDS=$(pgrep -P $PID -f opencode 2>/dev/null)

    kill $PID 2>/dev/null
    echo "OpenCodeBot (PID: $PID) has been stopped."

    if [ -n "$OPENCODE_PIDS" ]; then
        for CPID in $OPENCODE_PIDS; do
            kill $CPID 2>/dev/null && echo "Opencode process (PID: $CPID) has been stopped."
        done
    fi
    
    return 0
}

echo "Stopping OpenCodeBot..."

if [ -n "$1" ]; then
    # 停止指定 PID
    stop_process "$1"
else
    # 使用完整路径查找进程，避免与其他项目冲突
    PIDS=$(pgrep -f "$SCRIPT_DIR/dist/index.js")

    if [ -z "$PIDS" ]; then
        echo "OpenCodeBot is not running."
    else
        # 处理所有 OpenCodeBot 实例
        for PID in $PIDS; do
            stop_process "$PID"
        done
    fi
fi
