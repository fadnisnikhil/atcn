import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The ATCN-operated collector. There is none yet, so reports are only sent when ATCN_USAGE_URL is set. */
export const DEFAULT_USAGE_URL: string | null = null;

export type Env = Record<string, string | undefined>;

/** The saved choice. Shared with the Python SDK, which reads and writes the same file. */
export interface UsageSettings {
  share_usage: boolean;
  /** Random, created when the user opts in and deleted when they opt out. */
  installation_id: string | null;
  decided_at: string;
}

export interface UsageStatus {
  enabled: boolean;
  reason: string;
  installationId: string | null;
  url: string | null;
}

export function settingsPath(env: Env = process.env): string {
  return join(env.ATCN_CONFIG_DIR || join(homedir(), ".config", "atcn"), "usage.json");
}

export function readUsageSettings(env: Env = process.env): UsageSettings | null {
  const path = settingsPath(env);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UsageSettings;
  } catch {
    return null;
  }
}

/** Saves an explicit choice. Opting in keeps an existing installation ID or creates a random one; opting out deletes it. */
export function saveUsageChoice(shareUsage: boolean, env: Env = process.env): UsageSettings {
  const previous = readUsageSettings(env);
  const settings: UsageSettings = {
    share_usage: shareUsage,
    installation_id: shareUsage ? (previous?.installation_id ?? randomUUID()) : null,
    decided_at: new Date().toISOString(),
  };
  const path = settingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** The environment variable that turns reporting off, if one is set. It wins over any saved choice. */
export function disabledBy(env: Env = process.env): "ATCN_USAGE_DISABLED" | "DO_NOT_TRACK" | null {
  if (isSet(env.ATCN_USAGE_DISABLED)) return "ATCN_USAGE_DISABLED";
  if (isSet(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  return null;
}

/** Reporting is on only after an explicit yes, and ATCN_USAGE_DISABLED or DO_NOT_TRACK always turn it off. */
export function usageStatus(env: Env = process.env): UsageStatus {
  const url = env.ATCN_USAGE_URL || DEFAULT_USAGE_URL;
  const off = (reason: string): UsageStatus => ({ enabled: false, reason, installationId: null, url });
  const variable = disabledBy(env);
  if (variable) return off(`off: ${variable} is set`);
  const settings = readUsageSettings(env);
  if (!settings) return off("off: not chosen yet (run npx atcn init)");
  if (!settings.share_usage || !settings.installation_id) return off("off: you chose not to share usage metrics");
  if (!url) return off("off until a collector is configured (set ATCN_USAGE_URL)");
  return { enabled: true, reason: `on: sharing anonymous usage metrics with ${url}`, installationId: settings.installation_id, url };
}
