#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-restore-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
sed -n '/^add_zone_member() {/,/^add_zone_member device/p' install.sh | sed '$d' > "$work/zone"
. "$work/zone"
wan_zone='@zone[4]'
uci() {
  case "$*" in
    '-q get firewall.@zone[4].network') echo 'wan wan6 wwan existing-uplink' ;;
    '-q get firewall.@zone[4].device') echo tun0 ;;
    add_list*) printf '%s\n' "$*" >> "$work/additions" ;;
    *) echo 'Unexpected destructive operation' >&2; exit 99 ;;
  esac
}
add_zone_member device tun0
[ ! -e "$work/additions" ]
add_zone_member network modem_mm
grep -qx 'add_list firewall.@zone\[4\].network=modem_mm' "$work/additions"
sh -n install.sh
echo 'PASS: existing WAN members retained, existing devices not duplicated'
