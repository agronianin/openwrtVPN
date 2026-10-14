#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-module-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
. router-reinstall-kit/files/etc/init.d/modem-t77w968-qmi
uci() { echo "$enabled"; }
procd_open_instance() { echo called >> "$work/calls"; }
procd_close_instance() { :; }
procd_set_param() { echo "$*" >> "$work/calls"; }
enabled=0
start_service
[ ! -e "$work/calls" ]
enabled=1
start_service
grep -q '^command /usr/bin/modem-t77w968 boot$' "$work/calls"
sed -n '/^if \[ "$MODEM_ENABLED" != 1 \]; then/,/^if ! allowed_remote/p' router-reinstall-kit/files/opt/router-control/www/cgi-bin/router-control | sed '$d' > "$work/gate"
MODEM_ENABLED=0 ACTION=modem_status ACTIVE_TAB=modem sh "$work/gate" > "$work/result"
grep -q '403 Forbidden' "$work/result"
MODEM_ENABLED=0 ACTION='' ACTIVE_TAB=modem sh -c '. "$1"; echo "$ACTIVE_TAB"' sh "$work/gate" > "$work/result"
grep -qx vpn "$work/result"
MODEM_ENABLED=1 ACTION=modem_status ACTIVE_TAB=modem sh -c '. "$1"; echo enabled' sh "$work/gate" > "$work/result"
grep -qx enabled "$work/result"
sed -n '/^packages=/,/^if command -v apk/p' install.sh | sed '$d' > "$work/packages"
for INSTALL_MODEM in 0 1; do
  . "$work/packages"
  if [ "$INSTALL_MODEM" = 0 ]; then
    case "$packages" in *modem*|*qmi*) exit 99 ;; esac
  else
    case "$packages" in *modemmanager*) ;; *) exit 99 ;; esac
  fi
done
grep -q "option modem_enabled '0'" defaults/openwrtvpn
grep -q 'BIND_ADDR=.*ubus' router-reinstall-kit/files/etc/init.d/router-control-web
sh -n install.sh
echo 'PASS: modem off blocks UI/actions/startup and excludes dependencies; explicit opt-in works; dynamic LAN binding'
