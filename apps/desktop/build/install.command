#!/bin/bash
#
# Flairy 一键安装脚本 / One-click installer
#
# 双击运行后会：
#   1. 把 Flairy.app 复制到「应用程序」(/Applications)
#   2. 移除下载隔离标记 (com.apple.quarantine)，解决「已损坏，无法打开」的提示
#   3. 自动启动 Flairy
#
# 因为 App 未经 Apple 签名，首次双击本脚本时系统可能拦截，
# 请「右键 → 打开」一次即可。

APP_NAME="Flairy.app"
DMG_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DMG_DIR/$APP_NAME"
DEST="/Applications/$APP_NAME"

echo ""
echo "==================================="
echo "        正在安装 Flairy"
echo "==================================="
echo ""

if [ ! -d "$SRC" ]; then
  echo "❌ 没有找到 $APP_NAME，请确认本脚本与 App 在同一个磁盘映像内。"
  echo "   ($SRC)"
  echo ""
  echo "按任意键关闭窗口…"
  read -n 1 -s
  exit 1
fi

# 普通权限安装：删除旧版 → 复制 → 去隔离
install_plain() {
  rm -rf "$DEST" && cp -R "$SRC" /Applications/ && xattr -cr "$DEST"
}

# 需要管理员权限时，弹窗输入密码后执行同样的操作
install_admin() {
  /usr/bin/osascript -e "do shell script \"rm -rf '$DEST' && cp -R '$SRC' /Applications/ && xattr -cr '$DEST'\" with administrator privileges"
}

if install_plain; then
  echo "✅ 安装完成。"
else
  echo "🔑 需要管理员权限，请在弹窗中输入开机密码…"
  if install_admin; then
    echo "✅ 安装完成。"
  else
    echo "❌ 安装失败，请把 $APP_NAME 手动拖到「应用程序」后，"
    echo "   在终端执行：xattr -cr \"$DEST\""
    echo ""
    echo "按任意键关闭窗口…"
    read -n 1 -s
    exit 1
  fi
fi

echo "🚀 正在启动 Flairy…"
open "$DEST"

echo ""
echo "全部完成，可以关闭本窗口了。"
echo ""
