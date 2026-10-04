import { z } from "zod";
import { CLEARING_OUTCOMES } from "./states.js";
import { AmountMinor, Currency, DecisionId, Digest, ObligationId, SignatureSchema, Timestamp } from "./types.js";

/**
 * Clearing verdict (1.5): the obligation's latest clearing decision, signed by the ATCN service in a compact form an
 * escrow rail can name as its release authority. ATCN only publishes the verdict; it holds no funds and releases
 * nothing. The rail decides whether and how to release, refund or keep holding.
 */
export const CLEARING_VERDICT_TYPE = "atcn.clearing.verdict";

export const ClearingVerdictPayloadSchema = z.strictObject({
  document_type: z.literal(CLEARING_VERDICT_TYPE),
  verdict_version: z.literal("1.0"),
  issued_at: Timestamp,
  obligation_id: ObligationId,
  decision: z.strictObject({
    decision_id: DecisionId,
    decision_digest: Digest,
    decided_at: Timestamp,
    outcome: z.enum(CLEARING_OUTCOMES),
    currency: Currency,
    accepted_amount_minor: AmountMinor,
    rejected_amount_minor: AmountMinor,
    disputed_amount_minor: AmountMinor,
    pending_amount_minor: AmountMinor,
  }),
  /** True when nothing is disputed or pending, so no later decision is expected on the evidence as it stands. */
  final: z.boolean(),
  /** The escrow this verdict is issued for, as the requester named it; null for a verdict not bound to an escrow. */
  escrow: z.strictObject({ rail: z.string().min(1).max(100), escrow_ref: z.string().min(1).max(200) }).nullable(),
  /** Digest of the closure package payload the decision was read from; verify the package to see the evidence. */
  package_digest: Digest,
  stance: z.literal("record_only"),
});
export type ClearingVerdictPayload = z.infer<typeof ClearingVerdictPayloadSchema>;

export const ClearingVerdictSchema = z.object({ payload: ClearingVerdictPayloadSchema, signature: SignatureSchema });
export type ClearingVerdict = z.infer<typeof ClearingVerdictSchema>;
