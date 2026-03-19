import { dirname } from "node:path";

import { ensureDirectory } from "./paths";

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = (await Bun.file(path).text()).trim();

    if (!text) {
      return null;
    }

    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}
