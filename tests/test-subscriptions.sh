#!/bin/sh
set -eu
cd "$(dirname "$0")"
source="${ROUTER_CONTROL_SOURCE:-../router-reinstall-kit/files/opt/router-control/www/cgi-bin/router-control}"
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-subscriptions.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
sed -n '/^subscription_path() {/,/^save_vpn_intervals() {/p' "$source" | sed '$d' | sed "s|/tmp/vpn-subscriptions.lock|$work/lock|g" > "$work/helpers"
. "$work/helpers"
subscription_path() { case "$1" in BLACK|WHITE) echo "$work/$1.txt" ;; *) return 2 ;; esac; }
url_decode() { printf '%s' "$1"; }
field() { case "$1" in profile) echo "$profile_input" ;; revision) echo "$revision_input" ;; esac; }
flock() { return "${LOCK_BUSY:-0}"; }
sha256sum() { shasum -a 256 "$@"; }
logger() { :; }
profile_input=BLACK
printf '# Keep comments\n[first]\nhttps://example.org/one\n' > "$work/BLACK.txt"
revision_input="$(sha256sum "$work/BLACK.txt" | cut -d' ' -f1)"
CONTENT='# Keep comments
[first]
https://example.org/changed
https://mirror.example.org/subscription
[second]
https://example.net/two'
save_subscriptions > "$work/result"
grep -q 'groups=2' "$work/result"
grep -q '# Keep comments' "$work/BLACK.txt"
cmp "$work/BLACK.txt.previous" "$work/BLACK.txt" >/dev/null && exit 99
old_revision="$revision_input"
revision_input="$(sha256sum "$work/BLACK.txt" | cut -d' ' -f1)"
CONTENT='[second]
https://example.net/two'
save_subscriptions > "$work/result"
grep -q 'groups=1' "$work/result"
revision_input="$old_revision"
if save_subscriptions > "$work/result"; then exit 99; fi
grep -q 'file changed' "$work/result"
revision_input="$(sha256sum "$work/BLACK.txt" | cut -d' ' -f1)"
before="$revision_input"
for CONTENT in '[empty]' '[duplicate]
https://example.org
[duplicate]
https://example.net' '[bad]
ftp://example.org/sub' '[bad]
file:///etc/shadow' '[bad]
file:///etc/sing-box/manual-subscriptions/white/..' '[bad]
https://example.org/has spaces'; do
  if save_subscriptions > "$work/result"; then exit 99; fi
  [ "$(sha256sum "$work/BLACK.txt" | cut -d' ' -f1)" = "$before" ]
done
LOCK_BUSY=1
if save_subscriptions > "$work/result"; then exit 99; fi
LOCK_BUSY=0
CONTENT=''
save_subscriptions > "$work/result"
grep -q 'groups=0' "$work/result"
# Способ загрузки сохраняется вместе с периодами, применяется сразу и не принимает произвольные shell-значения.
sed -n '/^save_vpn_intervals() {/,/^save_force_rule() {/p' "$source" | sed '$d' \
  | sed "s|/etc/sing-box/vpn-config/vpn-settings.conf|$work/settings|g" > "$work/intervals"
. "$work/intervals"
printf 'UPDATE_INTERVAL_HOURS=1\nVPN_HEALTH_INTERVAL_MINUTES=5\nOTHER_SETTING=keep\n' > "$work/settings"
field() { case "$1" in update_hours) echo 2 ;; health_minutes) echo 7 ;; subscription_fetch_mode) printf '%s' "$mode_input" ;; esac; }
for mode_input in vpn direct vpn-first; do
  save_vpn_intervals > "$work/result"
  grep -q "^SUBSCRIPTION_FETCH_MODE=$mode_input$" "$work/settings"
  grep -q '^OTHER_SETTING=keep$' "$work/settings"
done
before=$(sha256sum "$work/settings" | cut -d' ' -f1)
mode_input='bad; command'
if save_vpn_intervals > "$work/result"; then exit 99; fi
[ "$(sha256sum "$work/settings" | cut -d' ' -f1)" = "$before" ]
mode_input=''
save_vpn_intervals > "$work/result"
grep -q '^SUBSCRIPTION_FETCH_MODE=vpn-first$' "$work/settings"
echo 'PASS: create/edit/delete, comments, stale revision, invalid data, busy lock, empty list'
