(function () {
  'use strict';
  function parseSubscriptions(text) {
    var model = { preamble: [], groups: [] }, current;
    text.replace(/\r/g, '').split('\n').forEach(function (line) {
      var match = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
      if (match) {
        current = { name: match[1], comment: match[2] || '', lines: [] };
        model.groups.push(current);
      } else if (current) current.lines.push(line);
      else model.preamble.push(line);
    });
    return model;
  }
  function serializeSubscriptions(model) {
    var lines = model.preamble.slice();
    model.groups.forEach(function (group) {
      lines.push('[' + group.name + ']' + (group.comment ? ' ' + group.comment : ''));
      lines.push.apply(lines, group.lines);
    });
    return lines.join('\n').replace(/\n*$/, '\n');
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parse: parseSubscriptions, serialize: serializeSubscriptions };
    return;
  }
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  document.querySelectorAll('.subscription-form').forEach(function (form) {
    var source = form.querySelector('[name=content]');
    var model = parseSubscriptions(source.value);
    if (model.preamble.some(function (line) { return /^\s*(https?:|file:)/.test(line); })) return;
    var groups = element('div', 'subscription-groups');
    var state = form.querySelector('[data-save-state]');
    var add = element('button', 'secondary', 'Добавить подписку');
    var undo = element('button', 'secondary', 'Вернуть удаленную подписку');
    var deleted;
    add.type = undo.type = 'button';
    undo.hidden = true;
    source.closest('details').before(groups, add, undo);
    function changed() {
      form.dataset.dirty = '1';
      state.textContent = 'Есть несохраненные изменения';
      source.value = serializeSubscriptions(model);
    }
    function icon(symbol, label, callback, disabled) {
      var button = element('button', 'icon-button secondary', symbol);
      button.type = 'button'; button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = !!disabled;
      button.addEventListener('click', callback);
      return button;
    }
    function render() {
      groups.replaceChildren();
      model.groups.forEach(function (group, index) {
        var section = element('section', 'subscription-group');
        var header = element('div', 'subscription-heading');
        var tools = element('div', 'subscription-tools');
        header.append(element('strong', '', 'Приоритет ' + (index + 1)), tools);
        function move(offset) {
          var other = index + offset;
          model.groups[index] = model.groups[other]; model.groups[other] = group;
          changed(); render();
        }
        tools.append(icon('↑', 'Повысить приоритет ' + group.name, function () { move(-1); }, index === 0));
        tools.append(icon('↓', 'Понизить приоритет ' + group.name, function () { move(1); }, index === model.groups.length - 1));
        tools.append(icon('×', 'Удалить подписку ' + group.name, function () {
          deleted = { group: group, index: index };
          model.groups.splice(index, 1); undo.hidden = false; changed(); render();
        }));
        var nameLabel = element('label', '', 'Название');
        var name = element('input'); name.value = group.name;
        name.required = true; name.pattern = '[A-Za-z0-9_.-]+'; name.maxLength = 80;
        name.autocapitalize = 'none'; name.spellcheck = false;
        name.addEventListener('input', function () { group.name = name.value; changed(); });
        nameLabel.append(name);
        var urlsLabel = element('label', '', 'Адреса зеркал');
        var urls = element('textarea', 'mirror-urls'); urls.value = group.lines.join('\n');
        urls.required = true; urls.spellcheck = false; urls.autocapitalize = 'none';
        urls.addEventListener('input', function () { group.lines = urls.value.split('\n'); changed(); });
        urlsLabel.append(urls);
        section.append(header, nameLabel, urlsLabel);
        groups.append(section);
      });
      if (!model.groups.length) groups.append(element('p', 'empty-state', 'Подписок пока нет.'));
    }
    add.addEventListener('click', function () {
      var number = 1;
      while (model.groups.some(function (group) { return group.name === 'subscription-' + number; })) number++;
      model.groups.push({ name: 'subscription-' + number, comment: '', lines: [''] });
      changed(); render(); groups.lastElementChild.querySelector('input').focus();
    });
    undo.addEventListener('click', function () {
      model.groups.splice(Math.min(deleted.index, model.groups.length), 0, deleted.group);
      deleted = null; undo.hidden = true; changed(); render();
    });
    source.addEventListener('input', function () {
      model = parseSubscriptions(source.value); form.dataset.dirty = '1';
      state.textContent = 'Есть несохраненные изменения'; render();
    });
    form.addEventListener('submit', function () { source.value = serializeSubscriptions(model); });
    form.addEventListener('subscription-saved', function () {
      delete form.dataset.dirty; state.textContent = 'Сохранено';
    });
    render();
  });
  window.addEventListener('beforeunload', function (event) {
    if (document.querySelector('.subscription-form[data-dirty]')) { event.preventDefault(); event.returnValue = ''; }
  });
  var nav = document.querySelector('.vpn-nav');
  if (nav) {
    function selectView() {
      var id = window.location.hash.slice(1);
      if (!['vpn-connection','vpn-subscriptions','vpn-nodes','vpn-rules','vpn-settings'].includes(id)) id = 'vpn-connection';
      document.querySelectorAll('.vpn-view').forEach(function (view) { view.hidden = view.id !== id; });
      nav.querySelectorAll('a').forEach(function (link) {
        if (link.hash === '#' + id) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
    }
    window.addEventListener('hashchange', selectView);
    selectView();
  }
}());
