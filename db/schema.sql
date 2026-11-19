-- Схема БД (PostgreSQL 16+), версия 2
-- Принципы:
--   * Postgres — источник истины, Redis — кэш и очередь.
--   * Всё, что может понадобиться для аудита, не удаляется физически.
--   * ПД минимизированы: сканы не храним, контакты — только по согласию.
--   * Каталог документов импортируется из content/catalog.json по коду (code).

create extension if not exists pgcrypto;

-- ============ Пользователи ============

create table users (
  id              uuid primary key default gen_random_uuid(),
  max_user_id     bigint not null unique,
  chat_id         bigint,                       -- личный диалог с ботом
  display_name    text,                         -- из MAX, необязательно
  consent_at      timestamptz,                  -- когда дано согласие на ПД
  consent_version text,
  blocked_until   timestamptz,                  -- антиспам-бан
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz                   -- обезличивание
);

create unique index users_chat_id_uidx on users (chat_id) where chat_id is not null;
create index users_blocked_idx on users (blocked_until) where blocked_until is not null;

-- ============ Контент ============

create table scenarios (
  id              uuid primary key default gen_random_uuid(),
  code            text not null,                -- bankruptcy, debt, ...
  version         int  not null,
  title           text not null,
  status          text not null default 'draft'
                  check (status in ('draft', 'published', 'archived')),
  definition      jsonb not null,               -- граф шагов (см. docs/bot-engine.md)
  catalog_version text,                         -- версия content/catalog.json
  disclaimer      text not null,
  published_at    timestamptz,
  created_by      text,
  created_at      timestamptz not null default now(),
  unique (code, version)
);

create index scenarios_published_idx on scenarios (code, published_at desc)
  where status = 'published';

create table documents (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,             -- = catalog.json id
  title       text not null,                    -- = catalog.json name
  description text,
  source      text,                             -- = catalog.json source
  rule        text not null
              check (rule in (
                'always', 'manual',
                'pension', 'social', 'selfEmployed', 'officialWork',
                'realEstateDeal', 'securedCredit', 'mortgage', 'creditCards',
                'ip', 'otherDebts', 'children', 'spouse', 'divorce'
              )),
  note        text not null default '',         -- = catalog.json note
  commentable boolean not null default false,   -- менеджерская метка; боту не нужна
  how_to      text,                             -- пошаговая инструкция; может отсутствовать
  links       jsonb not null default '[]',      -- [{title,url}]
  required_by_default boolean not null default true,
  status      text not null default 'draft'
              check (status in ('draft', 'published', 'archived')),
  ttl_days    int,                              -- как часто проверять актуальность
  reviewed_by text,
  reviewed_at timestamptz,
  review_due_at timestamptz,
  updated_at  timestamptz not null default now()
);

create index documents_rule_idx on documents (rule) where status = 'published';
create index documents_review_idx on documents (review_due_at)
  where status = 'published' and review_due_at is not null;

-- История версий документа: что именно видел пользователь.
create table document_versions (
  id          bigserial primary key,
  document_id uuid not null references documents(id) on delete restrict,
  version     int  not null,
  snapshot    jsonb not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (document_id, version)
);

-- ============ Диалоги ============

create table sessions (
  id               uuid primary key default gen_random_uuid(),
  public_id        text not null unique,         -- ULID для ссылок, не угадывается
  user_id          uuid not null references users(id),
  scenario_code    text not null,
  scenario_version int  not null,
  catalog_version  text,                         -- версия каталога на старте
  state            jsonb not null default '{}',  -- answers + current_step + flags
  version          int  not null default 0,      -- optimistic lock
  status           text not null default 'active'
                   check (status in ('active', 'completed', 'abandoned', 'blocked')),
  current_step     text,
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  foreign key (scenario_code, scenario_version)
    references scenarios (code, version)
);

create index sessions_user_idx on sessions (user_id, started_at desc);
create index sessions_active_idx on sessions (status, updated_at)
  where status = 'active';

create table answers (
  id         bigserial primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  step_id    text not null,
  revision   int  not null default 1,            -- переответ создаёт новую ревизию
  value      jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, step_id, revision)
);

create table checklist_items (
  id                  bigserial primary key,
  session_id          uuid not null references sessions(id) on delete cascade,
  document_code       text not null,
  document_version_id bigint references document_versions(id) on delete set null,
  required            boolean not null,
  status              text not null default 'todo'
                      check (status in ('todo', 'collected', 'not_applicable')),
  note                text,
  updated_at          timestamptz not null default now(),
  unique (session_id, document_code),
  foreign key (document_code) references documents (code)
    on update cascade on delete restrict
);

create index checklist_session_idx on checklist_items (session_id);

-- ============ Входные события ============

-- Сырые webhook. payload содержит текст сообщения и может содержать ПД:
-- доступ только сервисной роли, retention 30 дней, без выгрузки в логи.
-- Партиционировать по месяцу после ~10 млн строк.
create table raw_updates (
  id           bigserial primary key,
  dedupe_key   text not null unique,             -- sha256(event-specific stable id, см. architecture.md)
  update_type  text not null,
  chat_id      bigint,
  user_id      bigint,
  payload      jsonb not null,
  late         boolean not null default false,   -- timestamp старше 10 минут
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       text not null default 'new'
               check (status in ('new', 'done', 'skipped', 'failed')),
  error_code   text,
  error        text
);

create index raw_updates_received_idx on raw_updates (received_at);
create index raw_updates_status_idx on raw_updates (status)
  where status in ('new', 'failed');

-- ============ Исходящие сообщения (outbox) ============

create table outbox (
  id              bigserial primary key,
  chat_id         bigint not null,
  session_id      uuid references sessions(id) on delete set null,
  kind            text not null,                 -- message, edit, lead, pdf
  payload         jsonb not null,
  idempotency_key text not null unique,
  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts        int not null default 0,
  next_at         timestamptz not null default now(),
  sent_at         timestamptz,
  message_id      text,                          -- mid от MAX
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index outbox_pending_idx on outbox (status, next_at)
  where status in ('pending', 'sending');
create index outbox_chat_idx on outbox (chat_id, created_at desc);

-- ============ Лиды и ссылки ============

create table leads (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id),
  contact         jsonb not null,                -- {name, phone}
  consent_at      timestamptz not null,
  consent_version text not null,
  scenario        text not null,
  status          text not null default 'new'
                  check (status in ('new', 'sent', 'accepted', 'rejected')),
  crm_id          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index leads_created_idx on leads (created_at desc);
create index leads_status_idx on leads (status) where status = 'new';

-- Одноразовые токены deep link сайт -> бот (payload <= 128 символов).
-- Храним только хэш: утечка БД не даёт переиграть токен.
create table start_tokens (
  token_hash      text primary key,              -- sha256(token), не сам токен
  scenario_code   text,
  scenario_version int,
  utm             jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz
);

create index start_tokens_expires_idx on start_tokens (expires_at);

-- ============ Аудит ============

create table audit_log (
  id         bigserial primary key,
  actor      text not null,                     -- admin:ivan, system:worker
  action     text not null,                     -- scenario.publish, user.delete, ...
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         inet,
  trace_id   text,                              -- связь с логами и инцидентом
  created_at timestamptz not null default now()
);

create index audit_created_idx on audit_log (created_at desc);
create index audit_entity_idx on audit_log (entity, entity_id);
create index audit_trace_idx on audit_log (trace_id) where trace_id is not null;

-- ============ updated_at ============

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger documents_set_updated_at
  before update on documents
  for each row execute function set_updated_at();

create trigger sessions_set_updated_at
  before update on sessions
  for each row execute function set_updated_at();

create trigger outbox_set_updated_at
  before update on outbox
  for each row execute function set_updated_at();

create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();

-- ============ Миграции ============

create table schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
