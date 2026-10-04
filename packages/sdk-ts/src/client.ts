import type { ClearingDecision, ClosurePackage, EventPayload, PublicKeyRecord, Signed } from "@atcn/schema";

export class AtcnApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason: string | undefined,
    readonly retryable: boolean,
    readonly correlationId: string | undefined,
    readonly details: unknown,
  ) {
    super(`${code}${reason ? ` (${reason})` : ""}: ${message}`);
  }
}

/** Must equal this package's version in package.json (checked by a test). */
export const SDK_VERSION = "1.4.0";
/** Names the SDK and its version on every request, so the API operator can count SDK versions in use. Nothing else is sent. */
export const SDK_HEADER = "atcn-sdk";

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Retries for retryable failures (same Idempotency-Key, so retries never duplicate effects). */
  retries?: number;
  fetch?: typeof fetch;
  /** Extra headers sent on every request, for example `{ "atcn-workflow": "demo" }` from the bundled examples. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  rawBody?: Uint8Array;
  textBody?: { contentType: string; text: string };
}

type SignedEvent = Signed<EventPayload>;
type Json = Record<string, unknown>;

/** Thin HTTP client for the ATCN API. Every mutating call carries an Idempotency-Key. */
export class AtcnClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T = Json>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      [SDK_HEADER]: `typescript/${SDK_VERSION}`,
      authorization: `Bearer ${this.options.apiKey}`,
      ...this.options.headers,
      ...opts.headers,
    };
    if (method !== "GET") headers["idempotency-key"] = opts.idempotencyKey ?? crypto.randomUUID();
    let payload: BodyInit | undefined;
    if (opts.rawBody) {
      headers["content-type"] = "application/octet-stream";
      payload = opts.rawBody as unknown as BodyInit;
    } else if (opts.textBody) {
      headers["content-type"] = opts.textBody.contentType;
      payload = opts.textBody.text;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const attempts = (this.options.retries ?? 2) + 1;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, body: payload });
      } catch (error) {
        if (attempt < attempts) continue;
        throw error;
      }
      const text = await response.text();
      const parsed = text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
      if (response.ok) return parsed as T;
      const err = (parsed as { error?: { code: string; message: string; reason?: string; retryable?: boolean; details?: unknown }; correlation_id?: string }) ?? {};
      const apiError = new AtcnApiError(
        response.status,
        err.error?.code ?? "http_error",
        err.error?.message ?? String(parsed),
        err.error?.reason,
        err.error?.retryable ?? false,
        err.correlation_id,
        err.error?.details,
      );
      if (apiError.retryable && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        continue;
      }
      throw apiError;
    }
  }

  // ---- Obligations ----
  /**
   * Creates or offers an obligation. With `subledger`, the obligation also becomes a delegation of one of the
   * caller's subledger tasks; the link is not part of the signed event and is never shared with the counterparty.
   */
  createObligation(signed: SignedEvent, subledger?: { task_id: string; parent_delegation_id?: string | null }) {
    return this.request<{ obligation: Json; event: Json; subledger?: { task_id: string; delegation_id: string } }>(
      "POST",
      "/v1/obligations",
      subledger ? { ...signed, subledger } : signed,
      { idempotencyKey: `event:${signed.payload.event_id}` },
    );
  }
  acceptObligation(obligationId: string, signed: SignedEvent) {
    return this.request<{ obligation: Json; event: Json }>("POST", `/v1/obligations/${obligationId}/accept`, signed, { idempotencyKey: `event:${signed.payload.event_id}` });
  }
  appendEvent(obligationId: string, signed: SignedEvent) {
    return this.request<{ obligation: Json; event: Json }>("POST", `/v1/obligations/${obligationId}/events`, signed, { idempotencyKey: `event:${signed.payload.event_id}` });
  }
  getObligation(obligationId: string) {
    return this.request<Json>("GET", `/v1/obligations/${obligationId}`);
  }
  listObligations(query: { state?: string; root_id?: string; limit?: number } = {}) {
    return this.request<{ items: Json[] }>("GET", "/v1/obligations", undefined, { query });
  }
  listEvents(obligationId: string) {
    return this.request<{ items: Json[] }>("GET", `/v1/obligations/${obligationId}/events`);
  }
  getChain(obligationId: string) {
    return this.request<Json>("GET", `/v1/obligations/${obligationId}/chain`);
  }
  getAllocation(obligationId: string) {
    return this.request<Json>("GET", `/v1/obligations/${obligationId}/allocation`);
  }

  // ---- Evidence ----
  uploadBlob(bytes: Uint8Array, mediaType = "application/octet-stream") {
    return this.request<{ digest: string; uri: string; size_bytes: number }>("POST", "/v1/blobs", undefined, { rawBody: bytes, headers: { "x-media-type": mediaType } });
  }
  submitEvidence(obligationId: string, signed: SignedEvent) {
    return this.request<{ evidence: Json; event: Json; reevaluation: { decision: ClearingDecision; reused: boolean } | null }>(
      "POST",
      `/v1/obligations/${obligationId}/evidence`,
      signed,
      { idempotencyKey: `event:${signed.payload.event_id}` },
    );
  }
  listEvidence(obligationId: string) {
    return this.request<{ items: Json[] }>("GET", `/v1/obligations/${obligationId}/evidence`);
  }
  evidenceLink(evidenceId: string) {
    return this.request<{ url: string; expires_at: string }>("GET", `/v1/evidence/${evidenceId}/link`);
  }

  // ---- Clearing and disputes ----
  evaluate(obligationId: string, policy: { policy_id: string; policy_version: string }, idempotencyKey?: string) {
    return this.request<{ decision: ClearingDecision; reused: boolean }>("POST", `/v1/obligations/${obligationId}/evaluate`, policy, { idempotencyKey });
  }
  listDecisions(obligationId: string) {
    return this.request<{ items: ClearingDecision[] }>("GET", `/v1/obligations/${obligationId}/decisions`);
  }
  finalize(decisionId: string, idempotencyKey?: string) {
    return this.request<Json>("POST", `/v1/decisions/${decisionId}/finalize`, undefined, { idempotencyKey });
  }
  openDispute(decisionId: string, signed: SignedEvent) {
    return this.request<Json>("POST", `/v1/decisions/${decisionId}/disputes`, signed, { idempotencyKey: `event:${signed.payload.event_id}` });
  }
  reviewDispute(disputeId: string, signed: SignedEvent) {
    return this.request<Json>("POST", `/v1/disputes/${disputeId}/review`, signed, { idempotencyKey: `event:${signed.payload.event_id}` });
  }
  listDisputes(query: { status?: string; obligation_id?: string } = {}) {
    return this.request<{ items: Json[] }>("GET", "/v1/disputes", undefined, { query });
  }

  // ---- Journal, settlement, reconciliation, exports ----
  journal(query: Record<string, string | number | undefined> = {}) {
    return this.request<{ items: Json[] }>("GET", "/v1/journal", undefined, { query });
  }
  statement(query: Record<string, string | number | undefined> = {}) {
    return this.request<Json>("GET", "/v1/journal/statement", undefined, { query });
  }
  createSettlementInstruction(input: { obligation_id: string; beneficiary_ref: string; amount_minor: number; currency: string; adapter: "manual" | "sandbox" | "stripe" }, idempotencyKey?: string) {
    return this.request<Json>("POST", "/v1/settlements/instructions", input, { idempotencyKey });
  }
  reportSettlementEvent(input: Json, idempotencyKey?: string) {
    return this.request<Json>("POST", "/v1/settlements/events", input, { idempotencyKey });
  }
  reconciliationExceptions(status?: string) {
    return this.request<{ items: Json[] }>("GET", "/v1/reconciliation/exceptions", undefined, { query: { status } });
  }
  exportClosurePackage(obligationId: string) {
    return this.request<ClosurePackage>("GET", `/v1/exports/${obligationId}`);
  }

  // ---- Keys ----
  serviceKeys() {
    return this.request<{ items: PublicKeyRecord[] }>("GET", "/v1/service/keys");
  }
  keysForActor(actorId: string) {
    return this.request<{ items: PublicKeyRecord[] }>("GET", "/v1/keys", undefined, { query: { actor_id: actorId } });
  }
}
