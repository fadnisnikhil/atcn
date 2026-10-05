import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { digestOf } from "@atcn/schema";
import {
  IMPORT_FIELDS,
  IMPORT_KINDS,
  IMPORT_PRESETS,
  importPresetRows,
  importRows,
  parseCsvRows,
  parseExportText,
  parseJsonlRows,
  type ImportField,
  type ImportKind,
  type ImportOptions,
  type ImportPreset,
  type ImportRow,
  type PresetImportResult,
  type PresetOptions,
} from "@atcn/subledger";
import { LocalRunnerError } from "./errors.js";
import { loadJob } from "./job.js";

export interface ImportSummary {
  added: number;
  /** Rows already in the job file with the same content. */
  deduplicated: number;
  /** Rows whose key is already in the job file with different content; the original is kept, as duplicate_event would. */
  conflicting: { source_event_id: string; row: number }[];
  /** Preset imports only: valid rows that carry no job cost, for example a Stripe payout. */
  skipped: { row: number; reason: string }[];
  errors: { row: number; error: string }[];
}

/** Parses repeated "field=column" pairs. */
export function parseColumnMap(pairs: string[]): Partial<Record<ImportField, string>> {
  const map: Partial<Record<ImportField, string>> = {};
  for (const pair of pairs) {
    const [field, column] = pair.split("=", 2);
    if (!column || !(IMPORT_FIELDS as readonly string[]).includes(field)) throw new LocalRunnerError(`--map ${pair}: use field=column with a field from ${IMPORT_FIELDS.join(", ")}`);
    map[field as ImportField] = column;
  }
  return map;
}

export function parseImportKind(kind: string): ImportKind {
  if (!(IMPORT_KINDS as readonly string[]).includes(kind)) throw new LocalRunnerError(`--kind ${kind}: use one of ${IMPORT_KINDS.join(", ")}`);
  return kind as ImportKind;
}

export function parseImportPreset(preset: string): ImportPreset {
  if (!(IMPORT_PRESETS as readonly string[]).includes(preset)) throw new LocalRunnerError(`--preset ${preset}: use one of ${IMPORT_PRESETS.join(", ")}`);
  return preset as ImportPreset;
}

/**
 * Reads a CSV or JSONL export and appends one financial event per row to the job file's financial_events. Rows are
 * keyed by (source, source_event_id): an identical row already in the job is skipped, a changed one is not added.
 */
export function importIntoJob(jobPath: string, filePath: string, options: ImportOptions): ImportSummary {
  const rows = readRows(filePath, (text) => (extname(filePath).toLowerCase() === ".csv" ? parseCsvRows(text) : parseJsonlRows(text)));
  return appendToJob(jobPath, { ...importRows(rows, options), skipped: [] });
}

/** Like importIntoJob, for a known export (LiteLLM, OpenRouter or Stripe) saved as JSON, JSONL or CSV. */
export function importPresetIntoJob(jobPath: string, filePath: string, preset: ImportPreset, options: PresetOptions = {}): ImportSummary {
  const rows = readRows(filePath, parseExportText);
  return appendToJob(jobPath, importPresetRows(preset, rows, options));
}

function readRows(filePath: string, parse: (text: string) => ImportRow[]): ImportRow[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new LocalRunnerError(`cannot read ${filePath}`);
  }
  try {
    return parse(text);
  } catch (error) {
    throw new LocalRunnerError(`${filePath}: ${(error as Error).message}`);
  }
}

function appendToJob(jobPath: string, { events, errors, skipped }: PresetImportResult): ImportSummary {
  const job = loadJob(jobPath) as { financial_events?: Record<string, unknown>[] };
  const existing = job.financial_events ?? [];
  const summary: ImportSummary = { added: 0, deduplicated: 0, conflicting: [], skipped, errors };
  for (const { row, event } of events) {
    const same = existing.find((e) => e.source === event.source && e.source_event_id === event.source_event_id);
    if (!same) {
      existing.push(event);
      summary.added += 1;
    } else if (digestOf(same) === digestOf(event)) summary.deduplicated += 1;
    else summary.conflicting.push({ source_event_id: String(event.source_event_id), row });
  }
  job.financial_events = existing;
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`);
  return summary;
}
