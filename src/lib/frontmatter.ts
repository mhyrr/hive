export type FrontmatterAttributes = Record<string, string>;

export type ParsedFrontmatter = {
  attributes: FrontmatterAttributes;
  body: string;
};

export function parseFrontmatter(input: string): ParsedFrontmatter {
  const normalized = input.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized.trim() };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);

  if (closingIndex === -1) {
    return { attributes: {}, body: normalized.trim() };
  }

  const rawFrontmatter = normalized.slice(4, closingIndex).trim();
  const body = normalized.slice(closingIndex + 5).trim();
  const attributes: FrontmatterAttributes = {};

  for (const line of rawFrontmatter.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key) {
      attributes[key] = value;
    }
  }

  return { attributes, body };
}

export function stringifyFrontmatter(
  attributes: FrontmatterAttributes,
  body: string,
): string {
  const lines = Object.entries(attributes).map(([key, value]) => `${key}: ${value}`);
  const normalizedBody = body.trim();

  return `---\n${lines.join("\n")}\n---\n\n${normalizedBody}\n`;
}
