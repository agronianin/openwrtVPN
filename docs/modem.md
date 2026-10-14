# Необязательный модуль DW5821e / T77W968

Для WAN, Wi-Fi или штатно поддерживаемого модема этот модуль не нужен. Публичный default: `/etc/config/openwrtvpn`, `option modem_enabled '0'`.

Установка: остановить VPN на время установки, затем `INSTALL_MODEM=1 sh install.sh`. Подписки, правила и settings сохраняются. ModemManager обслуживает мобильное соединение. Скрипт находит USB `413c:81d7` и при необходимости устанавливает временную USB configuration 1 (QMI), повторяя это при загрузке. Прошивка/NV не меняются. Сам установщик не запускает модем: при готовности `/etc/init.d/modemmanager start`, `/etc/init.d/modem-t77w968-qmi start`, затем `ifup modem_mm`.

APN нового интерфейса: `uci set openwrtvpn.main.modem_apn='internet'`, `uci commit openwrtvpn` перед установкой. Для существующего интерфейса менять `network.modem_mm.apn` в LuCI/UCI. Ожидание при старте: `BOOT_WAIT_SECONDS=120` в `/usr/bin/modem-t77w968`.

Диагностика: `mmcli -L`, `modem-t77w968 status`, `ifstatus modem_mm`, `qmicli -d /dev/cdc-wdm0 --device-open-proxy --nas-get-signal-strength`. Вкладка позволяет перезапускать MM и проверять радио/bands; ограничение/сравнение bands может прервать связь. Агрегацию выбирает сеть, разрешение нескольких bands не гарантирует CA.

Отключить модуль без удаления настроек:

```sh
uci set openwrtvpn.main.modem_enabled=0
uci commit openwrtvpn
/etc/init.d/modem-t77w968-qmi stop
/etc/init.d/modem-t77w968-qmi disable
/etc/init.d/router-control-web restart
```

Вкладка скрывается, CGI блокирует модемные действия, сервис не запускает модем при значении 0. Штатный ModemManager и существующий `modem_mm` автоматически не уничтожаются; если нужно — `ifdown modem_mm` или LuCI. Вернуть: свойство 1, enable/start сервиса, restart панели.
