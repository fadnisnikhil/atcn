import { digestOf, ExecutionDescriptorSchema, type DeclaredExecution, type EvidenceEnvelope, type ObligationTerms, type RecordedEvent } from "@atcn/schema";
import { producerRole, type EvidenceInput } from "./clearing.js";

/**
 * Runs the counterparty declared in its signed obligation.started events. A descriptor naming another agent is
 * ignored. The digest covers the descriptor exactly as signed.
 */
export function declaredExecutions(events: RecordedEvent[], counterpartyAgentId: string | null): DeclaredExecution[] {
  return events
    .filter((e) => e.payload.event_type === "obligation.started" && e.payload.actor_id === counterpartyAgentId)
    .flatMap((e) => {
      const parsed = ExecutionDescriptorSchema.safeParse(e.payload.data.execution);
      if (!parsed.success || parsed.data.agent.agent_id !== e.payload.actor_id) return [];
      return [{ execution_id: parsed.data.execution_id, execution_digest: digestOf(e.payload.data.execution), started_event_id: e.payload.event_id, descriptor: parsed.data }];
    });
}

/**
 * Builds clearing evidence inputs from an obligation's recorded events. Used by both
 * the hosted service and the offline verifier so both see the same evidence set.
 */
export function buildEvidenceInputs(events: RecordedEvent[], signedTerms: ObligationTerms, cutoffSequence?: number): EvidenceInput[] {
  const visible = events.filter((e) => cutoffSequence === undefined || e.sequence <= cutoffSequence);
  const terms = resolveCounterparty(signedTerms, visible);
  const actorOf = new Map(visible.map((e) => [e.payload.event_id, e.payload.actor_id]));
  const superseded = new Set<string>();
  for (const e of visible) {
    if (e.payload.event_type !== "event.superseded") continue;
    const target = String(e.payload.data.superseded_event_id);
    if (actorOf.get(target) === e.payload.actor_id) superseded.add(target);
  }
  return visible
    .filter((e) => e.payload.event_type === "evidence.submitted")
    .map((e) => {
      const envelope = e.payload.data.envelope as EvidenceEnvelope;
      return {
        envelope,
        event_id: e.payload.event_id,
        producer_role: producerRole(terms, envelope.producer_id),
        superseded: superseded.has(e.payload.event_id),
      };
    });
}

/**
 * Open offers (payee_selection) are signed without a counterparty; the first acceptance
 * event names it. Returns terms with the effective counterparty filled in.
 */
export function resolveCounterparty(terms: ObligationTerms, events: RecordedEvent[]): ObligationTerms {
  if (terms.counterparty_agent_id) return terms;
  const acceptance = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .find((e) => e.payload.obligation_id === terms.obligation_id && e.payload.event_type === "obligation.accepted");
  const counterparty = acceptance ? String(acceptance.payload.data.counterparty_agent_id) : null;
  return { ...terms, counterparty_agent_id: counterparty };
}
