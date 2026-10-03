import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { sendUsageReport, type SendOptions } from "./report.js";
import { disabledBy, readUsageSettings, saveUsageChoice, type Env } from "./settings.js";

export const CONSENT_QUESTION = "Share anonymous usage metrics to help improve ATCN?";
export const CONSENT_EXPLANATION = [
  "If you answer yes, this machine sends: a random installation ID, the event (integration initialized, task closed,",
  "closure verified, exception resolved), a timestamp, the SDK version, whether it was a demo, and counts of",
  "delegations and charges. Never task data, references, amounts, names, or keys.",
  "Change your answer with `npx atcn init`, or turn reporting off with ATCN_USAGE_DISABLED=1. Details: docs/USAGE_DATA.md",
].join("\n");

export interface ConsentIo {
  input: Readable;
  output: Writable;
}

/**
 * Asks the question and saves the answer. Only y/yes or n/no count; anything else asks again. Returns null, saving
 * nothing, if the input closes before an answer.
 */
export async function askToShareUsage(io: ConsentIo = { input: process.stdin, output: process.stdout }, env: Env = process.env): Promise<boolean | null> {
  const rl = createInterface({ input: io.input, terminal: false });
  const prompt = `${CONSENT_QUESTION} [y/n] `;
  try {
    io.output.write(`${CONSENT_EXPLANATION}\n${prompt}`);
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "y" || answer === "yes") return saveUsageChoice(true, env).share_usage;
      if (answer === "n" || answer === "no") return saveUsageChoice(false, env).share_usage;
      io.output.write(prompt);
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * First-run question for the bundled quickstart and demo. Asks only in an interactive terminal, only if no choice is
 * saved and reporting isn't turned off by environment. On a yes, reports `integration_initialized` for the demo.
 */
export async function askOnFirstRun(sdkVersion: string, options: SendOptions & { io?: ConsentIo; interactive?: boolean } = {}): Promise<void> {
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive || readUsageSettings(env) || disabledBy(env)) return;
  const shared = await askToShareUsage(options.io, env);
  if (shared) await sendUsageReport({ event: "integration_initialized", sdk_version: sdkVersion, workflow: "demo", delegations: null, charges: null }, options);
}
