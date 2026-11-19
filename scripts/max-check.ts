#!/usr/bin/env node
// Проверка токена MAX: запрашивает /me и печатает имя бота. Сам токен не выводится.
// Запуск: npm run max:check

import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { MaxClient } from "../src/max/client.js";

loadDotEnv();
const config = loadConfig();

if (!config.MAX_BOT_TOKEN) {
  console.error("MAX_BOT_TOKEN не задан — нечего проверять. Заполните .env.");
  process.exit(1);
}

const client = new MaxClient({ token: config.MAX_BOT_TOKEN, baseUrl: config.MAX_API_BASE });

try {
  const me = await client.getMe();
  const handle = me.username ? `@${me.username}` : "(username не задан)";
  console.log(`OK: бот «${me.first_name}» ${handle}, id=${me.user_id}`);
} catch (error) {
  console.error(`Не удалось получить /me: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
