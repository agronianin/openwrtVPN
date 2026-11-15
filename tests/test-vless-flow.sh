#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Проверяем, что импорт не включает Vision без явного flow и сохраняет заданный режим.
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-flow-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
source=router-reinstall-kit/files/usr/bin/vpn-subscriptions-update
sed -n '/^url_decode() {/,/^subscription_group_lines() {/p' "$source" | sed '$d' > "$work/helpers"
sed -n '/^query_get() {/,/^try_refresh_group_url() {/p' "$source" | sed '$d' >> "$work/helpers"
. "$work/helpers"
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
WORKDIR="$work"
base='vless://test-user@vpn.example:443?security=reality&type=tcp&sni=example.com&pbk=test-key&sid=00'
for mode in absent empty vision; do
  case "$mode" in absent) suffix='' ;; empty) suffix='&flow=' ;; vision) suffix='&flow=xtls-rprx-vision' ;; esac
  printf '%s%s\n' "$base" "$suffix" > "$work/links"
  parse_group "$mode" "$work/links"
  [ "$parsed_count" = 1 ]
  jq -Rs '("[" + sub(",\\s*$"; "") + "]") | fromjson | .[0]' "$work/$mode.nodes" > "$work/node.json"
  if [ "$mode" = vision ]; then
    jq -e '.flow == "xtls-rprx-vision"' "$work/node.json" >/dev/null
  else
    jq -e 'has("flow") | not' "$work/node.json" >/dev/null
  fi
done
printf '%s\n%s&flow=\n%s&flow=xtls-rprx-vision\n' "$base" "$base" "$base" > "$work/links"
parse_group combined "$work/links"
[ "$parsed_count" = 2 ]
# Query-параметры декодируются один раз: WS-путь, Host и буквальный плюс должны соответствовать URI.
printf '%s\n' 'vless://test-user@vpn.example:443?security=tls&type=ws&sni=example.com&host=cdn%2Eexample.com&path=%2Fedge%2520%3Fq%3Da%2Bb' > "$work/links"
parse_group websocket "$work/links"
jq -Rs '("[" + sub(",\\s*$"; "") + "]") | fromjson | .[0]' "$work/websocket.nodes" > "$work/node.json"
jq -e '.transport.path == "/edge%20?q=a+b" and .transport.headers.Host == "cdn.example.com"' "$work/node.json" >/dev/null
echo 'PASS: absent/empty flow stays disabled, explicit Vision preserved, deduplication distinguishes flow'
