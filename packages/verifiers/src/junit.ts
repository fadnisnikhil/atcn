import { XMLParser } from "fast-xml-parser";
import { utf8Decode } from "@atcn/schema";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

interface Counts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function countSuite(suite: Record<string, unknown>): Counts {
  const cases = asArray(suite.testcase as Record<string, unknown> | Record<string, unknown>[]);
  const counts: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const testCase of cases) {
    counts.tests += 1;
    if (testCase.failure !== undefined) counts.failures += 1;
    else if (testCase.error !== undefined) counts.errors += 1;
    else if (testCase.skipped !== undefined) counts.skipped += 1;
  }
  for (const nested of asArray(suite.testsuite as Record<string, unknown> | Record<string, unknown>[])) {
    const inner = countSuite(nested);
    counts.tests += inner.tests;
    counts.failures += inner.failures;
    counts.errors += inner.errors;
    counts.skipped += inner.skipped;
  }
  return counts;
}

/** Parses a JUnit XML report by counting <testcase> elements (attribute totals are not trusted). */
export function parseJUnit(xml: string): Counts | null {
  let document: Record<string, unknown>;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, allowBooleanAttributes: true, processEntities: false });
    document = parser.parse(xml, true) as Record<string, unknown>;
  } catch {
    return null;
  }
  const root = (document.testsuites ?? document.testsuite) as Record<string, unknown> | undefined;
  if (!root || typeof root !== "object") return null;
  if (document.testsuites) return countSuite({ testsuite: root.testsuite });
  return countSuite(root);
}

export const junitTestsVerifier: VerifierPlugin = {
  name: "junit_tests",
  version: "1.0.0",
  evidenceTypes: ["test_report"],
  run(context: VerifierContext): VerifierOutcome {
    const counts = parseJUnit(utf8Decode(context.content));
    if (!counts) return { status: "invalid_evidence", kind: "deterministic", details: { error: "not a JUnit XML report" }, model: null };
    const minTests = Number(context.check.config.min_tests ?? 1);
    const minPassRateBps = Number(context.check.config.min_pass_rate_bps ?? 10000);
    const executed = counts.tests - counts.skipped;
    const passed = executed - counts.failures - counts.errors;
    const passRateBps = executed > 0 ? Math.floor((passed * 10000) / executed) : 0;
    const ok = executed >= minTests && passRateBps >= minPassRateBps;
    return {
      status: ok ? "pass" : "fail",
      kind: "deterministic",
      details: { ...counts, executed, passed, pass_rate_bps: passRateBps, min_tests: minTests, min_pass_rate_bps: minPassRateBps },
      model: null,
    };
  },
};
