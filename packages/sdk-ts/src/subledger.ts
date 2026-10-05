import type { z } from "zod";
import {
  buildResponseStatement,
  countersignPayload,
  signStatement,
  type AllocationInputSchema,
  type AllocationRuleInputSchema,
  type AttestableField,
  type CaptureGapInput,
  type Correction,
  type DelegationEventInputSchema,
  type DelegationInputSchema,
  type EvidenceRef,
  type ExpectationIssuer,
  type FinancialEventInput,
  type ImportField,
  type OperatorKeyRecord,
  type OperatorSignature,
  type ProviderInputSchema,
  type RailAttestation,
  type ResponseType,
  type SignedClosure,
  type SignedReceipt,
  type TaskInputSchema,
} from "@atcn/subledger";
import { sha256Digest, type AttestationRef, type ExecutionBinding } from "@atcn/schema";
import { AtcnApiError, AtcnClient, type ClientOptions } from "./client.js";

type Json = Record<string, unknown>;
type Opts = { idempotencyKey?: string };
/**
 * How the hosted importer reads a CSV export: key_columns is a comma-separated list of columns that identify a row,
 * map names the export's column for an import field, and minor_digits is the decimal places of amount_major (default 2).
 * preset reads a LiteLLM, OpenRouter or Stripe export (CSV, JSON or JSONL) without a column map.
 */
type CsvImportOptions = {
  preset?: "litellm" | "openrouter" | "stripe";
  kind?: "charge" | "invoice" | "estimate" | "hold";
  source?: string;
  key_columns?: string;
  currency?: string;
  issued_by?: ExpectationIssuer;
  map?: Partial<Record<ImportField, string>>;
  minor_digits?: number;
};

/** Caller-supplied references address records before their server IDs are known: ext("job-42"). */
export const ext = (externalRef: string) => `ext:${externalRef}`;

/** Idempotency key derived from the caller's stable references; long references are hashed to fit 8-200 chars. */
export function stableKey(kind: string, ...parts: string[]): string {
  const key = `sl:${kind}:${parts.join(":")}`;
  return key.length <= 200 ? key : `sl:${kind}:${sha256Digest(parts.join(":"))}`;
}

/**
 * Small, independent subledger operations (PRD §15). Default idempotency keys derive from the caller's own
 * stable references, so a retry from anywhere in the orchestrator never creates a second record.
 */
export class SubledgerClient {
  readonly http: AtcnClient;

  constructor(options: ClientOptions | AtcnClient) {
    this.http = options instanceof AtcnClient ? options : new AtcnClient(options);
  }

  createTask(input: z.input<typeof TaskInputSchema>, opts: Opts = {}) {
    return this.http.request<Json>("POST", "/v1/tasks", input, { idempotencyKey: opts.idempotencyKey ?? stableKey("task", input.external_ref) });
  }
  getTask(taskId: string) {
    return this.http.request<Json>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }
  listTasks(query: { status?: "open" | "closed"; external_ref?: string } = {}) {
    return this.http.request<{ items: Json[] }>("GET", "/v1/tasks", undefined, { query });
  }
  /** Admin only. Principals are "user:<id>" or "api_key:<id>". */
  getTaskAccess(taskId: string) {
    return this.http.request<Json>("GET", `/v1/tasks/${encodeURIComponent(taskId)}/access`);
  }
  updateTaskAccess(taskId: string, input: { restricted?: boolean; grant?: string[]; revoke?: string[] }, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/access`, input, opts);
  }
  createDelegation(taskId: string, input: z.input<typeof DelegationInputSchema>, opts: Opts = {}) {
    const key = opts.idempotencyKey ?? (input.external_ref ? stableKey("delegation", input.external_ref) : undefined);
    return this.http.request<Json>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/delegations`, input, { idempotencyKey: key });
  }
  assignProvider(delegationId: string, providerId: string, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/delegations/${encodeURIComponent(delegationId)}/provider`, { provider_id: providerId }, opts);
  }
  appendDelegationEvent(delegationId: string, input: z.input<typeof DelegationEventInputSchema>, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/delegations/${encodeURIComponent(delegationId)}/events`, input, opts);
  }
  recordFinancialEvent(input: FinancialEventInput, opts: Opts = {}) {
    return this.http.request<{ financial_event: Json; deduplicated: boolean; attributed?: boolean; attribution: Json | null; match_id: string | null; exception_ids: string[] }>(
      "POST",
      "/v1/financial-events",
      input,
      { idempotencyKey: opts.idempotencyKey ?? stableKey("financial", input.source, input.source_event_id) },
    );
  }
  recordRailAttestation(input: { attestation: RailAttestation; source: string; match?: Record<string, string>; event_date?: string }, opts: Opts = {}) {
    return this.http.request<{ financial_event: Json; deduplicated: boolean; attributed?: boolean; attribution: Json | null; match_id: string | null; exception_ids: string[] }>(
      "POST",
      "/v1/financial-events/rail-attestations",
      input,
      opts,
    );
  }
  importCsv(csv: string, opts: Opts & CsvImportOptions = {}) {
    const { idempotencyKey, map, ...query } = opts;
    return this.http.request<{ imported: number; deduplicated: number; rejected: number; skipped?: number; rows: Json[] }>("POST", "/v1/financial-events/import", undefined, {
      idempotencyKey,
      query: { ...query, map: map === undefined ? undefined : JSON.stringify(map) },
      textBody: { contentType: "text/csv", text: csv },
    });
  }
  listFinancialEvents(query: { unattributed?: "true" | "false"; source?: string } = {}) {
    return this.http.request<{ items: Json[] }>("GET", "/v1/financial-events", undefined, { query });
  }
  allocate(financialEventId: string, input: z.input<typeof AllocationInputSchema>, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/financial-events/${financialEventId}/allocations`, input, opts);
  }
  createAllocationRule(input: z.input<typeof AllocationRuleInputSchema>, opts: Opts = {}) {
    return this.http.request<Json>("POST", "/v1/allocation-rules", input, opts);
  }
  listMatches(status?: "pending" | "confirmed" | "dismissed") {
    return this.http.request<{ items: Json[] }>("GET", "/v1/matches", undefined, { query: { status } });
  }
  confirmMatch(matchId: string, node: { task_id: string; delegation_id?: string | null }, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/matches/${matchId}/confirm`, node, opts);
  }
  financialSummary(taskId: string, query: { report_currency?: string; as_of?: string } = {}) {
    return this.http.request<Json>("GET", `/v1/tasks/${encodeURIComponent(taskId)}/financial-summary`, undefined, { query });
  }
  listExceptions(query: { task_id?: string; status?: "open" | "resolved" | "dismissed" } = {}) {
    return this.http.request<{ items: Json[] }>("GET", "/v1/subledger-exceptions", undefined, { query });
  }
  resolveException(exceptionId: string, input: { status: "resolved" | "dismissed"; resolution: string }, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/subledger-exceptions/${exceptionId}/resolve`, input, opts);
  }
  reportCaptureGap(taskId: string, gap: { delegation_id?: string | null; kind: CaptureGapInput["kind"]; detail: string }, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/capture-gaps`, gap, opts);
  }
  closeTask(taskId: string, opts: Opts = {}) {
    return this.http.request<{ closure: SignedClosure; digest: string }>("POST", `/v1/tasks/${taskId}/close`, {}, opts);
  }
  getClosure(taskId: string, version?: number) {
    return this.http.request<SignedClosure>("GET", `/v1/tasks/${taskId}/closure`, undefined, { query: { version } });
  }
  createReceipt(taskId: string, delegationId: string, opts: Opts = {}) {
    return this.http.request<{ receipt: SignedReceipt; digest: string }>("POST", `/v1/tasks/${taskId}/receipts`, { delegation_id: delegationId }, opts);
  }
  getReceipt(receiptId: string) {
    return this.http.request<SignedReceipt>("GET", `/v1/receipts/${receiptId}`);
  }
  markReceiptDelivered(receiptId: string, channel: string, reference: string | null = null, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/receipts/${receiptId}/delivered`, { channel, reference }, opts);
  }
  createReceiptShare(receiptId: string, allowedActions: string[] = ["view"], ttlHours?: number, opts: Opts = {}) {
    return this.http.request<{ share_id: string; token: string; url: string; expires_at: string; allowed_actions: string[] }>(
      "POST",
      "/v1/receipt-shares",
      { receipt_id: receiptId, allowed_actions: allowedActions, ttl_hours: ttlHours },
      opts,
    );
  }
  /** A witness link: lets another provider (not the delegation's own) sign that it observed the run. It allows only viewing and witnessing. */
  createWitnessShare(receiptId: string, witnessProviderId: string, ttlHours?: number, opts: Opts = {}) {
    return this.http.request<{ share_id: string; token: string; url: string; expires_at: string; allowed_actions: string[]; witness_provider_id: string }>(
      "POST",
      "/v1/receipt-shares",
      { receipt_id: receiptId, allowed_actions: ["view", "witness_attestation"], ttl_hours: ttlHours, witness_provider_id: witnessProviderId },
      opts,
    );
  }
  revokeReceiptShare(shareId: string, opts: Opts = {}) {
    return this.http.request<Json>("DELETE", `/v1/receipt-shares/${shareId}`, undefined, opts);
  }
  listResponses(receiptId: string) {
    return this.http.request<{ items: Json[] }>("GET", `/v1/receipts/${receiptId}/responses`);
  }
  /** Accepting appends the corrected records. A correction of financial fields needs the corrected events in `financialEvents`. */
  decideCorrection(responseId: string, status: "accepted" | "rejected", reason: string, opts: Opts & { financialEvents?: FinancialEventInput[] } = {}) {
    const body = { status, reason, financial_events: opts.financialEvents ?? [] };
    return this.http.request<Json>("POST", `/v1/receipt-responses/${responseId}/decision`, body, { idempotencyKey: opts.idempotencyKey });
  }
  createProvider(input: z.input<typeof ProviderInputSchema>, opts: Opts = {}) {
    return this.http.request<Json>("POST", "/v1/provider-identities", input, { idempotencyKey: opts.idempotencyKey ?? stableKey("provider", input.name) });
  }
  bindProviderKey(providerId: string, keyId: string, publicKey: string, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/provider-identities/${providerId}/key-bindings`, { key_id: keyId, public_key: publicKey }, opts);
  }
  /** Admin only. The provider publishes the returned txt_value at txt_name; then call verifyDomainChallenge. */
  startDomainChallenge(providerId: string, input: { key_id: string; public_key: string; domain?: string }, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/provider-identities/${providerId}/domain-challenges`, input, opts);
  }
  verifyDomainChallenge(challengeId: string, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/domain-challenges/${challengeId}/verify`, {}, opts);
  }
  /** Admin only. Registers the public half of a key the operator holds; the private key stays with the operator. */
  registerOperatorKey(keyId: string, publicKey: string, opts: Opts = {}) {
    return this.http.request<Json>("POST", "/v1/operator-keys", { key_id: keyId, public_key: publicKey }, opts);
  }
  revokeOperatorKey(keyId: string, reason: string, opts: Opts = {}) {
    return this.http.request<Json>("POST", `/v1/operator-keys/${encodeURIComponent(keyId)}/revoke`, { reason }, opts);
  }
  operatorKeys(operatorId: string) {
    return this.http.request<{ items: OperatorKeyRecord[] }>("GET", `/v1/operators/${operatorId}/keys`);
  }
  /** Signs the document's payload locally with the operator's private key and records the countersignature. */
  countersign(signed: SignedClosure | SignedReceipt, keyId: string, privateKey: string, opts: Opts = {}) {
    const signature = countersignPayload(signed.payload, privateKey);
    const path = "closure_id" in signed.payload ? `closures/${signed.payload.closure_id}` : `receipts/${signed.payload.receipt_id}`;
    return this.http.request<OperatorSignature>("POST", `/v1/${path}/countersign`, { key_id: keyId, signature }, opts);
  }
  productMetrics() {
    return this.http.request<Json>("GET", "/v1/metrics/product");
  }
  serviceKeys() {
    return this.http.request<{ items: Json[] }>("GET", "/v1/service/keys");
  }
}

/** Provider-side access through a receipt link: no account, no API key, only the link's scope. */
export class ReceiptLinkClient {
  private readonly http: AtcnClient;

  constructor(options: { baseUrl: string; shareToken: string; fetch?: typeof fetch; retries?: number }) {
    const shareToken = options.shareToken;
    const baseFetch = options.fetch ?? fetch;
    // The share token replaces the API key: strip the Authorization header the base client adds.
    const linkFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.set("x-atcn-share-token", shareToken);
      return baseFetch(input, { ...init, headers });
    };
    this.http = new AtcnClient({ baseUrl: options.baseUrl, apiKey: "", fetch: linkFetch, retries: options.retries });
  }

  current() {
    return this.http.request<{ receipt: SignedReceipt; digest: string; revisions: Json[]; allowed_actions: string[]; expires_at: string; responses: Json[]; notice: string }>(
      "GET",
      "/v1/receipt-shares/current",
    );
  }
  verification(receiptId: string) {
    return this.http.request<Json>("GET", `/v1/receipts/${receiptId}/verification`);
  }
  respond(
    receipt: { receipt_id: string; digest: string; revision: number },
    response: {
      response_type: ResponseType;
      fields?: AttestableField[];
      note?: string | null;
      evidence?: EvidenceRef[];
      corrections?: Correction[];
      execution?: ExecutionBinding;
      issued_at?: string;
      expires_at?: string;
      refs?: AttestationRef[];
      /** Schema 1.5: a witness statement, sent through a witness link. */
      role?: "witness";
    },
    signing?: { bindingId: string; keyId: string; privateKey: string; issuerOperatorId: string },
    opts: Opts = {},
  ) {
    let provider_signature = null;
    if (signing) {
      const statement = buildResponseStatement({
        receipt: { receipt_id: receipt.receipt_id, digest: receipt.digest, revision: receipt.revision, issuer_operator_id: signing.issuerOperatorId },
        response_type: response.response_type,
        fields: response.fields ?? [],
        note: response.note ?? null,
        evidence: response.evidence ?? [],
        corrections: response.corrections ?? [],
        execution: response.execution,
        issued_at: response.issued_at,
        expires_at: response.expires_at,
        refs: response.refs,
        role: response.role,
      });
      provider_signature = { binding_id: signing.bindingId, key_id: signing.keyId, value: signStatement(statement, signing.privateKey) };
    }
    return this.http.request<Json>(
      "POST",
      `/v1/receipts/${receipt.receipt_id}/responses`,
      { receipt_digest: receipt.digest, receipt_revision: receipt.revision, ...response, provider_signature },
      opts,
    );
  }
}

export interface CaptureOperation {
  id: string;
  method: "POST";
  path: string;
  body: unknown;
  idempotencyKey: string;
  enqueued_at: string;
  attempts: number;
  last_error: string | null;
}

export interface CaptureQueueOptions {
  /** Documented maximum. When full, new operations are dropped (never the oldest) and counted. Default 1000. */
  maxSize?: number;
  /** Attempts before an operation moves to the failed list for export and replay. Default 5. */
  maxAttempts?: number;
}

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
}

/**
 * Bounded local capture queue (PRD §15, acceptance 20-21). enqueue() and flush() never throw, so a capture
 * outage never stops the orchestrator's work. Each operation keeps one idempotency key for its lifetime, so
 * replays and retries create exactly one record. Drops and permanent failures are counted and can be
 * reported as capture gaps, so the chain is never silently shown as complete.
 *
 * Overflow policy: reject the newest operation and increment `dropped`. Older operations keep their order,
 * because later events (completions, charges) depend on earlier ones (tasks, delegations).
 */
export class CaptureQueue {
  readonly maxSize: number;
  readonly maxAttempts: number;
  private pending: CaptureOperation[] = [];
  private failed: CaptureOperation[] = [];
  private droppedCount = 0;
  private sequence = 0;

  constructor(
    private readonly client: SubledgerClient,
    options: CaptureQueueOptions = {},
  ) {
    this.maxSize = options.maxSize ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  get dropped(): number {
    return this.droppedCount;
  }
  get size(): number {
    return this.pending.length;
  }

  /** Queues one mutation. Returns false (and counts a drop) when the queue is full; never throws. */
  enqueue(path: string, body: unknown, idempotencyKey?: string): boolean {
    if (this.pending.length >= this.maxSize) {
      this.droppedCount += 1;
      return false;
    }
    this.sequence += 1;
    this.pending.push({
      id: `op_${Date.now()}_${this.sequence}`,
      method: "POST",
      path,
      body,
      idempotencyKey: idempotencyKey ?? stableKey("capture", crypto.randomUUID()),
      enqueued_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
    });
    return true;
  }

  task(input: z.input<typeof TaskInputSchema>): boolean {
    return this.enqueue("/v1/tasks", input, stableKey("task", input.external_ref));
  }
  delegation(taskRef: string, input: z.input<typeof DelegationInputSchema>): boolean {
    return this.enqueue(`/v1/tasks/${encodeURIComponent(taskRef)}/delegations`, input, input.external_ref ? stableKey("delegation", input.external_ref) : undefined);
  }
  delegationEvent(delegationRef: string, input: z.input<typeof DelegationEventInputSchema>, idempotencyKey?: string): boolean {
    return this.enqueue(`/v1/delegations/${encodeURIComponent(delegationRef)}/events`, input, idempotencyKey);
  }
  financialEvent(input: FinancialEventInput): boolean {
    return this.enqueue("/v1/financial-events", input, stableKey("financial", input.source, input.source_event_id));
  }

  /**
   * Sends queued operations in order. A retryable failure (network, 5xx, 429) stops the flush and keeps the
   * operation for the next flush; a non-retryable rejection moves it to the failed list. Never throws.
   */
  async flush(): Promise<FlushResult> {
    let sent = 0;
    let failed = 0;
    while (this.pending.length > 0) {
      const op = this.pending[0];
      op.attempts += 1;
      try {
        await this.client.http.request(op.method, op.path, op.body, { idempotencyKey: op.idempotencyKey });
        this.pending.shift();
        sent += 1;
      } catch (error) {
        op.last_error = error instanceof Error ? error.message : String(error);
        const retryable = !(error instanceof AtcnApiError) || error.retryable;
        if (retryable && op.attempts < this.maxAttempts) break;
        this.failed.push(this.pending.shift()!);
        failed += 1;
      }
    }
    return { sent, failed, remaining: this.pending.length };
  }

  failedOperations(): CaptureOperation[] {
    return [...this.failed];
  }

  /** Failed operations as JSON lines, for replay after the cause is fixed. */
  exportFailed(): string {
    return this.failed.map((op) => JSON.stringify(op)).join("\n");
  }

  /** Puts exported operations back in the queue with their original idempotency keys. */
  replay(jsonLines: string): number {
    const replayed = new Set<string>();
    for (const line of jsonLines.split("\n").filter((l) => l.trim() !== "")) {
      const op = JSON.parse(line) as CaptureOperation;
      if (this.enqueue(op.path, op.body, op.idempotencyKey)) replayed.add(op.idempotencyKey);
    }
    this.failed = this.failed.filter((f) => !replayed.has(f.idempotencyKey));
    return replayed.size;
  }

  /** Reports drops and permanent failures for a task as capture gaps (marks its lineage incomplete). Never throws. */
  async reportGaps(taskRef: string): Promise<boolean> {
    if (this.droppedCount === 0 && this.failed.length === 0) return true;
    const detail = `${this.droppedCount} capture operation(s) dropped by queue overflow; ${this.failed.length} failed permanently`;
    try {
      await this.client.reportCaptureGap(taskRef, { kind: this.droppedCount > 0 ? "queue_overflow" : "capture_failed", detail });
      return true;
    } catch {
      return false;
    }
  }
}
