# Формат правил `.rules`

Файлы лежат здесь:

```sh
/etc/sing-box/rule-packs/available/
```

Для личных правил использовать:

```sh
05-force-proxy.rules   # обязательно через VPN/proxy
06-force-direct.rules  # обязательно напрямую
```

После изменения применить из директории `/etc/sing-box/rule-packs`:

```sh
./apply-rules
```

Скрипт сам берет текущий профиль правил. Если нужно применить конкретный профиль:

```sh
./apply-rules WHITE
./apply-rules BLACK
```

## Варианты правил

### Точный домен

```text
rule exact-example
outbound vpn-out
domain example.com api.example.com
```

`domain example.com` матчится только на `example.com`, не на `www.example.com`.

### Суффикс домена

```text
rule suffix-example
outbound direct
domain_suffix example.ru cdn.example.ru
```

`domain_suffix example.ru` матчится на `example.ru` и на `*.example.ru`.

### Подстрока в домене

```text
rule keyword-example
outbound vpn-out
domain_keyword googlevideo ytimg
```

Использовать аккуратно: keyword может задеть лишние домены.

### IP или подсеть

```text
rule ip-example
outbound direct
ip_cidr 203.0.113.10/32 198.51.100.0/24
```

Для одного IPv4 адреса использовать `/32`.

### Внешний `.srs` rule-set

```text
ruleset blocked binary /etc/sing-box/rules/blocked.srs

rule blocked-proxy
outbound vpn-out
rule_set blocked
```

Файл `.srs` должен уже существовать на роутере.

### Final

```text
final vpn-out
```

Задает маршрут по умолчанию для всего, что не совпало с правилами. В личные `05/06` файлы обычно не добавлять.

## Outbound

В текущей конфигурации использовать только:

```text
outbound vpn-out
outbound direct
```

## Как перечислять

В одном правиле можно перечислять несколько значений через пробел:

```text
rule mixed-example
outbound vpn-out
domain example.com api.example.com
domain_suffix example.net cdn.example.net
domain_keyword video cdn
ip_cidr 203.0.113.10/32 198.51.100.0/24
```

Комментарии начинаются с `#`.

## Важные нюансы

- Правила применяются в порядке имен файлов.
- Внутри файла правила применяются сверху вниз.
- Первое совпавшее правило выигрывает.
- `00-private-direct.rules` идет раньше личных правил, поэтому локальные/private сети остаются напрямую.
- Эти `.rules` файлы не читает sing-box напрямую. Их читает `/usr/bin/vpn-subscriptions-update`, генерирует `/etc/sing-box/config.json` и применяет его.
- Для доменов на кириллице использовать punycode, например `xn--p1ai`.
