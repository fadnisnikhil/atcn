import type { PublicKeyRecord } from "@atcn/schema";
import type {
  CaptureGapInputSchema,
  CurrencyTotals,
  DelegationEventInputSchema,
  DelegationInputSchema,
  FinancialEventInput,
  SignedClosure,
  TaskInputSchema,
} from "@atcn/subledger";
import type { z } from "zod";

export type TaskBody = z.input<typeof TaskInputSchema>;
export type DelegationBody = z.input<typeof DelegationInputSchema>;
export type DelegationEventBody = z.input<typeof DelegationEventInputSchema>;
export type CaptureGapBody = z.input<typeof CaptureGapInputSchema>;

export interface FinancialEventOutcome {
  financial_event: { financial_event_id: string; type: string };
  deduplicated: boolean;
  attribution: { task_id: string; delegation_id: string | null } | null;
  exception_ids: string[];
}

export interface TaskSummary {
  totals_by_currency: CurrencyTotals;
  open_exceptions: { exception_id: string; kind: string; detail: string }[];
}

/**
 * Where the tools record to: the in-process local subledger, or the hosted ATCN API. Task and delegation references
 * accept either the ID or "ext:<external_ref>". Results are the full records; the types name only what the tools read.
 */
export interface Backend {
  readonly mode: "local" | "hosted";
  createTask(input: TaskBody): Promise<{ task_id: string }>;
  createDelegation(taskRef: string, input: DelegationBody): Promise<{ delegation_id: string }>;
  appendDelegationEvent(delegationRef: string, input: DelegationEventBody): Promise<{ event_id: string }>;
  recordFinancialEvent(input: FinancialEventInput): Promise<FinancialEventOutcome>;
  addProvider(name: string, providerOwnId: string | null): Promise<{ provider_id: string }>;
  bindProviderKey(providerId: string, keyId: string, publicKey: string): Promise<{ binding_id: string }>;
  reportCaptureGap(taskRef: string, input: CaptureGapBody): Promise<{ gap_id: string }>;
  taskSummary(taskRef: string): Promise<TaskSummary>;
  closeTask(taskRef: string): Promise<{ closure: SignedClosure; digest: string }>;
  /** The service keys that sign this backend's closures, trusted automatically by verify_document. */
  trustedKeys(): Promise<PublicKeyRecord[]>;
}
