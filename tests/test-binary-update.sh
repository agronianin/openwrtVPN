#!/bin/sh
# Проверяем установку архивов разных архитектур без сети, настоящих бинарников и сервисов.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-binary-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/bin" "$work/root/etc/sing-box/vpn-config" "$work/root/usr/bin"
export SANDBOX="$work/root" FIXTURE="$work/fixture" PATH="$work/bin:$PATH"
sed -e "s|/etc/sing-box|$SANDBOX/etc/sing-box|g" -e "s|/usr/bin/sing-box|$SANDBOX/usr/bin/sing-box|g" \
  -e "s|/etc/init.d/sing-box|$work/bin/service|g" router-reinstall-kit/files/usr/bin/sing-box-update > "$work/update"
printf '#!/bin/sh\nexit 1\n' > "$work/bin/service"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/logger"
printf '#!/bin/sh\necho "sing-box version 1.14.3"\n' > "$work/bin/sing-box"
cat > "$work/bin/curl" <<'EOF'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://api.github.com/*) source="$FIXTURE/release.json" ;;
    https://github.com/*) source="$FIXTURE/release.tar.gz" ;;
    -o) shift; destination="$1" ;;
  esac
  shift
done
cp "$source" "$destination"
EOF
chmod 755 "$work/bin/"*
for arch in arm64 amd64 armv6 armv7; do
  mkdir -p "$FIXTURE/sing-box-1.14.4-linux-$arch-musl"
  printf '#!/bin/sh\n# %s\nexit 0\n' "$arch" > "$FIXTURE/sing-box-1.14.4-linux-$arch-musl/sing-box"
  chmod 755 "$FIXTURE/sing-box-1.14.4-linux-$arch-musl/sing-box"
  tar -czf "$FIXTURE/release.tar.gz" -C "$FIXTURE" "sing-box-1.14.4-linux-$arch-musl"
  digest=$(sha256sum "$FIXTURE/release.tar.gz" | cut -d' ' -f1)
  jq -n --arg name "sing-box-1.14.4-linux-$arch-musl.tar.gz" --arg digest "sha256:$digest" \
    '{tag_name:"v1.14.4",prerelease:false,draft:false,assets:[{name:$name,digest:$digest,
      browser_download_url:("https://github.com/SagerNet/sing-box/releases/download/v1.14.4/"+$name)}]}' > "$FIXTURE/release.json"
  echo previous > "$SANDBOX/usr/bin/sing-box"
  SING_BOX_ARCH="$arch" sh "$work/update" > "$work/output"
  cmp "$SANDBOX/usr/bin/sing-box" "$FIXTURE/sing-box-1.14.4-linux-$arch-musl/sing-box"
  [ "$(cat "$SANDBOX/usr/bin/sing-box.previous")" = previous ]
done
echo 'PASS: binary updater extracts arm64/amd64/armv6/armv7 candidates and preserves previous binary'
