import { describe, expect, it } from "vitest";
import { digestOf, type PostingBatch, type PostingLine, type SettlementEvent } from "@atcn/schema";
import { clearingFacts, settlementEvidence, undoneBatch } from "../src/index.js";

const T = "2026-10-01T00:00:00.000Z";

function line(account_type: PostingLine["account_type"], allocation_role: PostingLine["allocation_role"], debit: number, credit: number): PostingLine {
  return { account_type, party_id: "p", allocation_role, currency: "USD", debit_minor: debit, credit_minor: credit };
}

function batch(batch_id: string, entry_type: PostingBatch["entry_type"], lines: PostingLine[], extra: Partial<PostingBatch> = {}): PostingBatch {
  return {
    batch_id,
    obligation_id: "obl_1",
    entry_type,
    decision_id: null,
    settlement_event_id: null,
    reverses_batch_id: null,
    policy_version: null,
    source_event_ids: [],
    rounding: null,
    lines,
    posted_at: T,
    ...extra,
  };
}

function settlementEvent(id: string, instruction: string, status: SettlementEvent["normalized_status"]): SettlementEvent {
  return {
    settlement_event_id: id,
    instruction_id: instruction,
    provider: "manual",
    provider_event_id: id,
    provider_reference: "wire",
    provider_status: status,
    normalized_status: status,
    currency: "USD",
    amount_minor: 90,
    raw_json: "{}",
    reported_at: T,
  };
}

const clearing = batch("bat_c", "clearing", [
  line("obligation_expense", "payer_expense", 100, 0),
  line("payable", "payee_share", 0, 63),
  line("platform_fee", "platform_fee", 0, 7),
  line("dispute_frozen", "dispute_freeze", 0, 30),
]);

describe("clearingFacts", () => {
  it("turns a clearing batch into a charge for the payee's share and a platform fee; frozen amounts are not costs", () => {
    expect(clearingFacts(clearing, null)).toEqual([
      { key: "bat_c:charge", type: "charge", amount_minor: 63, currency: "USD", reverses_key: null },
      { key: "bat_c:fee", type: "fee", amount_minor: 7, currency: "USD", reverses_key: null },
    ]);
  });

  it("counts child cost and parent margin as the charge", () => {
    const parent = batch("bat_p", "clearing", [
      line("obligation_expense", "payer_expense", 100, 0),
      line("payable", "child_cost", 0, 54),
      line("payable", "parent_margin", 0, 36),
      line("platform_fee", "platform_fee", 0, 10),
    ]);
    expect(clearingFacts(parent, null).map((f) => [f.type, f.amount_minor])).toEqual([
      ["charge", 90],
      ["fee", 10],
    ]);
  });

  it("reports settlements and refunds, and ignores estimates and holds", () => {
    const settled = batch("bat_s", "settlement", [line("payable", "payee_share", 90, 0), line("settlement_reported", "payee_share", 0, 90)]);
    const refund = batch("bat_r", "refund", [line("settlement_reported", "payee_share", 90, 0), line("refund", "payee_share", 0, 90)]);
    const contingent = batch("bat_k", "contingent", [line("contingent_expense", "payer_expense", 100, 0), line("contingent_payable", "payee_share", 0, 100)]);
    expect(clearingFacts(settled, null)).toEqual([{ key: "bat_s:payment", type: "payment_reported", amount_minor: 90, currency: "USD", reverses_key: null }]);
    expect(clearingFacts(refund, null)).toEqual([{ key: "bat_r:refund", type: "refund", amount_minor: 90, currency: "USD", reverses_key: null }]);
    expect(clearingFacts(contingent, null)).toEqual([]);
  });

  it("reverses each fact of a reversed clearing batch", () => {
    const reversal = batch("bat_v", "reversal", clearing.lines.map((l) => ({ ...l, debit_minor: l.credit_minor, credit_minor: l.debit_minor })), { reverses_batch_id: "bat_c" });
    const undone = undoneBatch(reversal, [clearing, reversal], []);
    expect(undone?.batch_id).toBe("bat_c");
    expect(clearingFacts(reversal, undone)).toEqual([
      { key: "bat_v:charge", type: "reversal", amount_minor: 63, currency: "USD", reverses_key: "bat_c:charge" },
      { key: "bat_v:fee", type: "reversal", amount_minor: 7, currency: "USD", reverses_key: "bat_c:fee" },
    ]);
  });

  it("reverses the payment of a returned settlement instruction", () => {
    const settled = batch("bat_s", "settlement", [line("payable", "payee_share", 90, 0), line("settlement_reported", "payee_share", 0, 90)], { settlement_event_id: "se_1" });
    const returned = batch("bat_x", "return", [line("settlement_reported", "payee_share", 90, 0), line("payable", "payee_share", 0, 90)], { settlement_event_id: "se_2" });
    const events = [settlementEvent("se_1", "ins_1", "settled"), settlementEvent("se_2", "ins_1", "returned")];
    const undone = undoneBatch(returned, [settled, returned], events);
    expect(undone?.batch_id).toBe("bat_s");
    expect(clearingFacts(returned, undone)).toEqual([{ key: "bat_x:payment", type: "reversal", amount_minor: 90, currency: "USD", reverses_key: "bat_s:payment" }]);
    expect(undoneBatch(settled, [settled, returned], events)).toBeNull();
  });
});

describe("settlementEvidence", () => {
  it("cites the settlement report and labels who reported it; nothing is labeled provider-confirmed", () => {
    const settled = batch("bat_s", "settlement", [line("payable", "payee_share", 90, 0), line("settlement_reported", "payee_share", 0, 90)], { settlement_event_id: "se_1" });
    const manual = settlementEvent("se_1", "ins_1", "settled");
    expect(settlementEvidence(settled, [manual])).toEqual({ uri: "urn:atcn:settlement-event:se_1", digest: digestOf(manual), evidence_type: "settlement_reported_by_operator" });
    expect(settlementEvidence(settled, [{ ...manual, provider: "stripe" }])?.evidence_type).toBe("settlement_relayed_from_stripe_by_operator_connector");
    expect(settlementEvidence(settled, [{ ...manual, provider: "sandbox" }])?.evidence_type).toBe("settlement_simulated_in_sandbox");
    expect(settlementEvidence(clearing, [manual])).toBeNull();
  });
});
