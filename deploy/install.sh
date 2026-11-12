#!/usr/bin/env bash
# 在服务器上运行（幂等）：安装 / 更新 systemd 服务并重启。
#   ssh my-server 'bash /opt/conut_drama/deploy/install.sh'
# 首次运行会生成登录密码，写入 /etc/count-drama.env（仅 root 可读），并且只在这一次打印出来；
# 再次运行会把旧配置里的 BASIC_AUTH 改名为 AUTH，并补上会话签名密钥 SESSION_SECRET。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/count-drama.env

[ "$APP_DIR" = /opt/conut_drama ] || { echo "请把项目放在 /opt/conut_drama（当前：$APP_DIR）" >&2; exit 1; }
[ -x /usr/local/bin/node ] || { echo "找不到 /usr/local/bin/node" >&2; exit 1; }

# 先检查当前版本，失败时不动现有服务。
/usr/local/bin/node --test "$APP_DIR"/test/*.test.js

if [ ! -f "$ENV_FILE" ]; then
  PW="$(openssl rand -base64 36 | tr -dc 'a-km-zA-HJ-NP-Z2-9')"
  PW="${PW:0:14}"
  ( umask 077; printf 'HOST=0.0.0.0\nPORT=80\nAUTH=admin:%s\n' "$PW" | sudo tee "$ENV_FILE" >/dev/null )
  sudo chown root:root "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
  echo "已生成登录账号：admin / $PW"
else
  sudo sed -i 's/^BASIC_AUTH=/AUTH=/' "$ENV_FILE"
fi
# 会话签名密钥：没有就生成一个（之后重启服务不会让大家掉线）
if ! sudo grep -q '^SESSION_SECRET=' "$ENV_FILE"; then
  echo "SESSION_SECRET=$(openssl rand -hex 32)" | sudo tee -a "$ENV_FILE" >/dev/null
fi
sudo chown root:root "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"
sudo /usr/local/bin/node "$APP_DIR/deploy/healthcheck.js" --config-only

sudo install -m 644 "$APP_DIR/deploy/count-drama.service" /etc/systemd/system/count-drama.service
sudo systemctl daemon-reload
sudo systemctl enable count-drama >/dev/null 2>&1
sudo systemctl restart count-drama
if sudo /usr/local/bin/node "$APP_DIR/deploy/healthcheck.js"; then
  echo "count-drama: active，登录及健康检查通过"
  git -C "$APP_DIR" rev-parse HEAD
else
  echo "启动失败，最近日志：" >&2
  sudo journalctl -u count-drama -n 30 --no-pager >&2
  exit 1
fi
