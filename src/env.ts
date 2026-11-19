import { existsSync } from "node:fs";

// Загружает .env, если он есть. process.loadEnvFile не перезаписывает уже
// заданные переменные окружения, поэтому в проде .env не нужен и не мешает.
export function loadDotEnv(file = ".env"): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
