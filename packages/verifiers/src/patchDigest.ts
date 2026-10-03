import { utf8Decode } from "@atcn/schema";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

/** Confirms the evidence is a non-empty unified diff and reports its size. The digest is checked by the runner. */
export const patchDigestVerifier: VerifierPlugin = {
  name: "patch_digest",
  version: "1.0.0",
  evidenceTypes: ["patch_ref"],
  run(context: VerifierContext): VerifierOutcome {
    const text = utf8Decode(context.content);
    const lines = text.split("\n");
    const files = lines.filter((l) => l.startsWith("+++ ")).length;
    const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    if (files === 0) {
      return { status: "invalid_evidence", kind: "deterministic", details: { error: "not a unified diff" }, model: null };
    }
    const minFiles = Number(context.check.config.min_files_changed ?? 1);
    return {
      status: files >= minFiles ? "pass" : "fail",
      kind: "deterministic",
      details: { files_changed: files, additions, deletions, min_files_changed: minFiles },
      model: null,
    };
  },
};
