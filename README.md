# MAX-бот «Фемида AI» — подбор документов

> Если вы агент, который продолжает работу — сначала прочитайте `AGENTS.md`.

Статус: **ревизия 8 (19.11.2026)**. Есть архитектура, контентная модель,
проверяемый пример сценария, движок, транспорт MAX, миграции, локальный Docker,
хранилище (Postgres/Redis) и воркер: webhook → очередь → движок → outbox → MAX.
Путь собран и проверен на живой БД (`npm run check:db`). Есть локальный запуск
без MAX (`npm run sim`) и боевой тест через long polling (`npm run poll`, в проде
`node dist/poll.js`). Проект развёрнут на сервере (дополнительно, ничего чужого
не трогаем). Интеграция с сайтом, CI и админка — следующие шаги.

> Документация сверена с официальным API MAX 19.11.2026:
> <https://dev.max.ru/docs-api/>. Базовый URL — `https://platform-api2.max.ru`,
> токен — только в заголовке `Authorization`, лимит — 30 rps.

## Что делает продукт

Пользователь заходит в бота MAX (из сайта `sales.femida-ai.ru` или по прямой ссылке),
выбирает жизненную ситуацию, отвечает на 5–10 вопросов кнопками и получает
**персональный чек-лист документов**: что нужно обязательно, что уточнит юрист,
где получить и пошагово — куда зайти и на что нажать.

Дальше пользователь может:

- отмечать собранные документы и вернуться позже;
- открыть полный чек-лист на сайте (подписанная ссылка);
- скачать PDF;
- передать заявку юристу (лид в CRM).

## Ключевые решения

1. **Детерминированный движок сценариев.** Логика — граф шагов в YAML, а не «промпт».
   LLM только распознаёт свободный текст и пересказывает справку, но не решает,
   какие документы нужны. Это предсказуемо, тестируемо и не врёт.
2. **Один источник правил, два клиента.** Каталог и 13 условий живут в одном
   месте: бот вызывает API сайта или общий `core-api`, но не заводит второй
   каталог. Сайт и бот не расходятся в перечне документов.
3. **Webhook → очередь → воркеры.** HTTP 200 отдаётся сразу после проверки подписи,
   вся работа асинхронная. Дубли и ретраи MAX не ломают состояние.
4. **Postgres — источник истины, Redis — горячее состояние.** Сессии, лимиты,
   идемпотентность, кэш рендера.
5. **Контент версионируется.** Сценарий и документы имеют версию; сессия идёт по той
   версии, с которой началась. Публикация не ломает текущих пользователей.
6. **Переиспользуем движок сайта.** На `sales.femida-ai.ru/documents` уже есть
   каталог из 46 документов, 13 условий и API разбора анкеты. Бот — клиентский
   интерфейс к этой логике, а не второй источник правды. Подробности — в
   `docs/site-audit.md`.

## Рекомендуемый стек

| Слой | Выбор | Почему |
|---|---|---|
| Язык | TypeScript (Node 22+) | официальная библиотека MAX — JS/TS |
| MAX SDK | `@maxhub/max-bot-api` | официальный JS-клиент (`max-messenger/max-bot-api-client-ts`) |
| HTTP | Fastify | быстрый, строгие схемы, удобные хуки |
| Очередь | Redis + BullMQ | минимальная инфраструктура на старте |
| БД | PostgreSQL 16 | JSONB для ответов и определений сценариев |
| Валидация | zod | один источник типов для API и вебхука |
| Условия | `json-logic-js` | безопасные выражения вместо `eval` (пакет `jsonlogic` сломан) |
| Логи | pino + OpenTelemetry | структурированные логи, трейсы |
| Деплой | Docker + nginx/Traefik | 2+ инстанса за балансировщиком |
| Хостинг | Yandex Cloud / Selectel / VK Cloud | РФ, 152-ФЗ, сертификаты, WAF |
| Админка | Next.js (или React + API) | редактирование сценариев и документов |

## Структура репозитория

```
.
├── .env.example            # шаблон переменных, без секретов
├── .gitignore
├── AGENTS.md               # точка входа для следующего агента
├── README.md
├── package.json            # скрипты: dev, worker, build, test, sim, poll, check:db
├── tsconfig.json           # проверка типов (src + test + scripts)
├── tsconfig.build.json     # сборка src → dist
├── docs/
│   ├── product.md          # продукт, пользователи, сценарии, метрики
│   ├── site-audit.md       # что уже есть на сайте (аудит 19.11.2026)
│   ├── plan-week1.md       # план первой недели и письмо руководителю
│   ├── architecture.md     # компоненты, потоки, асинхронность, деплой
│   ├── bot-engine.md       # движок диалога, формат сценариев, защита от дурака
│   ├── security.md         # угрозы, вебхук, лимиты, 152-ФЗ, LLM
│   ├── operations.md       # логи, метрики, кэш, SLO, runbook
│   ├── integration.md      # сайт, deep links, API, CRM
│   ├── deploy-server.md    # рунбук сервера (additive) + корень MAX
│   └── review-2026-11-19.md # что исправлено при ревизиях
├── content/
│   ├── catalog.json        # реальный каталог документов с сайта (46 шт.)
│   └── scenarios/
│       └── example.yaml    # пример catalog-driven сценария (черновик, требует юриста)
├── db/schema.sql           # схема БД (читаемая копия; сверяется с 0001_init тестом)
├── migrations/
│   └── 0001_init.sql       # исполняемая миграция (источник истины для БД)
├── Dockerfile              # сборка образа (build → runtime, без dev-зависимостей)
├── docker-compose.yml      # Postgres, Redis, migrate, app, worker
├── .dockerignore
├── scripts/
│   ├── check-content.ts    # проверка сценария и каталога без сети
│   ├── max-check.ts        # проверка токена MAX (GET /me)
│   ├── sim.ts              # симулятор диалога в терминале (без БД и сети)
│   └── smoke.ts            # смоук-тест пути на живой БД (доставка — подменная)
├── src/
│   ├── config.ts           # валидация env (zod)
│   ├── env.ts              # загрузка .env
│   ├── catalog.ts          # каталог: id→code, name→title, required
│   ├── app.ts              # Fastify: /healthz, /webhook (собирается с зависимостями)
│   ├── server.ts           # HTTP-процесс: пишет событие и ставит задачу
│   ├── worker.ts           # воркер: разбор событий и доставка outbox
│   ├── poll.ts             # бот через long polling MAX (без БД; тот же путь)
│   ├── queue.ts            # очереди BullMQ (updates, outbox)
│   ├── updates.ts          # разбор событий MAX: dedupe_key и событие диалога
│   ├── migrate.ts          # CLI применения миграций
│   ├── db/                 # pool (pg) и раннер миграций
│   ├── store/              # Postgres (сессии, raw_updates, outbox, scenarios),
│   │                       #   Redis и хранилище в памяти (memory.ts)
│   ├── dialog/             # оркестратор, экраны, обработка, доставка, handle
│   ├── engine/             # scenario, conditions, checklist, progress, render, transition
│   └── max/                # транспорт MAX (SDK): rate-limit, fetch, keyboard, client
└── test/                   # vitest: контент, движок, транспорт, хранилище, диалог,
                            #   очередь, webhook, память, обработка
```

## Переменные окружения

```dotenv
NODE_ENV=production

# MAX
MAX_BOT_TOKEN=              # токен бота, только из секрет-хранилища
MAX_API_BASE=https://platform-api2.max.ru
MAX_WEBHOOK_SECRET=         # 5–256 символов [A-Za-z0-9_-]

# Хранилища
DATABASE_URL=postgres://...
REDIS_URL=redis://...

# Хост-порты docker compose (если 5432/6379 заняты — задайте другие)
POSTGRES_PORT=5432
REDIS_PORT=6379

# Интеграция с сайтом
SITE_BASE_URL=https://sales.femida-ai.ru
SITE_SERVICE_TOKEN=         # bot -> site: /api/documents-conditions, /api/rules-chat
INTERNAL_API_TOKEN=         # site -> bot, service-to-service
LINK_SIGNING_KEY=           # Ed25519/HS256 ключ для ссылок на сайт

# Контент
CATALOG_PATH=content/catalog.json
SCENARIO_PATH=content/scenarios/example.yaml

# Воркер
WORKER_CONCURRENCY=5
OUTBOX_SWEEP_MS=15000

# Прочее
LOG_LEVEL=info
OTEL_EXPORTER_OTLP_ENDPOINT=
```

`SITE_SERVICE_TOKEN` и `INTERNAL_API_TOKEN` — **разные** токены. Один даёт боту
читать API сайта, другой — сайту вызывать бота. Не переиспользовать один и тот же.

## Быстрая проверка контента

```powershell
npm install
npm run check:content
```

Скрипт проверяет, что в сценарии нет битых переходов, все 13 условий известны,
`source: catalog` не конфликтует с `documents`, коды документов есть в
`content/catalog.json`, а условия не ссылаются на несуществующие ответы.
Это дешёвая проверка до запуска полноценного CI.

Секреты и локальные значения — в `.env`, шаблон — `.env.example`. `.env` в git
не попадает (см. `.gitignore`).

## Разработка

```powershell
npm run dev            # сервер с watch (tsx), читает .env
npm run dev:worker     # воркер с watch (tsx)
npm run typecheck      # tsc по src + test + scripts
npm run test           # vitest (контент, движок, транспорт, хранилище, диалог, webhook)
npm run build          # сборка src → dist
npm run start          # запуск собранного сервера
npm run start:worker   # запуск собранного воркера
npm run check:content  # проверка сценария и каталога без сети
npm run max:check      # проверка токена MAX (GET /me, токен не выводится)
npm run migrate        # применить миграции к DATABASE_URL
npm run sim            # симулятор диалога в терминале (без БД, Redis и MAX)
npm run poll           # бот через long polling MAX (без БД; нужен MAX_BOT_TOKEN)
npm run start:poll     # то же на собранном dist/poll.js (прод)
npm run check:db       # смоук-тест пути на живой БД (без сети MAX)
```

Сервер (`server.ts`) и воркер (`worker.ts`) — разные процессы: HTTP отдаёт 200
сразу, а разбор события и отправка сообщений идут в воркере. Локально нужны
`DATABASE_URL` и `REDIS_URL` (поднять: `docker compose up -d postgres redis`),
воркеру ещё и `MAX_BOT_TOKEN`.

### Как потестировать бота локально

Три способа — от самого простого к боевому:

1. **Симулятор в терминале** — вообще ничего не нужно, кроме Node:

   ```powershell
   npm run sim
   ```

   Тот же движок, каталог и сценарий, что в бою, но диалог идёт в консоли.
   Отвечайте номером варианта; «н» — назад, «r» — заново, «q» — выход.

2. **Живой бот в MAX через long polling** — нужен только `MAX_BOT_TOKEN`,
   публичный webhook не требуется:

   ```powershell
   npm run poll
   ```

   Откройте бота в MAX и нажмите «Начать». Работает тот же путь события и
   доставка, но состояние держится в памяти (Postgres/Redis не нужны).
   В проде тот же раннер запускается как `node dist/poll.js` (`npm run
   start:poll`) — без dev-зависимостей.

3. **Боевой путь (webhook + воркер)** — как в проде:

   ```powershell
   docker compose up -d postgres redis
   npm run migrate
   npm run dev            # сервер
   npm run dev:worker     # воркер (в отдельном окне)
   ```

   Либо целиком в Docker: `docker compose up --build`.

### Локальный запуск в Docker

Postgres, Redis, приложение и воркер поднимаются одной командой; миграции
применяются автоматически перед стартом (сервис `migrate`, затем `app` и
`worker`):

```powershell
docker compose up --build
```

Секреты Compose берёт из `.env` рядом с `docker-compose.yml`. Локально
`NODE_ENV=development`, поэтому токен MAX необязателен — но без него воркер
не запустится (он отвечает за отправку сообщений). Если порт 5432 или 6379
занят, задайте `POSTGRES_PORT`/`REDIS_PORT` в `.env`. Отдельно миграции:

```powershell
docker compose run --rm migrate
```

## Деплой на сервер

Пробный стенд развёрнут на `45.152.202.114` в `/root/helpmax` — **только
добавление**, чужие проекты и сервисы не трогаем. Подробный рунбук:
[`docs/deploy-server.md`](docs/deploy-server.md).

Важная деталь: MAX отдаёт сертификат, подписанный российским корнем
(Russian Trusted Root CA), которого нет в доверенных корнях Node. Без него
запросы падают с `fetch failed` (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). Корень
подключается **только нашему процессу** через `NODE_EXTRA_CA_CERTS` — системное
хранилище не трогаем (сервер общий). Отпечаток и команды — в рунбуке.

## Что нужно от вас, чтобы стартовать

1. Список 3–5 реальных ситуаций и документов к ним (с юристом).
2. Можно ли поднять API/воркеры рядом с сайтом (сайт уже на Next.js) и кто даст
   сервисный токен к `/api/documents-conditions` и `/api/rules-chat`.
3. Поддомен под webhook, например `bot.femida-ai.ru` (обязателен HTTPS на 443).
4. Есть ли верифицированный профиль организации/ИП в MAX для партнёров.
5. Кто оператор персональных данных и подано ли уведомление в РКН.

## Что уже выяснено (аудит 19.11.2026)

- Сайт — Next.js, вход по паролю, 9 внутренних разделов.
- `/documents` уже формирует список документов: 46 позиций, 13 условий,
  правила `always | manual | <условие>`.
- `POST /api/documents-conditions` разбирает анкету клиента в 13 условий.
- `POST /api/rules-chat` — RAG по регламентам, отвечает с указанием правил.
- Каталог выгружен в `content/catalog.json` и нормализован: у всех 46 документов
  есть `rule`, `note` и boolean `commentable` (в исходной выгрузке поле было
  только у 7).
- Пример сценария `content/scenarios/example.yaml` переведён в catalog-driven
  режим: он не дублирует документы, а маппит ответы в 13 условий.

Главный вывод: бот не должен изобретать перечень документов. Он должен
использовать тот же каталог и те же правила, что и сайт.
