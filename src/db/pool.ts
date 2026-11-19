import { Pool } from "pg";

// Пул соединений с Postgres. Один на процесс: соединения переиспользуются,
// а max защищает БД от всплеска. Соединение устанавливается лениво, при первом
// запросе, поэтому создание пула ничего не делает по сети.
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
