import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalRunnerError, LocalSubledger, loadOrCreateServiceKey, servicePublicKey, type ServiceKey } from "@atcn/local-runner";
import type { FinancialEventInput } from "@atcn/subledger";
import type { Backend, CaptureGapBody, DelegationBody, DelegationEventBody, TaskBody } from "./backend.js";

const OPERATOR_NAME = "ATCN MCP (local)";

/** Everything the local subledger holds. Saved after every change so IDs, timestamps and closure chains survive restarts. */
const STATE_FIELDS = ["tasks", "providers", "delegations", "claims", "financialEvents", "exceptions", "closures", "keyBindings", "captureGaps"] as const;
type LedgerState = Pick<LocalSubledger, (typeof STATE_FIELDS)[number]>;

/** Records into an in-process LocalSubledger signed with a key kept in the data directory. No account needed. */
export class LocalBackend implements Backend {
  readonly mode = "local";
  private readonly serviceKey: ServiceKey;
  private readonly ledger: LocalSubledger;
  private readonly statePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.serviceKey = loadOrCreateServiceKey(join(dataDir, "service-key.json"));
    this.ledger = new LocalSubledger(this.serviceKey, OPERATOR_NAME);
    this.statePath = join(dataDir, "state.json");
    if (existsSync(this.statePath)) this.restore();
  }

  async createTask(input: TaskBody) {
    return this.change(() => this.ledger.createTask(input));
  }

  async createDelegation(taskRef: string, input: DelegationBody) {
    return this.change(() => this.ledger.createDelegation(this.resolveTaskId(taskRef), input));
  }

  async appendDelegationEvent(delegationRef: string, input: DelegationEventBody) {
    return this.change(() => this.ledger.appendDelegationEvent(this.ledger.resolveDelegationId(delegationRef), input));
  }

  async recordFinancialEvent(input: FinancialEventInput) {
    return this.change(() => this.ledger.recordFinancialEvent(input));
  }

  async addProvider(name: string, providerOwnId: string | null) {
    return this.change(() => this.ledger.addProvider(name, providerOwnId));
  }

  async bindProviderKey(providerId: string, keyId: string, publicKey: string) {
    return this.change(() => this.ledger.bindProviderKey(providerId, publicKey, keyId));
  }

  async reportCaptureGap(taskRef: string, input: CaptureGapBody) {
    return this.change(() => this.ledger.reportCaptureGap(this.resolveTaskId(taskRef), input));
  }

  async taskSummary(taskRef: string) {
    const { task, rollup, open_exceptions } = this.ledger.summary(this.resolveTaskId(taskRef));
    return { task, totals_by_currency: rollup.root_total, rollup, open_exceptions };
  }

  async closeTask(taskRef: string) {
    return this.change(() => this.ledger.closeTask(this.resolveTaskId(taskRef), []));
  }

  async trustedKeys() {
    return [servicePublicKey(this.serviceKey)];
  }

  /** Tasks may be addressed as "ext:<external_ref>", as in the hosted API. */
  private resolveTaskId(ref: string): string {
    if (!ref.startsWith("ext:")) return ref;
    const task = this.ledger.tasks.find((t) => t.external_ref === ref.slice(4));
    if (!task) throw new LocalRunnerError(`task ${ref} not found`);
    return task.task_id;
  }

  /** Saves even when the change is refused: a refused duplicate financial event still opens a duplicate_event exception. */
  private change<T>(apply: () => T): T {
    try {
      return apply();
    } finally {
      this.save();
    }
  }

  private save(): void {
    const state = Object.fromEntries(STATE_FIELDS.map((field) => [field, this.ledger[field]]));
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.statePath);
  }

  private restore(): void {
    const state = JSON.parse(readFileSync(this.statePath, "utf8")) as LedgerState;
    for (const field of STATE_FIELDS) (this.ledger[field] as unknown[]).push(...state[field]);
  }
}
