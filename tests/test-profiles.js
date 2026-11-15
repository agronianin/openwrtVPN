'use strict';
// Проверяем миграцию, CRUD профилей и сохранение рабочего config при редактировании каталога.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const project = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'profiles-test-'));
const root = path.join(work, 'data');
const cli = path.join(project, 'router-reinstall-kit/files/usr/bin/vpn-profiles');
const library = path.join(project, 'router-reinstall-kit/files/usr/bin/vpn-subscriptions-update');
function write(name, value) {
  const dest = path.join(root, name);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.writeFileSync(dest, value);
}
function run(args, input) {
  return spawnSync('sh', [cli, ...args], {
    input, encoding: 'utf8', env: {...process.env, VPN_PROFILES_LOCKED: '1', VPN_DATA_ROOT: root, VPN_PROFILE_LIBRARY: library}
  });
}
function snapshot() {
  const result = run(['snapshot']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
try {
  write('subscriptions.d/black.txt', '[test]\nhttps://example.com/subscription\n');
  write('subscriptions.d/white.txt', '[test-white]\nhttps://example.net/subscription\n');
  write('config.json', '{"old":"working-config"}');
  write('rule-packs/available/00-private-direct.rules', 'rule local\noutbound direct\nip_cidr 10.0.0.0/8\n');
  // После перестановки подписок исходный кэш может иметь другой номер: сопоставляем по URL, не позиции.
  write('subscriptions-cache/black-09.nodes', '{"tag":"black-09-001","type":"vless","server":"example.com","server_port":443},\n');
  write('subscriptions-cache/black-09.tags', 'black-09-001\n');
  write('subscriptions-cache/black-09.titles', 'black-09-001\tTest title\n');
  write('subscriptions-cache/black-09.preferred', '');
  write('subscriptions-cache/black-09.count', '1\n');
  write('subscriptions-cache/black-09.url', 'https://example.com/subscription\n');
  const initial = snapshot();
  assert.equal(initial.data.profiles.length, 2);
  assert.equal(initial.data.subscriptions.length, 2);
  assert.equal(initial.nodes[0].title, 'Test title');
  assert.match(initial.nodes[0].tag, /^source-black-01-[a-f0-9]{24}$/);
  const data = initial.data;
  data.profiles.push({id: 'third-place', name: 'Третье место', subscriptions: ['source-black-01'], nodes: [], rules: [], final: 'vpn-out', preference: 'any'});
  assert.equal(run(['save', initial.revision], JSON.stringify(data)).status, 0);
  const next = snapshot();
  assert.equal(next.data.profiles.length, 3);
  assert.equal(run(['save', initial.revision], JSON.stringify(data)).status, 1);
  data.profiles[2].subscriptions = ['missing'];
  assert.equal(run(['save', next.revision], JSON.stringify(data)).status, 1);
  data.profiles[2].subscriptions = ['source-black-01'];
  data.profiles[2].rules = ['../../etc/shadow'];
  assert.equal(run(['save', next.revision], JSON.stringify(data)).status, 1);
  assert.equal(run(['rule-save', '../../bad'], 'bad').status, 1);
  assert.equal(run(['rule-delete', '00-private-direct']).status, 1);
  assert.equal(run(['rule-save', 'my-rule', 'new'], 'rule example\noutbound direct\ndomain example.com\n').status, 0);
  const rule = snapshot().rules.find(rule => rule.id === 'my-rule');
  assert.ok(rule);
  assert.equal(run(['rule-save', 'my-rule', 'stale'], 'bad').status, 1);
  assert.equal(run(['rule-delete', 'my-rule', rule.revision]).status, 0);
  // Ручной URI превращается в отдельный источник и узел; повторный импорт не создает дубликат.
  const current = snapshot();
  const uri = 'vless://test-user@vpn.example:443?security=reality&type=tcp&sni=example.com&pbk=test-key&sid=00\n';
  assert.equal(run(['node-import', 'Own node', current.revision], uri).status, 0);
  const imported = snapshot();
  assert.ok(imported.nodes.some(node => node.subscription.startsWith('manual-')));
  assert.equal(run(['node-import', 'Own node', imported.revision], uri).status, 1);
  // Готовую подписку можно подложить в существующий источник без изменения URL, профиля и рабочего config.
  const importedFile = path.join(work, 'subscription.txt');
  fs.writeFileSync(importedFile, Buffer.from(uri).toString('base64'));
  const catalogBefore = fs.readFileSync(path.join(root, 'profiles/catalog.json'), 'utf8');
  const cacheImport = run(['import-cache', 'source-black-01', importedFile]);
  assert.equal(cacheImport.status, 0, cacheImport.stderr);
  const nodesFile = path.join(root, 'profiles/cache/source-black-01.nodes');
  const nodesBefore = fs.readFileSync(nodesFile, 'utf8');
  fs.writeFileSync(importedFile, 'invalid data');
  assert.equal(run(['import-cache', 'source-black-01', importedFile]).status, 1);
  assert.equal(fs.readFileSync(nodesFile, 'utf8'), nodesBefore);
  assert.equal(fs.readFileSync(path.join(root, 'profiles/catalog.json'), 'utf8'), catalogBefore);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"old":"working-config"}');
  // Неудачный запуск из OFF должен вернуть обычную маршрутизацию, а ошибка записи — не менять метаданные.
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  const mock = (name, content) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, '#!/bin/sh\n' + content);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const service = mock('service', 'exit 1\n');
  const toggle = mock('toggle', 'case "$1" in on) touch "$VPN_DATA_ROOT/network-changed"; exit 1 ;; off) rm -f "$VPN_DATA_ROOT/network-changed" ;; esac\n');
  mock('sing-box', 'if [ "$1" = check ]; then cp "$3" "$VPN_DATA_ROOT/last-checked.json"; fi\nexit 0\n');
  const safeCli = path.join(work, 'safe-cli');
  fs.writeFileSync(safeCli, fs.readFileSync(cli, 'utf8').replaceAll('/etc/init.d/sing-box', service).replaceAll('/usr/bin/vpn-toggle', toggle));
  const env = {...process.env, PATH: bin + ':' + process.env.PATH, VPN_PROFILES_LOCKED: '1', VPN_DATA_ROOT: root, VPN_PROFILE_LIBRARY: library};
  let failed = spawnSync('sh', [safeCli, 'activate', 'black'], {env, encoding: 'utf8'});
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /previous configuration restored/);
  assert.equal(fs.existsSync(path.join(root, 'network-changed')), false);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"old":"working-config"}');
  const checked = JSON.parse(fs.readFileSync(path.join(root, 'last-checked.json'), 'utf8'));
  assert.equal(checked.route.rules[0].outbound, 'direct');
  assert.ok(checked.route.rules[0].ip_cidr.includes('10.0.0.0/8'));
  assert.equal(checked.outbounds.find(outbound => outbound.tag === 'vpn-out').type, 'selector');
  write('profiles/active', 'old-profile\n');
  mock('cp', 'case "$2" in */config.json.new) exit 1 ;; esac\nexec /bin/cp "$@"\n');
  failed = spawnSync('sh', [safeCli, 'activate', 'black'], {env, encoding: 'utf8'});
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Cannot stage profile files/);
  assert.equal(fs.readFileSync(path.join(root, 'profiles/active'), 'utf8'), 'old-profile\n');
  // Native selector подтверждает auto/manual через API; ни одна команда не пересобирает рабочий конфиг.
  write('profiles/managed', '1\n');
  const selector = path.join(work, 'selector.json');
  fs.writeFileSync(selector, JSON.stringify({proxies: {
    'vpn-out': {all: ['profile-auto', 'loaded-node'], now: 'loaded-node'},
    'profile-auto': {now: 'loaded-node', type: 'URLTest'},
    'loaded-node': {type: 'VLESS', history: [{delay: 123}]}
  }}));
  mock('service', 'exit 0\n');
  const curl = mock('curl', '');
  fs.writeFileSync(curl, `#!/usr/bin/env node
const fs=require('node:fs'), file=process.env.TEST_SELECTOR, state=JSON.parse(fs.readFileSync(file));
if(process.argv.includes('PUT')) {
  const value=JSON.parse(fs.readFileSync(0,'utf8')).name;
  if(!process.env.TEST_REJECT_SELECTION) { state.proxies['vpn-out'].now=value; fs.writeFileSync(file,JSON.stringify(state)); }
} else console.log(JSON.stringify(state));
`);
  const selectorEnv = {...env, TEST_SELECTOR: selector};
  const select = tag => spawnSync('sh', [safeCli, 'node', tag], {env: selectorEnv, encoding: 'utf8'});
  assert.equal(select('auto').status, 0);
  let state = spawnSync('sh', [safeCli, 'snapshot'], {env: selectorEnv, encoding: 'utf8'});
  assert.deepEqual(JSON.parse(state.stdout).selection, {tag: 'profile-auto', mode: 'auto'});
  assert.equal(select('loaded-node').status, 0);
  state = spawnSync('sh', [safeCli, 'snapshot'], {env: selectorEnv, encoding: 'utf8'});
  assert.deepEqual(JSON.parse(state.stdout).selection, {tag: 'loaded-node', mode: 'manual'});
  selectorEnv.TEST_REJECT_SELECTION = '1';
  assert.equal(select('auto').status, 1);
  assert.equal(select('not-loaded').status, 1);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"old":"working-config"}');
  console.log('PASS: profile migration, stable node IDs, arbitrary profiles, stale revision, invalid refs, rule CRUD, no config restart');
} finally { fs.rmSync(work, {recursive: true, force: true}); }
