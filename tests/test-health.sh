#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d "${TMPDIR:-/tmp}/glinet-health-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir "$work/bin"
printf 'VPN_HEALTH_INTERVAL_MINUTES=1\n' > "$work/settings"
cat > "$work/bin/fake" <<'EOF'
#!/bin/sh
case "${0##*/}" in
  service) exit "${TEST_SERVICE_RC:-0}" ;;
  date) echo "$TEST_TIME" ;;
  logger) exit 0 ;;
  curl) exit "${TEST_DIRECT_RC:-0}" ;;
  vpnctl)
    if [ "$1 $2" = 'node verify' ]; then exit "${TEST_PROBE_RC:-1}"; fi
    echo recovery >> "$TEST_RECOVERY_LOG"
    ;;
esac
EOF
chmod 755 "$work/bin/fake"
for cmd in service date logger curl vpnctl; do ln -s fake "$work/bin/$cmd"; done
sed -e "s|^SETTINGS_FILE=.*|SETTINGS_FILE=$work/settings|" \
    -e "s|^HEALTH_STATE=.*|HEALTH_STATE=$work/state|" \
    -e "s|/etc/init.d/sing-box|$work/bin/service|g" \
    -e "s|/usr/bin/vpnctl|$work/bin/vpnctl|g" router-reinstall-kit/files/usr/bin/vpn-health-check > "$work/health"
export PATH="$work/bin:$PATH" VPN_HEALTH_LOCKED=1 TEST_TIME=1000 TEST_PROBE_RC=1 TEST_RECOVERY_LOG="$work/recoveries"
run() { sh "$work/health" auto > "$work/output" 2>&1 || true; }
run
[ "$(awk '{print $2}' "$work/state")" = 1 ]
run
[ "$(awk '{print $2}' "$work/state")" = 1 ]
TEST_TIME=1061; run
[ ! -f "$work/recoveries" ]
TEST_TIME=1122; run
[ "$(wc -l < "$work/recoveries" | tr -d ' ')" = 1 ]
TEST_TIME=1183; run
[ "$(wc -l < "$work/recoveries" | tr -d ' ')" = 1 ]
TEST_PROBE_RC=0 TEST_TIME=1244; run
[ "$(awk '{print $2}' "$work/state")" = 0 ]
TEST_SERVICE_RC=1; export TEST_SERVICE_RC
run
[ ! -e "$work/state" ]
echo 'PASS: timer, three failures, cooldown, success reset, off skips checks'
