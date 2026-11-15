(function () {
  'use strict';
  var root = document.getElementById('vpn-app');
  var source = document.getElementById('vpn-profile-data');
  if (!root || !source) return;

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  var snapshot, data, baseline, busy = false, view = 'VPN', drafts = new Map(), expanded = new Set();
  var probeJob = null, probeStarting = false, probeError = '', probeNote = '', drawProbe = null, targetId = 'google';
  var defaultTargets = [
    { id: 'google', name: 'Google', url: 'https://www.google.com/generate_204', status: 204 },
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/generate_204', status: 204 },
    { id: 'cloudflare', name: 'Cloudflare', url: 'https://cp.cloudflare.com/generate_204', status: 204 }
  ];
  try {
    snapshot = JSON.parse(source.textContent);
    data = JSON.parse(JSON.stringify(snapshot.data));
    baseline = JSON.stringify(data);
  } catch (error) {
    root.append(el('p', 'Не удалось прочитать данные VPN: ' + error.message, 'vp-error'));
    return;
  }
  function dirty() { return JSON.stringify(data) !== baseline || drafts.size > 0; }
  function changed() {
    save.disabled = busy || JSON.stringify(data) === baseline;
    saveState.textContent = dirty() ? 'Есть несохраненные изменения' : 'Сохранено';
  }
  function button(text, action, title) {
    var node = el('button', text);
    node.type = 'button';
    if (title) {
      node.title = title;
      if (text.length <= 2) node.setAttribute('aria-label', title);
      else node.setAttribute('aria-description', title);
    }
    node.addEventListener('click', action);
    return node;
  }
  function field(parent, label, control) {
    var wrapper = el('label', label);
    wrapper.append(control); parent.append(wrapper);
    return control;
  }
  function input(value, onInput, multiline) {
    var node = el(multiline ? 'textarea' : 'input');
    node.value = value;
    if (multiline) node.rows = 5;
    node.addEventListener('input', function () { onInput(node.value); changed(); });
    return node;
  }
  function select(options, value, onChange) {
    var node = el('select');
    options.forEach(function (item) {
      var option = el('option', item[1]); option.value = item[0]; node.append(option);
    });
    node.value = value;
    node.addEventListener('change', function () { onChange(node.value); });
    return node;
  }
  function result(parent) {
    var node = el('p', '', 'vp-result'); node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite');
    parent.append(node); return node;
  }
  function fail(target, message) { target.textContent = message; target.classList.add('vp-error'); }
  function probing() { return probeStarting || !!(probeJob && probeJob.state === 'running'); }
  function updateProbe() { if (drawProbe) drawProbe(); }
  async function probeRequest(action, extra) {
    var params = new URLSearchParams({ action: action, ajax: '1', tab: 'vpn' });
    Object.keys(extra || {}).forEach(function (key) { params.set(key, extra[key]); });
    var controller = new AbortController(), timer;
    try {
      return await Promise.race([
        (async function () {
          var response = await fetch(window.location.pathname, {
            method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: params, signal: controller.signal
          });
          var payload, httpError = 'HTTP ' + response.status + (response.statusText ? ': ' + response.statusText : '');
          try { payload = await response.json(); } catch (_) {
            throw new Error(response.ok ? 'Сервер вернул некорректный JSON' : httpError);
          }
          if (!response.ok) throw new Error(httpError + (payload && payload.error ? ': ' + payload.error : ''));
          if (!payload || !payload.ok) throw new Error(payload && payload.error || 'Операция отклонена сервером');
          return payload;
        }()),
        new Promise(function (_, reject) {
          timer = setTimeout(function () { controller.abort(); reject(new Error('Сервер не ответил за 20 секунд')); }, 20000);
        })
      ]);
    } finally { clearTimeout(timer); }
  }
  function readProbe(payload, id) {
    var job = payload.job;
    if (!job || typeof job.id !== 'string' || !job.id || (id && job.id !== id) ||
        !['running', 'done', 'failed'].includes(job.state) || !Array.isArray(job.results) ||
        !Number.isInteger(job.total) || !Number.isInteger(job.done) || job.total < 1 || job.done < 0 || job.done > job.total || job.total > 60 ||
        job.results.some(function (item) { return !item || typeof item.tag !== 'string' || !Number.isInteger(item.passed) ||
          item.passed < 0 || item.passed > 2 || item.attempts !== 2 || typeof item.ok !== 'boolean'; })) {
      throw new Error('Некорректный ответ задания проверки');
    }
    return job;
  }
  async function pollProbe() {
    try {
      probeJob = readProbe(await probeRequest('vpn_profiles_probe_status', { arg: probeJob.id }), probeJob.id);
      probeError = '';
    } catch (error) { probeError = error.message; }
    updateProbe();
    if (probing()) setTimeout(pollProbe, 1500);
  }
  async function startProbe(tags, speed, count) {
    if (probing() || busy || !tags.length) return;
    if (speed && !window.confirm('Тест скорости через Cloudflare: до 2 MiB на узел, до ' + tags.length * 2 + ' MiB всего. Продолжить?')) return;
    probeStarting = true; probeError = ''; probeJob = null;
    probeNote = count > 60 ? 'Найдено: ' + count + '. Проверяются первые 60 узлов.' : 'Узлов: ' + tags.length;
    updateProbe();
    try {
      probeJob = readProbe(await probeRequest('vpn_profiles_probe_start', {
        content: JSON.stringify({ tags: tags.slice(0, 60), target: targetId, speed: speed })
      }));
    } catch (error) { probeError = error.message; }
    finally { probeStarting = false; updateProbe(); }
    if (probing()) setTimeout(pollProbe, 1500);
  }
  function nextId(prefix, items) {
    var number = 1;
    while (items.some(function (item) { return item.id === prefix + '-' + number; })) number++;
    return prefix + '-' + number;
  }
  function allowedNodes(profile) {
    return snapshot.nodes.filter(function (node) {
      return profile && (profile.subscriptions.includes(node.subscription) || profile.nodes.includes(node.tag));
    });
  }
  function testOutput(output) {
    var raw = typeof output === 'string' ? output : JSON.stringify(output), check;
    try { check = typeof output === 'string' ? JSON.parse(output) : output; } catch (_) { return raw; }
    if (!check || typeof check.https !== 'boolean') return raw;
    var text = check.https ? 'HTTPS-проверка прошла.' : 'HTTPS-проверка не прошла.';
    if (typeof check.delay_ms === 'number') text += '\nЗадержка: ' + check.delay_ms + ' мс';
    if (!check.https || Object.keys(check).some(function (key) { return !['https', 'delay_ms'].includes(key); })) text += '\n' + raw;
    return text;
  }
  function operationStart(action, arg) {
    if (action === 'vpn_profiles_node') return arg === 'auto' ? 'Включаю автовыбор узла...' : 'Фиксирую выбранный узел...';
    if (action === 'vpn_profiles_activate') return arg === 'off' ? 'Выключаю VPN...' : 'Применяю профиль; возможен краткий разрыв соединений...';
    if (action === 'vpn_profiles_test') return 'Проверяю HTTPS через VPN и определяю выходной IP...';
    return 'Выполняется...';
  }
  function selectionOutput(arg) {
    if (!snapshot.selection || snapshot.selection.tag !== (arg === 'auto' ? 'profile-auto' : arg)) {
      return 'Команда отправлена, но режим выбора не подтверждён. Обновите состояние перед повтором.';
    }
    var text = arg === 'auto' ? 'Автовыбор включён. sing-box управляет выбором среди уже загруженных узлов.' : 'Узел зафиксирован вручную.';
    var node = snapshot.effective;
    if (node && typeof node.type === 'string' && !['Selector', 'URLTest'].includes(node.type) && node.tag !== 'profile-auto') {
      text += '\nСейчас выбран: ' + (node.title || node.tag) + '.';
    } else text += '\nВыбранный выходной узел пока не определён.';
    return text + '\nVPN не перезапускался. Доступность интернета этой командой не проверяется.';
  }
  async function request(action, arg, target, extra, saving, savedDrafts) {
    if (busy) return false;
    var otherDrafts = Array.from(drafts.keys()).some(function (key) { return !(savedDrafts || []).includes(key); });
    var discarding = JSON.stringify(data) !== baseline || otherDrafts;
    if (!saving && discarding && !window.confirm('Несохраненные изменения будут потеряны после успешной операции. Продолжить?')) return false;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    var controls = Array.from(root.querySelectorAll('button, input, select, textarea'));
    var disabled = controls.map(function (node) { return node.disabled; });
    controls.forEach(function (node) { node.disabled = true; });
    target.classList.remove('vp-error'); target.classList.add('vp-pending');
    target.textContent = operationStart(action, arg);
    var controller = new AbortController(), timeout;
    var waitMs = action === 'vpn_profiles_node' ? 45000 : 90000;
    try {
      var params = new URLSearchParams({ action: action, ajax: '1', tab: 'vpn' });
      if (arg !== undefined) params.set('arg', arg);
      Object.keys(extra || {}).forEach(function (key) { params.set(key, extra[key]); });
      var reply = await Promise.race([
        (async function () {
          var response = await fetch(window.location.pathname, {
            method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: params, signal: controller.signal
          });
          var httpError = 'HTTP ' + response.status + (response.statusText ? ': ' + response.statusText : ''), payload;
          try { payload = await response.json(); } catch (_) {
            throw new Error(response.ok ? 'Сервер вернул некорректный JSON' : httpError);
          }
          return { response: response, payload: payload, httpError: httpError };
        }()),
        new Promise(function (_, reject) {
          timeout = setTimeout(function () {
            controller.abort();
            reject(new Error('Сервер не подтвердил результат за ' + waitMs / 1000 + ' секунд. Операция могла выполниться; обновите состояние перед повтором.'));
          }, waitMs);
        })
      ]);
      var response = reply.response, payload = reply.payload, httpError = reply.httpError;
      if (!payload || typeof payload !== 'object') throw new Error('Сервер вернул некорректный ответ');
      var testDetails = action === 'vpn_profiles_test' && payload.output !== undefined ? '\n' + testOutput(payload.output) : '';
      if (!response.ok) throw new Error(httpError + (payload.error ? ': ' + payload.error : '') + testDetails);
      if (!payload.ok) throw new Error((payload.error || 'Операция отклонена сервером') + testDetails);
      if (!payload.snapshot || !payload.snapshot.data) throw new Error('В ответе сервера отсутствуют данные VPN');
      snapshot = payload.snapshot;
      data = JSON.parse(JSON.stringify(snapshot.data)); baseline = JSON.stringify(data); drafts.clear();
      render();
      var output = action === 'vpn_profiles_test' ? testOutput(payload.output) : String(payload.output);
      if (action === 'vpn_profiles_node') output = selectionOutput(arg);
      notice.textContent = payload.output === undefined ? 'Готово' : output;
      if (action === 'vpn_profiles_node') notice.textContent = output;
      if (action === 'vpn_profiles_node' && (!snapshot.selection || snapshot.selection.tag !== (arg === 'auto' ? 'profile-auto' : arg))) {
        notice.classList.add('vp-warning');
      }
      return true;
    } catch (error) {
      fail(target, error.message || 'Не удалось связаться с сервером');
      return false;
    } finally {
      clearTimeout(timeout);
      busy = false; root.removeAttribute('aria-busy');
      target.classList.remove('vp-pending');
      controls.forEach(function (node, index) { if (node.isConnected) node.disabled = disabled[index]; });
      changed();
    }
  }
  // Preserve the stored order; catalog order only determines where unchecked items appear.
  function ordered(parent, title, selected, items, searchable) {
    var group = el('fieldset', undefined, 'vp-ordered'); group.append(el('legend', title)); parent.append(group);
    var query = '', lookup = new Map(items);
    if (searchable) {
      var search = field(group, 'Поиск дополнительных узлов', input('', function (value) { query = value.toLocaleLowerCase(); draw(); }));
      search.type = 'search';
    }
    var count = el('p', '', 'vp-count'), list = el('div'); group.append(count, list);
    function draw() {
      list.replaceChildren();
      var available = items.filter(function (item) {
        return !selected.includes(item[0]) && (!query || item.join(' ').toLocaleLowerCase().includes(query));
      });
      var shown = searchable ? available.slice(0, 30) : available;
      count.textContent = searchable ? 'Выбрано: ' + selected.length + '. Найдено: ' + available.length + ', показано: ' + shown.length : '';
      var ids = selected.concat(shown.map(function (item) { return item[0]; }));
      if (!ids.length) list.append(el('p', 'Список пуст'));
      ids.forEach(function (id) {
        var name = lookup.get(id), item = name === undefined ? null : [id, name];
        var index = selected.indexOf(id), row = el('div', undefined, 'vp-order-row');
        var check = el('input'); check.type = 'checkbox'; check.checked = index !== -1;
        check.addEventListener('change', function () {
          if (check.checked) selected.push(id); else selected.splice(selected.indexOf(id), 1);
          changed(); draw();
        });
        var label = el('label'); label.append(check, el('span', (index < 0 ? '' : (index + 1) + '. ') + (item ? item[1] : id + ' (недоступен)')));
        row.append(label);
        [-1, 1].forEach(function (offset) {
          var move = button(offset < 0 ? '\u2191' : '\u2193', function () {
            var other = index + offset;
            selected[index] = selected[other]; selected[other] = id;
            changed(); draw();
          }, (offset < 0 ? 'Выше: ' : 'Ниже: ') + (item ? item[1] : id));
          move.disabled = index < 0 || index + offset < 0 || index + offset >= selected.length;
          row.append(move);
        });
        list.append(row);
      });
    }
    draw();
  }
  function section(title) {
    var node = el('section', undefined, 'vp-section'); node.append(el('h2', title)); panel.append(node); return node;
  }
  function editor(parent, name, id) {
    var node = el('fieldset', undefined, 'vp-editor');
    node.append(el('legend', name), el('code', id)); parent.append(node); return node;
  }
  function compactEditor(parent, name, id, kind, build) {
    var details = el('details', undefined, 'vp-compact'), key = kind + ':' + id;
    details.setAttribute('data-editor-id', id);
    details.append(el('summary', name + ' (' + id + ')'));
    parent.append(details);
    var loaded = false;
    function toggle() {
      if (!details.open) { expanded.delete(key); return; }
      expanded.add(key);
      if (!loaded) { loaded = true; build(editor(details, name, id)); }
    }
    details.addEventListener('toggle', toggle);
    details.open = expanded.has(key);
    if (details.open) toggle();
  }
  function vpn() {
    var area = section('VPN');
    var current = snapshot.data.profiles.find(function (profile) { return profile.id === snapshot.active; });
    area.append(el('p', snapshot.running ? 'Сервис VPN запущен' : 'VPN выключен', 'vp-status'));
    var legacy = snapshot.running && !current;
    if (legacy) area.append(el('p', 'Старое подключение: выберите профиль', 'vp-warning'));
    if (current) area.append(el('p', 'Профиль: ' + current.name));
    if (snapshot.running && current) {
      var mode = snapshot.selection && snapshot.selection.mode;
      area.append(el('p', 'Выбор узла: ' + (mode === 'auto' ? 'автоматически' : mode === 'manual' ? 'вручную' : 'не определён')));
    }
    if (snapshot.effective) {
      var effective = snapshot.effective;
      area.append(el('p', 'Текущий узел: ' + (effective.title || effective.tag) + (effective.type ? ' · ' + effective.type : '')));
      var delay = effective.delay_ms === undefined ? effective.delay : effective.delay_ms;
      if (delay !== undefined && delay !== null) area.append(el('p', 'Задержка: ' + delay + ' мс'));
    }
    var target = result(area);
    var profiles = [['off', 'Выключен']].concat(snapshot.data.profiles.map(function (profile) { return [profile.id, profile.name]; }));
    if (legacy) profiles.unshift(['', 'Выберите профиль']);
    var selectedProfile = legacy ? '' : snapshot.running && current ? current.id : 'off';
    var chooser = field(area, 'Профиль', select(profiles, selectedProfile, async function (id) {
      if (!id || !await request('vpn_profiles_activate', id, target)) chooser.value = selectedProfile;
    }));
    var reapply = button('Применить профиль', function () {
      if (chooser.value && window.confirm('Применить сохранённые настройки профиля? VPN может кратко прерваться; ручная фиксация узла сбросится на автовыбор.')) {
        request('vpn_profiles_activate', chooser.value, target);
      }
    }, 'Повторно собирает выбранный профиль из сохранённых подписок и правил и применяет его. Возможен краткий разрыв соединений. Подписки не скачивает; ручная фиксация узла сбрасывается на автовыбор.');
    reapply.disabled = !chooser.value || chooser.value === 'off'; area.append(reapply);
    var actions = el('div', undefined, 'vp-actions');
    actions.append(button('Проверить подключение', function () { request('vpn_profiles_test', '', target); },
      'Проверяет HTTPS через текущий VPN-выход и запрашивает его внешний IP и геолокацию. Узел не переключает и VPN не перезапускает. Ошибка геолокации сама по себе не означает отказ VPN.'));
    var auto = button('Автовыбор узла', function () { request('vpn_profiles_node', 'auto', target); },
      'Включает автоматический режим sing-box среди уже загруженных узлов профиля. Не запускает отдельный поиск, загрузку подписок или перезапуск VPN. Это режим работы, а не разовый поиск с процентом выполнения; доступность проверяется отдельно.');
    auto.disabled = !snapshot.running || !current; actions.append(auto); area.append(actions);
    var options = [['', 'Выберите узел']].concat(allowedNodes(current).map(function (node) { return [node.tag, node.title || node.tag]; }));
    var manual = field(area, 'Узел вручную', select(options, '', async function (tag) {
      if (tag) await request('vpn_profiles_node', tag, target);
      manual.value = '';
    }));
    manual.disabled = !snapshot.running || !current;
    manual.title = 'Фиксирует выбранный узел вместо автоматического выбора, без перезапуска VPN. Узел должен уже присутствовать в работающей конфигурации; доступность этой командой не проверяется.';
    chooser.title = 'Выбор профиля применяет его сохранённые настройки и может кратко прервать соединения. Выключен возвращает обычную маршрутизацию.';
  }
  function profiles() {
    var area = section('Профили');
    area.append(button('Добавить профиль', function () {
      var id = nextId('profile', data.profiles); expanded.add('profile:' + id);
      data.profiles.push({
        id: id, name: 'Новый профиль', subscriptions: [], nodes: [], rules: [], final: 'direct', preference: 'any'
      });
      render();
    }));
    data.profiles.forEach(function (profile) {
      compactEditor(area, profile.name, profile.id, 'profile', function (group) {
      field(group, 'Название профиля', input(profile.name, function (value) { profile.name = value; }));
      ordered(group, 'Подписки по приоритету', profile.subscriptions, data.subscriptions.map(function (item) { return [item.id, item.name]; }));
      ordered(
        group,
        'Дополнительные узлы по приоритету',
        profile.nodes,
        snapshot.nodes.map(function (item) { return [item.tag, item.title || item.tag]; }),
        true
      );
      ordered(group, 'Правила по приоритету', profile.rules, snapshot.rules.map(function (item) { return [item.id, item.name || item.id]; }));
      field(group, 'Остальной трафик', select([['direct', 'Напрямую'], ['vpn-out', 'Через VPN']], profile.final, function (value) {
        profile.final = value; changed();
      }));
      field(group, 'Предпочтение страны', select([['ru', 'Россия'], ['non-ru', 'Не Россия'], ['any', 'Любая']], profile.preference, function (value) {
        profile.preference = value; changed();
      }));
      group.append(button('Удалить профиль', function () {
        if (window.confirm('Удалить профиль «' + profile.name + '»?')) { data.profiles.splice(data.profiles.indexOf(profile), 1); render(); }
      }));
      });
    });
  }
  function subscriptions() {
    var area = section('Подписки'), target = result(area);
    if (snapshot.updateJob) {
      var job = snapshot.updateJob;
      var states = {
        queued: 'Обновление подписок в очереди. Запуск в течение минуты.',
        running: 'Подписки обновляются...',
        done: 'Подписки обновлены.',
        failed: 'Не удалось обновить подписки.'
      };
      var status = result(area);
      status.textContent = (states[job.state] || 'Состояние обновления неизвестно.') + (job.message ? '\n' + job.message : '');
      if (job.state === 'failed') status.classList.add('vp-error');
    }
    area.append(button('Добавить подписку', function () {
      var id = nextId('source', data.subscriptions); expanded.add('source:' + id);
      data.subscriptions.push({ id: id, name: 'Новая подписка', urls: [] }); render();
    }), button('Обновить все', function () { request('vpn_profiles_update', 'all', target); }));
    data.subscriptions.forEach(function (subscription) {
      compactEditor(area, subscription.name, subscription.id, 'source', function (group) {
      field(group, 'Название подписки', input(subscription.name, function (value) { subscription.name = value; }));
      field(group, 'Зеркала по приоритету', input(subscription.urls.join('\n'), function (value) {
        subscription.urls = value.split(/\r?\n/).map(function (url) { return url.trim(); }).filter(Boolean);
      }, true));
      var output = result(group);
      group.append(button('Обновить', function () { request('vpn_profiles_update', subscription.id, output); }));
      group.append(button('Удалить подписку', function () {
        var nodeTags = snapshot.nodes.filter(function (node) { return node.subscription === subscription.id; }).map(function (node) { return node.tag; });
        if (data.profiles.some(function (profile) {
          return profile.subscriptions.includes(subscription.id) || profile.nodes.some(function (tag) { return nodeTags.includes(tag); });
        })) {
          fail(output, 'Подписка используется в профилях. Сначала уберите ее из профилей.'); return;
        }
        if (window.confirm('Удалить подписку «' + subscription.name + '»?')) {
          data.subscriptions.splice(data.subscriptions.indexOf(subscription), 1); render();
        }
      }));
      });
    });
  }
  function rules() {
    var area = section('Правила');
    function ruleEditor(rule, fresh) {
      if (!fresh) {
        compactEditor(area, rule.name || rule.id, rule.id, 'rule', function (group) { ruleFields(rule, false, group); });
      } else ruleFields(rule, true, editor(area, 'Новое правило', ''));
    }
    function ruleFields(rule, fresh, group) {
      var id = rule.id;
      if (fresh) field(group, 'ID правила', input(id, function (value) {
        id = value; drafts.set('__new_id', value); if (!value) drafts.delete('__new_id');
      }));
      var key = fresh ? '__new_content' : rule.id;
      var content = field(group, 'Содержимое правила', input(drafts.has(key) ? drafts.get(key) : rule.content, function (value) {
        if (value === rule.content) drafts.delete(key); else drafts.set(key, value);
      }, true));
      var output = result(group);
      group.append(button('Сохранить правило', function () {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) { fail(output, 'ID: строчные латинские буквы, цифры, дефис и подчеркивание.'); return; }
        if (fresh && snapshot.rules.some(function (item) { return item.id === id; })) { fail(output, 'Такой ID уже существует.'); return; }
        request(
          'vpn_profiles_rule_save',
          id,
          output,
          { revision: fresh ? 'new' : rule.revision, content: content.value },
          false,
          fresh ? ['__new_id', '__new_content'] : [key]
        );
      }));
      if (!fresh) group.append(button('Удалить правило', function () {
        var referenced = data.profiles.concat(snapshot.data.profiles).some(function (profile) { return profile.rules.includes(id); });
        if (referenced) { fail(output, 'Правило используется в профилях. Сначала уберите его из профилей и сохраните.'); return; }
        if (window.confirm('Удалить правило «' + id + '»?')) {
          request('vpn_profiles_rule_delete', id, output, { revision: rule.revision });
        }
      }));
    }
    snapshot.rules.forEach(function (rule) { ruleEditor(rule, false); });
    ruleEditor({ id: drafts.get('__new_id') || '', content: '' }, true);
  }
  function nodes() {
    var area = section('Узлы'), query = '', sourceId = '', page = 0;
    var importer = editor(area, 'Добавить узел', '');
    var nodeName = field(importer, 'Название узла', input(drafts.get('__node_name') || '', function (value) {
      if (value) drafts.set('__node_name', value); else drafts.delete('__node_name');
    }));
    var uri = field(importer, 'URI VLESS / Hysteria2', input(drafts.get('__node_uri') || '', function (value) {
      if (value) drafts.set('__node_uri', value); else drafts.delete('__node_uri');
    }, true));
    uri.rows = 3; uri.autocomplete = 'off'; uri.spellcheck = false;
    var importResult = result(importer);
    importer.append(button('Добавить узел', function () {
      if (!nodeName.value.trim()) { fail(importResult, 'Укажите название узла.'); return; }
      if (!/^(vless|hy2|hysteria2):\/\/[^\r\n]+$/i.test(uri.value.trim())) {
        fail(importResult, 'Укажите один URI VLESS или Hysteria2.'); return;
      }
      request(
        'vpn_profiles_node_import',
        nodeName.value.trim(),
        importResult,
        { content: uri.value.trim(), revision: snapshot.revision },
        false,
        ['__node_name', '__node_uri']
      );
    }));
    var search = field(area, 'Поиск узлов', input('', function (value) { query = value.toLocaleLowerCase(); page = 0; draw(); }));
    search.type = 'search';
    field(area, 'Подписка', select([['', 'Все подписки']].concat(data.subscriptions.map(function (item) {
      return [item.id, item.name];
    })), '', function (value) { sourceId = value; page = 0; draw(); }));
    var tests = el('div', undefined, 'vp-tests'); area.append(tests);
    tests.append(el('h3', 'HTTPS-тесты'));
    var targets = snapshot.testTargets || { revision: '', items: defaultTargets };
    var targetItems = drafts.has('__targets') ? JSON.parse(drafts.get('__targets')) : JSON.parse(JSON.stringify(targets.items));
    var targetSelect = field(tests, 'Ресурс', select([], '', function (value) { targetId = value; }));
    function targetOptions() {
      targetSelect.replaceChildren();
      targets.items.forEach(function (item) {
        var option = el('option', item.name); option.value = item.id; targetSelect.append(option);
      });
      if (!targets.items.some(function (item) { return item.id === targetId; })) targetId = targets.items[0] ? targets.items[0].id : '';
      targetSelect.value = targetId;
    }
    targetOptions();
    var targetDetails = el('details', undefined, 'vp-compact vp-targets');
    targetDetails.append(el('summary', 'Ресурсы')); tests.append(targetDetails);
    var targetList = el('div'), targetMessage = result(targetDetails), targetSaving = false;
    targetDetails.append(targetList);
    function targetChanged() { drafts.set('__targets', JSON.stringify(targetItems)); changed(); }
    function drawTargets() {
      targetList.replaceChildren();
      targetItems.forEach(function (item) {
        var row = el('div', undefined, 'vp-target-row'); targetList.append(row);
        row.append(el('code', item.id));
        field(row, 'Название ресурса', input(item.name, function (value) { item.name = value; targetChanged(); }));
        var url = field(row, 'HTTPS URL', input(item.url, function (value) { item.url = value; targetChanged(); })); url.type = 'url';
        var status = field(row, 'HTTP-код', input(item.status, function (value) { item.status = Number(value); targetChanged(); }));
        status.type = 'number'; status.min = 200; status.max = 299;
        row.append(button('×', function () {
          targetItems.splice(targetItems.indexOf(item), 1); targetChanged(); drawTargets();
        }, 'Удалить ресурс: ' + item.name));
      });
    }
    drawTargets();
    var targetActions = el('div', undefined, 'vp-actions'); targetDetails.append(targetActions);
    targetActions.append(button('+', function () {
      targetItems.push({ id: nextId('target', targetItems), name: '', url: '', status: 204 }); targetChanged(); drawTargets();
    }, 'Добавить ресурс'));
    var targetSave = button('Сохранить ресурсы', async function () {
      if (targetSaving) return;
      var invalid = !targetItems.length || targetItems.some(function (item) {
        try {
          var url = new URL(item.url);
          return !item.name.trim() || url.protocol !== 'https:' || !!url.username || !!url.password ||
            !Number.isInteger(item.status) || item.status < 200 || item.status > 299;
        } catch (_) { return true; }
      });
      if (invalid) { fail(targetMessage, 'Укажите название, HTTPS URL без пароля и HTTP-код 200–299. Нужен хотя бы один ресурс.'); return; }
      targetSaving = true; targetSave.disabled = true; targetList.inert = true; targetActions.inert = true;
      targetMessage.classList.remove('vp-error'); targetMessage.textContent = 'Сохранение...';
      var content = JSON.stringify(targetItems);
      try {
        var payload = await probeRequest('vpn_profiles_targets_save', { revision: targets.revision, content: content });
        if (!payload.snapshot || !payload.snapshot.testTargets || !Array.isArray(payload.snapshot.testTargets.items)) {
          throw new Error('В ответе сервера отсутствуют ресурсы');
        }
        snapshot.testTargets = payload.snapshot.testTargets; targets = snapshot.testTargets;
        if (drafts.get('__targets') === content) drafts.delete('__targets');
        targetOptions(); targetMessage.textContent = 'Ресурсы сохранены'; updateProbe();
      } catch (error) { fail(targetMessage, error.message); }
      finally { targetSaving = false; targetSave.disabled = false; targetList.inert = false; targetActions.inert = false; changed(); }
    });
    targetActions.append(targetSave);
    var targetURLs = el('details', undefined, 'vp-compact');
    targetURLs.append(el('summary', 'URL проверки')); tests.append(targetURLs);
    var urls = el('div'); targetURLs.append(urls);
    var testActions = el('div', undefined, 'vp-actions'); tests.append(testActions);
    function filteredNodes() {
      return snapshot.nodes.filter(function (node) {
        return (!sourceId || node.subscription === sourceId) && [node.title, node.tag, node.type].join(' ').toLocaleLowerCase().includes(query);
      });
    }
    function batch(speed) {
      var matches = filteredNodes();
      return startProbe(matches.slice(0, 60).map(function (node) { return node.tag; }), speed, matches.length);
    }
    var quick = button('Быстрый тест', function () { return batch(false); });
    var speed = button('Тест скорости', function () { return batch(true); }); testActions.append(quick, speed);
    var probeStatus = result(tests), progress = el('progress'), results = el('table', undefined, 'vp-probe-results');
    progress.setAttribute('aria-label', 'Прогресс HTTPS-теста'); tests.append(progress, results);
    drawProbe = function () {
      var matches = filteredNodes(), active = probing();
      quick.disabled = speed.disabled = active || !matches.length || !targetId;
      targetSelect.disabled = active;
      list.querySelectorAll('button').forEach(function (node) { node.disabled = active; });
      urls.replaceChildren();
      targets.items.forEach(function (item) { urls.append(el('p', item.name + ' · HTTP ' + item.status), el('code', item.url)); });
      urls.append(el('p', 'Скорость · Cloudflare · 2 MiB'), el('code', 'https://speed.cloudflare.com/__down?bytes=2097152'));
      var text = probeStarting ? 'Запуск...' : probeJob ?
        ({ running: 'Проверка', done: 'Готово', failed: 'Ошибка задания' })[probeJob.state] + ': ' + probeJob.done + '/' + probeJob.total :
        'Найдено: ' + matches.length + '. К тесту: ' + Math.min(60, matches.length) + ' (максимум 60).';
      if (probeJob) text += '\n' + probeNote + (probeJob.target ? ' · ' + probeJob.target.name : '');
      if (probeJob && probeJob.state === 'running' && probeJob.phase === 'speed') {
        text += '\nЗамер скорости: ' + probeJob.results.filter(function (item) { return item.speed_bytes != null; }).length + '/' +
          probeJob.results.filter(function (item) { return item.ok; }).length;
      }
      probeStatus.textContent = text + (probeError ? '\n' + probeError : '') + (probeJob && probeJob.error ? '\n' + probeJob.error : '');
      probeStatus.classList.remove('vp-error');
      if (probeError || probeJob && probeJob.state === 'failed') probeStatus.classList.add('vp-error');
      progress.hidden = !active; progress.max = probeJob ? probeJob.total || 1 : 1; progress.value = probeJob ? probeJob.done : 0;
      results.replaceChildren();
      if (!probeJob || !probeJob.results.length) return;
      var head = el('thead'), headings = el('tr');
      ['Узел', 'HTTPS', 'HTTPS, мс', 'Мбит/с'].forEach(function (name) { var cell = el('th', name); cell.scope = 'col'; headings.append(cell); });
      head.append(headings); results.append(head);
      var body = el('tbody'); results.append(body);
      probeJob.results.forEach(function (item) {
        var row = el('tr'); body.append(row);
        var values = [
          (item.title || item.tag) + (item.type ? ' · ' + item.type : ''),
          (item.ok ? 'Доступен' : item.passed ? 'Нестабильно' : 'Недоступен') +
            ' · ' + item.passed + '/' + item.attempts + (item.http_code ? ' · HTTP ' + item.http_code : ''),
          item.latency_ms == null ? '—' : String(item.latency_ms),
          item.speed_mbps == null ? '—' : String(item.speed_mbps)
        ];
        values.forEach(function (value, index) {
          var cell = el('td', value); cell.setAttribute('data-label', ['Узел', 'HTTPS', 'HTTPS, мс', 'Мбит/с'][index]); row.append(cell);
          if (index === 1 && item.error) cell.append(el('p', item.error, 'vp-error'));
          if (index === 3 && item.speed_error) cell.append(el('p', item.speed_error, 'vp-error'));
        });
      });
    };
    var list = el('div'), pages = el('div', undefined, 'vp-actions'); area.append(list, pages);
    function draw() {
      list.replaceChildren();
      var matches = filteredNodes();
      if (!matches.length) list.append(el('p', 'Узлы не найдены'));
      matches.slice(page * 30, (page + 1) * 30).forEach(function (node) {
        var row = el('div', undefined, 'vp-node');
        row.append(el('strong', node.title || node.tag), el('p', node.type + ' · ' + node.subscription), el('code', node.tag));
        row.append(button('Проверить узел', function () { return startProbe([node.tag], false, 1); })); list.append(row);
      });
      pages.replaceChildren();
      if (matches.length > 30) {
        var previous = button('Назад', function () { page--; draw(); }); previous.disabled = page === 0;
        var next = button('Далее', function () { page++; draw(); }); next.disabled = (page + 1) * 30 >= matches.length;
        pages.append(previous, el('span', (page + 1) + ' / ' + Math.ceil(matches.length / 30)), next);
      }
      updateProbe();
    }
    draw();
  }
  var save, saveState, notice, panel;
  function render() {
    drawProbe = null;
    root.replaceChildren();
    var nav = el('nav', undefined, 'vp-nav'); nav.setAttribute('aria-label', 'VPN');
    [
      ['VPN', 'VPN', 'Статус подключения, выбор профиля и ручной или автоматический режим узла.'],
      ['Profiles', 'Профили', 'Состав профилей: подписки, узлы, правила и приоритеты. Сохранение не применяет профиль автоматически.'],
      ['Subscriptions', 'Подписки', 'Редактирование источников и обновление кэша узлов без разрыва текущего подключения.'],
      ['Rules', 'Правила', 'Редактирование наборов маршрутизации. Для применения сохранённых изменений нужно применить профиль.'],
      ['Nodes', 'Узлы', 'Поиск, независимые HTTPS-тесты и замер скорости. Тесты не переключают текущий узел.']
    ].forEach(function (item) {
      var link = button(item[1], function () { view = item[0]; render(); }, item[2]);
      if (view === item[0]) link.setAttribute('aria-current', 'page'); nav.append(link);
    });
    var refresh = button('Обновить', function () { request('vpn_profiles_snapshot', undefined, notice); },
      'Перечитывает состояние роутера и фактический выбор sing-box. Не применяет профиль, не тестирует интернет и не перезапускает VPN. Несохранённые правки потребуют подтверждения перед сбросом.');
    refresh.setAttribute('aria-label', 'Обновить состояние'); nav.append(refresh);
    root.append(nav);
    var toolbar = el('div', undefined, 'vp-save');
    save = button('Сохранить изменения', function () {
      var invalid = data.profiles.concat(data.subscriptions).some(function (item) { return !item.name.trim(); });
      if (invalid) { fail(notice, 'Укажите название каждого профиля и подписки.'); return; }
      if (data.subscriptions.some(function (item) { return !item.urls.length; })) { fail(notice, 'Добавьте адрес зеркала каждой подписки.'); return; }
      if (drafts.size && !window.confirm('Черновики правил и импорта узла будут потеряны. Сохранить профили и подписки?')) return;
      request('vpn_profiles_save', undefined, notice, { revision: snapshot.revision, content: JSON.stringify(data) }, true);
    });
    saveState = el('span'); toolbar.append(save, saveState);
    if (view !== 'VPN') root.append(toolbar);
    notice = result(root); panel = el('div'); root.append(panel);
    ({ VPN: vpn, Profiles: profiles, Subscriptions: subscriptions, Rules: rules, Nodes: nodes })[view]();
    changed();
  }
  window.addEventListener('beforeunload', function (event) {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  render();
}());
