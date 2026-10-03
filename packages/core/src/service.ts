import { newId, type EventPayload, type EventType } from "@atcn/schema";

/** Actor of every fact the clearing service records itself: decisions, journal postings, settlement reports. */
export const SERVICE_ACTOR_ID = "svc_atcn";

export interface ServiceEventInput {
  obligationId: string;
  type: EventType;
  data: Record<string, unknown>;
  causationIds?: string[];
}

/** Payload of a service-recorded event, to be signed with the service key. */
export function serviceEventPayload(input: ServiceEventInput): EventPayload {
  return {
    schema_version: "1.0",
    event_id: newId("event"),
    event_type: input.type,
    obligation_id: input.obligationId,
    actor_id: SERVICE_ACTOR_ID,
    actor_platform_id: SERVICE_ACTOR_ID,
    event_time: new Date().toISOString(),
    causation_ids: input.causationIds ?? [],
    data: input.data,
  };
}
