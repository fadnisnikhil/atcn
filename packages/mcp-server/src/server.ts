import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PublicKeyRecordSchema } from "@atcn/schema";
import {
  CaptureGapInputSchema,
  DelegationEventInputSchema,
  DelegationInputSchema,
  ExpectationSchema,
  FINANCIAL_EVENT_TYPES,
  FinancialEventInputSchema,
  HOLD_STATUSES,
  ProviderInputSchema,
  TaskInputSchema,
  type CurrencyTotals,
} from "@atcn/subledger";
import { z } from "zod";
import type { Backend, FinancialEventOutcome, TaskSummary } from "./backend.js";
import { verifyDocument } from "./verify.js";

export const SERVER_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const RECORD_ONLY = "ATCN is record-only: it never blocks, gates or reserves money.";
const ATTESTATION_CAVEAT = "A valid signature attests to the signer's statement, not to the truth of the underlying work or payment.";

const TaskRef = z.string().min(1).describe('The task_id, or "ext:<external_ref>"');
const DelegationRef = z.string().min(1).describe('The delegation_id, or "ext:<external_ref>"');

const CostEventSchema = FinancialEventInputSchema.safeExtend({ type: z.enum(FINANCIAL_EVENT_TYPES).exclude(["estimate", "hold"]) });
const EstimateEventSchema = FinancialEventInputSchema.safeExtend({ type: z.literal("estimate"), expectation: ExpectationSchema });
const HoldEventSchema = FinancialEventInputSchema.safeExtend({
  type: z.literal("hold"),
  expectation: ExpectationSchema.extend({ hold_status: z.enum(HOLD_STATUSES) }),
});

const VerifyInputSchema = z.object({
  path: z.string().min(1).optional().describe("Path to the signed document's JSON file, such as the closure_path close_task returned"),
  document: z.record(z.string(), z.unknown()).optional().describe("The signed document as inline JSON (instead of path)"),
  trusted_keys: z.array(PublicKeyRecordSchema).default([]).describe("Public key records to trust in addition to this server's own service keys"),
});

function reply(summary: string, data: object): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

function totalsLines(totals: CurrencyTotals): string[] {
  return Object.entries(totals).map(
    ([currency, t]) => `${currency}: net cost ${t.net_cost}, reported paid ${t.reported_paid}, unresolved ${t.unresolved} (minor units)`,
  );
}

function exceptionLines(exceptions: { kind: string; detail: string }[]): string[] {
  return [`open exceptions: ${exceptions.length}`, ...exceptions.map((x) => `  ${x.kind}: ${x.detail}`)];
}

function financialEventReply(outcome: FinancialEventOutcome, note?: string): CallToolResult {
  const event = outcome.financial_event;
  const lines = [`${outcome.deduplicated ? "Already recorded" : "Recorded"} ${event.type} ${event.financial_event_id}`];
  if (outcome.attribution) lines.push(`attributed to ${outcome.attribution.delegation_id ?? outcome.attribution.task_id}`);
  else lines.push("not attributed to a task or delegation");
  if (outcome.exception_ids.length > 0) lines.push(`exceptions opened: ${outcome.exception_ids.join(", ")}`);
  if (note) lines.push(note);
  return reply(lines.join("\n"), outcome);
}

/** The ATCN tools over one backend. Closures and their signing keys are written under dataDir. */
export function createAtcnMcpServer(options: { backend: Backend; dataDir: string }): McpServer {
  const { backend } = options;
  const dataDir = resolve(options.dataDir);
  const server = new McpServer({ name: "atcn", version: SERVER_VERSION });

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        'Open a task: the root of the after-the-fact cost record for one piece of agent work (a job or user request). Returns task_id; later calls may also address the task as "ext:<external_ref>". Amounts are integer minor units in an ISO 4217 currency. budget_minor is recorded for comparison only. ' +
        RECORD_ONLY,
      inputSchema: TaskInputSchema,
    },
    async (input) => {
      const task = await backend.createTask(input);
      return reply(`Created task ${task.task_id} (${input.external_ref}, ${input.currency})`, task);
    },
  );

  server.registerTool(
    "create_delegation",
    {
      title: "Create delegation",
      description:
        'Record that the task (or a parent delegation) handed work to a provider: another agent, or a paid API or tool. Set external_ref to address it later as "ext:<external_ref>", and provider_job_ref (the provider\'s own job or request ID) so costs and claims match automatically. Set provider_id (from add_provider) when the provider signs estimates or outcomes. Quoted and accepted amounts are recorded, never enforced.',
      inputSchema: DelegationInputSchema.extend({ task_id: TaskRef }),
    },
    async ({ task_id, ...input }) => {
      const delegation = await backend.createDelegation(task_id, input);
      return reply(`Created delegation ${delegation.delegation_id} under task ${task_id}`, delegation);
    },
  );

  server.registerTool(
    "record_claim",
    {
      title: "Record delivery claim",
      description:
        "Append a delivery claim to a delegation: acceptance, completion, partial_completion, cancellation, provider_failure, terms_update, or correction (supersedes an earlier claim; nothing is overwritten). asserted_by says who made the statement. A provider-signed outcome claim (completion, partial_completion, cancellation or provider_failure) is asserted_by provider and carries signer: a signature over the outcome statement by a key bound with bind_provider_key.",
      inputSchema: DelegationEventInputSchema.extend({ delegation_id: DelegationRef }),
    },
    async ({ delegation_id, ...input }) => {
      const claim = await backend.appendDelegationEvent(delegation_id, input);
      return reply(`Recorded ${input.type} claim ${claim.event_id} on delegation ${delegation_id}`, claim);
    },
  );

  server.registerTool(
    "record_cost",
    {
      title: "Record cost",
      description:
        "Record a financial event from a bill, receipt or payment log: charge, invoice, fee, refund, credit, adjustment, payment_reported, reversal, quote or fx_rate. Deduplicated by source + source_event_id. Attribution uses only the stable references in match (task_id, delegation_id, task_external_ref, delegation_external_ref, provider_job_ref); an event without a unique match is kept and opens an exception. A payment or refund may embed rail_attestation, the payment rail's own record, which verifies offline. Amounts are integer minor units. Use record_estimate and record_hold for estimates and holds. " +
        RECORD_ONLY,
      inputSchema: CostEventSchema,
    },
    async (input) => financialEventReply(await backend.recordFinancialEvent(input)),
  );

  server.registerTool(
    "record_estimate",
    {
      title: "Record estimate",
      description:
        "Record what a piece of work was expected to cost before it ran: an estimate by the agent, a budget gateway or the operator (expectation.issued_by). It is a record only: nothing is reserved or enforced, and estimates never count toward net cost; the closure reports actual cost against them. Set expectation.supersedes to the source_event_id of an earlier estimate this one replaces. A provider-signed estimate carries expectation.signer (bind the key first with bind_provider_key). Attach it to a task or delegation with match. " +
        RECORD_ONLY,
      inputSchema: EstimateEventSchema,
    },
    async (input) => financialEventReply(await backend.recordFinancialEvent(input), "Estimates are records only; nothing was reserved and they do not count toward net cost."),
  );

  server.registerTool(
    "record_hold",
    {
      title: "Record hold",
      description:
        "Record a budget hold that a gateway or wallet reported, with its status in expectation.hold_status (open, captured, released or expired). It is a record only: ATCN reserves nothing and never blocks spend, and holds never count toward net cost; the closure compares actual cost with what was held. Record a status change as a new hold record whose expectation.supersedes is the earlier record's source_event_id. Attach it to a task or delegation with match. " +
        RECORD_ONLY,
      inputSchema: HoldEventSchema,
    },
    async (input) => financialEventReply(await backend.recordFinancialEvent(input), "Holds are records only; nothing was reserved and they do not count toward net cost."),
  );

  server.registerTool(
    "add_provider",
    {
      title: "Add provider",
      description:
        "Register a provider (an agent's provider, a paid API, or a budget gateway) so delegations can name it by provider_id and its signing key can be bound. One provider per provider_own_id: adding it again returns the existing provider.",
      inputSchema: ProviderInputSchema.pick({ name: true, provider_own_id: true }),
    },
    async ({ name, provider_own_id }) => {
      const provider = await backend.addProvider(name, provider_own_id);
      return reply(`Provider ${provider.provider_id} (${name})`, provider);
    },
  );

  server.registerTool(
    "bind_provider_key",
    {
      title: "Bind provider key",
      description:
        "Bind a provider's Ed25519 public key (base64url, as from generateKeyPair in @atcn/sdk) so the estimates, holds and outcome claims it signs are accepted, and verify offline from the closure. Returns the binding_id that signers name.",
      inputSchema: z.object({
        provider_id: z.string().min(1).describe("The provider_id from add_provider"),
        key_id: z.string().min(1).describe("The provider's own name for the key"),
        public_key: z.string().min(1).describe("Ed25519 public key, base64url"),
      }),
    },
    async ({ provider_id, key_id, public_key }) => {
      const binding = await backend.bindProviderKey(provider_id, key_id, public_key);
      return reply(`Bound key ${key_id} to provider ${provider_id} as ${binding.binding_id}`, binding);
    },
  );

  server.registerTool(
    "report_capture_gap",
    {
      title: "Report capture gap",
      description:
        "Record part of the delegation chain that was not captured: capture_failed, queue_overflow, provider_undisclosed, manual_gap, or broken_edge (a reported sub-task with no outcome). The closure then shows lineage as incomplete, and an incomplete_lineage exception stays open.",
      inputSchema: CaptureGapInputSchema.extend({ task_id: TaskRef }),
    },
    async ({ task_id, ...input }) => {
      const gap = await backend.reportCaptureGap(task_id, input);
      return reply(`Recorded ${input.kind} gap ${gap.gap_id} on task ${task_id}`, gap);
    },
  );

  server.registerTool(
    "task_summary",
    {
      title: "Task summary",
      description:
        "The task's cost roll-up by currency (net cost, reported paid, unresolved, and the billed, refunded and credited amounts) with its open exceptions. Estimates and holds never count toward net cost.",
      inputSchema: z.object({ task_id: TaskRef }),
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const summary: TaskSummary = await backend.taskSummary(task_id);
      const lines = [`Task ${task_id}`, ...totalsLines(summary.totals_by_currency), ...exceptionLines(summary.open_exceptions)];
      return reply(lines.join("\n"), summary);
    },
  );

  server.registerTool(
    "close_task",
    {
      title: "Close task",
      description:
        "Close the task into a signed, versioned closure: delegation lineage, delivery claims, event digests, the roll-up, open exceptions, and the estimate-versus-actual report. Closing again creates the next version. Open exceptions do not block closing; they are listed in the closure. Writes the closure and the keys that verify it as JSON files in the server's data directory and returns their paths, the digest and a summary.",
      inputSchema: z.object({ task_id: TaskRef }),
    },
    async ({ task_id }) => {
      const { closure, digest } = await backend.closeTask(task_id);
      const payload = closure.payload;
      const closuresDir = join(dataDir, "closures");
      mkdirSync(closuresDir, { recursive: true });
      const closurePath = join(closuresDir, `${payload.task.task_id}.v${payload.version}.json`);
      writeFileSync(closurePath, `${JSON.stringify(closure, null, 2)}\n`);
      const keysPath = join(dataDir, "keys.json");
      writeFileSync(keysPath, `${JSON.stringify(await backend.trustedKeys(), null, 2)}\n`);
      const verifyCommand = `npx @atcn/verify-cli ${closurePath} --keys ${keysPath}`;
      const openExceptions = payload.open_exceptions.map(({ kind, detail }) => ({ kind, detail }));
      const report = payload.expectation_report;
      const data = {
        task_id: payload.task.task_id,
        closure_id: payload.closure_id,
        version: payload.version,
        digest,
        closure_path: closurePath,
        keys_path: keysPath,
        totals_by_currency: payload.rollup.root_total,
        open_exceptions: openExceptions,
        lineage_complete: payload.lineage.complete,
        expectation_report: report ?? null,
        verify_command: verifyCommand,
      };
      const lines = [`Closed task ${data.task_id}: closure ${data.closure_id} version ${data.version}, digest ${digest}`, ...totalsLines(data.totals_by_currency)];
      if (report) {
        const t = report.task;
        lines.push(`${report.currency}: estimated ${t.estimated_minor ?? "none"}, held ${t.held_minor}, actual ${t.actual_minor} (estimates and holds are records only; nothing was reserved)`);
      }
      lines.push(...exceptionLines(openExceptions), `lineage complete: ${data.lineage_complete}`, `closure: ${closurePath}`, `keys: ${keysPath}`, `verify offline: verify_document, or ${verifyCommand}`);
      return reply(lines.join("\n"), data);
    },
  );

  server.registerTool(
    "verify_document",
    {
      title: "Verify document",
      description:
        `Verify a signed ATCN document offline, without contacting any service: a task closure, a provider receipt, or a closure package. Pass a file path or the document as inline JSON. This server's own service keys are trusted automatically; add others in trusted_keys. ${ATTESTATION_CAVEAT}`,
      inputSchema: VerifyInputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ path, document, trusted_keys }) => {
      if ((path === undefined) === (document === undefined)) throw new Error("pass exactly one of path or document");
      const signed: unknown = path === undefined ? document : JSON.parse(readFileSync(resolve(path), "utf8"));
      const result = verifyDocument(signed, [...(await backend.trustedKeys()), ...trusted_keys]);
      const lines =
        result.unsupported_schema_version !== undefined
          ? [`UNSUPPORTED: ${result.checks[0].details[0]}`]
          : [`${result.label} is ${result.valid ? "VALID" : "INVALID"}`, ...result.checks.filter((c) => !c.ok).map((c) => `FAIL ${c.name}: ${c.details.join("; ")}`)];
      const notInspected = result.checks.filter((c) => c.ok && c.state === "not_inspected");
      if (notInspected.length > 0) lines.push(`not inspected: ${notInspected.map((c) => c.name).join(", ")}`);
      lines.push(ATTESTATION_CAVEAT);
      return reply(lines.join("\n"), result);
    },
  );

  return server;
}
