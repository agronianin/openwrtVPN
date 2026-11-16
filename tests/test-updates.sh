#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-update-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
sed -n '/^case "${1:-update}" in/,$p' router-reinstall-kit/files/usr/bin/vpn-subscriptions-update > "$work/dispatch"
export TEST_DISPATCH="$work/dispatch" TEST_LOG="$work/updates"
for action in refresh update update-one; do
  sh -c '
    refresh_selected() { echo refreshed >> "$TEST_LOG"; }
    refresh_one_group_number() { echo refreshed >> "$TEST_LOG"; }
    build_config() { echo "Unexpected rebuild" >&2; exit 99; }
    install_config() { echo "Unexpected install" >&2; exit 99; }
    log() { :; }
    . "$TEST_DISPATCH"
  ' sh "$action" BLACK 1
done
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" = 3 ]
sed -n '/^fetch_direct() {/,/^decode_subscription() {/p' router-reinstall-kit/files/usr/bin/vpn-subscriptions-update | sed '$d' > "$work/fetch"
. "$work/fetch"
is_running() { [ "${TEST_OFF:-0}" != 1 ]; }
ip() { echo '77.88.8.8 via 192.0.2.1 dev testwan src 192.0.2.2'; }
warn() { echo "$*" >> "$work/warnings"; }
curl() {
  printf '%s\n' "$@" > "$work/arguments"
  if printf '%s\n' "$@" | grep -q '^socks5h:'; then
    echo vpn >> "$work/fetch-attempts"
    [ "${TEST_OFF_AFTER_PROXY:-0}" != 1 ] || TEST_OFF=1
    return "${TEST_PROXY_RC:-0}"
  fi
  echo direct >> "$work/fetch-attempts"
  return "${TEST_DIRECT_RC:-0}"
}
fetch_to https://example.invalid/subscription "$work/data"
grep -q '^socks5h://127.0.0.1:2080$' "$work/arguments"
grep -q '^35$' "$work/arguments"
VPN_BOOTSTRAP=1
fetch_to https://example.invalid/subscription "$work/data"
! grep -q '^socks5h://' "$work/arguments"
grep -q '^\*$' "$work/arguments"
grep -q '^if!testwan$' "$work/arguments"
# VPN-first не уходит напрямую после успеха; при ошибке выполняет ровно одну direct-попытку.
VPN_BOOTSTRAP=0 SUBSCRIPTION_FETCH_MODE=vpn-first
: > "$work/fetch-attempts"
fetch_to https://example.invalid/subscription "$work/data"
[ "$(cat "$work/fetch-attempts")" = vpn ]
TEST_PROXY_RC=28
fetch_to https://example.invalid/subscription "$work/data"
[ "$(tail -n 2 "$work/fetch-attempts")" = "$(printf 'vpn\ndirect')" ]
SUBSCRIPTION_FETCH_MODE=vpn
fetch_to https://example.invalid/subscription "$work/data" && exit 99
[ "$(tail -n 1 "$work/fetch-attempts")" = vpn ]
SUBSCRIPTION_FETCH_MODE=direct
fetch_to https://example.invalid/subscription "$work/data"
[ "$(tail -n 1 "$work/fetch-attempts")" = direct ]
TEST_DIRECT_RC=22
fetch_to https://example.invalid/subscription "$work/data" && exit 99
# OFF запрещает сеть во всех режимах; выключение во время VPN-попытки отменяет direct fallback.
before=$(wc -l < "$work/fetch-attempts")
TEST_OFF=1
for SUBSCRIPTION_FETCH_MODE in vpn direct vpn-first; do fetch_to https://example.invalid/subscription "$work/data" && exit 99; done
[ "$(wc -l < "$work/fetch-attempts")" = "$before" ]
TEST_OFF=0 TEST_OFF_AFTER_PROXY=1 SUBSCRIPTION_FETCH_MODE=vpn-first
fetch_to https://example.invalid/subscription "$work/data" && exit 99
[ "$(tail -n 1 "$work/fetch-attempts")" = vpn ]
unset TEST_OFF TEST_OFF_AFTER_PROXY TEST_PROXY_RC TEST_DIRECT_RC
SUBSCRIPTION_FETCH_MODE=vpn
# Ошибки зеркал не раскрывают адреса подписки, а управляющие символы сохраняются в корректном JSON.
(
  sed '/^load_settings$/,$d' router-reinstall-kit/files/usr/bin/vpn-subscriptions-update > "$work/library"
  VPN_LIBRARY_ONLY=1 . "$work/library"
  WORKDIR="$work/parse"
  CACHE_DIR="$work/cache"
  mkdir "$WORKDIR"
  logger() { printf '%s\n' "$*" >> "$work/syslog"; }
  fetch_to() {
    case "$1" in
      *first*) echo "curl failed: $1" >&2; return 1 ;;
      *second*) echo 'unsupported format' > "$2" ;;
      *) printf 'vless://test-user@vpn.example:443?type=ws&path=/has\ttab#test\n' > "$2" ;;
    esac
  }
  refresh_group source Source 'https://first.invalid/secret' 'https://second.invalid/?token=secret' 'https://third.invalid/' \
    > "$work/stdout" 2> "$work/stderr"
  grep -q 'mirror 1 download failed' "$work/stderr"
  grep -q 'mirror 2 cannot decode subscription' "$work/stderr"
  if grep -q 'secret' "$work/stdout" "$work/stderr" "$work/syslog"; then exit 99; fi
  sed '$s/,$//' "$CACHE_DIR/source.nodes" | jq -e '.transport.path=="/has\ttab"' >/dev/null
)
export TEST_BOOTSTRAP="$work/bootstrap"
sh -c '
  is_running() { return 0; }
  fail() { exit 2; }
  refresh_selected() { echo unexpected > "$TEST_BOOTSTRAP"; }
  . "$TEST_DISPATCH"
' sh bootstrap && exit 99
[ ! -e "$work/bootstrap" ]
sh -c '
  is_running() { return 1; }
  refresh_selected() { [ "$VPN_BOOTSTRAP" = 1 ]; echo refreshed > "$TEST_BOOTSTRAP"; }
  subscription_profile() { echo BLACK; }
  build_config() { [ "$1" = BLACK ]; }
  install_config() { echo installed >> "$TEST_BOOTSTRAP"; }
  log() { :; }
  . "$TEST_DISPATCH"
' sh bootstrap
grep -q '^installed$' "$work/bootstrap"
# Частичный отказ подписки не запускает новый полный обход каждую минуту; busy не расходует интервал.
mkdir -p "$work/data/profiles" "$work/data/subscriptions-cache" "$work/bin"
printf 'UPDATE_INTERVAL_HOURS=1\n' > "$work/settings"
printf '{}' > "$work/data/profiles/catalog.json"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/service"
printf '#!/bin/sh\necho "$1" >> "$TEST_LOG"\n' > "$work/bin/legacy-update"
printf '#!/bin/sh\necho attempt >> "$TEST_LOG"\nexit "${TEST_REFRESH_RC:-1}"\n' > "$work/bin/profiles"
printf '#!/bin/sh\necho "$TEST_TIME"\n' > "$work/bin/date"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/logger"
chmod 755 "$work/bin/"*
sed -e "s|^SETTINGS_FILE=.*|SETTINGS_FILE=$work/settings|" \
    -e "s|^STATE_FILE=.*|STATE_FILE=$work/data/subscriptions-cache/last-auto-update|" \
    -e "s|/etc/init.d/sing-box|$work/bin/service|g" -e "s|/etc/sing-box|$work/data|g" \
    -e "s|/usr/bin/vpn-profiles|$work/bin/profiles|g" -e "s|/usr/bin/vpn-subscriptions-update|$work/bin/legacy-update|g" \
    router-reinstall-kit/files/usr/bin/vpn-auto-update > "$work/auto"
export PATH="$work/bin:$PATH" TEST_TIME=10000 TEST_LOG="$work/auto-attempts"
# До активации профиля cron обновляет старую подписку, даже если каталог уже создан.
TEST_LOG="$work/legacy-attempts" sh "$work/auto"
[ "$(cat "$work/legacy-attempts")" = refresh ]
rm "$work/data/subscriptions-cache/last-auto-update"
printf '1\n' > "$work/data/profiles/managed"
sh "$work/auto" || true
TEST_TIME=10060; sh "$work/auto"
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" = 1 ]
TEST_TIME=13601; sh "$work/auto" || true
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" = 2 ]
TEST_TIME=17202 TEST_REFRESH_RC=75; export TEST_REFRESH_RC
sh "$work/auto" || true
[ "$(cat "$work/data/subscriptions-cache/last-auto-update")" = 13601 ]
echo 'PASS: refresh preserves config; VPN/direct/fallback routing, timeout, OFF and partial-failure intervals'
