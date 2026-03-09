import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { toCompactTimestamp, toIsoTimestamp } from "./time";

export type HiveMessage = {
  path: string;
  filename: string;
  attributes: Record<string, string>;
  body: string;
  raw: string;
};

export type CreateMessageInput = {
  from: string;
  to: string;
  type: string;
  project: string;
  body: string;
};

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function createMessage(
  msgDir: string,
  input: CreateMessageInput,
): Promise<HiveMessage> {
  await mkdir(msgDir, { recursive: true });

  const timestamp = toIsoTimestamp();
  const filename = [
    toCompactTimestamp(),
    sanitizeSegment(input.from),
    "to",
    sanitizeSegment(input.to),
    crypto.randomUUID().slice(0, 8),
  ].join("-");
  const path = join(msgDir, `${filename}.md`);
  const raw = stringifyFrontmatter(
    {
      from: input.from,
      to: input.to,
      type: input.type,
      status: "open",
      ts: timestamp,
      project: input.project,
    },
    input.body,
  );

  await Bun.write(path, raw);

  return {
    path,
    filename: `${filename}.md`,
    attributes: parseFrontmatter(raw).attributes,
    body: input.body.trim(),
    raw,
  };
}

export async function listMessages(msgDir: string): Promise<HiveMessage[]> {
  const dir = await readdir(msgDir, { withFileTypes: true }).catch(() => []);
  const filenames = dir
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const messages: HiveMessage[] = [];

  for (const filename of filenames) {
    const path = join(msgDir, filename);
    const raw = await Bun.file(path).text();
    const parsed = parseFrontmatter(raw);

    messages.push({
      path,
      filename,
      attributes: parsed.attributes,
      body: parsed.body,
      raw: raw.trim(),
    });
  }

  return messages;
}
