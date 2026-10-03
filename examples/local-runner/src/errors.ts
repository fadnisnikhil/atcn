import type { z } from "zod";

/** A request the runner refuses, with a message meant for the person who wrote the job file or calls the runner. */
export class LocalRunnerError extends Error {
  override name = "LocalRunnerError";
}

/** Parses with a zod schema and reports every problem as "path: message" lines. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `  ${[label, ...issue.path].join(".")}: ${issue.message}`);
  throw new LocalRunnerError(`invalid ${label}:\n${problems.join("\n")}`);
}
