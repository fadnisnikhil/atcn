import { utf8Decode } from "@atcn/schema";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

interface EslintFileResult {
  filePath: string;
  errorCount: number;
  warningCount: number;
}

function isEslintReport(value: unknown): value is EslintFileResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as EslintFileResult).filePath === "string" &&
        Number.isInteger((f as EslintFileResult).errorCount) &&
        Number.isInteger((f as EslintFileResult).warningCount),
    )
  );
}

/** Evaluates ESLint's JSON formatter output against max error/warning thresholds. */
export const eslintLintVerifier: VerifierPlugin = {
  name: "eslint_lint",
  version: "1.0.0",
  evidenceTypes: ["lint_report"],
  run(context: VerifierContext): VerifierOutcome {
    let report: unknown;
    try {
      report = JSON.parse(utf8Decode(context.content));
    } catch {
      return { status: "invalid_evidence", kind: "deterministic", details: { error: "lint report is not JSON" }, model: null };
    }
    if (!isEslintReport(report)) {
      return { status: "invalid_evidence", kind: "deterministic", details: { error: "not an ESLint JSON report" }, model: null };
    }
    const errors = report.reduce((sum, f) => sum + f.errorCount, 0);
    const warnings = report.reduce((sum, f) => sum + f.warningCount, 0);
    const maxErrors = Number(context.check.config.max_errors ?? 0);
    const maxWarnings = Number(context.check.config.max_warnings ?? -1);
    const ok = errors <= maxErrors && (maxWarnings < 0 || warnings <= maxWarnings);
    return {
      status: ok ? "pass" : "fail",
      kind: "deterministic",
      details: { files: report.length, errors, warnings, max_errors: maxErrors, max_warnings: maxWarnings },
      model: null,
    };
  },
};
