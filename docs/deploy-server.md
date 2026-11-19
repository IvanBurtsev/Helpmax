# Развёртывание на сервере (только добавление)

Целевой сервер: `45.152.202.114`, каталог проекта `/root/helpmax`.
Это общий сервер: на нём уже работают чужие проекты и сервисы.

## Правила (важно)

Работаем **только добавляюще**. Ничего чужого не трогаем:

- не меняем `/opt/debt-relief-crm` и другие каталоги в `/root` (кроме нашего
  `/root/helpmax`);
- не меняем конфиги nginx (`/etc/nginx`) и cloudflared (`.cloudflared`);
- не трогаем чужие Docker-сервисы (`cancel-bot`, `tarot_bot-*`) и системные
  юниты (`battleship*`, `durak*`, `cloudflared-tunnel.service`);
- свои файлы держим в `/root/helpmax` (код) и `/root/helpmax-certs` (сертификаты);
- новые порты стараемся не занимать: long polling их не требует.

## Требования

Node ≥ 22 (на сервере 22.x), git, npm. Сборка:

```bash
cd /root/helpmax
git pull --ff-only
npm ci --no-audit --no-fund
npm run build          # dist/: server, worker, poll, ...
```

## Корневой сертификат MAX (обязательно)

MAX отдаёт сертификат, подписанный **Russian Trusted Root CA** (российский
национальный удостоверяющий центр). В доверенных корнях Node его нет, поэтому
без него все запросы падают с `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (`fetch
failed`), хотя TLS-рукопожатие проходит.

Скачиваем корень и проверяем отпечаток:

```bash
mkdir -p /root/helpmax-certs
curl -fsSL -o /root/helpmax-certs/russian_trusted_root_ca.crt \
  https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
openssl x509 -in /root/helpmax-certs/russian_trusted_root_ca.crt -noout \
  -subject -fingerprint -sha256
```

Ожидаемый отпечаток SHA-256:

```
D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
```

Если отпечаток совпал — доверяем. Подключаем корень **только** нашему процессу
через `NODE_EXTRA_CA_CERTS` (системное хранилище не трогаем — это общий сервер):

```bash
NODE_EXTRA_CA_CERTS=/root/helpmax-certs/russian_trusted_root_ca.crt \
  MAX_BOT_TOKEN=<токен> node dist/poll.js
```

> `NODE_EXTRA_CA_CERTS` читается Node один раз при старте, поэтому его нужно
> задавать в окружении запуска (shell или systemd), а не в `.env`: загрузка
> `.env` внутри процесса уже не влияет на хранилище доверия.

Проверка связки без бота:

```bash
NODE_EXTRA_CA_CERTS=/root/helpmax-certs/russian_trusted_root_ca.crt \
  MAX_BOT_TOKEN=dummy npx tsx scripts/max-check.ts
# ожидаемо: «401: Invalid access_token» (TLS ок, токен подменный)
```

## Режим long polling (без БД, рекомендуется первым)

Нужен только `MAX_BOT_TOKEN`. Публичный webhook и порты не требуются,
состояние держится в памяти процесса. Подходит для теста бота в MAX.

`.env` рядом с проектом (в git не попадает):

```dotenv
NODE_ENV=development
MAX_BOT_TOKEN=<токен>
MAX_API_BASE=https://platform-api2.max.ru
```

Запуск:

```bash
cd /root/helpmax
NODE_EXTRA_CA_CERTS=/root/helpmax-certs/russian_trusted_root_ca.crt \
  node dist/poll.js
```

## systemd-юнит (позже, когда токен на месте)

Юнит запускает long polling и перезапускает его при падении. Создаём **новый**
файл, существующие сервисы не трогаем:

```ini
# /etc/systemd/system/helpmax-poll.service
[Unit]
Description=Helpmax MAX bot (long polling)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/root/helpmax
EnvironmentFile=/root/helpmax/.env
Environment=NODE_EXTRA_CA_CERTS=/root/helpmax-certs/russian_trusted_root_ca.crt
ExecStart=/usr/bin/node dist/poll.js
Restart=always
RestartSec=5
# Память на сервере ограничена — держим потолок
MemoryMax=300M

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now helpmax-poll
journalctl -u helpmax-poll -f
```

## Режим webhook + воркер (как в проде)

Нужны Postgres и Redis, публичный HTTPS-адрес и секрет webhook. На общем
сервере это дороже по памяти (~500 МБ свободно) и требует решения по
reverse-proxy/поддомену — согласуем отдельно.
