/**
 * ATCN event vocabulary (PRD EV-2). Each event type lists who may sign it.
 *  - "issuer" / "counterparty": a party to the subject obligation
 *  - "party": either party
 *  - "reviewer": the dispute reviewer named in the accepted terms
 *  - "service": the ATCN service key (server-produced facts and decisions)
 */
export const EVENT_TYPES = {
  "obligation.created": { signer: "issuer", description: "Obligation drafted (not yet offered)." },
  "obligation.offered": { signer: "issuer", description: "Terms offered to a counterparty." },
  "obligation.accepted": {
    signer: "party",
    description: "Counterparty accepted the offered terms, or the non-proposing party accepted an amendment.",
  },
  "obligation.amended": { signer: "party", description: "New terms version proposed; effective only after acceptance by the other party." },
  "obligation.delegated": { signer: "service", description: "Child obligation linked to parent after signed offer and acceptance." },
  "obligation.started": { signer: "counterparty", description: "Counterparty started work." },
  "evidence.submitted": { signer: "party_or_verifier", description: "Evidence envelope registered." },
  "completion.proposed": { signer: "counterparty", description: "Counterparty proposes the work is complete." },
  "completion.accepted": { signer: "service", description: "Clearing decision: accepted." },
  "completion.partially_accepted": { signer: "service", description: "Clearing decision: partially accepted." },
  "completion.rejected": { signer: "service", description: "Clearing decision: rejected." },
  "completion.insufficient_evidence": { signer: "service", description: "Clearing decision: insufficient evidence." },
  "completion.disputed": { signer: "service", description: "Clearing decision routed to review (disputed portion or probabilistic verifier)." },
  "dispute.opened": { signer: "party_or_service", description: "A party disputed a decision or amount, or policy routed a portion to review." },
  "dispute.resolved": { signer: "reviewer_or_service", description: "Reviewer upheld, amended, or remanded; or the configured default applied." },
  "obligation.cancelled": { signer: "issuer", description: "Issuer cancelled before completion was proposed." },
  "obligation.expired": { signer: "service", description: "Deadline elapsed before clearing." },
  "obligation.cleared": { signer: "service", description: "Decision finalized into journal postings." },
  "journal.posted": { signer: "service", description: "Balanced posting batch committed." },
  "settlement.reported": { signer: "service", description: "Provider-reported settlement status recorded." },
  "journal.reversed": { signer: "service", description: "Reversal posting batch committed." },
  "event.superseded": { signer: "party", description: "A prior event by the same actor is superseded, with reason." },
} as const;

export type EventType = keyof typeof EVENT_TYPES;
export const EVENT_TYPE_NAMES = Object.keys(EVENT_TYPES) as EventType[];

/** Events a client may append through POST /v1/obligations/{id}/events. */
export const CLIENT_LIFECYCLE_EVENTS: EventType[] = [
  "obligation.offered",
  "obligation.amended",
  "obligation.started",
  "completion.proposed",
  "obligation.cancelled",
  "event.superseded",
];

export const SERVICE_EVENTS: EventType[] = EVENT_TYPE_NAMES.filter((t) => EVENT_TYPES[t].signer === "service");

export const SCHEMA_VERSION = "1.0" as const;
