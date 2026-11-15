#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for test in tests/test-*.sh; do sh "$test"; done
node tests/test-vpn-ui.js
node tests/test-install.js
node tests/test-profiles.js
node tests/test-profiles-ui.js
if [ -d .git ]; then node tests/test-publication.js; fi
