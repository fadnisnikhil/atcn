/** A node a financial event's stable references point to, and which references matched. */
export interface MatchCandidate {
  task_id: string;
  delegation_id: string | null;
  reason: string;
}

/**
 * Candidates from stable references only (PRD §6): one per node, with the matching references joined by "+". A
 * delegation candidate replaces a task-level candidate for the same task, because it is more specific. An event is
 * attributed automatically only when exactly one candidate remains.
 */
export function mergeMatchCandidates(found: MatchCandidate[]): MatchCandidate[] {
  const byNode = new Map<string, MatchCandidate>();
  for (const c of found) {
    const key = c.delegation_id ?? `task:${c.task_id}`;
    const existing = byNode.get(key);
    byNode.set(key, existing ? { ...existing, reason: `${existing.reason}+${c.reason}` } : c);
  }
  const delegationTasks = new Set([...byNode.values()].filter((c) => c.delegation_id).map((c) => c.task_id));
  return [...byNode.values()].filter((c) => c.delegation_id !== null || !delegationTasks.has(c.task_id));
}
