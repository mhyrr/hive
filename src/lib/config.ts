export function extractConfigValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
}

export function setConfigValue(input: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^[ \\t]*${escapedKey}:.*$`, "m");

  if (pattern.test(input)) {
    return input.replace(pattern, line);
  }

  const existing = input.trimEnd();
  return `${existing}${existing ? "\n\n" : ""}${line}\n`;
}

export function extractConfigValueAlias(input: string, keys: string[]): string | null {
  for (const key of keys) {
    const value = extractConfigValue(input, key);

    if (value) {
      return value;
    }
  }

  return null;
}

export function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
