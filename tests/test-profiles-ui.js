'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../router-reinstall-kit/files/opt/router-control/www/profiles.js'), 'utf8');

// Минимальный DOM запускает настоящий интерфейс без браузера и внешних зависимостей.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {};
    this.value = ''; this.disabled = false; this._text = ''; this.parent = null;
    this.classes = new Set();
    this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value) };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get isConnected() { return this === root || !!(this.parent && this.parent.isConnected); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type) { for (const callback of this.listeners[type] || []) await callback({ target: this }); await settle(); }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(tag => tag.trim());
    return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
let root, context, requests, confirmAnswer, replies, unload, timers;
const initial = {
  revision: 'revision-1', active: 'work', running: true,
  selection: {mode: 'auto', tag: 'profile-auto'}, effective: {tag: 'b', title: 'Node B', type: 'Hysteria2'},
  connection: {
    revision: 'connection-1',
    settings: { enabled: false, interval_minutes: 5, failures: 3, target: 'google', refresh_on_failure: false, allow_reload: true },
    lastCheck: null, job: null
  },
  testTargets: { revision: 'targets-1', items: [
    { id: 'google', name: 'Google', url: 'https://www.google.com/generate_204', status: 204 },
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/generate_204', status: 204 }
  ] },
  data: {
    version: 1,
    subscriptions: [{ id: 'first', name: 'First', urls: ['https://a.example', 'https://b.example'] },
      { id: 'second', name: 'Second', urls: ['https://c.example'] }],
    profiles: [{ id: 'work', name: 'Work', subscriptions: ['second', 'first'], nodes: ['extra'],
      rules: ['20-direct', '05-proxy'], final: 'vpn-out', preference: 'non-ru' }]
  },
  nodes: [{ tag: 'a', subscription: 'first', title: '<img src=x onerror=alert(1)>', type: 'vless' },
    { tag: 'b', subscription: 'second', title: 'Node B', type: 'hy2' },
    { tag: 'extra', subscription: 'third', title: 'Extra', type: 'vless' },
    { tag: 'excluded', subscription: 'third', title: 'Excluded', type: 'vless' }],
  rules: [{ id: '05-proxy', name: 'Proxy', content: 'proxy content', revision: 'sha-proxy' },
    { id: '20-direct', name: 'Direct', content: 'direct content', revision: 'sha-direct' }]
};
function boot(snapshot = initial) {
  root = new Element('main'); requests = []; replies = []; confirmAnswer = true; timers = new Map();
  const seed = new Element('script'); seed.textContent = JSON.stringify(snapshot);
  context = {
    document: { getElementById: id => id === 'vpn-app' ? root : seed, createElement: tag => new Element(tag) },
    window: { location: { pathname: '/cgi-bin/router-control' }, confirm: () => confirmAnswer,
      addEventListener: (name, callback) => { if (name === 'beforeunload') unload = callback; } },
    URLSearchParams, URL, AbortController,
    setTimeout: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options, fields: Object.fromEntries(options.body) });
      const fields = requests.at(-1).fields;
      const saved = fields.action === 'vpn_profiles_save' ? { ...snapshot, data: JSON.parse(fields.content) } : initial;
      const reply = replies.shift() || { ok: true, snapshot: saved };
      if (reply instanceof Error) throw reply;
      if (reply.hang) return new Promise(() => {});
      return { ok: reply.http === undefined, status: reply.http, statusText: 'Failure', json: async () => {
        if (reply.jsonError) throw new Error('Invalid JSON');
        return reply;
      } };
    }
  };
  vm.runInNewContext(source, context);
}
function buttons(parent = root) { return parent.querySelectorAll('button'); }
function named(text, parent = root) {
  const match = buttons(parent).find(node => node.textContent === text || node.attributes['aria-label'] === text);
  assert.ok(match, 'Missing button: ' + text); return match;
}
async function click(text, parent) { const node = named(text, parent); assert.ok(!node.disabled, text); await node.fire('click'); }
async function edit(node, value, type = 'input') { node.value = value; await node.fire(type); }
function openDetails(details) {
  if (details && !details.open) { details.open = true; details.fire('toggle'); }
  return details;
}
function editor(id) {
  const details = openDetails(root.querySelectorAll('details').find(node => node.attributes['data-editor-id'] === id));
  return details && details.querySelectorAll('fieldset')[0];
}
function disclosure(title, parent = root) {
  return parent.querySelectorAll('details').find(node => node.children[0].textContent === title);
}
function group(title) { return root.querySelectorAll('fieldset').find(node => node.children[0].textContent === title); }
function postedData() { return JSON.parse(requests.at(-1).fields.content); }
function nodeSearch() { return root.querySelectorAll('input').find(node => node.type === 'search'); }
function nodeCards() { return root.querySelectorAll('details').filter(node => node.classes.has('vp-node')); }
function nodeCard(tag) { return nodeCards().find(node => node.attributes['data-editor-id'] === tag); }

// Приоритеты не сортируются сами, идентификаторы стабильны, сохранение одного профиля отправляет его правки с исходной ревизией.
async function testAtomicSaveAndOrdering() {
  boot(); await click('Профили');
  const profile = editor('work');
  const groups = disclosure('Группы и узлы', profile);
  const rules = disclosure('Правила', profile);
  assert.equal(groups.open, false);
  assert.equal(rules.open, false);
  openDetails(rules);
  assert.equal(group('Группы узлов по приоритету'), undefined);
  assert.ok(group('Правила по приоритету'));
  openDetails(groups);
  assert.deepEqual(group('Группы узлов по приоритету').querySelectorAll('span').map(node => node.textContent), ['1. Second', '2. First']);
  await edit(editor('work').querySelectorAll('input')[0], 'Renamed');
  await click('Выше: First'); await click('Ниже: Direct');
  await click('Сохранить профиль');
  assert.equal(requests[0].url, '/cgi-bin/router-control');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].fields.revision, 'revision-1');
  assert.equal(requests[0].fields.action, 'vpn_profiles_save');
  assert.equal(requests[0].fields.ajax, '1'); assert.equal(requests[0].fields.tab, 'vpn');
  const data = postedData();
  assert.equal(data.profiles[0].id, 'work'); assert.equal(data.profiles[0].name, 'Renamed');
  assert.deepEqual(data.profiles[0].subscriptions, ['first', 'second']);
  assert.deepEqual(data.profiles[0].rules, ['05-proxy', '20-direct']);
  assert.deepEqual(data.subscriptions, initial.data.subscriptions);
}

// Конфликт ревизий, HTTP-сбой и сетевая ошибка сохраняют правки; отмена подтверждения не отправляет запрос.
async function testFailuresAndDiscard() {
  for (const reply of [{ ok: false, error: 'Revision conflict' }, { http: 503 }, new Error('Network unavailable')]) {
    boot(); await click('Профили'); await edit(editor('work').querySelectorAll('input')[0], 'Unsaved');
    replies.push(reply); await click('Сохранить профиль');
    assert.ok(root.textContent.includes(reply.error || (reply.http ? 'HTTP 503' : reply.message)));
    assert.equal(editor('work').querySelectorAll('input')[0].value, 'Unsaved');
    assert.equal(named('Сохранить профиль').disabled, false);
    let prevented = false; unload({ preventDefault: () => { prevented = true; } }); assert.ok(prevented);
    await click('Статус'); confirmAnswer = false; await edit(root.querySelectorAll('select')[1], 'b', 'change');
    assert.equal(requests.length, 1);
    confirmAnswer = true; await edit(root.querySelectorAll('select')[1], 'b', 'change');
    assert.equal(requests.at(-1).fields.arg, 'b');
    assert.ok(!root.textContent.includes('Есть несохраненные изменения'));
  }
}

// Главный экран ограничивает узлы источниками профиля и явными добавлениями; данные остаются текстом, а не HTML.
async function testConnectionAndSearch() {
  boot();
  const manual = root.querySelectorAll('select')[1];
  assert.deepEqual(manual.children.map(node => node.value), ['', 'a', 'b', 'extra']);
  assert.equal(root.querySelectorAll('img').length, 0);
  await edit(manual, 'extra', 'change'); assert.equal(requests.at(-1).fields.arg, 'extra');
  replies.push({ ok: true, snapshot: { ...initial, running: false, selection: null, effective: null } });
  await click('Выключить VPN');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_activate'); assert.equal(requests.at(-1).fields.arg, 'off');
  assert.equal(root.querySelectorAll('select')[0].value, 'work');
  await click('Включить VPN');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_on');
  assert.ok(named('Выключить VPN'));
  await click('Узлы'); await edit(nodeSearch(), 'Node B');
  assert.deepEqual(nodeCards(), [nodeCard('b')]);
  assert.equal(root.querySelectorAll('script').length, 0);
  await click('Узлы'); await edit(root.querySelectorAll('select')[0], 'second', 'change');
  assert.deepEqual(nodeCards(), [nodeCard('b')]);
}

// Одиночная проверка обновляет только карточку узла и сохраняет её при переходах по вкладкам.
async function testSingleNodeProbe() {
  boot(); await click('Узлы');
  assert.equal(nodeCards().length, initial.nodes.length);
  const card = nodeCard('b'), neighbor = nodeCard('a');
  assert.ok(nodeCards().every(node => !node.open && buttons(node).length === 0));
  assert.equal(card.children[0].querySelectorAll('strong')[0].textContent, 'Node B');
  assert.equal(card.children[0].querySelectorAll('span')[0].textContent, 'hy2 · Second');
  openDetails(card);
  const check = named('Проверить узел', card);
  const batchStatus = root.querySelectorAll('p').find(node => node.textContent.includes('К тесту:'));
  const batchText = batchStatus.textContent;
  replies.push({ ok: true, job: { ...probeJob(), total: 1 } }); await click('Проверить узел', card);
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_probe_start');
  assert.deepEqual(postedData(), { tags: ['b'], target: 'google', speed: false });
  assert.ok(card.textContent.includes('Проверка HTTPS'));
  assert.equal(check.disabled, true);
  const measurement = { tag: 'b', passed: 2, attempts: 2, ok: true, http_code: 204, latency_ms: 13 };
  replies.push({ ok: true, job: { ...probeJob('done', 1, [measurement]), total: 1 } }); await tick();
  assert.equal(nodeCard('b'), card); assert.equal(named('Проверить узел', card), check);
  assert.equal(check.disabled, false); assert.equal(card.open, true);
  assert.equal(neighbor.open, false);
  assert.equal(batchStatus.textContent, batchText);
  const reading = 'Google · Доступен · 2/2 · HTTP 204 · 13 мс';
  assert.ok(card.textContent.includes(reading)); assert.ok(!neighbor.textContent.includes(reading));
  assert.equal(root.querySelectorAll('table').length, 0);
  replies.push(new Error('Проверка недоступна')); await click('Проверить узел', card);
  assert.ok(card.textContent.includes('Проверка недоступна'));
  assert.equal(batchStatus.textContent, batchText);
  await click('Статус'); await click('Узлы');
  assert.equal(nodeCard('b').open, true); assert.ok(nodeCard('b').textContent.includes(reading));
}

// CRUD подписок и профилей сохраняет порядок зеркал и блокирует удаление используемого источника.
async function testCatalogCrud() {
  boot(); await click('Группы узлов'); await click('Удалить подписку', editor('first'));
  assert.ok(root.textContent.includes('Подписка используется')); await click('Добавить подписку');
  const subscription = editor('source-1');
  await edit(subscription.querySelectorAll('input')[0], 'New source');
  await edit(subscription.querySelectorAll('textarea')[0], 'https://z.example\nhttps://a.example');
  await click('Профили'); await click('Добавить профиль');
  const profile = editor('profile-1');
  openDetails(disclosure('Группы и узлы', profile));
  const checks = profile.querySelectorAll('input').filter(node => node.type === 'checkbox');
  checks[0].checked = true; await checks[0].fire('change');
  await click('Сохранить профиль', profile);
  assert.deepEqual(postedData().subscriptions, initial.data.subscriptions);
  assert.equal(postedData().profiles[1].id, 'profile-1');
  assert.deepEqual(postedData().profiles[1].subscriptions, ['first']);
  await click('Группы узлов');
  assert.equal(editor('source-1').querySelectorAll('input')[0].value, 'New source');
  await click('Сохранить подписку', editor('source-1'));
  assert.deepEqual(postedData().subscriptions[2].urls, ['https://z.example', 'https://a.example']);
  await click('Профили'); await click('Удалить профиль', editor('profile-1'));
  await click('Профили'); await click('Добавить профиль'); await click('Удалить профиль', editor('profile-1'));
  assert.equal(editor('profile-1'), undefined);
  await click('Группы узлов'); await click('Добавить подписку'); await click('Удалить подписку', editor('source-2'));
  assert.equal(editor('source-2'), undefined);
  await click('Обновить все'); assert.equal(requests.at(-1).fields.arg, 'all');
}

// Имя узла сохраняется по тегу, а локальный источник обозначается как ручная группа.
async function testNodeNameAndLocalGroup() {
  const local = JSON.parse(JSON.stringify(initial));
  local.data.subscriptions[0].urls = ['file:///etc/sing-box/manual-subscriptions/test.txt'];
  boot(local); await click('Группы узлов');
  assert.ok(root.textContent.includes('First · Ручная группа'));
  assert.equal(editor('first').querySelectorAll('textarea').length, 0);
  const heading = root.querySelectorAll('details').find(node => node.attributes['data-editor-id'] === 'first').children[0];
  assert.equal(heading.textContent, 'First · Ручная группа');
  assert.equal(heading.title, 'ID: first');
  const priority = group('Приоритет узлов внутри группы').querySelectorAll('input').find(node => node.type === 'checkbox');
  priority.checked = true; await priority.fire('change');
  await click('Сохранить группу', editor('first'));
  assert.deepEqual(postedData().subscriptions[0].priority, ['a']);
  await click('Узлы');
  const card = openDetails(nodeCard('b'));
  await edit(card.querySelectorAll('input')[0], 'New node label');
  await click('Сохранить узел', card);
  assert.deepEqual(postedData().nodeNames, { b: 'New node label' });
  assert.deepEqual(postedData().profiles, initial.data.profiles);
}

// Правила сохраняются отдельным действием, переживают переходы между разделами и не удаляются при наличии ссылок.
async function testRuleActions() {
  boot(); await click('Правила'); await click('Удалить правило', editor('05-proxy'));
  assert.ok(root.textContent.includes('Правило используется')); assert.equal(requests.length, 0);
  await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'updated content');
  await click('Статус'); await click('Правила'); assert.equal(editor('05-proxy').querySelectorAll('textarea')[0].value, 'updated content');
  replies.push({ ok: false, error: 'Invalid rule' }); await click('Сохранить правило', editor('05-proxy'));
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_rule_save');
  assert.equal(requests.at(-1).fields.arg, '05-proxy'); assert.equal(requests.at(-1).fields.content, '# profile-name: Proxy\nupdated content');
  assert.equal(requests.at(-1).fields.revision, 'sha-proxy');
  assert.equal(editor('05-proxy').querySelectorAll('textarea')[0].value, 'updated content');
  const fresh = root.querySelectorAll('fieldset').find(node => node.children[0].textContent === 'Новое правило');
  await edit(fresh.querySelectorAll('input')[0], '../invalid'); await click('Сохранить правило', fresh);
  assert.equal(requests.length, 1);
  await edit(fresh.querySelectorAll('input')[0], '30-custom'); await edit(fresh.querySelectorAll('textarea')[0], 'custom');
  await click('Сохранить правило', fresh); assert.equal(requests.at(-1).fields.arg, '30-custom');
  assert.equal(requests.at(-1).fields.revision, 'new');
  const unreferenced = JSON.parse(JSON.stringify(initial)); unreferenced.data.profiles[0].rules = [];
  boot(unreferenced); await click('Правила'); await click('Удалить правило', editor('05-proxy'));
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_rule_delete');
  assert.equal(requests.at(-1).fields.revision, 'sha-proxy');
}

// Большой каталог не раздувает скрытый DOM: редакторы ленивые, выбранные узлы всегда видны, результаты ограничены 30.
async function testLargeCatalog() {
  const large = JSON.parse(JSON.stringify(initial));
  large.nodes = Array.from({ length: 600 }, (_, index) => ({
    tag: 'node-' + index, title: 'Server ' + index, subscription: 'first', type: 'vless'
  }));
  large.data.profiles[0].nodes = ['node-599', 'node-598'];
  boot(large); assert.equal(buttons().some(node => node.textContent === 'Сохранить изменения'), false);
  await click('Профили'); assert.equal(root.querySelectorAll('input').length, 0);
  openDetails(disclosure('Группы и узлы', editor('work')));
  const chooser = group('Дополнительные узлы по приоритету');
  let checks = chooser.querySelectorAll('input').filter(node => node.type === 'checkbox');
  assert.equal(checks.length, 32); assert.equal(checks.filter(node => node.checked).length, 2);
  await edit(chooser.querySelectorAll('input').find(node => node.type === 'search'), 'node-500');
  checks = chooser.querySelectorAll('input').filter(node => node.type === 'checkbox');
  assert.equal(checks.length, 3); assert.equal(checks.filter(node => node.checked).length, 2);
  assert.ok(chooser.textContent.includes('1. Server 599')); assert.ok(chooser.textContent.includes('2. Server 598'));
  checks[2].checked = true; await checks[2].fire('change');
  assert.ok(chooser.textContent.includes('3. Server 500'));
  await click('Узлы'); assert.equal(nodeCards().length, 30);
  await click('Далее'); assert.ok(root.textContent.includes('Server 30')); assert.ok(!root.textContent.includes('Server 0'));
  await edit(nodeSearch(), 'node-599');
  assert.deepEqual(nodeCards(), [nodeCard('node-599')]);
}

// Фактическое подключение не маскируется состоянием «выключен», а сохранение своего правила не требует потери чужих правок.
async function testEffectiveAndRuleGuard() {
  const legacy = JSON.parse(JSON.stringify(initial)); legacy.active = null;
  legacy.effective = { tag: 'actual', title: 'Actual node', type: 'vless', delay_ms: 0 };
  boot(legacy);
  assert.ok(root.textContent.includes('Сервис VPN запущен')); assert.ok(!root.textContent.includes('VPN работает'));
  assert.ok(root.textContent.includes('Старое подключение: выберите профиль'));
  assert.ok(root.textContent.includes('Текущий узел: Actual node')); assert.ok(root.textContent.includes('Задержка: 0 мс'));
  assert.equal(root.querySelectorAll('select')[0].value, '');
  boot(); await click('Правила'); await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'changed');
  confirmAnswer = false; await click('Сохранить правило', editor('05-proxy')); assert.equal(requests.length, 1);
  await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'changed again');
  await edit(editor('20-direct').querySelectorAll('textarea')[0], 'another draft');
  await click('Сохранить правило', editor('05-proxy')); assert.equal(requests.length, 2);
  assert.equal(editor('20-direct').querySelectorAll('textarea')[0].value, 'another draft');
}

// Импорт передает имя, один URI и ревизию; ошибки сохраняют ввод, успех удаляет URI, обновление защищает чужие черновики.
async function testImportAndRefresh() {
  boot(); await click('Узлы');
  const name = root.querySelectorAll('input').find(node => node.type !== 'search');
  const uri = root.querySelectorAll('textarea')[0];
  await edit(name, 'Local node'); await edit(uri, 'vless://example@test.example:443');
  replies.push({ http: 409, error: 'Catalog changed; refresh and retry' });
  confirmAnswer = false; await click('Добавить узел');
  assert.equal(requests.length, 1); assert.equal(requests[0].fields.action, 'vpn_profiles_node_import');
  assert.equal(requests[0].fields.arg, 'Local node'); assert.equal(requests[0].fields.revision, 'revision-1');
  assert.equal(requests[0].fields.content, 'vless://example@test.example:443');
  assert.ok(root.textContent.includes('HTTP 409')); assert.ok(root.textContent.includes('Catalog changed; refresh and retry'));
  assert.equal(uri.value, 'vless://example@test.example:443');
  await click('Обновить состояние'); assert.equal(requests.length, 1);
  await click('Статус'); await click('Узлы'); assert.equal(root.querySelectorAll('textarea')[0].value, uri.value);
  await click('Добавить узел'); assert.equal(requests.length, 2);
  assert.equal(root.querySelectorAll('textarea')[0].value, '');
  assert.equal(root.querySelectorAll('input').find(node => node.type !== 'search').value, '');
  await click('Обновить состояние'); assert.equal(requests.at(-1).fields.action, 'vpn_profiles_snapshot');
}

// Фоновое обновление показывает все состояния задания, а кнопка обновления получает новый снимок без активации профиля.
async function testUpdateJob() {
  const states = {
    queued: 'Обновление подписок в очереди. Запуск в течение минуты.',
    running: 'Подписки обновляются...', done: 'Подписки обновлены.', failed: 'Не удалось обновить подписки.'
  };
  for (const [state, text] of Object.entries(states)) {
    const snapshot = JSON.parse(JSON.stringify(initial));
    snapshot.updateJob = { state, message: '<test>job message</test>' };
    boot(snapshot); await click('Группы узлов');
    assert.ok(root.textContent.includes(text)); assert.ok(root.textContent.includes('<test>job message</test>'));
    assert.equal(root.querySelectorAll('test').length, 0);
  }
  boot(); await click('Группы узлов');
  const queued = JSON.parse(JSON.stringify(initial)); queued.updateJob = { state: 'queued' };
  replies.push({ ok: true, snapshot: queued, output: 'Обновление поставлено в очередь' });
  await click('Обновить все');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_update'); assert.ok(root.textContent.includes(states.queued));
  const done = JSON.parse(JSON.stringify(initial)); done.updateJob = { state: 'done' };
  replies.push({ ok: true, snapshot: done }); await click('Обновить состояние');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_snapshot'); assert.ok(root.textContent.includes(states.done));
  assert.ok(requests.every(request => request.fields.action !== 'vpn_profiles_activate'));
}

// Полный typed-контракт отделён от снимка каталога: ответы не содержат snapshot.
function connectionReply(state = 'running', extra = {}) {
  return { ok: true, connection: { ...initial.connection, ...extra,
    job: { id: 'connection-job', kind: 'find', state, phase: 'testing', message: 'Проверка кандидатов', done: 1, total: 4, ...extra.job }
  } };
}
// Последняя проверка сохраняет нулевую задержку и причины; чужой профиль/узел и выключенный VPN помечаются устаревшими.
async function testLastCheck() {
  const check = { time: 1794770000, profile: 'work', node: 'b', ok: false, passed: 1, attempts: 2,
    latency_ms: 0, http_code: 503, reason: '<img src=x> TLS certificate expired' };
  for (const overrides of [{}, { active: 'other' }, { effective: { tag: 'a' } }, { running: false }]) {
    boot({ ...initial, connection: { ...initial.connection, lastCheck: check }, ...overrides });
    assert.ok(root.textContent.includes('Последняя проверка:')); assert.ok(root.textContent.includes('Нестабильно · 1/2 · 0 мс · HTTP 503'));
    assert.ok(root.textContent.includes(check.reason)); assert.equal(root.querySelectorAll('img').length, 0);
    assert.equal(root.textContent.includes('Устарело:'), Object.keys(overrides).length > 0);
    await click('Узлы'); await click('Статус'); assert.ok(root.textContent.includes(check.reason));
  }
  boot({ ...initial, connection: { ...initial.connection, lastCheck: { ...check, ok: true, passed: 2, latency_ms: null, reason: '' } } });
  assert.ok(root.textContent.includes('HTTPS доступен · 2/2')); assert.ok(!root.textContent.includes('null мс'));
  replies.push({ ok: true, snapshot: { ...initial, effective: { tag: 'extra', title: 'Extra' },
    connection: { ...initial.connection, lastCheck: check } } });
  await edit(root.querySelectorAll('select')[1], 'extra', 'change');
  assert.ok(root.textContent.includes(check.reason)); assert.ok(root.textContent.includes('Устарело:'));
}

// Автовыбор — конечное задание: polling показывает прогресс, блокирует конфликтующие команды и один раз читает итоговый снимок.
async function testSelectionFeedback() {
  boot();
  assert.equal(root.querySelectorAll('nav')[0].children[0].textContent, 'Статус');
  assert.ok(named('Применить профиль').title.includes('разрыв'));
  assert.ok(named('Автовыбор узла').title.includes('Разовый поиск'));
  assert.ok(named('Автовыбор узла').title.includes('текущий узел сохраняется'));
  assert.ok(named('Проверить подключение').title.includes('Два HTTPS-запроса'));
  assert.ok(named('Обновить состояние').title.includes('Не применяет профиль'));
  assert.ok(!root.textContent.includes('Выбор узла:'));
  replies.push(connectionReply()); await click('Автовыбор узла');
  assert.equal(requests[0].fields.action, 'vpn_profiles_connection_start'); assert.equal(requests[0].fields.arg, 'find');
  assert.ok(root.textContent.includes('Проверка кандидатов')); assert.ok(!root.textContent.includes(' · testing'));
  assert.equal(root.attributes['aria-busy'], 'true');
  for (const name of ['Автовыбор узла', 'Проверить подключение', 'Применить профиль', 'Обновить состояние', 'Сохранить автовосстановление']) {
    assert.equal(named(name).disabled, true);
  }
  assert.equal(root.querySelectorAll('select')[1].disabled, true);
  await named('Автовыбор узла').fire('click'); assert.equal(requests.length, 1);
  const nav = root.querySelectorAll('nav')[0];
  replies.push(connectionReply('running', { job: { done: 3, message: '<b>testing</b>' } })); await tick();
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_connection_status'); assert.equal(root.querySelectorAll('nav')[0], nav);
  assert.equal(root.querySelectorAll('progress')[0].value, 3); assert.equal(root.querySelectorAll('b').length, 0);
  const selected = { tag: 'extra', title: 'Extra', latency_ms: 12 };
  replies.push(connectionReply('done', { job: { done: 4, selected } }),
    { ok: true, snapshot: { ...initial, effective: { tag: 'extra', title: 'Extra', delay_ms: 12 } } });
  await tick(); assert.ok(root.textContent.includes('Завершено · проверено 4/4')); assert.ok(root.textContent.includes('Выбран: Extra · 12 мс'));
  assert.ok(root.textContent.includes('Текущий узел: Extra')); assert.equal(timers.size, 0);
  assert.equal(requests.filter(request => request.fields.action === 'vpn_profiles_snapshot').length, 1);
  assert.equal(named('Автовыбор узла').disabled, false); assert.equal(root.attributes['aria-busy'], undefined);
  assert.ok(requests.every(request => request.fields.action !== 'vpn_profiles_node'));
}

// Нет кандидата и ошибки задания не подменяются успехом; черновики каталога, правил и импорта переживают завершение без снимка.
async function testConnectionDraftsAndNoCandidate() {
  boot(); await click('Профили'); await edit(editor('work').querySelectorAll('input')[0], 'Unsaved profile');
  await click('Правила'); await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'Unsaved rule');
  await click('Узлы'); await edit(root.querySelectorAll('textarea')[0], 'vless://draft@host:443');
  await click('Статус'); confirmAnswer = false;
  replies.push(connectionReply()); await click('Автовыбор узла');
  await click('Правила'); const textarea = editor('05-proxy').querySelectorAll('textarea')[0];
  replies.push(connectionReply('failed', { job: { error: 'No candidate; current node retained', message: 'Узел не найден' } })); await tick();
  assert.equal(editor('05-proxy').querySelectorAll('textarea')[0], textarea); assert.equal(textarea.value, 'Unsaved rule');
  await click('Статус'); assert.ok(root.textContent.includes('No candidate')); assert.ok(root.textContent.includes('Текущий узел: Node B'));
  assert.equal(named('Автовыбор узла').disabled, false); assert.equal(timers.size, 0);
  assert.equal(requests.length, 2);
  replies.push(connectionReply('done', { job: { id: 'empty-search', message: 'Кандидат не найден; текущий узел сохранён' } }));
  await click('Автовыбор узла'); assert.ok(root.textContent.includes('Кандидат не найден'));
  assert.ok(root.textContent.includes('Текущий узел: Node B')); assert.ok(!root.textContent.includes('Выбран:'));
  replies.push(connectionReply('done', { job: { id: 'next-job', selected: { tag: 'extra', title: 'Extra', latency_ms: 0 } } }));
  await click('Автовыбор узла'); assert.ok(root.textContent.includes('Текущий узел: Extra'));
  await click('Профили'); assert.equal(editor('work').querySelectorAll('input')[0].value, 'Unsaved profile');
  await click('Узлы'); assert.equal(root.querySelectorAll('textarea')[0].value, 'vless://draft@host:443');
  assert.ok(requests.every(request => request.fields.action !== 'vpn_profiles_snapshot'));
}

// HTTP/JSON/сеть/таймаут не оставляют старт заблокированным; polling повторяется и сохраняет последнюю проверку.
async function testConnectionErrorsAndCheck() {
  for (const reply of [{ http: 502, error: 'Unavailable' }, { jsonError: true }, new Error('Offline'), { ok: true },
    connectionReply('invalid'), connectionReply('running', { lastCheck: {} })]) {
    boot(); replies.push(reply); await click('Проверить подключение');
    assert.equal(named('Проверить подключение').disabled, false); assert.equal(timers.size, 0);
    assert.ok(root.textContent.includes(reply.http ? 'HTTP 502' : reply.jsonError ? 'JSON' : reply.message || 'Некорректный ответ'));
  }
  boot(); replies.push({ hang: true }); const pending = named('Проверить подключение').fire('click'); await settle();
  assert.ok(root.textContent.includes('Запуск операции')); await tick(20000); await pending;
  assert.ok(root.textContent.includes('20 секунд')); assert.equal(named('Проверить подключение').disabled, false);
  const check = { time: 1794770000, profile: 'work', node: 'b', ok: true, passed: 2, attempts: 2,
    latency_ms: 10, http_code: 204, reason: '' };
  boot(); replies.push(connectionReply('running', { lastCheck: check, job: { kind: 'check' } })); await click('Проверить подключение');
  assert.equal(requests[0].fields.arg, 'check');
  for (const reply of [{ http: 503 }, { jsonError: true }, new Error('Disconnected'), connectionReply('running', { job: { id: 'other' } })]) {
    replies.push(reply); await tick(); assert.equal(named('Проверить подключение').disabled, true);
    assert.ok(root.textContent.includes('HTTPS доступен · 2/2')); assert.equal([...timers.values()][0].delay, 1500);
  }
  replies.push(connectionReply('done', { lastCheck: check, job: { kind: 'check', done: 4 } }), { http: 503 }); await tick();
  assert.ok(root.textContent.includes('Не удалось обновить текущий узел')); assert.equal(timers.size, 0);
  assert.equal(named('Проверить подключение').disabled, false);
  // Открытие панели с уже идущим заданием возобновляет polling, а OFF не разрешает запуск проверок.
  boot({ ...initial, connection: connectionReply().connection });
  replies.push(connectionReply('done'), { ok: true, snapshot: initial }); await tick(); assert.equal(timers.size, 0);
  boot({ ...initial, running: false }); assert.equal(named('Автовыбор узла').disabled, true);
  assert.equal(named('Проверить подключение').disabled, true);
}

// Настройки сохраняются отдельно с CAS, диапазонами и всеми флагами; конфликт и чужие черновики сохраняются.
async function testRecoverySettings() {
  boot(); await click('Профили'); await edit(editor('work').querySelectorAll('input')[0], 'Unsaved profile');
  await click('Правила'); await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'Unsaved rule');
  await click('Узлы'); await edit(root.querySelectorAll('textarea')[0], 'vless://draft@host:443');
  await click('Статус');
  const details = root.querySelectorAll('details').find(node => node.children[0].textContent === 'Автовосстановление');
  const inputs = details.querySelectorAll('input'), enabled = inputs[0], interval = inputs[1], failures = inputs[2];
  assert.equal(enabled.type, 'checkbox'); assert.equal(enabled.checked, false); assert.equal(inputs[4].checked, true);
  enabled.checked = true; await enabled.fire('change');
  for (const value of ['0', '1441', '1.5']) {
    await edit(interval, value); await click('Сохранить автовосстановление'); assert.equal(requests.length, 0);
  }
  await edit(interval, '1');
  for (const value of ['1', '11', '2.5']) {
    await edit(failures, value); await click('Сохранить автовосстановление'); assert.equal(requests.length, 0);
  }
  await edit(failures, '10'); await edit(details.querySelectorAll('select')[0], 'youtube', 'change');
  inputs[3].checked = true; await inputs[3].fire('change');
  const settings = { enabled: true, interval_minutes: 1, failures: 10, target: 'youtube', refresh_on_failure: true, allow_reload: true };
  replies.push({ http: 409, error: 'Connection revision conflict' }); await click('Сохранить автовосстановление');
  assert.ok(details.textContent.includes('HTTP 409')); assert.equal(enabled.checked, true);
  assert.equal(requests.at(-1).fields.revision, 'connection-1'); assert.deepEqual(postedData(), settings);
  replies.push({ ok: true, connection: { ...initial.connection, revision: 'connection-2', settings } });
  const nav = root.querySelectorAll('nav')[0]; await click('Сохранить автовосстановление');
  assert.equal(root.querySelectorAll('nav')[0], nav); assert.ok(root.textContent.includes('Автовосстановление включено'));
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_connection_save');
  inputs[4].checked = false; await inputs[4].fire('change');
  replies.push({ ok: true, connection: { ...initial.connection, revision: 'connection-3', settings: { ...settings, allow_reload: false } } });
  await click('Сохранить автовосстановление'); assert.equal(requests.at(-1).fields.revision, 'connection-2');
  assert.equal(postedData().allow_reload, false);
  await click('Профили'); assert.equal(editor('work').querySelectorAll('input')[0].value, 'Unsaved profile');
  await click('Правила'); assert.equal(editor('05-proxy').querySelectorAll('textarea')[0].value, 'Unsaved rule');
  await click('Узлы'); assert.equal(root.querySelectorAll('textarea')[0].value, 'vless://draft@host:443');
  await click('Статус'); assert.equal(root.querySelectorAll('input')[0].checked, true);
}

// Финальный снимок не сбрасывает правки, введённые после его отправки, и до ответа не разрешает новое задание.
async function testConnectionSnapshotRace() {
  boot(); replies.push(connectionReply()); await click('Автовыбор узла');
  const originalFetch = context.fetch; let complete;
  context.fetch = (url, options) => {
    if (options.body.get('action') !== 'vpn_profiles_snapshot') return originalFetch(url, options);
    requests.push({ url, options, fields: Object.fromEntries(options.body) });
    return new Promise(resolve => { complete = resolve; });
  };
  replies.push(connectionReply('done')); const pending = tick(); await settle();
  await click('Профили'); await edit(editor('work').querySelectorAll('input')[0], 'Late draft');
  await click('Статус'); assert.equal(named('Автовыбор узла').disabled, true);
  await click('Правила'); await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'Late rule');
  const textarea = editor('05-proxy').querySelectorAll('textarea')[0];
  complete({ ok: true, json: async () => ({ ok: true, snapshot: initial }) }); await pending;
  assert.equal(editor('05-proxy').querySelectorAll('textarea')[0], textarea); assert.equal(textarea.value, 'Late rule');
  await click('Профили'); assert.equal(editor('work').querySelectorAll('input')[0].value, 'Late draft');
  assert.equal(timers.size, 0);
}

// Необязательная проверка настоящим Chrome: iframe задаёт точную мобильную ширину без новых npm-зависимостей.
function testMobileLayout() {
  if (!process.env.PROFILES_UI_CHROME) return;
  const { execFileSync } = require('node:child_process');
  const css = fs.readFileSync(path.join(__dirname, '../router-reinstall-kit/files/opt/router-control/www/profiles.css'), 'utf8');
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'profiles-ui-chrome-'));
  const fixture = JSON.parse(JSON.stringify(initial));
  fixture.connection.lastCheck = { time: 1794770000, profile: 'old-profile', node: 'old-node', ok: false, passed: 0, attempts: 2,
    latency_ms: null, http_code: 503, reason: 'LongErrorWithoutSpaces'.repeat(8) };
  const seed = JSON.stringify(fixture).replace(/</g, '\\u003c');
  const document = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:8px}' + css + '</style><main id="vpn-app"></main>' +
    '<script id="vpn-profile-data" type="application/json">' + seed + '</script><script>' + source + '</script>';
  try {
    for (const width of [320, 390, 1200]) {
      const shell = '<!doctype html><body style="margin:0"><script>' +
        'const frame=document.createElement("iframe");frame.style="border:0;width:' + width + 'px;height:1800px";' +
        'frame.onload=async()=>{try{const d=frame.contentDocument,w=frame.contentWindow,app=d.getElementById("vpn-app");' +
        'if(!app)throw Error("Missing app");if(w.innerWidth!==' + width + ')throw Error("Wrong viewport");' +
        'for(const view of ["Статус","Профили","Группы узлов","Правила","Узлы"]){' +
        '[...app.querySelectorAll("nav button")].find(b=>b.textContent===view).click();' +
        'if(view==="Узлы" && ![...app.querySelectorAll(".vp-node")].every(n=>!n.open))throw Error("Open node on entry");' +
        'app.querySelectorAll("details").forEach(n=>{n.open=true;n.dispatchEvent(new Event("toggle"));});' +
        'if(d.documentElement.scrollWidth>w.innerWidth)throw Error("Page overflow: "+view);' +
        'for(const n of app.querySelectorAll("button,input,select,textarea,summary,progress")){' +
        'if(!n.getClientRects().length)continue;const r=n.getBoundingClientRect();' +
        'if(r.left<0||r.right>w.innerWidth+1)throw Error("Control overflow: "+view+" "+n.tagName);}' +
        'if(view==="Узлы"){const card=app.querySelector(".vp-node"),top=card.getBoundingClientRect().top;' +
        'w.fetch=async()=>({ok:true,json:async()=>({ok:true,job:{id:"test",state:"done",total:1,done:1,' +
        'results:[{tag:"a",ok:true,passed:2,attempts:2,latency_ms:13}]}})});' +
        '[...card.querySelectorAll("button")].find(b=>b.textContent==="Проверить узел").click();' +
        'await new Promise(resolve=>w.setTimeout(resolve,0));' +
        'if(!card.open||!card.textContent.includes("13 мс")||card.getBoundingClientRect().top!==top)throw Error("Node result moved the list");}' +
        '}[...app.querySelectorAll("nav button")].find(b=>b.textContent==="Статус").click();' +
        'app.querySelector("details").open=true;' +
        'const columns=w.getComputedStyle(app.querySelector(".vp-recovery-grid")).gridTemplateColumns.split(" ").length;' +
        'if(columns!==' + (width < 481 ? 1 : 3) + ')throw Error("Recovery columns");' +
        'document.body.setAttribute("data-layout","pass");' +
        '}catch(e){document.body.setAttribute("data-layout","FAIL: "+e.message);}};' +
        'frame.srcdoc=' + JSON.stringify(document).replace(/</g, '\\u003c') + ';document.body.append(frame);</script>';
      const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile,
        '--window-size=' + Math.max(width, 500) + ',1800', '--virtual-time-budget=1500', '--dump-dom'];
      if (process.env.PROFILES_UI_SCREENSHOTS) {
        args.push('--screenshot=' + path.join(process.env.PROFILES_UI_SCREENSHOTS, 'profiles-' + width + '.png'));
      }
      args.push('data:text/html;charset=utf-8,' + encodeURIComponent(shell));
      const output = execFileSync(process.env.PROFILES_UI_CHROME, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.ok(output.includes('data-layout="pass"'), 'Layout ' + width + ': ' + (output.match(/data-layout="([^"]*)"/) || [])[1]);
    }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  console.log('PASS: Chrome layouts at 320, 390 and 1200 px, including inline probe results and stable node position');
}

// Ответы заданий и виртуальное время позволяют проверить polling без реальной сети и ожидания.
function probeJob(state = 'running', done = 0, results = []) {
  return { id: 'job-1', state, total: 60, done, target: initial.testTargets.items[0], speed: false, results };
}
// Один шаг запускает только нужный таймер, чтобы таймаут запроса не подменял polling.
async function tick(delay = 1500) {
  const entry = [...timers].find(([, timer]) => timer.delay === delay);
  assert.ok(entry, 'Missing timer: ' + delay); timers.delete(entry[0]); await entry[1].callback(); await settle();
}

// Массовый тест берет первые 60 совпадений поиска И подписки со всех страниц, а не первые 30 видимых строк.
async function testFilteredProbeAndProgress() {
  const large = JSON.parse(JSON.stringify(initial));
  large.nodes = Array.from({ length: 140 }, (_, index) => ({
    tag: 'tag-' + index, title: 'Match ' + index, subscription: index % 2 ? 'second' : 'first', type: 'vless'
  }));
  boot(large); await click('Узлы');
  await edit(root.querySelectorAll('textarea')[0], 'vless://draft@host:443');
  await edit(nodeSearch(), 'Match'); await edit(root.querySelectorAll('select')[0], 'second', 'change');
  await click('Далее');
  const nav = root.querySelectorAll('nav')[0], search = nodeSearch(), uri = root.querySelectorAll('textarea')[0];
  const targetSelect = root.querySelectorAll('select')[1]; await edit(targetSelect, 'youtube', 'change');
  const visibleCard = openDetails(nodeCards()[0]);
  replies.push({ ok: true, job: probeJob() }); await click('Быстрый тест');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_probe_start');
  assert.deepEqual(postedData(), { tags: Array.from({ length: 60 }, (_, i) => 'tag-' + (i * 2 + 1)), target: 'youtube', speed: false });
  assert.ok(root.textContent.includes('Найдено: 70. Проверяются первые 60'));
  assert.equal(named('Быстрый тест').disabled, true); assert.equal(named('Тест скорости').disabled, true);
  assert.equal(named('Проверить узел', visibleCard).disabled, true);
  await named('Быстрый тест').fire('click'); assert.equal(requests.length, 1);
  const result = { tag: 'tag-1', title: '<img src=x>', type: 'vless', passed: 1, attempts: 2, ok: false,
    http_code: 503, latency_ms: 0, error: 'TLS failed', speed_mbps: null, speed_error: 'No download' };
  replies.push({ ok: true, job: probeJob('running', 1, [result]) }); await tick();
  assert.equal(requests.at(-1).fields.arg, 'job-1'); assert.equal(requests.at(-1).fields.action, 'vpn_profiles_probe_status');
  assert.ok(root.textContent.includes('1/60')); assert.equal(root.querySelectorAll('progress')[0].value, 1);
  assert.ok(!root.textContent.includes('TLS failed')); assert.ok(!root.textContent.includes('No download'));
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.equal(root.querySelectorAll('nav')[0], nav); assert.equal(nodeSearch(), search);
  assert.equal(uri.value, 'vless://draft@host:443'); assert.equal(targetSelect.value, 'youtube');
  replies.push({ ok: true, job: probeJob('done', 60, [result]) }); await tick();
  assert.ok(root.textContent.includes('Готово: 60/60')); assert.equal(named('Быстрый тест').disabled, false);
  await click('Назад');
  const testedCard = openDetails(nodeCard('tag-1'));
  assert.ok(testedCard.textContent.includes('TLS failed'));
  assert.ok(testedCard.textContent.includes('0 мс'));
  assert.ok(testedCard.textContent.includes('Ошибка замера скорости: No download'));
  assert.ok(!openDetails(nodeCard('tag-3')).textContent.includes('TLS failed'));
  assert.equal(timers.size, 0);
  assert.ok(requests.every(request => !['vpn_profiles_activate', 'vpn_profiles_node', 'vpn_profiles_snapshot'].includes(request.fields.action)));
}

// HTTP, JSON, сеть и неверное задание не блокируют старт; ошибка polling повторяется через 1500 мс и сохраняет результаты.
async function testProbeErrorsAndSpeed() {
  for (const reply of [
    { http: 502, error: 'Unavailable' }, { jsonError: true }, new Error('Offline'), { ok: true },
    { ok: true, job: probeJob('running', 0, [null]) }
  ]) {
    boot(); await click('Узлы'); replies.push(reply); await click('Быстрый тест');
    assert.equal(named('Быстрый тест').disabled, false); assert.equal(timers.size, 0);
    assert.ok(root.textContent.includes(reply.http ? 'HTTP 502' : reply.jsonError ? 'JSON' : reply.message || 'Некорректный ответ'));
  }
  boot(); await click('Узлы'); replies.push({ hang: true });
  const pending = named('Быстрый тест').fire('click'); await settle(); await tick(20000); await pending;
  assert.ok(root.textContent.includes('20 секунд')); assert.equal(named('Быстрый тест').disabled, false);
  boot(); await click('Узлы'); confirmAnswer = false; await click('Тест скорости'); assert.equal(requests.length, 0);
  confirmAnswer = true; replies.push({ ok: true, job: probeJob() }); await click('Тест скорости');
  assert.equal(postedData().speed, true);
  for (const reply of [{ http: 503 }, { jsonError: true }, new Error('Disconnected'), { ok: true, job: { id: 'other' } }]) {
    replies.push(reply); await tick(); assert.equal(named('Тест скорости').disabled, true);
    assert.ok(root.textContent.includes('0/60')); assert.equal([...timers.values()][0].delay, 1500);
  }
  await click('Правила'); await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'keep draft');
  const textarea = editor('05-proxy').querySelectorAll('textarea')[0];
  replies.push({ ok: true, job: { ...probeJob('failed', 1), error: 'Worker stopped' } }); await tick();
  assert.equal(editor('05-proxy').querySelectorAll('textarea')[0], textarea); assert.equal(textarea.value, 'keep draft');
  await click('Узлы'); assert.ok(root.textContent.includes('Worker stopped')); assert.equal(named('Тест скорости').disabled, false);
  assert.equal(timers.size, 0);
}

// CRUD ресурсов передает CAS-ревизию, валидирует HTTPS, сохраняет ошибки и не уничтожает черновики каталога/импорта.
async function testTargetEditing() {
  boot(); await click('Профили'); await edit(editor('work').querySelectorAll('input')[0], 'Unsaved profile');
  await click('Узлы'); const uri = root.querySelectorAll('textarea')[0]; await edit(uri, 'vless://draft@host:443');
  const details = root.querySelectorAll('details').find(node => node.children[0].textContent === 'Ресурсы'); details.open = true;
  await edit(details.querySelectorAll('input')[0], 'Renamed Google'); await click('Добавить ресурс');
  let inputs = details.querySelectorAll('input'); await edit(inputs[6], 'Custom');
  await edit(inputs[7], 'http://unsafe.example'); await click('Сохранить ресурсы'); assert.equal(requests.length, 0);
  await edit(inputs[7], 'https://custom.example/check'); await edit(inputs[8], '200');
  replies.push({ http: 409, error: 'Target revision conflict' }); await click('Сохранить ресурсы');
  assert.ok(details.textContent.includes('HTTP 409')); assert.equal(inputs[7].value, 'https://custom.example/check');
  assert.equal(requests.at(-1).fields.revision, 'targets-1'); assert.equal(requests.at(-1).fields.action, 'vpn_profiles_targets_save');
  const content = postedData(); assert.equal(content[2].status, 200); assert.equal(content[0].name, 'Renamed Google');
  const updated = { ...initial, testTargets: { revision: 'targets-2', items: content } };
  replies.push({ ok: true, snapshot: updated }); const nav = root.querySelectorAll('nav')[0]; await click('Сохранить ресурсы');
  assert.equal(root.querySelectorAll('nav')[0], nav); assert.equal(uri.value, 'vless://draft@host:443');
  assert.ok(root.querySelectorAll('select')[1].textContent.includes('Custom'));
  await click('Удалить ресурс: YouTube');
  replies.push({ ok: true, snapshot: { ...updated, testTargets: { revision: 'targets-3', items: content.filter(item => item.id !== 'youtube') } } });
  await click('Сохранить ресурсы'); assert.equal(requests.at(-1).fields.revision, 'targets-2'); assert.equal(postedData().length, 2);
  await click('Профили'); assert.equal(editor('work').querySelectorAll('input')[0].value, 'Unsaved profile');
}

(async function () {
  const tests = [testAtomicSaveAndOrdering, testFailuresAndDiscard, testConnectionAndSearch, testSingleNodeProbe, testCatalogCrud, testNodeNameAndLocalGroup, testRuleActions,
    testLargeCatalog, testEffectiveAndRuleGuard, testImportAndRefresh, testUpdateJob, testLastCheck,
    testFilteredProbeAndProgress, testProbeErrorsAndSpeed, testTargetEditing, testSelectionFeedback,
    testConnectionDraftsAndNoCandidate, testConnectionErrorsAndCheck, testRecoverySettings, testConnectionSnapshotRace];
  for (const test of tests) await test();
  assert.ok(!source.includes('innerHTML'));
  console.log('PASS: profiles UI scenarios, including entity saves, local groups, aliases, polling and retained drafts');
  testMobileLayout();
})().catch(error => { console.error(error); process.exitCode = 1; });
