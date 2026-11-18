(function () {
  'use strict';
  var root = document.getElementById('vpn-app');
  var source = document.getElementById('vpn-profile-data');
  if (!root || !source) return;

  var overview = root.getAttribute('data-view') === 'overview';

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  var snapshot, data, baseline, busy = false, view = 'VPN', drafts = new Map(), expanded = new Set();
  var probeJob = null, probeStarting = false, probeError = '', probeNote = '', drawProbe = null, targetId = 'google';
  var probeNode = null, nodeResults = new Map();
  var connectionStarting = false, connectionSaving = false, connectionRefreshing = false, connectionError = '';
  var drawConnection = null, connectionTimer;
  var connectionControls = [], completedConnectionJob = null;
  var connectionDefaults = {
    enabled: false, interval_minutes: 5, failures: 3, target: 'google', refresh_on_failure: false, allow_reload: true
  };
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
  // Only numeric measurements and outcomes belong in browser storage.
  try {
    var savedMeasurements = new Map(JSON.parse(window.localStorage.getItem('vpn-node-measurements') || '[]'));
    snapshot.nodes.forEach(function (node) {
      var item = savedMeasurements.get(node.tag);
      if (item && (item.revision || null) === (snapshot.data.nodeEndpoints?.[node.tag] ? snapshot.revision : null) && [0, 1, 2].includes(item.passed)) nodeResults.set(node.tag, { item: item });
    });
  } catch (_) {}
  function dirty() { return JSON.stringify(data) !== baseline || drafts.size > 0; }
  function changed() {
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
  function connectionWorking() {
    return connectionStarting || connectionSaving || connectionRefreshing ||
      !!(snapshot.connection && snapshot.connection.job && snapshot.connection.job.state === 'running');
  }
  function connectionControl(node, unavailable) {
    connectionControls.push({ node: node, unavailable: !!unavailable });
    node.disabled = busy || connectionWorking() || !!unavailable;
    return node;
  }
  function command(text, action, title) { return connectionControl(button(text, action, title)); }
  function updateConnection() {
    connectionControls.forEach(function (item) {
      if (item.node.isConnected) item.node.disabled = busy || connectionWorking() || item.unavailable;
    });
    if (connectionWorking() || busy) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    if (drawConnection) drawConnection();
    updateProbe(); changed();
  }
  function readConnection(payload, id) {
    var connection = payload.connection, settings = connection && connection.settings;
    var job = connection && connection.job, check = connection && connection.lastCheck;
    if (!connection || typeof connection.revision !== 'string' || !settings ||
        typeof settings.enabled !== 'boolean' || typeof settings.refresh_on_failure !== 'boolean' || typeof settings.allow_reload !== 'boolean' ||
        !Number.isInteger(settings.interval_minutes) || settings.interval_minutes < 1 || settings.interval_minutes > 1440 ||
        !Number.isInteger(settings.failures) || settings.failures < 2 || settings.failures > 10 || typeof settings.target !== 'string' ||
        (check !== null && (!check || !Number.isFinite(check.time) || typeof check.profile !== 'string' || typeof check.node !== 'string' ||
          typeof check.ok !== 'boolean' || check.attempts !== 2 || !Number.isInteger(check.passed) || check.passed < 0 || check.passed > 2 ||
          (check.latency_ms !== null && !Number.isFinite(check.latency_ms)) ||
          !Number.isInteger(check.http_code) || typeof check.reason !== 'string')) ||
        (id && (!job || job.id !== id)) ||
        (job !== null && (!job || typeof job.id !== 'string' || !job.id || !['check', 'find', 'auto'].includes(job.kind) ||
          !['running', 'done', 'failed'].includes(job.state) || typeof job.phase !== 'string' || typeof job.message !== 'string' ||
          (job.error !== undefined && typeof job.error !== 'string') ||
          !Number.isInteger(job.done) || !Number.isInteger(job.total) || job.done < 0 || job.total < job.done ||
          (job.selected && (typeof job.selected.tag !== 'string' || typeof job.selected.title !== 'string' ||
            (job.selected.latency_ms !== null && !Number.isFinite(job.selected.latency_ms))))))) {
      throw new Error('Некорректный ответ проверки подключения');
    }
    return connection;
  }
  function scheduleConnection() {
    clearTimeout(connectionTimer);
    if (snapshot.connection && snapshot.connection.job && snapshot.connection.job.state === 'running') {
      connectionTimer = setTimeout(pollConnection, 1500);
    } else if (snapshot.connection && snapshot.connection.settings.enabled && view === 'VPN') {
      connectionTimer = setTimeout(pollConnection, 15000);
    }
  }
  async function completeConnection() {
    var job = snapshot.connection.job;
    if (!job || job.state === 'running' || completedConnectionJob === job.id) return;
    completedConnectionJob = job.id;
    if (job.state === 'done' && job.selected) {
      var node = snapshot.nodes.find(function (item) { return item.tag === job.selected.tag; });
      snapshot.effective = { tag: job.selected.tag, title: job.selected.title, delay_ms: job.selected.latency_ms, type: node ? node.type : '' };
      snapshot.selection = { mode: 'manual', tag: job.selected.tag };
    }
    if (dirty()) return;
    // Read runtime fields only: edits made while the snapshot is in flight must survive.
    connectionRefreshing = true;
    try {
      var payload = await probeRequest('vpn_profiles_snapshot');
      if (!payload.snapshot || !payload.snapshot.data) throw new Error('В ответе сервера отсутствуют данные VPN');
      ['active', 'effective', 'selection', 'running'].forEach(function (key) { snapshot[key] = payload.snapshot[key]; });
    } catch (error) { connectionError = 'Не удалось обновить текущий узел: ' + error.message; }
    finally { connectionRefreshing = false; }
  }
  async function pollConnection() {
    try {
      var previous = snapshot.connection && snapshot.connection.job;
      snapshot.connection = readConnection(await probeRequest('vpn_profiles_connection_status'),
        previous && previous.state === 'running' ? previous.id : undefined);
      connectionError = '';
      await completeConnection();
    } catch (error) { connectionError = error.message; }
    updateConnection(); scheduleConnection();
  }
  async function startConnection(kind) {
    if (busy || connectionWorking() || probing() || !snapshot.running || !snapshot.active) return;
    connectionStarting = true; connectionError = ''; updateConnection();
    try {
      var connection = readConnection(await probeRequest('vpn_profiles_connection_start', { arg: kind }));
      if (!connection.job || connection.job.kind !== kind) throw new Error('Некорректный ответ запуска проверки подключения');
      snapshot.connection = connection;
      await completeConnection();
    } catch (error) { connectionError = error.message; }
    finally { connectionStarting = false; updateConnection(); scheduleConnection(); }
  }
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
  function acceptProbe(payload, id) {
    var job = payload.job;
    if (!job || typeof job.id !== 'string' || !job.id || (id && job.id !== id) ||
        !['running', 'done', 'failed'].includes(job.state) || !Array.isArray(job.results) ||
        !Number.isInteger(job.total) || !Number.isInteger(job.done) || job.total < 1 || job.done < 0 || job.done > job.total || job.total > 60 ||
        job.results.some(function (item) { return !item || typeof item.tag !== 'string' || !Number.isInteger(item.passed) ||
          item.passed < 0 || item.passed > 2 || item.attempts !== 2 || typeof item.ok !== 'boolean'; })) {
      throw new Error('Некорректный ответ задания проверки');
    }
    job.results.forEach(function (item) {
      var previous = nodeResults.get(item.tag);
      if (previous && item.speed_mbps == null && !item.speed_error) {
        item = Object.assign({}, item, { speed_mbps: previous.item.speed_mbps, speed_error: previous.item.speed_error });
      }
      nodeResults.set(item.tag, { item: item, target: job.target, job: job.state === 'done' ? job.id : null, started: job.started_at });
    });
    if (job.state !== 'running') {
      try {
        var measurements = Array.from(nodeResults, function (entry) {
          var item = entry[1].item;
          return [entry[0], { revision: snapshot.data.nodeEndpoints?.[entry[0]] ? snapshot.revision : null, passed: item.passed, attempts: 2, ok: item.ok, latency_ms: item.latency_ms,
            speed_mbps: item.speed_mbps, speed_error: item.speed_error ? 'Замер не удался' : '', http_code: item.http_code }];
        });
        window.localStorage.setItem('vpn-node-measurements', JSON.stringify(measurements));
      } catch (_) {}
    }
    return job;
  }
  async function pollProbe() {
    try {
      probeJob = acceptProbe(await probeRequest('vpn_profiles_probe_status', { arg: probeJob.id }), probeJob.id);
      probeError = '';
    } catch (error) { probeError = error.message; }
    updateConnection();
    if (probing()) setTimeout(pollProbe, 1500);
  }
  async function startProbe(tags, speed, count, nodeTag = null) {
    if (probing() || busy || connectionWorking() || !tags.length || !targetId) return;
    if (speed && !window.confirm('Тест скорости через Cloudflare: до 2 MiB на узел, до ' + tags.length * 2 + ' MiB всего. Продолжить?')) return;
    probeStarting = true; probeError = ''; probeJob = null;
    probeNode = nodeTag;
    probeNote = count > 60 ? 'Найдено: ' + count + '. Проверяются первые 60 узлов.' : 'Узлов: ' + tags.length;
    updateConnection();
    try {
      probeJob = acceptProbe(await probeRequest('vpn_profiles_probe_start', {
        content: JSON.stringify({ tags: tags.slice(0, 60), target: targetId, speed: speed })
      }));
    } catch (error) { probeError = error.message; }
    finally { probeStarting = false; updateConnection(); }
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
  function operationStart(action, arg) {
    if (action === 'vpn_profiles_on') return 'Включаю VPN...';
    if (action === 'vpn_profiles_node') return 'Повторно проверяю узел перед переключением…';
    if (action === 'vpn_profiles_activate') return arg === 'off' ? 'Выключаю VPN...' : 'Применяю профиль; возможен краткий разрыв соединений...';
    return 'Выполняется...';
  }
  function selectionOutput(arg) {
    if (!snapshot.selection || snapshot.selection.tag !== arg) {
      return 'Команда отправлена, но выбор узла не подтверждён. Обновите состояние перед повтором.';
    }
    return 'Переключение на проверенный узел подтверждено.';
  }
  async function request(action, arg, target, extra, saving, savedDrafts) {
    if (busy || (connectionWorking() && !(action === 'vpn_profiles_activate' && arg === 'off'))) return false;
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
      if (!response.ok) throw new Error(httpError + (payload.error ? ': ' + payload.error : ''));
      if (!payload.ok) throw new Error(payload.error || 'Операция отклонена сервером');
      if (!payload.snapshot || !payload.snapshot.data) throw new Error('В ответе сервера отсутствуют данные VPN');
      var previous = JSON.parse(baseline), working = data;
      var freshNodes = new Map(payload.snapshot.nodes.map(function (node) { return [node.tag, node]; }));
      snapshot.nodes.forEach(function (node) {
        var next = freshNodes.get(node.tag);
        if (!next || next.server !== node.server || next.server_port !== node.server_port) nodeResults.delete(node.tag);
      });
      snapshot = payload.snapshot;
      data = JSON.parse(JSON.stringify(snapshot.data)); baseline = JSON.stringify(data);
      if (saving) {
        ['profiles', 'subscriptions'].forEach(function (collection) {
          working[collection].forEach(function (item) {
            if (saving.collection === collection && saving.id === item.id) return;
            var old = previous[collection].find(function (entry) { return entry.id === item.id; });
            if (JSON.stringify(old) !== JSON.stringify(item)) {
              var index = data[collection].findIndex(function (entry) { return entry.id === item.id; });
              if (index < 0) data[collection].push(item);
              else data[collection][index] = item;
            }
          });
        });
        (savedDrafts || []).forEach(function (key) { drafts.delete(key); });
      } else drafts.clear();
      render();
      var output = String(payload.output);
      if (action === 'vpn_profiles_node') output = selectionOutput(arg);
      notice.textContent = payload.output === undefined ? 'Готово' : output;
      if (action === 'vpn_profiles_node') notice.textContent = output;
      if (action === 'vpn_profiles_node' && (!snapshot.selection || snapshot.selection.tag !== arg)) {
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
      updateConnection(); scheduleConnection();
    }
  }
  function saveEntity(collection, item, target, remove) {
    var catalog = JSON.parse(baseline);
    var index = catalog[collection].findIndex(function (entry) { return entry.id === item.id; });
    if (remove) {
      if (index < 0) { data[collection] = data[collection].filter(function (entry) { return entry !== item; }); render(); return; }
      catalog[collection].splice(index, 1);
    } else {
      if (!item.name.trim()) { fail(target, 'Укажите название.'); return; }
      if (collection === 'subscriptions' && !item.urls.length) { fail(target, 'Добавьте адрес зеркала.'); return; }
      if (index < 0) catalog[collection].push(item); else catalog[collection][index] = item;
    }
    return request('vpn_profiles_save', undefined, target, { revision: snapshot.revision, content: JSON.stringify(catalog) },
      { collection: collection, id: item.id });
  }
  function groupName(id) {
    var group = data.subscriptions.find(function (item) { return item.id === id; });
    return group ? group.name : (id === 'loaded' ? 'Загружены из прежней конфигурации' : id);
  }
  function displayName(node) {
    if (node.title && node.title !== node.tag) return node.title;
    var alias = snapshot.data.nodeNames?.[node.tag];
    if (typeof alias === 'string' && alias !== node.tag) return alias;
    var entry = snapshot.nodes.find(function (item) { return item.tag === node.tag; });
    if (entry?.title && entry.title !== node.tag) return entry.title;
    if (snapshot.effective?.tag === node.tag && snapshot.effective.title && snapshot.effective.title !== node.tag) return snapshot.effective.title;
    return 'Узел без названия';
  }
  function nodeLabel(node) { return displayName(node) + ' · ' + groupName(node.subscription); }
  function localGroup(group) {
    return group.urls.length > 0 && group.urls.every(function (url) { return url.startsWith('file:///etc/sing-box/manual-subscriptions/'); });
  }
  // Preserve the stored order; catalog order only determines where unchecked items appear.
  function ordered(parent, title, selected, items, searchable, onEdit) {
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
          if (onEdit) onEdit();
          changed(); draw();
        });
        var label = el('label'); label.append(check, el('span', (index < 0 ? '' : (index + 1) + '. ') + (item ? item[1] : (searchable ? 'Узел вне каталога' : id) + ' (недоступен)')));
        row.append(label);
        [-1, 1].forEach(function (offset) {
          var move = button(offset < 0 ? '\u2191' : '\u2193', function () {
            var other = index + offset;
            selected[index] = selected[other]; selected[other] = id;
            if (onEdit) onEdit();
            changed(); draw();
          }, (offset < 0 ? 'Выше: ' : 'Ниже: ') + (item ? item[1] : searchable ? 'Узел вне каталога' : id));
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
  function editor(parent, name) {
    var node = el('fieldset', undefined, 'vp-editor');
    node.append(el('legend', name)); parent.append(node); return node;
  }
  function disclosure(parent, name, key, build, id) {
    var details = el('details', undefined, 'vp-compact');
    var summary = el('summary', name);
    if (id) {
      details.setAttribute('data-editor-id', id);
      if (!key.startsWith('node:')) summary.title = 'ID: ' + id;
    }
    details.append(summary);
    parent.append(details);
    var loaded = false;
    function toggle() {
      if (!details.open) { expanded.delete(key); return; }
      expanded.add(key);
      if (!loaded) { loaded = true; build(details); }
    }
    details.addEventListener('toggle', toggle);
    details.open = expanded.has(key);
    if (details.open) toggle();
    return details;
  }
  function compactEditor(parent, name, id, kind, build) {
    disclosure(parent, name, kind + ':' + id, function (details) { build(editor(details, name)); }, id);
  }
  function availabilityLevel(check) { return check.ok ? 'good' : check.passed ? 'warn' : 'bad'; }
  function latencyLevel(ms) { return ms <= 300 ? 'good' : ms <= 1000 ? 'warn' : 'bad'; }
  function vpn() {
    var area = section(overview ? 'VPN' : 'Статус');
    var current = snapshot.data.profiles.find(function (profile) { return profile.id === snapshot.active; });
    var serviceStatus = el('p', '', 'vp-status'); area.append(serviceStatus);
    var legacy = snapshot.running && !current;
    if (legacy) area.append(el('p', 'Старое подключение: выберите профиль', 'vp-warning'));
    var profileName = el('p'); area.append(profileName);
    var runtime = el('div'), lastCheck = el('div', undefined, 'vp-last-check'); var summary = el('div', undefined, overview ? 'vp-overview-grid' : undefined);
    summary.append(runtime, lastCheck); area.append(summary);
    var jobStatus = result(area), progress = el('progress'), connectionMessage = result(area);
    progress.setAttribute('aria-label', 'Ход проверки подключения'); area.append(progress);
    var target = result(area);
    if (!overview) {
      var profiles = snapshot.data.profiles.map(function (profile) { return [profile.id, profile.name]; });
      if (!current) profiles.unshift(['', 'Выберите профиль']);
      var selectedProfile = current ? current.id : '';
      var chooser = connectionControl(field(area, 'Профиль', select(profiles, selectedProfile, async function (id) {
        if (!id || !await request('vpn_profiles_activate', id, target)) chooser.value = selectedProfile;
      })));
      var reapply = button(
        'Применить профиль',
        function () {
          if (chooser.value && window.confirm('Применить сохранённые настройки профиля? VPN может кратко прерваться; ручная фиксация узла сбросится.')) {
            request('vpn_profiles_activate', chooser.value, target);
          }
        },
        'Повторно собирает выбранный профиль из сохранённых подписок и правил и применяет его. Возможен краткий разрыв соединений. ' +
          'Подписки не скачивает; ручная фиксация узла сбрасывается.'
      );
      area.append(connectionControl(reapply, !chooser.value));
      chooser.title = 'Выбор профиля применяет его сохранённые настройки и может кратко прервать соединения.';
    }
    var actions = el('div', undefined, 'vp-actions');
    var check = button(
      overview ? 'Проверить текущий узел' : 'Проверить подключение',
      function () { return startConnection('check'); },
      'Два HTTPS-запроса через текущий узел. ' +
        'Узел не переключает, VPN не перезапускает; геолокацию не проверяет.'
    );
    var auto = button(
      overview ? 'Подобрать и включить узел' : 'Автовыбор узла',
      function () { return startConnection('find'); },
      'Разовый поиск рабочего узла профиля с учётом приоритетов и HTTPS-задержки: две успешные HTTPS-попытки. ' +
        'Во время поиска VPN не перезапускается. Если кандидата нет, текущий узел сохраняется. ' +
        'Загрузка новых узлов зависит от настроек автовосстановления.'
    );
    actions.append(check, auto); area.append(actions);
    var power = button('', function () {
      if (snapshot.running) return request('vpn_profiles_activate', 'off', target);
      return request('vpn_profiles_on', undefined, target);
    });
    area.append(power);
    drawConnection = function () {
      var connection = snapshot.connection, job = connection && connection.job, latest = connection && connection.lastCheck;
      current = snapshot.data.profiles.find(function (profile) { return profile.id === snapshot.active; });
      profileName.textContent = current ? 'Профиль: ' + current.name : '';
      profileName.hidden = !current;
      serviceStatus.textContent = snapshot.running ? 'Сервис VPN запущен' : 'VPN выключен';
      serviceStatus.className = 'vp-status ' + (snapshot.running ? 'vp-info' : 'vp-muted');
      var stale = !snapshot.running || !latest || latest.profile !== snapshot.active || !snapshot.effective || latest.node !== snapshot.effective.tag;
      var healthColor = stale ? 'vp-muted' : 'vp-metric-' + availabilityLevel(latest);
      runtime.replaceChildren(); lastCheck.replaceChildren();
      if (snapshot.effective) {
        var effective = snapshot.effective, delay = effective.delay_ms === undefined ? effective.delay : effective.delay_ms;
        var health = !snapshot.running ? 'VPN выключен' : stale ? 'Доступность не проверена' :
          latest.ok ? 'Доступен' : latest.passed ? 'Нестабильно' : 'Недоступен';
        runtime.append(el('p', 'Текущий узел: ' + displayName(effective) + (effective.type ? ' · ' + effective.type : '') +
          ' · ' + health, 'vp-status ' + healthColor));
        if (delay !== undefined && delay !== null) runtime.append(el('p', 'Задержка: ' + delay + ' мс', snapshot.running ? 'vp-metric-' + latencyLevel(delay) : 'vp-muted'));
      }
      runtime.append(el('p', 'Автовосстановление ' + (connection && connection.settings.enabled ? 'включено' : 'выключено'), connection && connection.settings.enabled ? 'vp-info' : 'vp-muted'));
      if (!latest) lastCheck.append(el('p', 'Последняя проверка: ещё не выполнялась', 'vp-muted'));
      else {
        lastCheck.append(el('p', 'Последняя проверка: ' + new Date(latest.time * 1000).toLocaleString()));
        lastCheck.append(el('p', (latest.ok ? 'HTTPS доступен' : latest.passed ? 'Нестабильно' : 'HTTPS недоступен') + ' · ' + latest.passed + '/' + latest.attempts +
          (latest.latency_ms === null ? '' : ' · ' + latest.latency_ms + ' мс') + (latest.http_code ? ' · HTTP ' + latest.http_code : ''), healthColor));
        if (stale) {
          var previousProfile = snapshot.data.profiles.find(function (item) { return item.id === latest.profile; });
          lastCheck.append(el('p', 'Проверялся узел: ' + displayName({ tag: latest.node }) + (previousProfile ? ' · ' + previousProfile.name : '')));
        }
        if (latest.reason) lastCheck.append(el('p', latest.reason));
        if (stale) lastCheck.append(el('p', 'Устарело: проверка не относится к текущему подключению', 'vp-warning'));
      }
      var state = job && { running: 'Выполняется', done: 'Завершено', failed: 'Не удалось завершить' }[job.state];
      jobStatus.textContent = connectionStarting ? 'Запуск операции...' : job ? state +
        (job.total ? ' · проверено ' + job.done + '/' + job.total : '') + (job.message ? '\n' + job.message : '') +
        (job.selected && job.selected.tag !== snapshot.effective?.tag ? '\nВыбран: ' + displayName(job.selected) +
          (job.selected.latency_ms === null ? '' : ' · ' + job.selected.latency_ms + ' мс') : '') + (job.error ? '\n' + job.error : '') : '';
      jobStatus.className = 'vp-result';
      if (connectionStarting || (job && job.state === 'running')) jobStatus.className += ' vp-pending vp-info';
      else if (job && job.state === 'failed') jobStatus.className += ' vp-error';
      else if (job && job.selected) jobStatus.className += ' vp-metric-good';
      else if (job && job.kind === 'find') jobStatus.className += ' vp-warning';
      progress.hidden = !job || job.state !== 'running' || !job.total;
      progress.max = job ? job.total || 1 : 1; progress.value = job ? job.done : 0;
      power.textContent = snapshot.running ? 'Выключить VPN' : 'Включить VPN';
      power.disabled = busy || (!snapshot.running && (connectionWorking() || (snapshot.managed && !current)));
      connectionMessage.textContent = connectionError;
      if (connectionError) connectionMessage.classList.add('vp-error');
      check.disabled = auto.disabled = busy || connectionWorking() || probing() || !snapshot.running || !current;
    };
    if (overview) {
      var settingsLink = el('a', 'Настройки VPN'); settingsLink.href = '?tab=vpn';
      area.append(settingsLink); return;
    }
    recoverySettings(area);
    if (current && snapshot.running) disclosure(area, 'Подбор узла профиля «' + current.name + '»', 'status-nodes', function (details) {
      details.append(el('p', 'Сравните узлы профиля. После успешной проверки можно отдельно переключить VPN на выбранный узел.'));
      nodeList(details, allowedNodes(current), current);
    });
  }
  function recoverySettings(area) {
    var connection = snapshot.connection || { revision: '', settings: connectionDefaults };
    var settings = drafts.has('__connection') ? JSON.parse(drafts.get('__connection')) : Object.assign({}, connection.settings);
    var details = el('details', undefined, 'vp-compact vp-recovery'); details.append(el('summary', 'Автовосстановление')); area.append(details);
    details.open = expanded.has('connection');
    details.addEventListener('toggle', function () { if (details.open) expanded.add('connection'); else expanded.delete('connection'); });
    function modified() {
      var saved = snapshot.connection ? snapshot.connection.settings : connectionDefaults;
      if (JSON.stringify(settings) === JSON.stringify(saved)) drafts.delete('__connection');
      else drafts.set('__connection', JSON.stringify(settings));
      changed();
    }
    function checkbox(label, key, title) {
      var node = el('input'); node.type = 'checkbox'; node.checked = settings[key];
      node.addEventListener('change', function () { settings[key] = node.checked; modified(); });
      var wrapper = el('label', undefined, 'vp-checkbox'); wrapper.title = title; wrapper.append(node, el('span', label)); details.append(wrapper);
      connectionControl(node);
    }
    checkbox(
      'Включить автовосстановление',
      'enabled',
      'Периодически проверяет текущий узел. Только после нескольких отказов подряд при исправном WAN запускает конечный поиск замены. ' +
        'Повторные проверки отказа разнесены на 5 секунд; во время поиска VPN не перезапускается. Если замены нет, текущий узел сохраняется.'
    );
    var grid = el('div', undefined, 'vp-recovery-grid'); details.append(grid);
    [['Интервал, мин', 'interval_minutes', 1, 1440], ['Отказов подряд', 'failures', 2, 10]].forEach(function (item) {
      var control = field(grid, item[0], input(settings[item[1]], function (value) { settings[item[1]] = Number(value); modified(); }));
      control.type = 'number'; control.min = item[2]; control.max = item[3]; control.step = 1; connectionControl(control);
    });
    var targets = snapshot.testTargets ? snapshot.testTargets.items : defaultTargets;
    var options = targets.map(function (item) { return [item.id, item.name]; });
    if (!targets.some(function (item) { return item.id === settings.target; })) {
      options.unshift([settings.target, 'Ресурс удалён: ' + settings.target]);
    }
    connectionControl(field(grid, 'Ресурс проверки', select(options, settings.target, function (value) { settings.target = value; modified(); })));
    checkbox('Обновить подписки, если узел не найден', 'refresh_on_failure',
      'После неудачного поиска обновляет кэш подписок. Само обновление не переключает текущий узел.');
    checkbox('Разрешить загрузку новых узлов (краткий перезапуск)', 'allow_reload',
      'Разрешает загрузить найденные новые узлы в рабочую конфигурацию с кратким перезапуском. Во время самого поиска перезапуска нет.');
    var message = result(details);
    details.append(command('Сохранить автовосстановление', async function () {
      if (busy || connectionWorking()) return;
      if (!Number.isInteger(settings.interval_minutes) || settings.interval_minutes < 1 || settings.interval_minutes > 1440 ||
          !Number.isInteger(settings.failures) || settings.failures < 2 || settings.failures > 10 ||
          !targets.some(function (item) { return item.id === settings.target; })) {
        fail(message, 'Интервал: 1–1440 минут; отказов подряд: 2–10. Выберите существующий ресурс.'); return;
      }
      connectionSaving = true; message.classList.remove('vp-error'); message.textContent = 'Сохранение...'; updateConnection();
      var content = JSON.stringify(settings);
      try {
        snapshot.connection = readConnection(await probeRequest('vpn_profiles_connection_save', { revision: connection.revision, content: content }));
        connection = snapshot.connection;
        if (drafts.get('__connection') === content) drafts.delete('__connection');
        message.textContent = 'Автовосстановление сохранено';
      } catch (error) { fail(message, error.message); }
      finally { connectionSaving = false; updateConnection(); scheduleConnection(); }
    }));
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
      disclosure(group, 'Группы и узлы', 'profile-groups:' + profile.id, function (details) {
        var savedGroups = new Set(snapshot.data.subscriptions.map(function (item) { return item.id; }));
        ordered(details, 'Группы узлов по приоритету', profile.subscriptions, data.subscriptions.filter(function (item) {
          return savedGroups.has(item.id);
        }).map(function (item) { return [item.id, item.name]; }));
        details.append(el('p', 'Выбранная группа включает все её узлы. Дополнительные узлы можно выбрать отдельно, по названию и группе.'));
        ordered(
          details,
          'Дополнительные узлы по приоритету',
          profile.nodes,
          snapshot.nodes.filter(function (item) {
            return item.subscription !== 'loaded' || profile.nodes.includes(item.tag);
          }).map(function (item) { return [item.tag, nodeLabel(item)]; }),
          true
        );
      });
      disclosure(group, 'Правила', 'profile-rules:' + profile.id, function (details) {
        ordered(details, 'Правила по приоритету', profile.rules, snapshot.rules.map(function (item) { return [item.id, item.name || item.id]; }));
      });
      field(group, 'Остальной трафик', select([['direct', 'Напрямую'], ['vpn-out', 'Через VPN']], profile.final, function (value) {
        profile.final = value; changed();
      }));
      field(group, 'Предпочтение страны', select([['ru', 'Россия'], ['non-ru', 'Не Россия'], ['any', 'Любая']], profile.preference, function (value) {
        profile.preference = value; changed();
      }));
      var output = result(group);
      group.append(command('Сохранить профиль', function () { return saveEntity('profiles', profile, output); }),
        command('Удалить профиль', function () {
          if (window.confirm('Удалить профиль «' + profile.name + '»?')) return saveEntity('profiles', profile, output, true);
        }));
      });
    });
  }
  function linkKind(value) {
    if (/\s/.test(value)) return '';
    if (/^(vless|hy2|hysteria2):\/\/.+/i.test(value)) return 'node';
    if (/^https?:\/\/[^/?#]/i.test(value)) {
      try { if (new URL(value).hostname) return 'subscription'; } catch (_) {}
    }
    return '';
  }
  function qrField(parent, receive) {
    var file = field(parent, 'Изображение с QR-кодом', el('input'));
    file.type = 'file'; file.accept = 'image/*';
    var message = result(parent);
    file.addEventListener('change', async function () {
      var selected = file.files[0];
      if (!selected) return;
      file.disabled = true;
      var url = URL.createObjectURL(selected);
      try {
        message.classList.remove('vp-error');
        message.textContent = 'Чтение QR-кода…';
        var image = new Image();
        image.src = url;
        await Promise.all([image.decode(), import('/jsQR-1.4.0.js')]);
        var scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
        var canvas = el('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        var context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR(pixels.data, pixels.width, pixels.height);
        if (!code) { fail(message, 'QR-код не найден. Выберите более чёткое изображение.'); return; }
        if (!file.isConnected) return;
        var error = receive(code.data.trim());
        if (error) fail(message, error);
        else message.textContent = 'Ссылка из QR-кода добавлена в форму.';
      } catch (_) { fail(message, 'Не удалось прочитать изображение. Выберите другой файл или вставьте ссылку.'); }
      finally { URL.revokeObjectURL(url); file.value = ''; file.disabled = false; }
    });
  }
  function newSubscription(url, name) {
    var id = nextId('source', data.subscriptions);
    expanded.add('source:' + id);
    data.subscriptions.push({ id: id, name: name || 'Новая подписка', urls: url ? [url] : [] });
    view = 'Subscriptions'; render();
    var card = panel.querySelectorAll('details');
    var created = Array.from(card).find(function (item) { return item.getAttribute('data-editor-id') === id; });
    if (created) created.querySelector('input').focus();
  }
  function subscriptions() {
    var area = section('Группы узлов'), target = result(area);
    area.append(el('p', 'Группа получает узлы из подписки или содержит узлы, добавленные вручную. Зеркала одной подписки проверяются по порядку.'));
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
      newSubscription();
    }), command('Обновить все', function () { request('vpn_profiles_update', 'all', target); }));
    data.subscriptions.forEach(function (subscription) {
      var local = localGroup(subscription);
      var heading = subscription.name + (local ? ' · Ручная группа' : ' · Подписка');
      compactEditor(area, heading, subscription.id, 'source', function (group) {
      field(group, 'Название группы', input(subscription.name, function (value) { subscription.name = value; }));
      if (!local) {
        var mirrors = field(group, 'Зеркала по приоритету', input(subscription.urls.join('\n'), function (value) {
          subscription.urls = value.split(/\r?\n/).map(function (url) { return url.trim(); }).filter(Boolean);
        }, true));
        qrField(group, function (value) {
          if (linkKind(value) === 'node') return 'Это отдельный узел. Откройте «Узлы» → «Добавить узел».';
          if (linkKind(value) !== 'subscription') return 'Нужна HTTP(S)-ссылка подписки.';
          if (!subscription.urls.includes(value)) subscription.urls.push(value);
          mirrors.value = subscription.urls.join('\n'); changed();
        });
      }
      var priority = subscription.priority || [];
      ordered(group, 'Приоритет узлов внутри группы', priority, snapshot.nodes.filter(function (node) {
        return node.subscription === subscription.id;
      }).map(function (node) { return [node.tag, displayName(node)]; }), true, function () { subscription.priority = priority; });
      var output = result(group);
      group.append(command(local ? 'Сохранить группу' : 'Сохранить подписку', function () {
        if (subscription.urls.some(function (url) { return linkKind(url) === 'node'; })) {
          fail(output, 'В зеркалах есть ссылка на узел. Добавьте её в разделе «Узлы».'); return;
        }
        return saveEntity('subscriptions', subscription, output);
      }));
      group.append(command('Обновить', function () { request('vpn_profiles_update', subscription.id, output); }));
      group.append(button('Удалить подписку', function () {
        var nodeTags = snapshot.nodes.filter(function (node) { return node.subscription === subscription.id; }).map(function (node) { return node.tag; });
        if (data.profiles.some(function (profile) {
          return profile.subscriptions.includes(subscription.id) || profile.nodes.some(function (tag) { return nodeTags.includes(tag); });
        })) {
          fail(output, 'Подписка используется в профилях. Сначала уберите ее из профилей.'); return;
        }
        if (window.confirm('Удалить подписку «' + subscription.name + '»?')) {
          return saveEntity('subscriptions', subscription, output, true);
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
      } else ruleFields(rule, true, editor(area, 'Новое правило'));
    }
    function ruleFields(rule, fresh, group) {
      var id = rule.id;
      if (fresh) field(group, 'ID правила', input(id, function (value) {
        id = value; drafts.set('__new_id', value); if (!value) drafts.delete('__new_id');
      }));
      var key = fresh ? '__new_content' : rule.id;
      var nameKey = 'rule-name:' + (fresh ? 'new' : rule.id);
      var name = field(group, 'Название правила', input(drafts.get(nameKey) ?? rule.name ?? '', function (value) {
        if (value === (rule.name || '')) drafts.delete(nameKey); else drafts.set(nameKey, value);
      }));
      var content = field(group, 'Содержимое правила', input(drafts.has(key) ? drafts.get(key) : rule.content, function (value) {
        if (value === rule.content) drafts.delete(key); else drafts.set(key, value);
      }, true));
      var output = result(group);
      group.append(command('Сохранить правило', function () {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) { fail(output, 'ID: строчные латинские буквы, цифры, дефис и подчеркивание.'); return; }
        if (fresh && snapshot.rules.some(function (item) { return item.id === id; })) { fail(output, 'Такой ID уже существует.'); return; }
        var title = name.value.trim() || id;
        if (title.length > 160 || /[\x00-\x1f\x7f]/.test(title)) { fail(output, 'Название должно быть одной строкой до 160 символов.'); return; }
        var body = title === id ? content.value : '# profile-name: ' + title + '\n' + content.value;
        return request(
          'vpn_profiles_rule_save',
          id,
          output,
          { revision: fresh ? 'new' : rule.revision, content: body },
          true,
          fresh ? ['__new_id', '__new_content', nameKey] : [key, nameKey]
        );
      }));
      if (!fresh) group.append(command('Удалить правило', function () {
        var referenced = data.profiles.concat(snapshot.data.profiles).some(function (profile) { return profile.rules.includes(id); });
        if (referenced) { fail(output, 'Правило используется в профилях. Сначала уберите его из профилей и сохраните.'); return; }
        if (window.confirm('Удалить правило «' + id + '»?')) {
          request('vpn_profiles_rule_delete', id, output, { revision: rule.revision }, true, [key, nameKey]);
        }
      }));
    }
    snapshot.rules.forEach(function (rule) { ruleEditor(rule, false); });
    ruleEditor({ id: drafts.get('__new_id') || '', content: '' }, true);
  }
  function nodes() {
    var area = section('Узлы');
    var importer = el('details', undefined, 'vp-compact vp-import');
    importer.append(el('summary', 'Добавить узел')); area.append(importer);
    importer.open = expanded.has('node-import');
    importer.addEventListener('toggle', function () { if (importer.open) expanded.add('node-import'); else expanded.delete('node-import'); });
    importer.append(el('p', 'Для узла будет создана ручная группа. Её можно добавить в профиль целиком.'));
    var nodeName = field(importer, 'Название', input(drafts.get('__node_name') || '', function (value) {
      if (value) drafts.set('__node_name', value); else drafts.delete('__node_name');
    }));
    var uri = field(importer, 'Ссылка на узел или подписку', input(drafts.get('__node_uri') || '', function (value) {
      if (value) drafts.set('__node_uri', value); else drafts.delete('__node_uri');
      updateImport();
    }, true));
    uri.rows = 3; uri.autocomplete = 'off'; uri.spellcheck = false;
    var importResult = result(importer);
    qrField(importer, function (value) {
      if (!linkKind(value)) return 'QR-код должен содержать ссылку VLESS, Hysteria2 или HTTP(S).';
      uri.value = value; drafts.set('__node_uri', value); changed(); updateImport();
    });
    function updateImport() {
      var subscription = linkKind(uri.value.trim()) === 'subscription';
      submit.textContent = subscription ? 'Продолжить в подписках' : 'Добавить узел';
      importResult.classList.remove('vp-error');
      importResult.textContent = subscription ? 'Это ссылка на подписку. Проверьте название и сохраните её в разделе «Группы узлов».': '';
    }
    var submit = command('Добавить узел', function () {
      if (linkKind(uri.value.trim()) === 'subscription') {
        drafts.delete('__node_name'); drafts.delete('__node_uri');
        newSubscription(uri.value.trim(), nodeName.value.trim()); return;
      }
      if (linkKind(uri.value.trim()) !== 'node') {
        fail(importResult, 'Нужна ссылка VLESS, Hysteria2 или HTTP(S)-ссылка подписки.'); return;
      }
      if (!nodeName.value.trim()) { fail(importResult, 'Укажите название узла.'); return; }
      request(
        'vpn_profiles_node_import',
        nodeName.value.trim(),
        importResult,
        { content: uri.value.trim(), revision: snapshot.revision },
        true,
        ['__node_name', '__node_uri']
      );
    });
    importer.append(submit); updateImport();
    nodeList(area, snapshot.nodes);
  }
  function nodeList(area, candidates, profile) {
    var query = '', sourceId = '', page = 0;
    var search = field(area, 'Поиск узлов', input('', function (value) { query = value.toLocaleLowerCase(); page = 0; draw(); }));
    search.type = 'search';
    field(area, 'Группа', select([['', 'Все группы']].concat(data.subscriptions.filter(function (item) {
      return !profile || candidates.some(function (node) { return node.subscription === item.id; });
    }).map(function (item) {
      return [item.id, item.name];
    })), '', function (value) { sourceId = value; page = 0; draw(); }));
    var tests = el('details', undefined, 'vp-compact vp-tests'); area.append(tests);
    tests.append(el('summary', 'HTTPS-тесты'));
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
      if (targetSaving || busy || connectionWorking()) return;
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
    targetActions.append(connectionControl(targetSave));
    var targetURLs = el('details', undefined, 'vp-compact');
    targetURLs.append(el('summary', 'URL проверки')); tests.append(targetURLs);
    var urls = el('div'); targetURLs.append(urls);
    var testActions = el('div', undefined, 'vp-test-pair');
    var sort = 'catalog', visibleTags = [];
    field(area, 'Сортировка узлов', select([
      ['catalog', 'Порядок каталога'], ['name', 'По имени (А–Я)'], ['speed_mbps', 'По скорости (быстрые сначала)'],
      ['latency_ms', 'По задержке (меньшая сначала)']
    ], sort, function (value) { sort = value; page = 0; draw(); }));
    function filteredNodes() {
      var matches = candidates.filter(function (node) {
        return (!sourceId || node.subscription === sourceId) && [node.title, node.tag, node.type].join(' ').toLocaleLowerCase().includes(query);
      });
      if (sort === 'name') matches.sort(function (a, b) { return displayName(a).localeCompare(displayName(b), 'ru', { numeric: true }); });
      if (sort === 'latency_ms' || sort === 'speed_mbps') matches.sort(function (a, b) {
        var left = nodeResults.get(a.tag)?.item[sort], right = nodeResults.get(b.tag)?.item[sort];
        if (left == null || right == null) return Number(left == null) - Number(right == null);
        return sort === 'latency_ms' ? left - right : right - left;
      });
      return matches;
    }
    function batch(speed) {
      var matches = filteredNodes();
      return startProbe(matches.slice(0, 60).map(function (node) { return node.tag; }), speed, matches.length);
    }
    tests.append(el('p', 'Быстрый тест делает два HTTPS-запроса. Тест скорости дополнительно скачивает до 2 МиБ через каждый узел с результатом 2/2.'), testActions);
    var quick = button('Быстрый тест', function () { return batch(false); });
    var speed = button('Тест скорости', function () { return batch(true); }); testActions.append(quick, speed);
    var probeStatus = result(tests), progress = el('progress'), drawNodes = new Map();
    progress.setAttribute('aria-label', 'Прогресс HTTPS-теста'); tests.append(progress);
    function jobStatus(status, text) {
      var message = [text, probeError, probeJob && probeJob.error].filter(Boolean).join('\n');
      if (status.textContent !== message) status.textContent = message;
      status.classList.remove('vp-error');
      if (probeError || probeJob && probeJob.state === 'failed') status.classList.add('vp-error');
    }
    drawProbe = function () {
      var matches = filteredNodes(), active = probing(), blocked = active || busy || connectionWorking();
      if (!active && (sort === 'latency_ms' || sort === 'speed_mbps') &&
          matches.slice(page * 30, (page + 1) * 30).some(function (node, i) { return node.tag !== visibleTags[i]; })) { draw(); return; }
      var scope = matches.length > 60 ? 'первые 60 из ' + matches.length : 'все (' + matches.length + ')';
      if (query || sourceId) scope += ' по фильтру';
      quick.textContent = 'Быстрый тест · ' + scope;
      speed.textContent = 'Тест скорости · ' + scope;
      quick.disabled = speed.disabled = blocked || !matches.length || !targetId;
      targetSelect.disabled = blocked;
      summaries.forEach(function (update) { update(); });
      drawNodes.forEach(function (drawNode) { drawNode(); });
      urls.replaceChildren();
      targets.items.forEach(function (item) { urls.append(el('p', item.name + ' · HTTP ' + item.status), el('code', item.url)); });
      urls.append(el('p', 'Скорость · Cloudflare · 2 MiB'), el('code', 'https://speed.cloudflare.com/__down?bytes=2097152'));
      // Keep the list in place when an individual check starts below the batch controls.
      if (probeNode !== null && probeStatus.textContent) return;
      var batchJob = probeNode === null ? probeJob : null;
      var text = probeNode === null && probeStarting ? 'Запуск...' : batchJob ?
        ({ running: 'Проверка', done: 'Готово', failed: 'Ошибка задания' })[batchJob.state] + ': ' + batchJob.done + '/' + batchJob.total :
        'Найдено: ' + matches.length + '. К тесту: ' + Math.min(60, matches.length) + ' (максимум 60).';
      if (batchJob) text += '\n' + probeNote + (batchJob.target ? ' · ' + batchJob.target.name : '');
      if (batchJob && batchJob.state === 'running' && batchJob.phase === 'speed') {
        text += '\nЗамер скорости: ' + batchJob.results.filter(function (item) { return item.speed_bytes != null; }).length + '/' +
          batchJob.results.filter(function (item) { return item.ok; }).length;
      }
      if (batchJob && batchJob.results.length) text += '\nРезультаты в карточках узлов.';
      if (probeNode === null) jobStatus(probeStatus, text);
      else probeStatus.textContent = text;
      progress.hidden = probeNode !== null || !active;
      progress.max = batchJob ? batchJob.total : 1; progress.value = batchJob ? batchJob.done : 0;
    };
    var summaries = new Map();
    var list = el('div'), pages = el('div', undefined, 'vp-actions'); area.append(list, pages);
    function draw() {
      list.replaceChildren();
      drawNodes.clear(); summaries.clear();
      var matches = filteredNodes();
      if (!matches.length) list.append(el('p', 'Узлы не найдены'));
      var visible = matches.slice(page * 30, (page + 1) * 30);
      visibleTags = visible.map(function (node) { return node.tag; });
      visible.forEach(function (node) {
        var row = disclosure(list, undefined, 'node:' + node.tag, function (details) {
          var group = el('div', undefined, 'vp-node-body'); details.append(group);
          var check = button('Быстрый тест', function () { return startProbe([node.tag], false, 1, node.tag); });
          var speedCheck = button('Тест скорости', function () { return startProbe([node.tag], true, 1, node.tag); });
          var actions = el('div', undefined, 'vp-test-pair'); actions.append(check, speedCheck); group.append(actions);
          var status = result(group), measurement = result(group);
          var apply;
          function canApply() {
            var last = nodeResults.get(node.tag);
            return !check.disabled && snapshot.active === profile.id && snapshot.running && snapshot.effective?.tag !== node.tag &&
              last?.item.ok && last.job && last.started >= Date.now() / 1000 - 300;
          }
          if (profile && node.selectable) {
            apply = button('Переключить VPN на этот узел', function () {
              if (!canApply()) { fail(status, 'Сначала повторите быстрый тест этого узла.'); return; }
              return request('vpn_profiles_node', node.tag, status, { content: nodeResults.get(node.tag).job, profile: profile.id, revision: snapshot.revision });
            });
            group.append(apply);
            group.append(el('p', 'Для переключения нужны две успешные HTTPS-попытки за последние пять минут. Перед переключением роутер проверит узел ещё раз.'));
          } else if (profile) group.append(el('p', 'Узел есть в профиле, но ещё не загружен в рабочую конфигурацию.'));
          function drawNode() {
            check.disabled = speedCheck.disabled = probing() || busy || connectionWorking() || !targetId;
            if (apply) apply.disabled = !canApply();
            if (probeNode === node.tag) {
              jobStatus(status, probeStarting ? 'Запуск проверки…' : probing() ? (probeJob.phase === 'speed' ? 'Замер скорости…' : 'Проверка HTTPS…') :
                probeJob && probeJob.state === 'failed' ? 'Ошибка проверки' : '');
            } else {
              status.textContent = '';
            }
            var last = nodeResults.get(node.tag);
            if (!last) return;
            var item = last.item;
            var text = (last.target ? last.target.name + ' · ' : '') +
              (item.ok ? 'Доступен' : item.passed ? 'Нестабильно' : 'Недоступен') + ' · ' + item.passed + '/' + item.attempts;
            if (item.http_code) text += ' · HTTP ' + item.http_code;
            if (item.latency_ms != null) text += ' · ' + item.latency_ms + ' мс';
            if (item.speed_mbps != null) text += ' · ' + item.speed_mbps + ' Мбит/с';
            if (item.error) text += '\n' + item.error;
            if (item.speed_error) text += '\nОшибка замера скорости: ' + item.speed_error;
            if (measurement.textContent !== text) measurement.textContent = text;
          }
          drawNodes.set(node.tag, drawNode);
          drawNode();
          if (profile) return;
          var fields = editor(group, 'Редактировать узел');
          var key = 'node-name:' + node.tag, hostKey = 'node-host:' + node.tag, portKey = 'node-port:' + node.tag;
          var name = field(fields, 'Название узла', input(drafts.get(key) ?? displayName(node), function (value) {
            if (value === displayName(node)) drafts.delete(key); else drafts.set(key, value);
          }));
          function endpointField(label, draftKey, value) {
            return field(fields, label, input(drafts.get(draftKey) ?? value, function (next) {
              if (next === value) drafts.delete(draftKey); else drafts.set(draftKey, next);
            }));
          }
          var host = endpointField('IP-адрес или домен', hostKey, node.server || '');
          var port = endpointField('Порт', portKey, String(node.server_port ?? ''));
          port.type = 'number'; port.min = 1; port.max = 65535;
          if (node.endpointPending) fields.append(el('p', 'Работающий VPN использует прежний адрес. Для перехода примените профиль.', 'vp-warning'));
          if (node.sourceServer && (node.sourceServer !== node.server || node.sourcePort !== node.server_port)) fields.append(button('Вернуть исходный адрес и порт', function () {
            host.value = node.sourceServer; port.value = String(node.sourcePort);
            drafts.set(hostKey, host.value); drafts.set(portKey, port.value); changed();
          }));
          var output = result(fields);
          fields.append(command('Сохранить узел', function () {
            if (probing()) { fail(output, 'Дождитесь окончания проверки узлов.'); return; }
            var server = host.value.trim(), number = Number(port.value);
            if (/^\[[0-9a-f:.]+\]$/i.test(server)) server = server.slice(1, -1);
            if (!server || /[^a-z0-9.:-]/i.test(server) || !/^\d{1,5}$/.test(port.value) || number < 1 || number > 65535) {
              fail(output, 'Укажите IP-адрес или доменное имя и порт от 1 до 65535.'); return;
            }
            var title = name.value.trim();
            if (!title || title.length > 160) { fail(output, 'Укажите название до 160 символов.'); return; }
            var catalog = JSON.parse(baseline);
            catalog.nodeNames = Object.assign(Object.create(null), catalog.nodeNames);
            catalog.nodeNames[node.tag] = title;
            if (server !== node.server || number !== node.server_port) {
              catalog.nodeEndpoints = Object.assign(Object.create(null), catalog.nodeEndpoints);
              catalog.nodeEndpoints[node.tag] = { server: server, server_port: number };
            }
            return request('vpn_profiles_save', undefined, output, { revision: snapshot.revision, content: JSON.stringify(catalog) }, true, [key, hostKey, portKey]);
          }));
        }, node.tag);
        row.classList.add('vp-node');
        row.children[0].append(el('strong', displayName(node)),
          el('span', node.type + ' · ' + groupName(node.subscription), 'vp-node-source'));
        var summary = el('span', undefined, 'vp-measurements'); row.children[0].append(summary);
        summary.title = 'Последние замеры. Задержка: до 300 мс — низкая, свыше 1000 мс — высокая. Скорость: менее 5 Мбит/с — низкая, от 20 Мбит/с — высокая.';
        var rendered;
        summaries.set(node.tag, function () {
          var last = nodeResults.get(node.tag);
          if (!last || last === rendered) return;
          rendered = last;
          var item = last.item;
          summary.replaceChildren();
          function metric(text, level) { summary.append(el('span', text, 'vp-metric-' + level)); }
          metric((item.ok ? 'Доступен' : item.passed ? 'Нестабильно' : 'Недоступен') + ' · ' + item.passed + '/2', availabilityLevel(item));
          if (item.latency_ms != null) metric(item.latency_ms + ' мс', latencyLevel(item.latency_ms));
          if (item.speed_error) metric('Сбой замера скорости', 'bad');
          else if (item.speed_mbps != null) metric(item.speed_mbps + ' Мбит/с', item.speed_mbps >= 20 ? 'good' : item.speed_mbps >= 5 ? 'warn' : 'bad');
        });
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
  var saveState, notice, panel;
  function render() {
    drawProbe = null; drawConnection = null; connectionControls = [];
    root.replaceChildren();
    var nav = el('nav', undefined, 'vp-nav'); nav.setAttribute('aria-label', 'VPN');
    [
      ['VPN', 'Статус', 'Текущее подключение, последняя проверка, разовый поиск узла и автовосстановление.'],
      ['Profiles', 'Профили', 'Состав профилей: подписки, узлы, правила и приоритеты. Сохранение не применяет профиль автоматически.'],
      ['Subscriptions', 'Группы узлов', 'Редактирование источников и обновление кэша узлов без разрыва текущего подключения.'],
      ['Rules', 'Правила', 'Редактирование наборов маршрутизации. Для применения сохранённых изменений нужно применить профиль.'],
      ['Nodes', 'Узлы', 'Поиск, независимые HTTPS-тесты и замер скорости. Тесты не переключают текущий узел.']
    ].forEach(function (item) {
      var link = button(item[1], function () { view = item[0]; render(); }, item[2]);
      if (view === item[0]) link.setAttribute('aria-current', 'page'); nav.append(link);
    });
    var refresh = command('Обновить', function () { request('vpn_profiles_snapshot', undefined, notice); },
      'Перечитывает состояние роутера и фактический выбор sing-box. Не применяет профиль, не тестирует интернет и не перезапускает VPN. Несохранённые правки потребуют подтверждения перед сбросом.');
    refresh.setAttribute('aria-label', 'Обновить состояние'); nav.append(refresh);
    if (!overview) root.append(nav);
    var toolbar = el('div', undefined, 'vp-save');
    saveState = el('span'); toolbar.append(saveState);
    if (view !== 'VPN') root.append(toolbar);
    notice = result(root); panel = el('div'); root.append(panel);
    ({ VPN: vpn, Profiles: profiles, Subscriptions: subscriptions, Rules: rules, Nodes: nodes })[view]();
    updateConnection();
    scheduleConnection();
  }
  window.addEventListener('beforeunload', function (event) {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  render();
  scheduleConnection();
}());
