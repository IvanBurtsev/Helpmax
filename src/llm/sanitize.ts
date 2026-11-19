// Защита выхода LLM: ссылки только из allowlist. Модель может «придумать»
// адрес — на выходе всё, что не относится к официальным сервисам (гайды) или
// сайту продукта, вырезается. Это жёсткая проверка в коде, а не только просьба
// в промпте.

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'`)\]]+/g;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowed(url: string, allowed: ReadonlySet<string>): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (allowed.has(host)) return true;
  // поддомен разрешённого хоста (например, www.gosuslugi.ru при gosuslugi.ru)
  for (const base of allowed) {
    if (host === base || host.endsWith(`.${base}`)) return true;
  }
  return false;
}

export interface SanitizeResult {
  text: string;
  removed: number;
}

// Возвращает текст без недопустимых ссылок и число вырезанных адресов.
export function sanitizeLinks(input: string, allowed: ReadonlySet<string>): SanitizeResult {
  let removed = 0;

  let text = input.replace(MARKDOWN_LINK, (match, label: string, url: string) => {
    if (isAllowed(url, allowed)) return match;
    removed += 1;
    return label.trim();
  });

  text = text.replace(BARE_URL, (url: string) => {
    if (isAllowed(url, allowed)) return url;
    removed += 1;
    return "";
  });

  // Подчищаем возможные двойные пробелы/пустые скобки после вырезания.
  text = text.replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ");
  return { text: text.trim(), removed };
}

// Ограничение длины ответа: одно сообщение MAX не должно быть простыней.
export function clampAnswer(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
