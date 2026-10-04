import {
  countIndependentWitnesses,
  digestOf,
  inEffect,
  resolveAttestations,
  sameSkill,
  SignedExternalAttestationSchema,
  utf8Decode,
  verifyPayload,
  WITNESS_ATTESTATION_EVIDENCE_TYPE,
  type ExternalAttestationPayload,
  type Signed,
} from "@atcn/schema";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

interface AcceptedWitness {
  digest: string;
  payload: ExternalAttestationPayload;
}

/**
 * Passes when enough independent witnesses attested to a run the counterparty declared, under the terms'
 * witness_policy. Each witness_attestation covering the deliverable is checked like an external attestation; then
 * revocations apply, and only "pass" attestations from witnesses on distinct verified domains (none shared with a
 * party) count. Too few gives "fail" with code witness_quorum_not_met, which clearing treats as insufficient evidence.
 */
export const witnessQuorumVerifier: VerifierPlugin = {
  name: "witness_quorum",
  version: "1.0.0",
  evidenceTypes: [WITNESS_ATTESTATION_EVIDENCE_TYPE],
  run(context: VerifierContext): VerifierOutcome {
    const policy = context.witnessPolicy;
    if (!policy) return invalid("the terms set no witness_policy", "no_witness_policy");
    const domainOf = context.verifiedDomainOf ?? (() => null);
    const partyIds = context.partyIds ?? [];
    const partyDomains = partyIds.map(domainOf);
    const unverified = partyIds.filter((_, i) => partyDomains[i] === null);
    if (unverified.length > 0) return invalid(`witness independence cannot be checked: ${unverified.join(", ")} has no verified domain`, "independence_unverifiable");

    const at = context.evaluatedAt ?? new Date().toISOString();
    const refused: string[] = [];
    const accepted: AcceptedWitness[] = [];
    for (const bytes of context.witnessAttestations ?? [context.content]) {
      const checked = checkWitnessAttestation(bytes, context, partyIds, policy.witness_agent_ids);
      if (typeof checked === "string") refused.push(checked);
      else accepted.push(checked);
    }

    const resolution = resolveAttestations(
      accepted.map((a) => ({ digest: a.digest, signer: a.payload.verifier_id, issued_at: a.payload.issued_at, expires_at: a.payload.expires_at, refs: a.payload.refs })),
      at,
    );
    const candidates = [];
    for (const a of accepted) {
      const s = resolution.status[a.digest];
      if (s.revoked_by !== null) refused.push(`${a.payload.verifier_id}: revoked by ${s.revoked_by}`);
      else if (s.time !== "valid") refused.push(`${a.payload.verifier_id}: ${s.time === "expired" ? `expired at ${a.payload.expires_at}` : `issued_at ${a.payload.issued_at} is later than ${at}`}`);
      else if (a.payload.status !== "pass") refused.push(`${a.payload.verifier_id}: attested fail`);
      if (inEffect(resolution, a.digest) && a.payload.status === "pass") candidates.push({ witness_id: a.payload.verifier_id, domain: domainOf(a.payload.verifier_id) });
    }
    const count = countIndependentWitnesses(candidates, partyDomains as string[]);
    for (const r of count.refused) refused.push(`${r.witness_id}: ${r.reason}`);

    const met = count.counted.length >= policy.min_independent_witnesses;
    return {
      status: met ? "pass" : "fail",
      kind: "deterministic",
      details: {
        required: policy.min_independent_witnesses,
        counted: count.counted.map((w) => `${w.witness_id}@${w.domain}`).join(","),
        refused: refused.join("; "),
        ...(met ? {} : { code: "witness_quorum_not_met" }),
      },
      model: null,
    };
  },
};

/** Returns the attestation when its form, subject, signer, signature, run and evidence are acceptable, or why not. */
function checkWitnessAttestation(bytes: Uint8Array, context: VerifierContext, partyIds: string[], allowedWitnesses: string[] | undefined): AcceptedWitness | string {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(bytes));
  } catch {
    return "attestation is not JSON";
  }
  const parsed = SignedExternalAttestationSchema.safeParse(raw);
  if (!parsed.success) return `attestation does not match the schema: ${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`;
  const { payload: p, signature } = parsed.data;
  const who = p.verifier_id;
  if (p.role !== "witness") return `${who}: not a witness attestation`;
  if (p.obligation_id !== context.obligationId || p.deliverable_id !== context.deliverableId || p.check_id !== context.check.check_id) {
    return `${who}: subject does not match obligation, deliverable, and check`;
  }
  if (partyIds.includes(who)) return `${who}: a party cannot witness its own obligation`;
  if (allowedWitnesses && !allowedWitnesses.includes(who)) return `${who}: not among the agreed witnesses`;
  const key = context.resolveKey(signature.key_id, signature.key_version);
  if (!key || key.actor_id !== who) return `${who}: key does not belong to the witness`;
  if (!verifyPayload(raw as Signed<unknown>, key.public_key)) return `${who}: signature does not verify`;
  const signedAt = p.issued_at ?? context.evaluatedAt ?? new Date().toISOString();
  if (key.revoked_at && Date.parse(key.revoked_at) <= Date.parse(signedAt)) return `${who}: key was revoked at ${key.revoked_at}`;

  const binding = p.execution!;
  const declared = (context.executions ?? []).find((e) => e.execution_id === binding.execution_id && e.execution_digest === binding.execution_digest);
  if (!declared) return `${who}: run ${binding.execution_id} was not declared by the counterparty`;
  const termsSkill = context.termsSkill ?? undefined;
  if (termsSkill && !sameSkill(declared.descriptor.skill, termsSkill)) return `${who}: run ${binding.execution_id} does not perform the agreed skill`;
  const onObligation = new Set(context.obligationEvidenceDigests ?? []);
  const unknown = (p.evidence_digests ?? []).filter((d) => !onObligation.has(d));
  if (unknown.length > 0) return `${who}: cites evidence not submitted on this obligation: ${unknown.join(", ")}`;
  return { digest: digestOf((raw as Signed<unknown>).payload), payload: p };
}

function invalid(error: string, code: string): VerifierOutcome {
  return { status: "invalid_evidence", kind: "deterministic", details: { error, code }, model: null };
}
