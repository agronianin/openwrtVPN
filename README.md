# OpenWrtVPN

Легкая веб-панель VPN на OpenWrt через **sing-box**: профили BLACK/WHITE, подписки с зеркалами, автоматический выбор узлов, правила direct/proxy и проверка подключения. Работает поверх уже настроенного WAN, Wi-Fi uplink или штатного модема. Поддержка **Dell/Foxconn DW5821e / T77W968** — необязательный модуль, по умолчанию выключен.

## Требования

OpenWrt с UCI, netifd, procd и firewall4, рабочий интернет и SSH; **sing-box 1.14+** с TUN/gVisor и нужными протоколами. Проверено на GL.iNet GL-BE3600, OpenWrt 23.05-SNAPSHOT, sing-box 1.14.3. Другие устройства требуют проверки; это не пакет официального feed. Большие подписки требуют запаса RAM/flash.

Установщик поддерживает `opkg`/`apk`, сохраняет backup, не меняет LAN/WAN-адреса и SSH. Добавляет `tun0` в существующую WAN-зону, выключает flow offloading. Не устанавливайте поверх работающего sing-box: сначала сохраните настройки и остановите сервис. Таблицы `2022`, `9910`, приоритеты `800`, `6000` и порты `2080`, `9090` должны быть свободны от других VPN/PBR-приложений.

## Установка

Команды выполняются **по SSH на роутере от root**. Сначала настройте обычный интернет штатным интерфейсом и задайте пароль администратора. Для скачивания нужны `curl`, CA и `tar`: `opkg update; opkg install curl ca-bundle tar` либо `apk add curl ca-bundle tar`.

Если sing-box не установлен, используйте [официальный установщик](https://sing-box.sagernet.org/installation/package-manager/), предварительно просмотрев скрипт:

```sh
curl -fL https://sing-box.app/install.sh -o /tmp/install-sing-box.sh
sh /tmp/install-sing-box.sh
/etc/init.d/sing-box stop
curl -fL https://github.com/agronianin/openwrtVPN/archive/refs/heads/main.tar.gz -o /tmp/openwrtvpn.tar.gz
tar -xzf /tmp/openwrtvpn.tar.gz -C /tmp
INSTALL_MODEM=0 sh /tmp/openwrtVPN-main/install.sh
```

Панель: `http://<LAN-IP>:8090/`, только на LAN, без открытия WAN-порта. Новые установки используют Basic Auth: `root` и существующий пароль роутера. HTTP не шифрует пароль; предпочтительно открыть панель через SSH-туннель с ноутбука:

```sh
ssh -N -L 18090:<LAN-IP>:8090 root@<адрес-роутера>
# Открыть http://127.0.0.1:18090/
```

Не публикуйте панель в интернете. Установка оставляет VPN **выключенным** до загрузки ваших узлов.

## Первый запуск

В разделе **Подписки** добавьте ссылки в BLACK/WHITE и сохраните. Поддерживаются текстовые/base64 URI-подписки **VLESS** и **Hysteria2 (`hy2`)**, не Clash YAML/JSON. Имя группы — уникальные латинские буквы/цифры/`-_.`. Выше группа — выше приоритет; адреса внутри группы — зеркала одного файла, используется первый успешно обработанный:

```ini
[provider]
https://example.org/private-subscription
https://mirror.example.org/same-subscription
# Комментарий
[fallback]
https://other.example.org/another-subscription
```

Начальная загрузка — явное исключение из правила «обновлять через VPN»: при остановленном VPN выполните:

```sh
vpn-subscriptions-update bootstrap BLACK
vpnctl on
vpnctl status check
```

Если ссылки недоступны напрямую, скачайте файл на другом устройстве, создайте на роутере `/etc/sing-box/bootstrap/`, загрузите туда `provider.txt` и временно укажите зеркало `file:///etc/sing-box/bootstrap/provider.txt` через SSH в `subscriptions.d/black.txt`. Запустите `bootstrap`, включите VPN, затем замените временный адрес реальной ссылкой и обновите подписки. Веб-редактор допускает локальные файлы только из `manual-subscriptions/{black,white}/`; такие ручные группы выбираются явно, не автоматически.

## Управление

```sh
vpnctl on                    # включить; работающий сервис не рестартует
vpnctl off                   # direct-интернет, фоновые сетевые задачи отключены
vpnctl status check          # HTTPS через VPN, IP, страна и город выхода
vpnctl mode BLACK            # выбранные сервисы через VPN, остальное direct
vpnctl mode WHITE            # явно разрешенные сайты direct, остальное VPN
vpnctl update                # обновить кэш без разрыва подключения
vpnctl node auto             # применить свежий кэш; возможен краткий разрыв
vpnctl node list             # список узлов
vpnctl node find             # ручной поиск, может переключать соединение
```

BLACK предпочитает не-RU узлы, WHITE — RU при их наличии. Название не гарантирует реальную страну. Проверки и выбор выполняет native [sing-box URLTest](https://sing-box.sagernet.org/configuration/outbound/urltest/); watchdog после трех неудач и проверки WAN применяет свежий кэш, с паузой минимум 10 минут между попытками.

**Ещё → Автоматизация VPN**: обновление подписок (часы), проверка (минуты). Сохранение применяется со следующего минутного запуска без дополнительной кнопки; 0 отключает задачу. Сохранение списков и обновление кэша не пересобирают исправное подключение. Обычно загрузки идут **только через VPN**. Автообновление бинарника выключено в публичных defaults: оно требует рестарта. Ручное обновление — `sing-box-update`.

## Правила

**Правила**: редакторы Force proxy/direct и просмотр маршрутов. Файлы в `/etc/sing-box/rule-packs/available/`; [формат и примеры](router-reinstall-kit/files/etc/sing-box/rule-packs/RULES-FORMAT.md). После ручного изменения: `/etc/sing-box/rule-packs/apply-rules`. Первое совпадение выигрывает; локальные сети идут direct раньше остальных правил.

Публичные BLACK/WHITE-наборы — стартовые примеры, **не полный актуальный список блокировок/белых сайтов**. Российский домен не означает белый список. Добавляйте домены под своего оператора. DNS по умолчанию идет напрямую к Яндексу, чтобы direct-сайты не зависели от VPN: это **не защита от DNS leak**. TUN/DNS ориентированы на IPv4; IPv6 клиентов отдельно не проверен и может обходить VPN. Kill switch и полная анонимность не обещаются.

## Необязательный модем

Для DW5821e/T77W968: `INSTALL_MODEM=1 sh /tmp/openwrtVPN-main/install.sh`. Свойство `openwrtvpn.main.modem_enabled=1` включает ModemManager/QMI-зависимости, интерфейс `modem_mm` при обнаружении USB `413c:81d7` и вкладку модема. Для других моделей не включать: модуль рассчитан на этот VID/PID и USB configuration 1. Без него модемные пакеты/сервис не устанавливаются, действия не выполняются. APN задается `openwrtvpn.main.modem_apn`. [Подробнее](docs/modem.md).

## Диагностика и восстановление

`vpnctl status check`, `logread | grep sing-box`, `/tmp/vpn-health-auto.log`, `/tmp/vpn-auto-update.log`. Если direct тоже не работает — сначала восстановите uplink штатным UI. Сбой геолокации не доказывает отказ VPN.

Backup: `/root/backup-openwrtvpn-<дата>/`. Для возврата: `vpnctl off`, остановить/отключить `router-control-web`, удалить только cron-задания проекта, восстановить архив настроек через штатный UI и предыдущие файлы из backup. Не использовать архив другого устройства/несовместимой прошивки.

Исходники: `router-reinstall-kit/files/`, чистые настройки: `defaults/`, тесты: `tests/`. Личные подписки, узлы, архивы и персональное офлайн-восстановление исключены из Git. Проверки: `sh tests/run.sh` (нужны `jq` и Node.js); [устройство проекта](docs/development.md).
