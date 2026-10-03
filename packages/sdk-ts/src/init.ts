import { parseArgs } from "node:util";
import { askToShareUsage, saveUsageChoice, sendUsageReport, settingsPath, usageStatus, type ConsentIo, type Env } from "@atcn/usage";
import { SDK_VERSION } from "./client.js";

const USAGE = "usage: atcn init [--share-usage yes|no]";

export interface CliOptions {
  env?: Env;
  io?: ConsentIo;
  interactive?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * `atcn init` records whether this machine shares anonymous usage metrics, by flag or by asking. On a yes it
 * reports `integration_initialized`. Returns the process exit code: 0 saved, 2 usage error or no answer.
 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { "share-usage": { type: "string" } }, allowPositionals: true });
  } catch {
    error(USAGE);
    return 2;
  }
  const flag = parsed.values["share-usage"];
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "init" || (flag !== undefined && flag !== "yes" && flag !== "no")) {
    error(USAGE);
    return 2;
  }

  let shared: boolean | null;
  if (flag !== undefined) shared = saveUsageChoice(flag === "yes", env).share_usage;
  else if (options.interactive ?? process.stdin.isTTY === true) shared = await askToShareUsage(options.io, env);
  else {
    error("Not an interactive terminal: pass --share-usage yes or --share-usage no.");
    return 2;
  }
  if (shared === null) {
    error("No answer given; nothing saved.");
    return 2;
  }

  if (shared) {
    await sendUsageReport({ event: "integration_initialized", sdk_version: `typescript/${SDK_VERSION}`, workflow: "custom", delegations: null, charges: null }, { env, fetch: options.fetch });
  }
  log(`Saved your choice to ${settingsPath(env)}.`);
  log(`Usage metrics: ${usageStatus(env).reason}.`);
  return 0;
}
