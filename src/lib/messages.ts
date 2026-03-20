import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { now, toCompactTimestamp, toIsoTimestamp } from "./time";

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
  attributes?: Record<string, string | null | undefined>;
};

type UpdateMessageInput = {
  reference: string;
  status: "resolved" | "closed";
  actor: string;
  body?: string;
  project?: string;
};

/** Normalize legacy "orchestrator" agent IDs to "steward" when reading messages. */
function normalizeMessageAttributes(
  attributes: Record<string, string>,
  body = "",
): Record<string, string> {
  const result = { ...attributes };

  if (result.from === "orchestrator") {
    result.from = "steward";
  }

  if (result.to === "orchestrator") {
    result.to = "steward";
  }

  if (result.type === "assignment") {
    result.type = "assign";
  }

  for (const key of ["task", "launch", "scope"] as const) {
    if (result[key]) {
      continue;
    }

    const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
    const value = match?.[1]?.trim();

    if (value) {
      result[key] = value;
    }
  }

  return result;
}

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
  const attributes = {
    from: input.from,
    to: input.to,
    type: input.type,
    status: "open",
    ts: timestamp,
    project: input.project,
  } as Record<string, string>;

  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    if (value?.trim()) {
      attributes[key] = value.trim();
    }
  }

  const raw = stringifyFrontmatter(attributes, input.body);
  const parsed = parseFrontmatter(raw);
  const normalizedAttributes = normalizeMessageAttributes(parsed.attributes, parsed.body);

  await Bun.write(path, raw);

  return {
    path,
    filename: `${filename}.md`,
    attributes: normalizedAttributes,
    body: parsed.body,
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
      attributes: normalizeMessageAttributes(parsed.attributes, parsed.body),
      body: parsed.body,
      raw: raw.trim(),
    });
  }

  return messages;
}

export async function readMessageFile(path: string): Promise<HiveMessage | null> {
  try {
    const raw = await Bun.file(path).text();
    const parsed = parseFrontmatter(raw);

    return {
      path,
      filename: basename(path),
      attributes: normalizeMessageAttributes(parsed.attributes, parsed.body),
      body: parsed.body,
      raw: raw.trim(),
    };
  } catch {
    return null;
  }
}

export function isOpenMessage(message: HiveMessage): boolean {
  return (message.attributes.status ?? "open") === "open";
}

export function isProjectMessage(message: HiveMessage, project: string): boolean {
  return message.attributes.project === project;
}

export async function listProjectMessages(
  msgDir: string,
  project: string,
): Promise<HiveMessage[]> {
  return (await listMessages(msgDir)).filter((message) => isProjectMessage(message, project));
}

export async function listOpenProjectMessages(
  msgDir: string,
  project: string,
): Promise<HiveMessage[]> {
  return (await listProjectMessages(msgDir, project)).filter((message) => isOpenMessage(message));
}

export async function listOpenAssignmentMessages(
  msgDir: string,
  project: string,
): Promise<HiveMessage[]> {
  return (await listOpenProjectMessages(msgDir, project)).filter(
    (message) => message.attributes.type === "assign",
  );
}

export async function findOpenAssignmentMessage(
  msgDir: string,
  project: string,
  agentId: string,
): Promise<HiveMessage | null> {
  const matches = (await listOpenProjectMessages(msgDir, project)).filter(
    (message) => message.attributes.type === "assign" && message.attributes.to === agentId,
  );

  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

export async function findMessage(
  msgDir: string,
  reference: string,
  project?: string,
): Promise<HiveMessage | null> {
  const normalizedReference = reference.trim();

  if (!normalizedReference) {
    return null;
  }

  const messages = project
    ? await listProjectMessages(msgDir, project)
    : await listMessages(msgDir);
  const matches = messages.filter((message) => {
    const filenameWithoutExtension = message.filename.replace(/\.md$/, "");

    return (
      message.filename === normalizedReference ||
      filenameWithoutExtension === normalizedReference ||
      message.filename.startsWith(normalizedReference) ||
      filenameWithoutExtension.startsWith(normalizedReference)
    );
  });

  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

async function updateMessage(
  msgDir: string,
  input: UpdateMessageInput,
): Promise<HiveMessage | null> {
  const message = await findMessage(msgDir, input.reference, input.project);
  const timestamp = toIsoTimestamp(now());

  if (!message) {
    return null;
  }

  const attributes = {
    ...message.attributes,
    status: input.status,
    [input.status]: timestamp,
  };
  const bodyParts = [message.body.trim()];

  if (input.body?.trim()) {
    const sectionTitle = input.status === "resolved" ? "Answer" : "Closed";

    bodyParts.push(`## ${sectionTitle} (${input.actor}, ${timestamp})\n${input.body.trim()}`);
  }

  const raw = stringifyFrontmatter(attributes, bodyParts.filter(Boolean).join("\n\n"));
  const parsed = parseFrontmatter(raw);
  const normalizedAttributes = normalizeMessageAttributes(parsed.attributes, parsed.body);

  await Bun.write(message.path, raw);

  return {
    path: message.path,
    filename: message.filename,
    attributes: normalizedAttributes,
    body: parsed.body,
    raw: raw.trim(),
  };
}

export async function resolveMessage(
  msgDir: string,
  reference: string,
  actor: string,
  answer: string,
  project?: string,
): Promise<HiveMessage | null> {
  return updateMessage(msgDir, {
    reference,
    status: "resolved",
    actor,
    body: answer,
    project,
  });
}

export async function closeMessage(
  msgDir: string,
  reference: string,
  actor: string,
  note: string,
  project?: string,
): Promise<HiveMessage | null> {
  return updateMessage(msgDir, {
    reference,
    status: "closed",
    actor,
    body: note,
    project,
  });
}
