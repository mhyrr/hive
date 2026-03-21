export function normalizeInlineText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max = 220): string {
  const normalized = normalizeInlineText(value);

  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function firstLine(value: string): string {
  return truncate(value.split("\n")[0] ?? "", 180);
}
