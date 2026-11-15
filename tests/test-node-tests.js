'use strict';
// Проверяем изолированный маршрут тестов, ожидаемый HTTP-код, повторные пробы, скорость и сохранность рабочего VPN.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const project = path.join(__dirname, '..');
const cli = path.join(project, 'router-reinstall-kit/files/usr/bin/vpn-node-tests');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'node-tests-'));
const root = path.join(work, 'data');
const jobs = path.join(work, 'jobs');
const bin = path.join(work, 'bin');
fs.mkdirSync(path.join(root, 'profiles/cache'), {recursive: true});
fs.mkdirSync(bin);
const env = {...process.env, PATH: bin + ':' + process.env.PATH, VPN_DATA_ROOT: root, VPN_TEST_ROOT: jobs, TEST_WORK: work};
function mock(name, text) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, text); fs.chmodSync(file, 0o755);
}
function run(args, input) { return spawnSync(cli, args, {input, encoding: 'utf8', env}); }
async function finish(job) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = JSON.parse(fs.readFileSync(path.join(jobs, job.id, 'job.json')));
    if (state.state !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test worker did not finish');
}
async function test() {
  // На Mac нет flock: сетевой сценарий использует заглушку, настоящая блокировка проверяется на OpenWrt отдельно.
  mock('flock', '#!/bin/sh\nexit 0\n');
  mock('sing-box', '#!/bin/sh\nif [ "$1" = check ]; then cp "$3" "$TEST_WORK/checked.json"; exit 0; fi\nexec sleep 30\n');
  mock('curl', `#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict'); const args=process.argv.slice(2);
assert.equal(args[0],'-q'); assert.ok(args.includes('--proto')); assert.equal(args[args.indexOf('--noproxy')+1],'');
const proxy=args[args.indexOf('--proxy')+1]; assert.ok(['socks5h://127.0.0.1:21080','socks5h://127.0.0.1:21081'].includes(proxy));
if(process.env.STUB_CURL_MODE==='tls-error') { console.error('Certificate verification failed'); console.log('000 0.05'); process.exit(60); }
const speed=args.at(-1).includes('speed.cloudflare.com');
if(speed) { console.log('200 2097152 2'); process.exit(0); }
const file=process.env.TEST_WORK+'/attempt-'+proxy.slice(-5); const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;
fs.writeFileSync(file,String(n+1));
if(proxy.endsWith('21081') && n===0) console.log('403 0.02'); else console.log('204 0.15');
`);
  fs.writeFileSync(path.join(root, 'config.json'), 'working config');
  fs.writeFileSync(path.join(root, 'profiles/cache/source.nodes'),
    '{"type":"vless","tag":"one","server":"vpn.example","server_port":443},\n' +
    '{"type":"hysteria2","tag":"two","server":"vpn2.example","server_port":443},\n');
  fs.writeFileSync(path.join(root, 'profiles/cache/source.titles'), 'one\tTest RU\ntwo\tTest NL\n');
  const targets = JSON.parse(run(['targets']).stdout);
  assert.equal(targets.items.find(item => item.id === 'youtube').status, 204);
  // Ошибки редактирования не повреждают файл, устаревшая ревизия не может перезаписать настройки.
  const custom = [{id: 'own', name: 'Мой ресурс', url: 'https://example.org/check', status: 200}];
  assert.equal(run(['targets-save', 'stale'], JSON.stringify(custom)).status, 1);
  assert.equal(run(['targets-save', targets.revision], JSON.stringify(custom)).status, 0);
  const changed = JSON.parse(run(['targets']).stdout);
  assert.equal(changed.items[0].name, 'Мой ресурс');
  custom[0].url = 'http://example.org';
  assert.equal(run(['targets-save', changed.revision], JSON.stringify(custom)).status, 1);
  custom[0].url = 'https://example.org/\nhttps://other.org/';
  assert.equal(run(['targets-save', changed.revision], JSON.stringify(custom)).status, 1);
  assert.deepEqual(JSON.parse(run(['targets']).stdout), changed);
  assert.equal(run(['start'], '').status, 1);
  assert.equal(run(['start'], '{}\n{}').status, 1);
  assert.equal(run(['start'], JSON.stringify({tags: ['missing'], target: 'own', speed: false})).status, 1);
  assert.equal(run(['start'], JSON.stringify({tags: Array.from({length: 61}, (_, i) => 'tag-' + i), target: 'own', speed: false})).status, 1);
  assert.equal(run(['status', '../../etc/passwd']).status, 1);
  // 403 не считается успешным туннелем к ресурсу; 1/2 дает «нестабильно», скорость меряется лишь при 2/2.
  fs.rmSync(path.join(root, 'profiles/test-targets.json'));
  const started = run(['start'], JSON.stringify({tags: ['one', 'two'], target: 'google', speed: true}));
  assert.equal(started.status, 0, started.stderr);
  const done = await finish(JSON.parse(started.stdout));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.done, 2);
  assert.equal(done.results[0].passed, 2); assert.equal(done.results[0].latency_ms, 150);
  assert.equal(done.results[0].speed_mbps, 8.39);
  assert.equal(done.results[1].passed, 1); assert.equal(done.results[1].ok, false);
  assert.equal(done.results[1].speed_mbps, null); assert.match(done.results[1].error, /403/);
  const config = JSON.parse(fs.readFileSync(path.join(work, 'checked.json')));
  assert.ok(config.inbounds.every(item => item.listen === '127.0.0.1'));
  assert.ok(config.outbounds.every(item => item.routing_mark === 32768 && item.type !== 'direct'));
  assert.equal(config.route.rules[1].outbound, 'two');
  assert.equal(config.dns.servers[0].routing_mark, 32768);
  // Две ошибки TLS — недоступность ресурса, а не ложный успех по открытому TCP-порту.
  env.STUB_CURL_MODE = 'tls-error';
  const failedStart = run(['start'], JSON.stringify({tags: ['one'], target: 'google', speed: false}));
  assert.equal(failedStart.status, 0, failedStart.stderr);
  const failed = await finish(JSON.parse(failedStart.stdout));
  assert.equal(failed.state, 'done', JSON.stringify(failed));
  assert.equal(failed.results[0].passed, 0); assert.equal(failed.results[0].ok, false);
  assert.equal(failed.results[0].latency_ms, null); assert.match(failed.results[0].error, /Certificate/);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), 'working config');
  console.log('PASS: forced per-node proxy, repeat HTTPS checks, bounded speed, custom targets and unchanged active config');
}
test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(work, {recursive: true, force: true}));
