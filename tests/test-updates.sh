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
sed -n '/^fetch_to() {/,/^decode_subscription() {/p' router-reinstall-kit/files/usr/bin/vpn-subscriptions-update | sed '$d' > "$work/fetch"
. "$work/fetch"
curl() { printf '%s\n' "$@" > "$work/arguments"; }
fetch_to https://example.invalid/subscription "$work/data"
grep -q '^socks5h://127.0.0.1:2080$' "$work/arguments"
grep -q '^35$' "$work/arguments"
VPN_BOOTSTRAP=1
fetch_to https://example.invalid/subscription "$work/data"
! grep -q '^socks5h://' "$work/arguments"
grep -q '^\*$' "$work/arguments"
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
printf '#!/bin/sh\necho attempt >> "$TEST_LOG"\nexit "${TEST_REFRESH_RC:-1}"\n' > "$work/bin/profiles"
printf '#!/bin/sh\necho "$TEST_TIME"\n' > "$work/bin/date"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/logger"
chmod 755 "$work/bin/"*
sed -e "s|^SETTINGS_FILE=.*|SETTINGS_FILE=$work/settings|" \
    -e "s|^STATE_FILE=.*|STATE_FILE=$work/data/subscriptions-cache/last-auto-update|" \
    -e "s|/etc/init.d/sing-box|$work/bin/service|g" -e "s|/etc/sing-box|$work/data|g" \
    -e "s|/usr/bin/vpn-profiles|$work/bin/profiles|g" router-reinstall-kit/files/usr/bin/vpn-auto-update > "$work/auto"
export PATH="$work/bin:$PATH" TEST_TIME=10000 TEST_LOG="$work/auto-attempts"
sh "$work/auto" || true
TEST_TIME=10060; sh "$work/auto"
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" = 1 ]
TEST_TIME=13601; sh "$work/auto" || true
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" = 2 ]
TEST_TIME=17202 TEST_REFRESH_RC=75; export TEST_REFRESH_RC
sh "$work/auto" || true
[ "$(cat "$work/data/subscriptions-cache/last-auto-update")" = 13601 ]
echo 'PASS: all refresh commands preserve live config; downloads force VPN with timeout'
