// Минимальный интерфейс доступа к БД. Репозитории зависят только от него,
// поэтому их можно тестировать подменным клиентом, без реального Postgres.

export interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
}

export function firstRow(result: QueryResultLike): Record<string, unknown> | undefined {
  return result.rows[0];
}

// Postgres отдаёт bigint/numeric как строку — приводим явно.
export function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
