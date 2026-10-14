#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-state-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
sed -n '/^current_effective_tag() {/,/^node_info_by_tag() {/p' router-reinstall-kit/files/usr/bin/vpnctl | sed '$d' > "$work/functions"
. "$work/functions"
is_running() { return 0; }
curl() { printf '%s\n' "$response"; }
response='{"proxies":{"vpn-out":{"now":"black-01-auto"},"black-01-auto":{"now":"black-01-non-ru-auto"},"black-01-non-ru-auto":{"now":"black-01-002"},"black-01-002":{"type":"VLESS"},"black-01-099":{"type":"VLESS"}}}'
[ "$(current_effective_tag)" = black-01-002 ]
response='{"proxies":{"vpn-out":{"now":"vpn-out"}}}'
! current_effective_tag >/dev/null 2>&1
response='{"proxies":{}}'
! current_effective_tag >/dev/null 2>&1
response='{"proxies":{"vpn-out":{"type":"URLTest","now":""}}}'
! current_effective_tag >/dev/null 2>&1
is_running() { return 1; }
! current_effective_tag >/dev/null 2>&1
echo 'PASS: nested selection, cycles, missing API data, stopped VPN'
sed -n '/^add_support_rules() {/,/^vpn_on() {/p' router-reinstall-kit/files/usr/bin/vpn-toggle | sed '$d' > "$work/routes"
. "$work/routes"
del_prio4() { :; }
del_prio6() { :; }
uci() { return 1; }
ip() {
  printf '%s\n' "$*" >> "$work/ip-calls"
  if [ "$*" = 'route show table main scope link' ]; then
    printf '10.42.0.0/24 dev br-test proto kernel scope link src 10.42.0.1\n172.19.0.0/30 dev tun0 scope link\n'
  fi
}
LAN_DEV=br-test LAN_IP=10.42.0.1 VPN_MARK=0x8000/0xf000
add_support_rules
grep -q '^rule add priority 6000 fwmark 0x8000/0xf000 table main$' "$work/ip-calls"
grep -q '^route replace table 9910 10.42.0.0/24 dev br-test' "$work/ip-calls"
! grep -q '^route replace table 9910 .*dev tun0' "$work/ip-calls"
grep -q 'vpn-toggle prepare' router-reinstall-kit/files/etc/init.d/sing-box
echo 'PASS: service startup prepares the marked WAN bypass'
