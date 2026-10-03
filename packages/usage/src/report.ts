import { z } from "zod";
import { usageStatus, type Env } from "./settings.js";

export const USAGE_EVENTS = ["integration_initialized", "task_closed", "closure_verified", "exception_resolved"] as const;
/** For example `typescript/1.3.0` or `python/1.3.0`: the SDK language and version, nothing else. */
export const SDK_VERSION_PATTERN = /^(typescript|python)\/\d+\.\d+\.\d+$/;

/** Everything a report may contain. Unknown fields are rejected, so nothing else can be sent by mistake. */
export const UsageReportSchema = z.strictObject({
  installation_id: z.uuid(),
  event: z.enum(USAGE_EVENTS),
  occurred_at: z.iso.datetime(),
  sdk_version: z.string().regex(SDK_VERSION_PATTERN).nullable(),
  workflow: z.enum(["demo", "custom"]),
  delegations: z.number().int().min(0).max(1_000_000).nullable(),
  charges: z.number().int().min(0).max(1_000_000).nullable(),
});

export type UsageReport = z.infer<typeof UsageReportSchema>;
export type UsageEvent = Omit<UsageReport, "installation_id" | "occurred_at">;

export interface SendOptions {
  env?: Env;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends one report if the user opted in, adding the installation ID and timestamp. Never throws and gives up after
 * `timeoutMs`, so reporting cannot change what ATCN does. Returns whether the collector accepted the report.
 */
export async function sendUsageReport(event: UsageEvent, options: SendOptions = {}): Promise<boolean> {
  const status = usageStatus(options.env);
  if (!status.enabled || !status.installationId || !status.url) return false;
  const report: UsageReport = { installation_id: status.installationId, occurred_at: new Date().toISOString(), ...event };
  try {
    const response = await (options.fetch ?? fetch)(status.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
