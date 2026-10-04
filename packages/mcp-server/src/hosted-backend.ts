import type { SubledgerClient } from "@atcn/sdk";
import { PublicKeyRecordSchema } from "@atcn/schema";
import type { FinancialEventInput } from "@atcn/subledger";
import type { Backend, CaptureGapBody, DelegationBody, DelegationEventBody, FinancialEventOutcome, TaskBody, TaskSummary } from "./backend.js";

/** The SubledgerClient operations the hosted backend uses. */
export type HostedClient = Pick<
  SubledgerClient,
  "createTask" | "createDelegation" | "appendDelegationEvent" | "recordFinancialEvent" | "createProvider" | "bindProviderKey" | "reportCaptureGap" | "financialSummary" | "closeTask" | "serviceKeys"
>;

/** Records through the hosted ATCN API with the TypeScript SDK. Requests carry idempotency keys from the caller's references. */
export class HostedBackend implements Backend {
  readonly mode = "hosted";

  constructor(private readonly client: HostedClient) {}

  async createTask(input: TaskBody) {
    return (await this.client.createTask(input)) as { task_id: string };
  }

  async createDelegation(taskRef: string, input: DelegationBody) {
    return (await this.client.createDelegation(taskRef, input)) as { delegation_id: string };
  }

  async appendDelegationEvent(delegationRef: string, input: DelegationEventBody) {
    return (await this.client.appendDelegationEvent(delegationRef, input)) as { event_id: string };
  }

  async recordFinancialEvent(input: FinancialEventInput) {
    return (await this.client.recordFinancialEvent(input)) as unknown as FinancialEventOutcome;
  }

  async addProvider(name: string, providerOwnId: string | null) {
    return (await this.client.createProvider({ name, provider_own_id: providerOwnId })) as { provider_id: string };
  }

  async bindProviderKey(providerId: string, keyId: string, publicKey: string) {
    return (await this.client.bindProviderKey(providerId, keyId, publicKey)) as { binding_id: string };
  }

  async reportCaptureGap(taskRef: string, input: CaptureGapBody) {
    return (await this.client.reportCaptureGap(taskRef, input)) as { gap_id: string };
  }

  async taskSummary(taskRef: string) {
    return (await this.client.financialSummary(taskRef)) as unknown as TaskSummary;
  }

  async closeTask(taskRef: string) {
    return this.client.closeTask(taskRef);
  }

  async trustedKeys() {
    const { items } = await this.client.serviceKeys();
    return items.map((key) => PublicKeyRecordSchema.parse(key));
  }
}
