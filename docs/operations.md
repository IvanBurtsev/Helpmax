# Эксплуатация

## Логи

Формат — JSON, одна строка на событие (pino). Обязательные поля:

```json
{
  "ts": "2026-11-19T13:40:00.123Z",
  "level": "info",
  "service": "bot-gateway",
  "env": "prod",
  "trace_id": "0af7651916cd43dd",
  "request_id": "01J...",
  "event": "webhook.received",
  "update_type": "message_created",
  "chat_id_hash": "9f2c...",
  "msg_id": "123456",
  "scenario": "bankruptcy",
  "scenario_version": 3,
  "step": "debt",
  "duration_ms": 42,
  "outcome": "queued"
}
```

Правила:

- **Никогда** не логируем: текст сообщений, телефоны, email, токены, ИНН,
  содержимое ответов, полный `chat_id` (только хэш с солью).
- `chat_id` в открытом виде — только в БД, для поддержки. В логах — `hash(chat_id)`.
- Ошибки — с `error_code`, `error_class`, стек без переменных окружения.
- Уровни: `debug` (локально), `info` (основные события), `warn` (деградация),
  `error` (инцидент), `fatal`.
- Хранение: 14 дней hot, 90 дней архив (без ПД).
- Отдельный **audit log** (в БД, не в файлах): публикация сценариев, баны,
  доступ к сессии, удаление ПД, изменение лимитов.

## Метрики

| Метрика | Тип | Зачем |
|---|---|---|
| `webhook_requests_total{status}` | counter | здоровье входа |
| `webhook_duration_ms` | histogram | успеваем ли в 30 с |
| `signature_failures_total` | counter | атака или сломанный секрет |
| `dedupe_hits_total` | counter | доля ретраев |
| `queue_depth{queue}` | gauge | заторы |
| `job_failures_total{job}` | counter | сбои обработки |
| `send_total{status}` | counter | доставка в MAX |
| `send_latency_ms` | histogram | отклик бота |
| `session_started_total` | counter | вход в воронку |
| `instruction_shown_total` | counter | список показан |
| `doc_question_total` | counter | вопросы помощнику |
| `lead_created_total` | counter | деньги |
| `llm_tokens_total{model}` | counter | расход |
| `llm_cost_rub` | counter | бюджет |
| `cache_hit_ratio{cache}` | gauge | эффективность кэша |
| `db_pool_in_use` | gauge | насыщение |
| `max_api_success_false_total{method}` | counter | MAX вернул 200 с `success:false` |
| `outbox_lag_seconds` | histogram | задержка исходящих |
| `webhook_subscription_active` | gauge | подписка MAX жива |
| `cert_expires_days` | gauge | срок сертификата |
| `raw_updates_deleted_total` | counter | работает retention (30 дней) |
| `catalog_version` | gauge | какая версия каталога в работе |

## Алерты

| Условие | Порог | Действие |
|---|---|---|
| Webhook 5xx | > 1% за 5 мин | дежурный, откат |
| p95 webhook | > 500 мс 5 мин | масштабирование |
| `signature_failures` | > 50/мин | проверить секрет, возможна атака |
| Очередь | > 1 000 5 мин | добавить воркеров |
| Ошибки отправки | > 5% 10 мин | проверить MAX API, токен |
| Конверсия в показ списка | падение > 30% неделя к неделе | контент/баг |
| LLM-расход | > 120% бюджета дня | стоп LLM, fallback |
| Диск Postgres | > 80% | чистка/расширение |
| Нет heartbeat планировщика | 5 мин | рестарт |
| `max_api_success_false` | > 1% за 5 мин | смотреть тело ответа и схему запроса |
| `outbox_lag_seconds` | > 60 с за 5 мин | проверить воркеры и MAX API |
| `webhook_subscription_active` | 0 | пересоздать `POST /subscriptions` |
| `cert_expires_days` | < 14 | обновить сертификат и цепочку |

## Кэширование

| Что | Где | TTL | Инвалидация |
|---|---|---|---|
| Определение сценария | process LRU + Redis | 60 с / 5 мин | по `version` |
| Каталог документов | process LRU | 5 мин | публикация |
| Сессия | Redis | 30 мин sliding | write-through в PG |
| Рендер инструкции | Redis, ключ = sha256(catalogVersion + guidesVersion) | 1 ч | версия |
| Инструкция документа | Redis | 10 мин | публикация |
| Ответ LLM на интент | Redis | 24 ч | версия промпта |
| PDF | S3 | 7 дней | — |
| Rate limit | Redis | окно | — |

Принципы:

- кэш **не источник истины**: потеря Redis не теряет данные;
- ключи с ПД — только per-user, никогда не общие;
- `stale-while-revalidate` для контента: отдаём старое, пока грузим новое;
- инвалидация по версии, а не по времени — предсказуемо.

## Очереди и ретраи

- BullMQ: `updates` (по chat_id), `outbound`, `integrations`, `scheduled`.
- Попытки: 5, backoff экспоненциальный с jitter: 1s, 5s, 30s, 2m, 10m.
- После 5 попыток — `dead-letter` + алерт, не теряем.
- MAX API: уважаем `429`, глобальный token bucket 25 rps.
- `Retry-After` учитываем, если пришёл.
- Идемпотентность на каждом шаге: outbox `idempotency_key UNIQUE`.

## SLO

| Показатель | Цель |
|---|---|
| Доступность webhook | 99,9% / месяц |
| p95 ответ gateway | < 300 мс |
| p95 ответ пользователю (без LLM/PDF) | < 2 с |
| Успешная доставка сообщений | ≥ 99,5% |
| Потеря событий | 0 |
| Время реакции на инцидент | < 15 мин |

Бюджет ошибок: 43 мин/месяц. При исчерпании — заморозка фич, только надёжность.

## Бэкапы и восстановление

- Postgres: ежедневный полный + WAL/PITR 7 дней, проверка восстановления раз в месяц.
- Redis: AOF, но без него переживаем (состояние в PG).
- S3: версионирование, lifecycle 30 дней.
- `raw_updates`: retention 30 дней, ежедневное автоудаление; в бэкапах не держать
  дольше. `outbox`/`leads` — по правилам 152-ФЗ из `docs/security.md`.
- Секреты: бэкап в vault, не в репозитории.
- RPO ≤ 15 мин, RTO ≤ 2 ч.

## Runbook

**Бот не отвечает**
1. `GET /healthz` gateway → 200?
2. `signature_failures` в норме? Секрет совпадает?
3. Очередь растёт? Воркеры живы?
4. MAX API: `POST /messages` → код?
5. Если код 200, но сообщения нет — проверить `"success": false` в теле.
6. Логи по `trace_id` последнего сообщения (без payload и текстов).

**Дубли сообщений**
1. Проверить `dedupe_hits_total` и `raw_updates`.
2. Есть ли уникальный индекс на `dedupe_key`?
3. Не отключена ли сериализация по `chat_id`.

**MAX отписал webhook**
1. `GET /subscriptions` — есть ли подписка.
2. Сертификат: цепочка полная, срок, 443.
3. Время ответа > 30 с? Смотреть p95.
4. Пересоздать подписку через `POST /subscriptions`.

**Спам-атака**
1. Edge: включить правило на IP/ASN.
2. Ужесточить лимиты на `bot_started`.
3. Бан по хэшу устройства/пользователя на 24 ч.
4. Не отключать бота целиком.

**Утечка токена**
1. Отозвать токен в MAX для партнёров, выпустить новый.
2. Пересоздать webhook-подписку.
3. Проверить логи на исходящие с этим токеном.
4. Ротация остальных секретов.

## Релизы

- trunk-based, короткие ветки, PR + ревью.
- CI: lint, typecheck, unit, контент-валидация, сборка, Trivy, gitleaks.
- Миграции: только backward-compatible, отдельным шагом, с откатом.
- Деплой: blue/green, healthcheck, 10% → 50% → 100%.
- Фича-флаги для новых сценариев и LLM.
- После деплоя: 15 минут наблюдения за ошибками и воронкой.
