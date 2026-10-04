import { digestOf } from "@atcn/schema";
import { EXPECTATION_ISSUERS, HOLD_STATUSES, type ExpectationIssuer } from "./types.js";

/**
 * Turns rows of an external export (a provider bill, a gateway's estimate/hold log) into financial event bodies.
 * Rows come from CSV or JSONL; a column map names which column feeds which field. Unsigned: imported rows are
 * buyer_recorded, whoever produced the export.
 */

export type ImportRow = Record<string, unknown>;
export type ImportKind = "charge" | "invoice" | "estimate" | "hold";
export const IMPORT_KINDS: readonly ImportKind[] = ["charge", "invoice", "estimate", "hold"];

/** Fields a column can feed. amount_major is a decimal amount ("1.25") converted exactly to minor units. */
export const IMPORT_FIELDS = [
  "source_event_id",
  "amount_minor",
  "amount_major",
  "currency",
  "event_date",
  "provider_reference",
  "provider_status",
  "provider_job_ref",
  "task_external_ref",
  "delegation_external_ref",
  "issued_by",
  "source_ref",
  "basis",
  "expires_at",
  "supersedes",
  "hold_status",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export interface ImportOptions {
  kind: ImportKind;
  /** The financial event source, for example "gamma-billing" or "cost-gateway". */
  source: string;
  /** Field -> column. A field without an entry reads the column of the same name. */
  map?: Partial<Record<ImportField, string>>;
  /** Used when no currency column is mapped or present. */
  currency?: string;
  /** Who issued imported estimates and holds when no issued_by column is given (default "gateway"). */
  issuedBy?: ExpectationIssuer;
  /**
   * Columns that identify a row when the export has no stable event id. The key is a hash of their canonical JSON,
   * so an exact replay deduplicates and a replay that changes any other field is refused as duplicate_event.
   */
  keyColumns?: string[];
  /** Digits after the decimal point for amount_major (default 2). */
  minorDigits?: number;
}

/** RFC 4180 CSV with a header row: comma separated, double-quoted fields, doubled quotes inside quotes. */
export function parseCsvRows(text: string): ImportRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return data.map((cells) => Object.fromEntries(names.map((name, i) => [name, (cells[i] ?? "").trim()])));
}

/** One JSON object per line; blank lines are skipped. */
export function parseJsonlRows(text: string): ImportRow[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "")
    .map(({ line, number }) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`line ${number} is not JSON: ${(error as Error).message}`);
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`line ${number} is not a JSON object`);
      return value as ImportRow;
    });
}

/** A source_event_id derived from the canonical JSON of a row's identifying columns. */
export function derivedSourceEventId(identity: Record<string, unknown>): string {
  return `jcs-${digestOf(identity)}`;
}

/** Converts "12.5" to 1250 with 2 minor digits, using string arithmetic so no floating point rounding occurs. */
export function majorToMinor(value: string, minorDigits = 2): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`amount ${JSON.stringify(value)} is not a decimal number`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > minorDigits) throw new Error(`amount ${value} has more than ${minorDigits} decimal places`);
  const minor = Number(whole + fraction.padEnd(minorDigits, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error(`amount ${value} is too large`);
  return sign === "-" ? -minor : minor;
}

/** A financial event body for one row. Throws with a readable message when a required value is missing. */
export function financialEventFromRow(row: ImportRow, options: ImportOptions): Record<string, unknown> {
  const columnOf = (field: ImportField) => options.map?.[field] ?? field;
  const text = (field: ImportField): string | null => {
    const value = row[columnOf(field)];
    if (value === undefined || value === null || value === "") return null;
    return typeof value === "string" ? value : String(value);
  };
  const required = (field: ImportField): string => {
    const value = text(field);
    if (value === null) throw new Error(`missing ${field} (column ${columnOf(field)})`);
    return value;
  };

  let amount: number;
  if (text("amount_minor") !== null) {
    amount = Number(text("amount_minor"));
    if (!Number.isSafeInteger(amount)) throw new Error(`amount_minor ${text("amount_minor")} is not a whole number`);
  } else if (text("amount_major") !== null) {
    amount = majorToMinor(text("amount_major")!, options.minorDigits ?? 2);
  } else {
    throw new Error(`missing amount (column ${columnOf("amount_minor")} or ${columnOf("amount_major")})`);
  }

  let sourceEventId = text("source_event_id");
  if (sourceEventId === null) {
    if (!options.keyColumns || options.keyColumns.length === 0) throw new Error(`missing source_event_id (column ${columnOf("source_event_id")}); name the identifying columns with keyColumns`);
    const identity = Object.fromEntries(options.keyColumns.map((column) => [column, row[column] ?? null]));
    if (Object.values(identity).every((value) => value === null || value === "")) throw new Error(`key columns ${options.keyColumns.join(", ")} are all empty`);
    sourceEventId = derivedSourceEventId(identity);
  }

  const body: Record<string, unknown> = {
    type: options.kind,
    source: options.source,
    source_event_id: sourceEventId,
    provider_reference: text("provider_reference"),
    provider_status: text("provider_status"),
    amount_minor: amount,
    currency: text("currency") ?? options.currency ?? required("currency"),
    event_date: isoDate(required("event_date"), "event_date"),
    match: {
      provider_job_ref: text("provider_job_ref"),
      task_external_ref: text("task_external_ref"),
      delegation_external_ref: text("delegation_external_ref"),
    },
  };
  if (options.kind === "estimate" || options.kind === "hold") {
    const issuedBy = text("issued_by") ?? options.issuedBy ?? "gateway";
    if (!EXPECTATION_ISSUERS.includes(issuedBy as ExpectationIssuer)) throw new Error(`issued_by ${issuedBy} is not one of ${EXPECTATION_ISSUERS.join(", ")}`);
    const holdStatus = text("hold_status") ?? "open";
    if (options.kind === "hold" && !(HOLD_STATUSES as readonly string[]).includes(holdStatus)) throw new Error(`hold_status ${holdStatus} is not one of ${HOLD_STATUSES.join(", ")}`);
    const expiresAt = text("expires_at");
    body.expectation = {
      issued_by: issuedBy,
      source_ref: text("source_ref"),
      basis: text("basis"),
      expires_at: expiresAt === null ? null : isoDate(expiresAt, "expires_at"),
      supersedes: text("supersedes"),
      ...(options.kind === "hold" ? { hold_status: holdStatus } : {}),
    };
  }
  return body;
}

function isoDate(value: string, field: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`${field} ${JSON.stringify(value)} is not a date`);
  return new Date(time).toISOString();
}

export interface ImportResult {
  /** Each event with the 1-based number of the row it came from. */
  events: { row: number; event: Record<string, unknown> }[];
  errors: { row: number; error: string }[];
}

/** Converts every row; a bad row is reported by its 1-based number without stopping the others. */
export function importRows(rows: ImportRow[], options: ImportOptions): ImportResult {
  const result: ImportResult = { events: [], errors: [] };
  rows.forEach((row, index) => {
    try {
      result.events.push({ row: index + 1, event: financialEventFromRow(row, options) });
    } catch (error) {
      result.errors.push({ row: index + 1, error: (error as Error).message });
    }
  });
  return result;
}
