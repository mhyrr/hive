export function extractConfigValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
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
