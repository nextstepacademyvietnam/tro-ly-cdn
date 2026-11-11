#!/usr/bin/env bash
# Bộ cài Trợ lý CDN cho macOS (và Linux/VPS).
#
#   curl -fsSL https://github.com/nextstepacademyvietnam/tro-ly-cdn/releases/latest/download/install.sh | bash
#
# Việc bộ cài làm (chạy lại lần nữa = sửa chữa / lên bản mới nhất, dữ liệu giữ nguyên):
#   1. Tải Node.js riêng cho app vào thư mục cài (không đụng phần mềm khác, không cần mật khẩu máy)
#   2. Tải bản Trợ lý CDN mới nhất từ GitHub Releases, kiểm tra mã SHA256, cài vào versions/<số bản>
#   3. Cài Codex (công cụ nối gói ChatGPT)
#   4. Cho app tự chạy nền khi mở máy (macOS: LaunchAgent; Linux: systemd)
#   5. Mời đăng nhập ChatGPT, rồi mở app trên trình duyệt
#
# Biến môi trường để thử nghiệm: CDN_INSTALL_DIR, CDN_RELEASE_URL, CDN_NODE_DIST, CDN_PORT,
# CDN_SKIP_CODEX=1, CDN_NO_SERVICE=1, CDN_NO_OPEN=1, CDN_YES=1 (không hỏi gì).
set -euo pipefail

REPO="nextstepacademyvietnam/tro-ly-cdn"
RELEASE_URL="${CDN_RELEASE_URL:-https://api.github.com/repos/$REPO/releases/latest}"
NODE_DIST="${CDN_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
PORT="${CDN_PORT:-3000}"
LABEL="vn.trolycdn.app"

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
note() { printf '  %s\n' "$1"; }
die() {
  printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2
  printf '  Chụp màn hình cửa sổ này gửi người hỗ trợ.\n' >&2
  exit 1
}
# Hỏi qua bàn phím kể cả khi chạy kiểu "curl … | bash" (stdin lúc đó là nội dung script).
ask() {
  local ans=""
  if [ -z "${CDN_YES:-}" ] && { : </dev/tty; } 2>/dev/null; then read -r -p "$1" ans </dev/tty || ans=""; fi
  printf '%s' "$ans"
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

OS="$(uname -s)"
case "$OS" in
  Darwin) PLAT=darwin; DEFAULT_DIR="$HOME/Library/Application Support/TroLyCDN" ;;
  Linux) PLAT=linux; DEFAULT_DIR="$HOME/.tro-ly-cdn" ;;
  *) die "Bộ cài này dành cho macOS và Linux. Trên Windows hãy dùng file Cai-dat-Tro-ly-CDN.cmd." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) NARCH=arm64 ;;
  x86_64 | amd64) NARCH=x64 ;;
  *) die "Chưa hỗ trợ loại máy $(uname -m)." ;;
esac
for c in curl tar; do command -v "$c" >/dev/null 2>&1 || die "Máy thiếu lệnh $c."; done

DIR="${CDN_INSTALL_DIR:-$DEFAULT_DIR}"
mkdir -p "$DIR/versions" "$DIR/data/logs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '\n\033[1mBộ cài Trợ lý CDN\033[0m — cài vào: %s\n' "$DIR"

# ---------- 1. Node.js riêng cho app ----------
say "1/5 Node.js (chạy riêng cho Trợ lý CDN)"
NODE="$DIR/node/bin/node"
if [ -x "$NODE" ] && "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  ok "Đã có Node.js $("$NODE" -v)"
else
  curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || die "Không tải được danh sách Node.js. Kiểm tra mạng rồi chạy lại."
  FILE="$(grep -o "node-v[0-9.]*-$PLAT-$NARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || die "Không tìm thấy Node.js cho máy $PLAT-$NARCH."
  note "Đang tải $FILE…"
  curl -fL --progress-bar "$NODE_DIST/$FILE" -o "$TMP/$FILE" || die "Tải Node.js bị lỗi. Kiểm tra mạng rồi chạy lại."
  [ "$(sha256 "$TMP/$FILE")" = "$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)" ] || die "File Node.js tải về bị hỏng (sai mã kiểm tra). Chạy lại bộ cài."
  rm -rf "$DIR/node"
  mkdir -p "$DIR/node"
  tar -xzf "$TMP/$FILE" -C "$DIR/node" --strip-components 1
  ok "Đã cài Node.js $("$NODE" -v)"
fi
export PATH="$DIR/node/bin:$PATH"
export npm_config_prefix="$DIR/node" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

# ---------- 2. Trợ lý CDN ----------
say "2/5 Tải Trợ lý CDN bản mới nhất"
curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: tro-ly-cdn-installer" "$RELEASE_URL" -o "$TMP/release.json" ||
  die "Không hỏi được GitHub bản mới nhất. Kiểm tra mạng rồi chạy lại."
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const a = r.assets || [];
  const t = a.find((x) => /\.tar\.gz$/.test(x.name)), s = a.find((x) => x.name === "SHA256SUMS");
  if (!r.tag_name || !t || !s) { console.error("Bản phát hành thiếu gói cài"); process.exit(1); }
  const q = (v) => "\x27" + String(v).replace(/\x27/g, "") + "\x27";
  console.log(`VERSION=${q(r.tag_name.replace(/^v/, ""))}\nTAR_NAME=${q(t.name)}\nTAR_URL=${q(t.browser_download_url)}\nSUMS_URL=${q(s.browser_download_url)}`);
' "$TMP/release.json" >"$TMP/release.env" || die "GitHub chưa có bản phát hành dùng được."
# shellcheck disable=SC1091
. "$TMP/release.env"
CURRENT="$(node -e 'try{console.log(require(process.argv[1]).version||"")}catch{}' "$DIR/current.json" 2>/dev/null || true)"
TARGET="$DIR/versions/$VERSION"
if [ "$CURRENT" = "$VERSION" ] && [ -f "$TARGET/dist/server/index.js" ] && [ -d "$TARGET/node_modules" ]; then
  ok "Đang dùng bản mới nhất v$VERSION"
else
  note "Đang tải v$VERSION…"
  curl -fL --progress-bar -H "User-Agent: tro-ly-cdn-installer" "$TAR_URL" -o "$TMP/$TAR_NAME" || die "Tải gói cài bị lỗi."
  curl -fsSL -H "User-Agent: tro-ly-cdn-installer" "$SUMS_URL" -o "$TMP/SHA256SUMS" || die "Tải mã kiểm tra bị lỗi."
  [ "$(sha256 "$TMP/$TAR_NAME")" = "$(grep " $TAR_NAME\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)" ] || die "Gói cài tải về bị hỏng (sai mã kiểm tra). Chạy lại bộ cài."
  STAGE="$DIR/versions/.cai-$VERSION"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  tar -xzf "$TMP/$TAR_NAME" -C "$STAGE"
  note "Đang cài thư viện (1–3 phút)…"
  (cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || die "Cài thư viện bị lỗi."
  rm -rf "$TARGET"
  mv "$STAGE" "$TARGET"
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$VERSION" ]; then PREV="\"$CURRENT\""; else PREV=null; fi
  printf '{\n  "version": "%s",\n  "previous": %s\n}\n' "$VERSION" "$PREV" >"$DIR/current.json"
  ok "Đã cài Trợ lý CDN v$VERSION"
fi
cp "$TARGET/launcher.mjs" "$DIR/launcher.mjs"

# ---------- 3. Codex (gói ChatGPT) ----------
say "3/5 Codex (công cụ nối gói ChatGPT)"
if [ -n "${CDN_SKIP_CODEX:-}" ]; then
  note "Bỏ qua (CDN_SKIP_CODEX)."
elif command -v codex >/dev/null 2>&1 && [ "$(command -v codex)" = "$DIR/node/bin/codex" ]; then
  ok "Đã có Codex"
else
  npm install -g @openai/codex --no-audit --no-fund --loglevel=error || die "Cài Codex bị lỗi."
  ok "Đã cài Codex"
fi

# ---------- 4. Tự chạy nền ----------
say "4/5 Cho Trợ lý CDN tự chạy khi mở máy"
cat >"$DIR/chay.sh" <<EOF
#!/bin/bash
# Bật Trợ lý CDN (bộ cài tạo file này). Dịch vụ nền gọi file này lúc mở máy.
DIR="$DIR"
export PATH="\$DIR/node/bin:\$PATH" CDN_DATA_DIR="\$DIR/data" PORT="$PORT" npm_config_prefix="\$DIR/node"
cd "\$DIR" || exit 1
exec node "\$DIR/launcher.mjs"
EOF
chmod +x "$DIR/chay.sh"
LOG="$DIR/data/logs/tro-ly-cdn.log"
SERVICE=""
# Bật app tách hẳn khỏi cửa sổ cài (phiên riêng): đóng Terminal hay script kết thúc thì app vẫn chạy.
# Không dùng "nohup … &": app vẫn chung nhóm tiến trình nên macOS tắt theo khi cửa sổ cài kết thúc.
start_plain() {
  node -e '
    const fs = require("fs"), { spawn } = require("child_process");
    const log = fs.openSync(process.argv[2], "a");
    spawn("/bin/bash", [process.argv[1]], { detached: true, stdio: ["ignore", log, log] }).unref();
  ' "$DIR/chay.sh" "$LOG"
}

if [ -n "${CDN_NO_SERVICE:-}" ]; then
  start_plain
  note "Không tạo dịch vụ nền (CDN_NO_SERVICE); đã bật app tạm thời."
elif [ "$PLAT" = darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/chay.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  SERVICE="mac"
  # Ứng dụng "Trợ lý CDN" để bấm mở (tạo trên máy nên macOS không chặn).
  mkdir -p "$HOME/Applications"
  APP="$HOME/Applications/Trợ lý CDN.app"
  rm -rf "$APP"
  osacompile -o "$APP" -e "do shell script \"launchctl kickstart gui/\$(id -u)/$LABEL >/dev/null 2>&1 || true\"" -e "delay 2" -e "open location \"http://localhost:$PORT\"" >/dev/null 2>&1 || true
  [ -d "$APP" ] && ln -sfn "$APP" "$HOME/Desktop/Trợ lý CDN.app" 2>/dev/null || true
  ok "App tự chạy khi mở máy. Mở nhanh bằng biểu tượng \"Trợ lý CDN\" trên Màn hình nền hoặc trong Ứng dụng."
elif command -v systemctl >/dev/null 2>&1; then
  UNIT="[Unit]
Description=Trợ lý CDN
After=network-online.target

[Service]
ExecStart=/bin/bash $DIR/chay.sh
Restart=on-failure
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target"
  if [ "$(id -u)" = 0 ]; then
    printf '%s\n' "$UNIT" | sed 's/default.target/multi-user.target/' >/etc/systemd/system/tro-ly-cdn.service
    systemctl daemon-reload && systemctl enable --now tro-ly-cdn.service >/dev/null && SERVICE="systemd"
  else
    mkdir -p "$HOME/.config/systemd/user"
    printf '%s\n' "$UNIT" >"$HOME/.config/systemd/user/tro-ly-cdn.service"
    if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now tro-ly-cdn.service >/dev/null 2>&1; then
      SERVICE="systemd-user"
      loginctl enable-linger "$USER" >/dev/null 2>&1 || note "Muốn app chạy cả khi chưa đăng nhập: sudo loginctl enable-linger $USER"
    fi
  fi
  if [ -n "$SERVICE" ]; then ok "Đã tạo dịch vụ systemd tro-ly-cdn."; else start_plain; note "Không tạo được dịch vụ nền; đã bật app tạm thời."; fi
else
  start_plain
  note "Máy không có systemd; đã bật app tạm thời. Lần sau bật bằng: $DIR/chay.sh"
fi

# Gỡ cài đặt
cat >"$DIR/go-cai-dat.sh" <<EOF
#!/bin/bash
# Gỡ Trợ lý CDN. Thêm --xoa-du-lieu để xoá cả dữ liệu (hộp thư, tính cách, đăng nhập Zalo).
launchctl bootout "gui/\$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/Desktop/Trợ lý CDN.app"
rm -rf "$HOME/Applications/Trợ lý CDN.app"
systemctl --user disable --now tro-ly-cdn.service >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/tro-ly-cdn.service"
pkill -f "$DIR/launcher.mjs" 2>/dev/null || true
pkill -f "$DIR/versions/" 2>/dev/null || true
if [ "\${1:-}" = "--xoa-du-lieu" ]; then rm -rf "$DIR"; echo "Đã gỡ và xoá dữ liệu."; else
  rm -rf "$DIR/node" "$DIR/versions" "$DIR/launcher.mjs" "$DIR/current.json" "$DIR/chay.sh"
  echo "Đã gỡ. Dữ liệu vẫn giữ ở: $DIR/data"
fi
EOF
chmod +x "$DIR/go-cai-dat.sh"

# ---------- 5. Đăng nhập ChatGPT, mở app ----------
say "5/5 Hoàn tất"
UP=""
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done
[ -n "$UP" ] || die "App chưa chạy được. Xem nhật ký: $LOG"
ok "Trợ lý CDN đang chạy: http://localhost:$PORT"

if [ -z "${CDN_SKIP_CODEX:-}" ]; then
  ANS="$(ask "  Đăng nhập gói ChatGPT ngay? Bấm Enter để đăng nhập, gõ k rồi Enter để làm sau: ")"
  if [ -z "${CDN_YES:-}" ] && [ "$ANS" != "k" ] && [ "$ANS" != "K" ]; then
    note "Trình duyệt sẽ mở trang đăng nhập ChatGPT. Đăng nhập đúng tài khoản trả phí rồi quay lại đây."
    codex login </dev/tty || note "Chưa đăng nhập được. Làm lại sau bằng lệnh: \"$DIR/node/bin/codex\" login"
  fi
fi

if [ -z "${CDN_NO_OPEN:-}" ]; then
  if [ "$PLAT" = darwin ]; then open "http://localhost:$PORT" >/dev/null 2>&1 || true
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || true; fi
fi

printf '\n\033[1;32mXong!\033[0m Mở trình duyệt vào \033[1mhttp://localhost:%s\033[0m để thiết lập.\n' "$PORT"
printf '  Nơi cài: %s\n  Dữ liệu: %s/data\n  Gỡ cài đặt: bash "%s/go-cai-dat.sh"\n\n' "$DIR" "$DIR" "$DIR"
[ "$PLAT" = linux ] && printf '  Chạy trên VPS: app chỉ nghe trên máy này (127.0.0.1). Muốn mở ra ngoài, đặt sau HTTPS (Caddy/Nginx).\n\n'
exit 0
