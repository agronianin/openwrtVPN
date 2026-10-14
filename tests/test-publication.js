'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
const files = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
assert.ok(files.length > 20, 'publication file list is available');
const privatePath = /(^backups\/|packages\/|subscriptions-cache\/|subscriptions\.d\/|vpn-config\/|manual-subscriptions\/|\/config\.json$|rule-packs\/(available|enabled)\/|local-setup\.md$|AGENTS\.md$)/;
const privateValue = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|withblancvpn\.online|BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY|\/Users\/argo\//i;
for (const file of files) {
  assert.ok(file === 'defaults/config.json' || file === 'AGENTS.md' || !privatePath.test(file), `private path: ${file}`);
  assert.ok(!fs.lstatSync(file).isSymbolicLink(), `symlink: ${file}`);
  assert.ok(!privateValue.test(fs.readFileSync(file,'utf8')), `private value: ${file}`);
}
console.log(`PASS: ${files.length} public files; no personal manifests, node UUIDs, archives, private keys or local paths`);
