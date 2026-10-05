import { derivedSourceEventId, majorToMinor, parseCsvRows, parseJsonlRows, type ImportResult, type ImportRow } from "./importing.js";

/**
 * Ready-made mappings for widely used cost exports, so no column map is needed.
 *
 * - litellm: LiteLLM proxy spend logs (`/spend/logs/v2` or `/spend/logs`). The job reference is `end_user`, the
 *   OpenAI `user` field the agent sent with the request.
 * - openrouter: OpenRouter analytics query rows (`POST /api/v1/analytics/query`) with metric `total_usage`, dimension
 *   `external_user` and granularity `day`. The job reference is `external_user`, the `user` field of the request.
 * - stripe: Stripe itemized balance report (`balance_change_from_activity.itemized`) with the extra columns
 *   `payment_metadata[atcn_job_ref]` and `transfer_metadata[atcn_job_ref]`.
 *
 * LLM spend is reported in fractions of a cent, so it is summed exactly per job reference per UTC day and rounded half
 * up to whole cents once. Re-importing a finished day replays the same events; importing a day again after more
 * requests landed changes its amount and is refused as duplicate_event, so import closed days.
 */
export type ImportPreset = "litellm" | "openrouter" | "stripe";
export const IMPORT_PRESETS: readonly ImportPreset[] = ["litellm", "openrouter", "stripe"];

/** Metadata key on Stripe PaymentIntents and transfers that holds the ATCN job reference. */
export const STRIPE_JOB_REF_KEY = "atcn_job_ref";

export interface PresetOptions {
  /** The financial event source (default: the preset name). */
  source?: string;
}

export interface PresetImportResult extends ImportResult {
  /** Rows that are valid but carry no job cost, for example a Stripe payout or a request sent without a user field. */
  skipped: { row: number; reason: string }[];
}

/** Rows of a JSON export: an array of objects, or an object wrapping one in `data` (LiteLLM) or `data.data` (OpenRouter). */
export function exportRowsFromJson(value: unknown): ImportRow[] {
  let items: unknown = value;
  if (isObject(items) && "data" in items) items = items.data;
  if (isObject(items) && "data" in items) items = items.data;
  if (isObject(items)) items = [items];
  if (!Array.isArray(items)) throw new Error("JSON export must be an array of rows or an object with a data array");
  return items.map((item, index) => {
    if (!isObject(item)) throw new Error(`row ${index + 1} is not a JSON object`);
    return item;
  });
}

/** Reads an export saved as JSON, JSONL or CSV. */
export function parseExportText(text: string): ImportRow[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return parseCsvRows(text);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return parseJsonlRows(text);
  }
  return exportRowsFromJson(value);
}

/** Converts rows of a known export into financial event bodies. */
export function importPresetRows(preset: ImportPreset, rows: ImportRow[], options: PresetOptions = {}): PresetImportResult {
  const source = options.source ?? preset;
  if (preset === "litellm") return importDailySpend(rows, { ref: "end_user", date: "startTime", amount: "spend" }, source);
  if (preset === "openrouter") return importDailySpend(rows, { ref: "external_user", date: "date__day", amount: "total_usage" }, source);
  return importStripeBalanceRows(rows, source);
}

interface DailySpendColumns {
  ref: string;
  date: string;
  amount: string;
}

/** Fixed-point scale for summing sub-cent USD spend: 18 decimal places. */
const SPEND_SCALE = 18;

function importDailySpend(rows: ImportRow[], columns: DailySpendColumns, source: string): PresetImportResult {
  const result: PresetImportResult = { events: [], errors: [], skipped: [] };
  const groups = new Map<string, { row: number; ref: string; day: string; total: bigint }>();
  rows.forEach((row, index) => {
    const number = index + 1;
    const ref = text(row[columns.ref]);
    if (ref === null) {
      result.skipped.push({ row: number, reason: `no ${columns.ref}: send the ATCN job reference as the request's user field` });
      return;
    }
    try {
      const day = utcIso(row[columns.date], columns.date).slice(0, 10);
      const amount = spendToScaled(row[columns.amount], columns.amount);
      const key = JSON.stringify([ref, day]);
      const group = groups.get(key) ?? { row: number, ref, day, total: 0n };
      group.total += amount;
      groups.set(key, group);
    } catch (error) {
      result.errors.push({ row: number, error: (error as Error).message });
    }
  });

  const cent = 10n ** BigInt(SPEND_SCALE - 2);
  for (const group of groups.values()) {
    const amountMinor = Number((group.total + cent / 2n) / cent);
    if (amountMinor === 0) {
      result.skipped.push({ row: group.row, reason: `spend for ${group.ref} on ${group.day} rounds to 0 cents` });
      continue;
    }
    result.events.push({
      row: group.row,
      event: {
        type: "charge",
        source,
        source_event_id: derivedSourceEventId({ provider_job_ref: group.ref, day: group.day }),
        provider_reference: null,
        provider_status: null,
        amount_minor: amountMinor,
        currency: "USD",
        event_date: `${group.day}T00:00:00.000Z`,
        match: { provider_job_ref: group.ref, task_external_ref: null, delegation_external_ref: null },
      },
    });
  }
  result.events.sort((a, b) => a.row - b.row);
  result.skipped.sort((a, b) => a.row - b.row);
  return result;
}

/** A non-negative decimal (a JSON number or a string, exponent allowed) as an integer at SPEND_SCALE. */
function spendToScaled(value: unknown, column: string): bigint {
  const decimal = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(decimal);
  if (!match || (match[1] === "" && !match[2])) throw new Error(`${column} ${JSON.stringify(value)} is not a non-negative decimal number`);
  const [, whole, fraction = "", exponent = "0"] = match;
  const digits = BigInt(whole + fraction || "0");
  const shift = SPEND_SCALE - fraction.length + Number(exponent);
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (digits + divisor / 2n) / divisor;
}

/** Stripe reporting categories that are job cost, the event type each becomes, and the column holding the job reference. */
const STRIPE_CATEGORIES: Record<string, { type: "charge" | "refund" | "payment_reported"; refColumn: string }> = {
  charge: { type: "charge", refColumn: `payment_metadata[${STRIPE_JOB_REF_KEY}]` },
  refund: { type: "refund", refColumn: `payment_metadata[${STRIPE_JOB_REF_KEY}]` },
  transfer: { type: "payment_reported", refColumn: `transfer_metadata[${STRIPE_JOB_REF_KEY}]` },
  // A reversal event needs the ATCN id of the event it reverses, which the export cannot know: money a provider
  // returns from a transfer is recorded as a refund.
  transfer_reversal: { type: "refund", refColumn: `transfer_metadata[${STRIPE_JOB_REF_KEY}]` },
};

/** ISO 4217 currencies Stripe reports without minor units, and those with three decimal places. */
const ZERO_DECIMAL_CURRENCIES = ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];
const THREE_DECIMAL_CURRENCIES = ["BHD", "JOD", "KWD", "OMR", "TND"];

function importStripeBalanceRows(rows: ImportRow[], source: string): PresetImportResult {
  const result: PresetImportResult = { events: [], errors: [], skipped: [] };
  rows.forEach((row, index) => {
    const number = index + 1;
    const category = text(row.reporting_category) ?? "";
    const mapping = STRIPE_CATEGORIES[category];
    if (!mapping) {
      result.skipped.push({ row: number, reason: `reporting_category ${category || "(empty)"} is not job cost` });
      return;
    }
    const ref = text(row[mapping.refColumn]);
    if (ref === null) {
      result.skipped.push({ row: number, reason: `no ${mapping.refColumn}` });
      return;
    }
    try {
      const sourceEventId = text(row.balance_transaction_id);
      if (sourceEventId === null) throw new Error("missing balance_transaction_id");
      const currency = (text(row.currency) ?? "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currency ${JSON.stringify(row.currency ?? null)} is not an ISO 4217 code`);
      const gross = text(row.gross);
      if (gross === null) throw new Error("missing gross");
      const created = row.created_utc ?? row.created;
      result.events.push({
        row: number,
        event: {
          type: mapping.type,
          source,
          source_event_id: sourceEventId,
          provider_reference: text(row.source_id),
          provider_status: null,
          amount_minor: Math.abs(stripeMajorToMinor(gross, currency)),
          currency,
          event_date: utcIso(created, row.created_utc !== undefined ? "created_utc" : "created"),
          match: { provider_job_ref: ref, task_external_ref: null, delegation_external_ref: null },
        },
      });
    } catch (error) {
      result.errors.push({ row: number, error: (error as Error).message });
    }
  });
  return result;
}

/** Stripe reports amounts in major units; zeros past the currency's decimal places (JPY "500.00") are dropped. */
function stripeMajorToMinor(value: string, currency: string): number {
  const digits = ZERO_DECIMAL_CURRENCIES.includes(currency) ? 0 : THREE_DECIMAL_CURRENCIES.includes(currency) ? 3 : 2;
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.length > digits ? fraction.slice(0, digits) + fraction.slice(digits).replace(/0+$/, "") : fraction;
  return majorToMinor(trimmedFraction ? `${whole}.${trimmedFraction}` : whole, digits);
}

/** An ISO timestamp; a date or date-time without a zone is read as UTC, as LiteLLM and Stripe write them. */
function utcIso(value: unknown, column: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const zoneless = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(raw);
  const time = Date.parse(zoneless ? `${raw.replace(" ", "T")}${raw.length > 10 ? "Z" : ""}` : raw);
  if (raw === "" || Number.isNaN(time)) throw new Error(`${column} ${JSON.stringify(value ?? null)} is not a date`);
  return new Date(time).toISOString();
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result === "" ? null : result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
