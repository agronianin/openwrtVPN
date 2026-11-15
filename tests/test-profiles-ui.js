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
let root, context, requests, confirmAnswer, replies, unload;
const initial = {
  revision: 'revision-1', active: 'work', running: true,
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
  root = new Element('main'); requests = []; replies = []; confirmAnswer = true;
  const seed = new Element('script'); seed.textContent = JSON.stringify(snapshot);
  context = {
    document: { getElementById: id => id === 'vpn-app' ? root : seed, createElement: tag => new Element(tag) },
    window: { location: { pathname: '/cgi-bin/router-control' }, confirm: () => confirmAnswer,
      addEventListener: (name, callback) => { if (name === 'beforeunload') unload = callback; } },
    URLSearchParams,
    fetch: async (url, options) => {
      requests.push({ url, options, fields: Object.fromEntries(options.body) });
      const reply = replies.shift() || { ok: true, snapshot: initial };
      if (reply instanceof Error) throw reply;
      return { ok: reply.http === undefined, status: reply.http, statusText: 'Failure', json: async () => reply };
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
function editor(id) {
  const details = root.querySelectorAll('details').find(node => node.attributes['data-editor-id'] === id);
  if (details && !details.open) { details.open = true; details.fire('toggle'); }
  return root.querySelectorAll('fieldset').find(node => node.children.some(child => child.tagName === 'code' && child.textContent === id));
}
function group(title) { return root.querySelectorAll('fieldset').find(node => node.children[0].textContent === title); }
function postedData() { return JSON.parse(requests.at(-1).fields.content); }
function nodeSearch() { return root.querySelectorAll('input').find(node => node.type === 'search'); }

// Приоритеты не сортируются сами, идентификаторы стабильны, сохранение отправляет весь документ с исходной ревизией.
async function testAtomicSaveAndOrdering() {
  boot(); await click('Профили');
  editor('work');
  assert.deepEqual(group('Подписки по приоритету').querySelectorAll('span').map(node => node.textContent), ['1. Second', '2. First']);
  await edit(editor('work').querySelectorAll('input')[0], 'Renamed');
  await click('Выше: First'); await click('Ниже: Direct');
  await click('Сохранить изменения');
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
    replies.push(reply); await click('Сохранить изменения');
    assert.ok(root.textContent.includes(reply.error || (reply.http ? 'HTTP 503' : reply.message)));
    assert.equal(editor('work').querySelectorAll('input')[0].value, 'Unsaved');
    assert.equal(named('Сохранить изменения').disabled, false);
    let prevented = false; unload({ preventDefault: () => { prevented = true; } }); assert.ok(prevented);
    await click('VPN'); confirmAnswer = false; await click('Автовыбор узла'); assert.equal(requests.length, 1);
    confirmAnswer = true; await click('Автовыбор узла');
    assert.equal(requests.at(-1).fields.arg, 'auto');
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
  await edit(root.querySelectorAll('select')[0], 'off', 'change');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_activate'); assert.equal(requests.at(-1).fields.arg, 'off');
  await click('Узлы'); await edit(nodeSearch(), 'Node B');
  assert.equal(buttons().filter(node => node.textContent === 'Проверить узел').length, 1);
  replies.push({ ok: true, snapshot: initial, output: '<script>unsafe</script>' }); await click('Проверить узел');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_test'); assert.equal(requests.at(-1).fields.arg, 'b');
  assert.ok(root.textContent.includes('<script>unsafe</script>')); assert.equal(root.querySelectorAll('script').length, 0);
  await click('Узлы'); await edit(root.querySelectorAll('select')[0], 'second', 'change');
  assert.equal(buttons().filter(node => node.textContent === 'Проверить узел').length, 1);
}

// CRUD подписок и профилей сохраняет порядок зеркал и блокирует удаление используемого источника.
async function testCatalogCrud() {
  boot(); await click('Подписки'); await click('Удалить подписку', editor('first'));
  assert.ok(root.textContent.includes('Подписка используется')); await click('Добавить подписку');
  const subscription = editor('source-1');
  await edit(subscription.querySelectorAll('input')[0], 'New source');
  await edit(subscription.querySelectorAll('textarea')[0], 'https://z.example\nhttps://a.example');
  await click('Профили'); await click('Добавить профиль');
  const profile = editor('profile-1');
  const checks = profile.querySelectorAll('input').filter(node => node.type === 'checkbox');
  checks[0].checked = true; await checks[0].fire('change');
  await click('Сохранить изменения');
  assert.deepEqual(postedData().subscriptions[2].urls, ['https://z.example', 'https://a.example']);
  assert.equal(postedData().profiles[1].id, 'profile-1');
  assert.deepEqual(postedData().profiles[1].subscriptions, ['first']);
  await click('Профили'); await click('Добавить профиль'); await click('Удалить профиль', editor('profile-1'));
  assert.equal(editor('profile-1'), undefined);
  await click('Подписки'); await click('Добавить подписку'); await click('Удалить подписку', editor('source-1'));
  assert.equal(editor('source-1'), undefined);
  await click('Обновить все'); assert.equal(requests.at(-1).fields.arg, 'all');
}

// Правила сохраняются отдельным действием, переживают переходы между разделами и не удаляются при наличии ссылок.
async function testRuleActions() {
  boot(); await click('Правила'); await click('Удалить правило', editor('05-proxy'));
  assert.ok(root.textContent.includes('Правило используется')); assert.equal(requests.length, 0);
  await edit(editor('05-proxy').querySelectorAll('textarea')[0], 'updated content');
  await click('VPN'); await click('Правила'); assert.equal(editor('05-proxy').querySelectorAll('textarea')[0].value, 'updated content');
  replies.push({ ok: false, error: 'Invalid rule' }); await click('Сохранить правило', editor('05-proxy'));
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_rule_save');
  assert.equal(requests.at(-1).fields.arg, '05-proxy'); assert.equal(requests.at(-1).fields.content, 'updated content');
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
  editor('work');
  const chooser = group('Дополнительные узлы по приоритету');
  let checks = chooser.querySelectorAll('input').filter(node => node.type === 'checkbox');
  assert.equal(checks.length, 32); assert.equal(checks.filter(node => node.checked).length, 2);
  await edit(chooser.querySelectorAll('input').find(node => node.type === 'search'), 'node-500');
  checks = chooser.querySelectorAll('input').filter(node => node.type === 'checkbox');
  assert.equal(checks.length, 3); assert.equal(checks.filter(node => node.checked).length, 2);
  assert.ok(chooser.textContent.includes('1. Server 599')); assert.ok(chooser.textContent.includes('2. Server 598'));
  checks[2].checked = true; await checks[2].fire('change');
  assert.ok(chooser.textContent.includes('3. Server 500'));
  await click('Узлы'); assert.equal(buttons().filter(node => node.textContent === 'Проверить узел').length, 30);
  await click('Далее'); assert.ok(root.textContent.includes('Server 30')); assert.ok(!root.textContent.includes('Server 0'));
  await edit(nodeSearch(), 'node-599');
  assert.equal(buttons().filter(node => node.textContent === 'Проверить узел').length, 1);
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
  await click('Сохранить правило', editor('05-proxy')); assert.equal(requests.length, 1);
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
  await click('VPN'); await click('Узлы'); assert.equal(root.querySelectorAll('textarea')[0].value, uri.value);
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
    boot(snapshot); await click('Подписки');
    assert.ok(root.textContent.includes(text)); assert.ok(root.textContent.includes('<test>job message</test>'));
    assert.equal(root.querySelectorAll('test').length, 0);
  }
  boot(); await click('Подписки');
  const queued = JSON.parse(JSON.stringify(initial)); queued.updateJob = { state: 'queued' };
  replies.push({ ok: true, snapshot: queued, output: 'Обновление поставлено в очередь' });
  await click('Обновить все');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_update'); assert.ok(root.textContent.includes(states.queued));
  const done = JSON.parse(JSON.stringify(initial)); done.updateJob = { state: 'done' };
  replies.push({ ok: true, snapshot: done }); await click('Обновить состояние');
  assert.equal(requests.at(-1).fields.action, 'vpn_profiles_snapshot'); assert.ok(root.textContent.includes(states.done));
  assert.ok(requests.every(request => request.fields.action !== 'vpn_profiles_activate'));
}

// JSON проверки читается по-русски, а отрицательный результат и диагностические подробности не теряются.
async function testReadableOutput() {
  boot();
  replies.push({ ok: true, snapshot: initial, output: '{"https":true,"delay_ms":123}' });
  await click('Проверить подключение');
  assert.ok(root.textContent.includes('HTTPS-проверка прошла.')); assert.ok(root.textContent.includes('Задержка: 123 мс'));
  replies.push({ ok: true, snapshot: initial, output: { https: false, delay_ms: 0, error: 'TLS certificate expired' } });
  await click('Проверить подключение');
  assert.ok(root.textContent.includes('HTTPS-проверка не прошла.')); assert.ok(root.textContent.includes('TLS certificate expired'));
  replies.push({ http: 502, ok: false, error: 'Probe failed', output: '{"https":false,"detail":"Connection refused"}' });
  await click('Проверить подключение');
  assert.ok(root.textContent.includes('HTTP 502')); assert.ok(root.textContent.includes('Probe failed'));
  assert.ok(root.textContent.includes('Connection refused'));
}

(async function () {
  const tests = [testAtomicSaveAndOrdering, testFailuresAndDiscard, testConnectionAndSearch, testCatalogCrud, testRuleActions,
    testLargeCatalog, testEffectiveAndRuleGuard, testImportAndRefresh, testUpdateJob, testReadableOutput];
  for (const test of tests) await test();
  assert.ok(!source.includes('innerHTML'));
  console.log('PASS: profiles UI ordering, atomic CAS save, CRUD, node filters, safe text, errors and dirty-state protection');
})().catch(error => { console.error(error); process.exitCode = 1; });
