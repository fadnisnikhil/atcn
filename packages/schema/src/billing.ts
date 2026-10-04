import { z } from "zod";

/**
 * A2A billing-reference extension, version 1. An agent declares it in its Agent Card under
 * capabilities.extensions[] so a buyer knows which reference its bills carry, and so the charge can be matched to
 * the delegation without hand mapping. Optional: agents that do not declare it keep today's behaviour.
 * Spec: docs/extensions/billing-ref-v1.md.
 */
export const BILLING_REF_EXTENSION_URI = "https://github.com/fadnisnikhil/atcn/blob/main/docs/extensions/billing-ref-v1.md";

export const BillingRefSchema = z.union([
  z.enum(["task_id", "context_id"]),
  z.strictObject({ metadata_key: z.string().min(1).max(100) }),
]);
export type BillingRef = z.infer<typeof BillingRefSchema>;

/** A per-skill price the agent states. It is a stated price, not a quote: a buyer may record it as an estimate. */
export const SkillPriceSchema = z.strictObject({
  skill_id: z.string().min(1).max(200),
  /** What one amount_minor buys, for example "task" or "call". */
  unit: z.string().min(1).max(50),
  amount_minor: z.number().int().nonnegative(),
});
export type SkillPrice = z.infer<typeof SkillPriceSchema>;

export const BillingRefParamsSchema = z.strictObject({
  /** The reference every bill line carries: the A2A task id, the context id, or a value in the task's metadata. */
  billing_ref: BillingRefSchema,
  /** ISO 4217 currency of the stated prices. */
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  pricing: z.array(SkillPriceSchema).max(200).optional(),
});
export type BillingRefParams = z.infer<typeof BillingRefParamsSchema>;

/** An A2A AgentExtension entry as it appears in capabilities.extensions[]. */
export interface AgentCardExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: unknown;
}

/**
 * The billing-reference params an Agent Card declares, or null when the card does not declare the extension.
 * A declared extension whose params do not parse is an error, not a silent fallback.
 */
export function billingRefFromAgentCard(card: object): BillingRefParams | null {
  const extensions = (((card as { capabilities?: unknown }).capabilities as { extensions?: AgentCardExtension[] } | undefined)?.extensions ?? []) as AgentCardExtension[];
  const declared = extensions.find((e) => e.uri === BILLING_REF_EXTENSION_URI);
  if (!declared) return null;
  const parsed = BillingRefParamsSchema.safeParse(declared.params);
  if (!parsed.success) throw new Error(`invalid ${BILLING_REF_EXTENSION_URI} params: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/**
 * The provider_job_ref for one A2A task under the card's declared billing reference. Null when the card declares no
 * extension (the caller falls back to its own mapping) or the declared metadata value is absent: a charge carrying
 * that value then opens unmatched_charge rather than being dropped.
 */
export function providerJobRefFor(card: object, task: { id: string; contextId?: string; metadata?: Record<string, unknown> }): string | null {
  const params = billingRefFromAgentCard(card);
  if (!params) return null;
  const ref = params.billing_ref;
  if (ref === "task_id") return task.id;
  if (ref === "context_id") return task.contextId ? task.contextId : null;
  const value = task.metadata?.[ref.metadata_key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The price the card states for a skill, in the card's currency, or null when none is stated. */
export function statedSkillPrice(card: object, skillId: string): { amount_minor: number; currency: string; unit: string } | null {
  const params = billingRefFromAgentCard(card);
  const price = params?.pricing?.find((p) => p.skill_id === skillId);
  if (!price || !params?.currency) return null;
  return { amount_minor: price.amount_minor, currency: params.currency, unit: price.unit };
}
