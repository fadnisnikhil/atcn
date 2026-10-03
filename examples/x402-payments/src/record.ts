import type { LocalSubledger } from "@atcn/local-runner";
import { digestOf, sha256Digest } from "@atcn/schema";
import type { DelegationRecord } from "@atcn/subledger";
import type { PaymentRequirements, X402Purchase } from "./x402.js";

/** Assets this example converts to USD, by CAIP-2 network and token address (lowercase): USDC, 6 decimals. */
const USD_STABLECOINS: Record<string, { name: string; decimals: number }> = {
  "eip155:84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e": { name: "USDC", decimals: 6 },
  "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USDC", decimals: 6 },
};

/**
 * ATCN amounts are ISO 4217 minor units, so USDC is recorded as USD at 1:1, in cents. The exact atomic amount, asset
 * and network stay in the delegation's quote_basis and in the digest of the settlement response.
 */
export function usdCents(requirements: PaymentRequirements): number {
  const asset = USD_STABLECOINS[`${requirements.network}:${requirements.asset}`.toLowerCase()];
  if (!asset) throw new Error(`no USD conversion for ${requirements.asset} on ${requirements.network}`);
  const perCent = 10n ** BigInt(asset.decimals - 2);
  const atomic = BigInt(requirements.amount);
  if (atomic % perCent !== 0n) throw new Error(`${requirements.amount} atomic ${asset.name} is not a whole number of cents`);
  return Number(atomic / perCent);
}

/**
 * Records one x402 purchase on a task, linking the payment to the work it bought:
 *
 * - a delegation per paid request. Its provider_job_ref is the EIP-3009 authorization nonce, which the payer signed
 *   and which the token contract emits when the transfer executes, so the on-chain transfer can be traced back to it.
 *   Its terms_digest is the digest of the payment requirements the buyer accepted.
 * - a completion claim citing the digest of the response body, or a provider_failure claim when no resource came back.
 * - a charge for every settlement that was broadcast, with the transaction hash as provider reference and the digest
 *   of the settlement response as evidence.
 * - a payment report only when the settlement succeeded. A pending settlement stays unresolved.
 */
export function recordX402Purchase(subledger: LocalSubledger, taskId: string, ref: string, purchase: X402Purchase): DelegationRecord {
  const { required, accepted, payment, settlement } = purchase;
  const nonce = payment.payload.authorization.nonce;
  const amountMinor = usdCents(accepted);
  const source = `x402:${settlement.network}`;
  const match = { provider_job_ref: nonce };

  const delegation = subledger.createDelegation(taskId, {
    external_ref: ref,
    provider_name_stated: required.resource.serviceName ?? new URL(required.resource.url).host,
    provider_own_id: `${accepted.network}:${accepted.payTo}`,
    provider_job_ref: nonce,
    scope_ref: required.resource.url,
    shared_description: required.resource.description ?? null,
    currency: "USD",
    quoted_max_minor: amountMinor,
    quote_basis: `x402 ${accepted.scheme}: ${accepted.amount} atomic ${String(accepted.extra?.name ?? accepted.asset)} on ${accepted.network}`,
    terms_digest: digestOf(accepted),
  });

  if (purchase.status === 200) {
    subledger.appendDelegationEvent(delegation.delegation_id, {
      type: "completion",
      asserted_by: "provider",
      note: `HTTP 200 from ${required.resource.url}`,
      evidence: [{ uri: `urn:x402:response:${nonce}`, digest: sha256Digest(purchase.body), evidence_type: "x402_resource_response" }],
    });
  } else {
    subledger.appendDelegationEvent(delegation.delegation_id, {
      type: "provider_failure",
      asserted_by: "provider",
      note: `HTTP ${purchase.status}, settlement ${settlement.errorReason ?? "failed"}${settlement.transaction ? `; transaction ${settlement.transaction} may still confirm` : ""}`,
    });
  }

  if (settlement.transaction === "") return subledger.delegation(delegation.delegation_id);
  const evidence = { uri: `urn:x402:${settlement.network}:tx:${settlement.transaction}`, digest: digestOf(settlement), evidence_type: "x402_settlement_response" };
  const charge = subledger.recordFinancialEvent({
    type: "charge",
    source,
    source_event_id: settlement.transaction,
    provider_reference: settlement.transaction,
    provider_status: settlement.success ? "success" : (settlement.errorReason ?? "failed"),
    normalized_status: settlement.success ? "issued" : "pending",
    amount_minor: amountMinor,
    currency: "USD",
    event_date: new Date().toISOString(),
    evidence,
    match,
  });
  if (settlement.success) {
    subledger.recordFinancialEvent({
      type: "payment_reported",
      source,
      source_event_id: `${settlement.transaction}:paid`,
      provider_reference: settlement.transaction,
      provider_status: "success",
      normalized_status: "reported_paid",
      amount_minor: amountMinor,
      currency: "USD",
      event_date: new Date().toISOString(),
      settles_event_id: charge.financial_event.financial_event_id,
      evidence,
      match,
    });
  }
  return subledger.delegation(delegation.delegation_id);
}
