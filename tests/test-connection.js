'use strict';
// Проверяем разовый подбор, защиту от моргания сети, откат и сохранение результата без доступа к настоящему роутеру.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'vpn-connection-'));
const bin = path.join(work, 'bin'); fs.mkdirSync(bin);
const source = fs.readFileSync(path.join(__dirname, '../router-reinstall-kit/files/usr/bin/vpn-connection'), 'utf8');
const cli = path.join(work, 'connection');
const mock = (name, code) => { const dest = path.join(bin, name); fs.writeFileSync(dest, code); fs.chmodSync(dest, 0o755); return dest; };
const service = mock('service', String.raw`#!/usr/bin/env node
const fs=require('node:fs'),root=process.env.VPN_DATA_ROOT;
if(process.argv[2]==='status') process.exit(fs.existsSync(root+'/off')?1:0);
fs.appendFileSync(root+'/events','restart\n');
if(process.env.TEST_RESTART_FAIL && !fs.existsSync(root+'/restart-failed')) { fs.writeFileSync(root+'/restart-failed','1'); process.exit(1); }
const config=JSON.parse(fs.readFileSync(root+'/config.json')), state=JSON.parse(fs.readFileSync(root+'/api.json'));
const group=config.outbounds.find(node=>node.tag==='vpn-out'); state.proxies['vpn-out']={all:group.outbounds,now:group.default};
for(const node of config.outbounds.filter(n=>n.type==='vless')) state.proxies[node.tag]={type:'VLESS',history:[]};
fs.writeFileSync(root+'/api.json',JSON.stringify(state));
if(process.env.TEST_COLD_API) fs.writeFileSync(root+'/api-not-ready','3');
`);
const engine = mock('engine', String.raw`#!/usr/bin/env node
const fs=require('node:fs'),root=process.env.TEST_ROOT;
if(process.argv[2]==='targets') {
 console.log(JSON.stringify({items:[{id:process.env.TEST_TARGET||'google',name:'Test',url:'https://example.org/check',status:204}]}));
 process.exit(0);
}
if(process.argv[2]==='cancel') process.exit(0);
if(process.argv[2]==='discard') {fs.appendFileSync(root+'/discarded',process.argv[3]+'\n');process.exit(0);}
const request=JSON.parse(fs.readFileSync(0,'utf8')), results=JSON.parse(fs.readFileSync(root+'/results.json'));
const targets=JSON.parse(fs.readFileSync(process.env.VPN_DATA_ROOT+'/profiles/test-targets.json'));
if (!targets.some(target=>target.id===request.target)) process.exit(1);
fs.appendFileSync(root+'/tested',JSON.stringify(request.tags)+'\n');
if(process.env.TEST_CONTEXT_CHANGE) {
 const file=root+'/profiles/catalog.json', catalog=JSON.parse(fs.readFileSync(file));catalog.profiles[0].name='Changed during search';
 fs.writeFileSync(file,JSON.stringify(catalog));
}
if(process.env.TEST_OFF_DURING_SEARCH) fs.writeFileSync(process.env.VPN_CONNECTION_ROOT+'/off','1');
console.log(JSON.stringify({id:'test-job',state:'done',total:request.tags.length,done:request.tags.length,results:request.tags.map(tag=>({
 tag,title:tag,type:'vless',passed:results[tag]?.passed??0,attempts:2,ok:results[tag]?.passed===2,latency_ms:results[tag]?.latency??null,http_code:204
}))}));
`);
mock('curl', String.raw`#!/usr/bin/env node
const fs=require('node:fs'),root=process.env.TEST_ROOT,args=process.argv.slice(2),url=args.at(-1);
if(url.includes('127.0.0.1:9090') && fs.existsSync(root+'/api-not-ready')) {
 const n=Number(fs.readFileSync(root+'/api-not-ready'));
 if(n>0) {fs.writeFileSync(root+'/api-not-ready',String(n-1));process.exit(7);}
}
if(url.endsWith('/proxies/vpn-out')) {
 const state=JSON.parse(fs.readFileSync(root+'/api.json')); state.proxies['vpn-out'].now=JSON.parse(fs.readFileSync(0,'utf8')).name;
 if (process.env.TEST_PIN_FAIL && state.proxies['vpn-out'].now==='src-fast') fs.mkdirSync(root+'/config.json.new');
 fs.writeFileSync(root+'/api.json',JSON.stringify(state)); fs.appendFileSync(root+'/events','select '+state.proxies['vpn-out'].now+'\n'); process.exit(0);
}
if(url.endsWith('/proxies')) {console.log(fs.readFileSync(root+'/api.json','utf8'));process.exit(0);}
if(url==='https://ya.ru') process.exit(process.env.TEST_WAN_FAIL?28:0);
const countFile=root+'/probe-count', n=fs.existsSync(countFile)?Number(fs.readFileSync(countFile)):0;fs.writeFileSync(countFile,String(n+1));
const current=JSON.parse(fs.readFileSync(root+'/api.json')).proxies['vpn-out'].now;
const results=JSON.parse(fs.readFileSync(root+'/results.json'));
const good=n>=Number(process.env.TEST_FAIL_FIRST||0) && results[current]?.passed===2;
console.log(good?'204 0.1':'000 0.1');process.exit(good?0:28);
`);
mock('sing-box', String.raw`#!/usr/bin/env node
if(process.env.TEST_CHANGE_RELOAD) {
 const fs=require('node:fs'), file=process.env.VPN_DATA_ROOT+'/profiles/connection-settings.json';
 const settings=JSON.parse(fs.readFileSync(file));settings.allow_reload=false;
 fs.writeFileSync(file,JSON.stringify(settings));
}
`);
mock('date', '#!/bin/sh\necho "${TEST_NOW:-10000}"\n');
mock('sleep', '#!/bin/sh\nexit 0\n');
mock('ip', '#!/bin/sh\necho "77.88.8.8 via 192.0.2.1 dev testwan"\n');
mock('flock', `#!/bin/sh
while [ "$#" -gt 0 ]; do [ "$1" != env ] || exec "$@"; shift; done
exit 0
`);
const updater = mock('updater', '#!/bin/sh\necho refreshed >> "$TEST_ROOT/events"\nexit 1\n');
fs.writeFileSync(cli, source.replaceAll('/etc/init.d/sing-box', service).replaceAll('/usr/bin/vpn-node-tests', engine)
  .replaceAll('/usr/bin/vpn-profiles', updater)); fs.chmodSync(cli, 0o755);
function setup(name) {
  const root = path.join(work, name); fs.mkdirSync(path.join(root, 'profiles/cache'), {recursive: true});
  const write = (file, data) => fs.writeFileSync(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data));
  const node = tag => ({type: 'vless', tag, server: tag+'.example.org', server_port: 443});
  write('config.json', {outbounds:[{type:'direct',tag:'direct'},node('src-old'),
    {type:'selector',tag:'vpn-out',outbounds:['src-old'],default:'src-old',interrupt_exist_connections:false}],route:{final:'vpn-out',rules:[]}});
  write('api.json', {proxies:{'vpn-out':{all:['src-old'],now:'src-old'},'src-old':{type:'VLESS',history:[]}}});
  write('profiles/catalog.json', {version:1,subscriptions:[{id:'src',name:'Source',urls:['https://example.org/sub']}],
    profiles:[{id:'test',name:'Test',subscriptions:['src'],nodes:[],rules:[],final:'vpn-out',preference:'any'}]});
  write('profiles/active', 'test\n'); write('profiles/managed','1\n');
  write('profiles/cache/src.nodes',[node('src-fast'),node('src-slow')].map(n=>JSON.stringify(n)+',\n').join(''));
  write('profiles/cache/src.titles','src-fast\tFast NL\nsrc-slow\tSlow RU\n');
  write('profiles/cache/src.tags','src-fast\nsrc-slow\n'); write('profiles/cache/src.preferred','2\n');
  write('results.json', {'src-old':{passed:2,latency:500},'src-fast':{passed:2,latency:50},'src-slow':{passed:2,latency:200}});
  const env = {...process.env,PATH:bin+':'+process.env.PATH,TEST_ROOT:root,VPN_DATA_ROOT:root,VPN_CONNECTION_ROOT:path.join(root,'runtime')};
  const run = (args,input) => spawnSync(cli,args,{env,input,encoding:'utf8'});
  const settings = {enabled:true,interval_minutes:5,failures:3,target:'google',refresh_on_failure:false,allow_reload:true};
  const save = () => {
    const current=JSON.parse(run(['status']).stdout);
    const result=run(['configure',current.revision],JSON.stringify(settings)); assert.equal(result.status,0,result.stderr);
  };
  save(); return {root,write,env,run,settings,save};
}
async function finish(fixture) {
  for(let i=0;i<200;i++) {
    const result=JSON.parse(fixture.run(['status']).stdout);
    if(result.job && result.job.state!=='running') {await new Promise(r=>setTimeout(r,30));return result;}
    await new Promise(r=>setTimeout(r,30));
  }
  throw new Error('Worker did not finish');
}
async function start(fixture,kind) {
  const launched=fixture.run(['start',kind]);assert.equal(launched.status,0,launched.stderr);return finish(fixture);
}
async function test() {
  // Проверка сохраняется независимо от панели и не вызывает подбор; при OFF сеть вообще не запускается.
  let f=setup('check');
  // После перевода часов назад новое задание сохраняется, а самое старое из предыдущих удаляется.
  const runtime=path.join(f.root,'runtime');
  for(let i=0;i<20;i++) fs.mkdirSync(path.join(runtime,`${20000+i}-123`));
  let result=await start(f,'check');
  assert.equal(result.job.state,'done',JSON.stringify(result));assert.equal(result.lastCheck.ok,true);
  const retained=fs.readdirSync(runtime,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name);
  assert.equal(retained.length,20);
  assert.ok(retained.includes(result.job.id));
  assert.ok(!retained.includes('20000-123'));
  assert.equal(result.lastCheck.node,'src-old');assert.equal(fs.existsSync(path.join(f.root,'tested')),false);
  f.write('runtime/off','1');assert.equal(f.run(['start','find']).status,1);
  // Подбор новых узлов не трогает правила, находит минимум задержки и делает единственный restart после успешных тестов.
  f=setup('find'); const route=JSON.parse(fs.readFileSync(path.join(f.root,'config.json'))).route;
  f.env.TEST_TARGET='custom'; f.settings.target='custom'; f.save();
  fs.appendFileSync(
    path.join(f.root,'profiles/cache/src.nodes'),
    JSON.stringify({type:'vless',tag:'src-old',server:'cache.example.org',server_port:443})+',\n'
  );
  result=await start(f,'find');assert.equal(result.job.state,'done',JSON.stringify(result));
  assert.equal(result.job.selected.tag,'src-fast');assert.equal(result.lastCheck.node,'src-fast');
  const newConfig=JSON.parse(fs.readFileSync(path.join(f.root,'config.json')));
  assert.deepEqual(newConfig.route,route);
  assert.equal(newConfig.outbounds.find(node=>node.tag==='src-old').server,'src-old.example.org');
  assert.equal(fs.readFileSync(path.join(f.root,'discarded'),'utf8'),'test-job\n');
  assert.equal(fs.readFileSync(path.join(f.root,'events'),'utf8').split('\n').filter(x=>x==='restart').length,1);
  // Медленный старт API — не отказ узла: ждём готовности и не делаем лишний restart/откат.
  f=setup('cold-api');f.env.TEST_COLD_API='1';result=await start(f,'find');
  assert.equal(result.job.state,'done',JSON.stringify(result));assert.equal(result.lastCheck.ok,true);
  assert.equal(fs.readFileSync(path.join(f.root,'events'),'utf8').split('\n').filter(x=>x==='restart').length,1);
  // Когда все тесты отрицательные, конфиг, selector и процесс вообще не затрагиваются.
  f=setup('none'); f.write('results.json',{}); const old=fs.readFileSync(path.join(f.root,'config.json'),'utf8');
  result=await start(f,'find');assert.equal(result.job.state,'done',JSON.stringify(result));assert.equal(result.job.phase,'not_found');
  assert.equal(fs.readFileSync(path.join(f.root,'config.json'),'utf8'),old);assert.equal(fs.existsSync(path.join(f.root,'events')),false);
  // Без разрешения на новые узлы выбирается проверенный загруженный узел без restart.
  f=setup('loaded'); f.settings.allow_reload=false;f.save();result=await start(f,'find');
  assert.equal(result.job.state,'done',JSON.stringify(result));assert.equal(result.job.selected.tag,'src-old');
  assert.ok(!fs.readFileSync(path.join(f.root,'events'),'utf8').includes('restart'));
  // Одна провалившаяся пара запросов с последующим успехом — моргание, а не повод искать другой узел.
  f=setup('blink');f.env.TEST_FAIL_FIRST='2';let launched=f.run(['auto']);assert.equal(launched.status,0,launched.stderr);
  result=await finish(f);assert.equal(result.job.state,'done',JSON.stringify(result));
  assert.equal(result.lastCheck.ok,true);assert.equal(fs.existsSync(path.join(f.root,'tested')),false);
  // Устойчивый отказ запускает поиск, а отсутствие обычного WAN подавляет его.
  f=setup('wan'); f.write('results.json',{});f.env.TEST_WAN_FAIL='1';f.run(['auto']);result=await finish(f);
  assert.equal(result.job.phase,'offline');assert.equal(fs.existsSync(path.join(f.root,'tested')),false);
  f=setup('recover');f.write('results.json',{'src-fast':{passed:2,latency:50}});f.run(['auto']);result=await finish(f);
  assert.equal(result.job.selected.tag,'src-fast');assert.equal(result.lastCheck.ok,true);
  assert.ok(Number(fs.readFileSync(path.join(f.root,'probe-count'),'utf8'))>=8);
  // Неудачный запуск кандидата возвращает прежний config и выбор.
  f=setup('rollback');f.env.TEST_RESTART_FAIL='1';const before=fs.readFileSync(path.join(f.root,'config.json'),'utf8');
  result=await start(f,'find');assert.equal(result.job.state,'failed');
  assert.equal(fs.readFileSync(path.join(f.root,'config.json'),'utf8'),before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'api.json'))).proxies['vpn-out'].now,'src-old');
  // Изменение разрешения во время проверки конфига отменяет применение.
  f=setup('reload-changed'); f.env.TEST_CHANGE_RELOAD='1';
  result=await start(f,'find');
  assert.equal(result.job.state,'failed');
  assert.equal(fs.readFileSync(path.join(f.root,'config.json'),'utf8'),before);
  assert.equal(fs.existsSync(path.join(f.root,'events')),false);
  // Если выбор не удалось сохранить, selector возвращается к прежнему узлу без рестарта.
  f=setup('pin-failed'); f.env.TEST_PIN_FAIL='1';
  const loadedConfig=JSON.parse(before);
  const selector=loadedConfig.outbounds.find(outbound=>outbound.tag==='vpn-out');
  selector.outbounds.push('src-fast');
  loadedConfig.outbounds.push({type:'vless',tag:'src-fast',server:'loaded.example.org',server_port:443});
  f.write('config.json',loadedConfig);
  f.write('api.json',{proxies:{'vpn-out':{all:selector.outbounds,now:'src-old'},'src-old':{type:'VLESS'},'src-fast':{type:'VLESS'}}});
  result=await start(f,'find');
  assert.equal(result.job.state,'failed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'config.json'))),loadedConfig);
  assert.equal(fs.readFileSync(path.join(f.root,'events'),'utf8'),'select src-fast\nselect src-old\n');
  // Предпочтение страны и порядок подписок важнее миллисекунд; остальные источники в профиль не попадают.
  f=setup('priority');let catalog=JSON.parse(fs.readFileSync(path.join(f.root,'profiles/catalog.json')));
  catalog.profiles[0].preference='ru';f.write('profiles/catalog.json',catalog);result=await start(f,'find');
  assert.equal(result.job.selected.tag,'src-slow');
  const tested=fs.readFileSync(path.join(f.root,'tested'),'utf8');assert.ok(!tested.includes('src-fast'));
  // Ручной порядок внутри группы важнее страны и задержки, при отказе проверяется следующий узел.
  f=setup('node-priority'); catalog=JSON.parse(fs.readFileSync(path.join(f.root,'profiles/catalog.json')));
  catalog.profiles[0].preference='ru';
  catalog.subscriptions[0].priority=['src-old','src-fast'];
  catalog.nodeNames={'src-fast':'Personal name'};
  f.write('profiles/catalog.json',catalog);
  f.write('results.json', {'src-old':{passed:0,latency:500},'src-fast':{passed:2,latency:50},'src-slow':{passed:2,latency:200}});
  result=await start(f,'find');
  assert.equal(result.job.selected.tag,'src-fast');
  assert.equal(result.job.selected.title,'Personal name');
  assert.deepEqual(fs.readFileSync(path.join(f.root,'tested'),'utf8').trim().split('\n').map(line=>JSON.parse(line)),[['src-old'],['src-fast']]);
  // Параллельное изменение профиля или выключение VPN отменяет применение уже найденного кандидата.
  for(const flag of ['TEST_CONTEXT_CHANGE','TEST_OFF_DURING_SEARCH']) {
    f=setup(flag);f.env[flag]='1';const initial=fs.readFileSync(path.join(f.root,'config.json'),'utf8');
    result=await start(f,'find');assert.equal(result.job.state,'failed');
    assert.equal(fs.readFileSync(path.join(f.root,'config.json'),'utf8'),initial);
    assert.equal(fs.existsSync(path.join(f.root,'events')),false);
  }
  // Автовосстановление выключено — нет ни запросов проверки, ни подбора.
  f=setup('disabled');f.settings.enabled=false;f.save();assert.equal(f.run(['auto']).status,0);
  assert.equal(fs.existsSync(path.join(f.root,'probe-count')),false);assert.equal(fs.existsSync(path.join(f.root,'tested')),false);
  console.log('PASS: one-shot best node, remembered check, no-candidate preservation, sticky loaded selection, transient/WAN guard and rollback');
}
test().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(work,{recursive:true,force:true}));
