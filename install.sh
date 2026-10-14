#!/bin/sh
set -eu
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
FILES="$ROOT/router-reinstall-kit/files"
INSTALL_MODEM="${INSTALL_MODEM:-$(uci -q get openwrtvpn.main.modem_enabled || echo 0)}"
case "$INSTALL_MODEM" in 0|1) ;; *) echo 'INSTALL_MODEM must be 0 or 1' >&2; exit 2 ;; esac
command -v uci >/dev/null && command -v ubus >/dev/null || { echo 'OpenWrt with UCI/netifd/procd required'; exit 1; }
[ -x /etc/init.d/firewall ] || { echo 'OpenWrt firewall required'; exit 1; }
wan_zone="$(uci show firewall | sed -n "s/^firewall\.\([^.]*\)\.name='wan'$/\1/p" | head -n 1)"
[ -n "$wan_zone" ] || { echo 'Configure the WAN firewall zone and working internet first'; exit 1; }
if [ "$(uci -q get openwrtvpn.main.web_auth || echo 1)" = 1 ]; then
  awk -F: '$1 == "root" && $2 != "" && $2 !~ /^[!*]/ {ok=1} END {exit !ok}' /etc/shadow || {
    echo 'Set a router administrator password before installing the authenticated panel'; exit 1
  }
fi
if /etc/init.d/sing-box status >/dev/null 2>&1; then
  echo 'Stop the existing sing-box only when ready for installation; no files changed' >&2
  exit 1
fi
command -v sing-box >/dev/null || { echo 'Install the current official sing-box first (see README)'; exit 1; }
version="$(sing-box version | sed -n 's/^sing-box version //p' | head -n 1)"
major="${version%%.*}"; rest="${version#*.}"; minor="${rest%%.*}"
case "$major:$minor" in *[!0-9:]*|:*) echo 'Cannot determine sing-box version'; exit 1 ;; esac
if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 14 ]; }; then echo 'sing-box >= 1.14 required'; exit 1; fi
backup="/root/backup-openwrtvpn-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
sysupgrade -b "$backup/system-settings.tar.gz"
for path in /etc/sing-box /opt/router-control /etc/config/openwrtvpn /etc/init.d/sing-box /etc/init.d/router-control-web /etc/init.d/modem-t77w968-qmi /usr/bin/vpnctl /usr/bin/vpn-subscriptions-update /usr/bin/vpn-toggle /usr/bin/vpn-health-check /usr/bin/vpn-auto-update /usr/bin/vpn-mode /usr/bin/sing-box-update /usr/bin/modem-t77w968; do
  [ ! -e "$path" ] || { mkdir -p "$backup$(dirname "$path")"; cp -a "$path" "$backup$path"; }
done
packages='curl jq uhttpd flock ip-full kmod-tun ca-bundle'
[ "$INSTALL_MODEM" != 1 ] || packages="$packages modemmanager luci-proto-modemmanager qmi-utils kmod-usb-net-qmi-wwan kmod-usb-serial-option"
if command -v apk >/dev/null; then
  apk update
  apk add $packages
elif command -v opkg >/dev/null; then
  opkg update
  opkg install $packages
else
  echo 'Neither opkg nor apk found'; exit 1
fi
mkdir -p /usr/bin /etc/init.d /etc/config /opt/router-control/www/cgi-bin /etc/sing-box/vpn-config /etc/sing-box/subscriptions.d /etc/sing-box/rule-packs/available /etc/sing-box/rule-packs/enabled /etc/sing-box/subscriptions-cache /usr/share/sing-box
copy_file() { cp "$FILES/$1" "/$1"; chmod "$2" "/$1"; }
for name in vpnctl vpn-subscriptions-update vpn-toggle vpn-health-check vpn-auto-update vpn-mode sing-box-update; do copy_file "usr/bin/$name" 755; done
for name in sing-box router-control-web; do copy_file "etc/init.d/$name" 755; done
copy_file opt/router-control/www/cgi-bin/router-control 755
for name in vpn.js vpn.css index.html; do copy_file "opt/router-control/www/$name" 644; done
copy_file etc/sing-box/rule-packs/apply-rules 755
copy_file etc/sing-box/rule-packs/RULES-FORMAT.md 644
[ -f /etc/config/openwrtvpn ] || cp "$ROOT/defaults/openwrtvpn" /etc/config/openwrtvpn
uci set openwrtvpn.main.modem_enabled="$INSTALL_MODEM"
uci commit openwrtvpn
for profile in black white; do
  [ -f "/etc/sing-box/subscriptions.d/$profile.txt" ] || cp "$ROOT/defaults/subscriptions.txt" "/etc/sing-box/subscriptions.d/$profile.txt"
done
[ -f /etc/sing-box/vpn-config/vpn-settings.conf ] || cp "$ROOT/defaults/vpn-settings.conf" /etc/sing-box/vpn-config/vpn-settings.conf
for name in vpn-subscription-profile vpn-rules-profile vpn-mode; do
  [ -f "/etc/sing-box/vpn-config/$name" ] || echo BLACK > "/etc/sing-box/vpn-config/$name"
done
for name in vpn-group vpn-node; do [ -f "/etc/sing-box/vpn-config/$name" ] || echo auto > "/etc/sing-box/vpn-config/$name"; done
for file in "$ROOT/defaults/rule-packs/"*.rules; do
  dest="/etc/sing-box/rule-packs/available/${file##*/}"
  [ -f "$dest" ] || cp "$file" "$dest"
done
if ! ls /etc/sing-box/rule-packs/enabled/*.rules >/dev/null 2>&1; then
  for name in 00-private-direct 05-force-proxy 06-force-direct 30-black-main; do ln -s "../available/$name.rules" "/etc/sing-box/rule-packs/enabled/$name.rules"; done
fi
[ -f /etc/sing-box/config.json ] || cp "$ROOT/defaults/config.json" /etc/sing-box/config.json
sing-box check -c /etc/sing-box/config.json
touch /etc/config/sing-box
uci set sing-box.main=sing-box
uci set sing-box.main.enabled=1
uci set sing-box.main.conffile=/etc/sing-box/config.json
uci set sing-box.main.workdir=/usr/share/sing-box
uci commit sing-box
add_zone_member() {
  values="$(uci -q get "firewall.$wan_zone.$1" || true)"
  case " $values " in *" $2 "*) ;; *) uci add_list "firewall.$wan_zone.$1=$2" ;; esac
}
add_zone_member device tun0
uci set firewall.@defaults[0].flow_offloading=0
uci set firewall.@defaults[0].flow_offloading_hw=0
uci commit firewall
if [ "$INSTALL_MODEM" = 1 ]; then
  copy_file usr/bin/modem-t77w968 755
  copy_file etc/init.d/modem-t77w968-qmi 755
  /etc/init.d/modemmanager enable
  /etc/init.d/modem-t77w968-qmi enable
  if ! uci -q get network.modem_mm.proto >/dev/null; then
    for device in /sys/bus/usb/devices/*; do
      [ "$(cat "$device/idVendor" 2>/dev/null)" = 413c ] || continue
      [ "$(cat "$device/idProduct" 2>/dev/null)" = 81d7 ] || continue
      uci set network.modem_mm=interface
      uci set network.modem_mm.proto=modemmanager
      uci set network.modem_mm.device="$(readlink -f "$device")"
      uci set network.modem_mm.apn="$(uci -q get openwrtvpn.main.modem_apn || echo internet)"
      uci set network.modem_mm.iptype=ipv4
      uci set network.modem_mm.metric=5
      uci commit network
      break
    done
  fi
  add_zone_member network modem_mm
  uci commit firewall
fi
if [ "$(uci -q get openwrtvpn.main.web_auth || echo 1)" = 1 ]; then
  cp "$ROOT/defaults/httpd.conf" /opt/router-control/httpd.conf
fi
touch /etc/crontabs/root
for job in 'vpn-auto-update' 'vpn-health-check auto'; do
  grep -Fq "/usr/bin/$job" /etc/crontabs/root || echo "* * * * * /usr/bin/$job >/tmp/${job%% *}.log 2>&1" >> /etc/crontabs/root
done
grep -Fq '/usr/bin/sing-box-update auto' /etc/crontabs/root || echo '19 4 * * * /usr/bin/sing-box-update auto >/tmp/sing-box-update.log 2>&1' >> /etc/crontabs/root
/etc/init.d/cron enable
/etc/init.d/cron restart
/etc/init.d/firewall restart
/etc/init.d/router-control-web enable
/etc/init.d/router-control-web restart
# First-time installation deliberately leaves VPN off until real nodes are loaded.
/etc/init.d/sing-box disable
echo "Installed; backup: $backup"
echo 'Open http://<LAN-IP>:8090/ and add subscriptions. Follow the bootstrap steps in README.'
