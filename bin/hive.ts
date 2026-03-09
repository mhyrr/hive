#!/usr/bin/env bun

import { runCli } from "../src/cli";
import { UsageError } from "../src/lib/errors";

async function main(): Promise<void> {
  try {
    const output = await runCli(Bun.argv.slice(2));

    if (output) {
      console.log(output);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}

await main();
