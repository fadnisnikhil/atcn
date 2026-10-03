import { newId, signPayload, type EventPayload, type EventType, type Signed } from "@atcn/schema";

export interface SignerIdentity {
  actorId: string;
  platformId: string;
  keyId: string;
  keyVersion?: number;
  privateKey: string;
}

/** Signs ATCN events for one actor. Keys stay with the caller; ATCN only ever sees public keys. */
export class EventSigner {
  constructor(readonly identity: SignerIdentity) {}

  get actorId(): string {
    return this.identity.actorId;
  }

  get platformId(): string {
    return this.identity.platformId;
  }

  sign(eventType: EventType, obligationId: string, data: Record<string, unknown> = {}, causationIds: string[] = []): Signed<EventPayload> {
    const payload: EventPayload = {
      schema_version: "1.0",
      event_id: newId("event"),
      event_type: eventType,
      obligation_id: obligationId,
      actor_id: this.identity.actorId,
      actor_platform_id: this.identity.platformId,
      event_time: new Date().toISOString(),
      causation_ids: causationIds,
      data,
    };
    return signPayload(payload, { keyId: this.identity.keyId, keyVersion: this.identity.keyVersion ?? 1, privateKey: this.identity.privateKey });
  }
}
