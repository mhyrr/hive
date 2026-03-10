import { toLogHeading } from "./time";

export async function appendLogEntry(
  logPath: string,
  actor: string,
  message: string,
): Promise<void> {
  const existing = await Bun.file(logPath).text();
  const nextContent = `${existing.trimEnd()}\n\n${toLogHeading(actor)}\n${message.trim()}\n`;

  await Bun.write(logPath, nextContent);
}
