import { readFileSync } from "node:fs";
import { verifyClearingVerdict, verifyClosurePackage } from "@atcn/core";
import { utf8Encode, type PublicKeyRecord } from "@atcn/schema";
import { verifySubledgerDocument } from "@atcn/subledger";
import { describe, expect, it } from "vitest";

/** Written by scripts/generate-package-vectors.ts (npm run gen:vectors); the Python SDK must reproduce every report. */
type VectorCase = { name: string } & Record<string, any>;
const vectors: { trusted_keys: PublicKeyRecord[]; packages: VectorCase[]; closures: VectorCase[]; verdicts: VectorCase[] } = JSON.parse(
  readFileSync(new URL("../../../packages/core/test-vectors/closure-packages.json", import.meta.url), "utf8"),
);
const trustedKeys = vectors.trusted_keys;
const named = (cases: VectorCase[], name: string): VectorCase => {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no vector named ${name}`);
  return found;
};
const failedDetails = (report: { checks: { name: string; ok: boolean; details: string[] }[] }, name: string) => report.checks.find((c) => c.name === name && !c.ok)?.details ?? [];

describe("closure package vectors", () => {
  it.each(vectors.packages)("$name: the stored report is current", (c: any) => {
    const report = verifyClosurePackage(c.package, { trustedKeys: c.options.trusted_keys ?? trustedKeys, traces: c.options.traces?.map(utf8Encode) });
    expect(report).toEqual(c.report);
  });

  it.each(vectors.closures)("$name: the stored closure report is current", (c: any) => {
    const report = verifySubledgerDocument(c.document, { trustedKeys, ...(c.obligation_packages ? { obligationPackages: c.obligation_packages } : {}) });
    expect(report).toEqual(c.report);
  });

  it.each(vectors.verdicts)("$name: the stored verdict report is current", (c: any) => {
    const report = verifyClearingVerdict(c.verdict, { trustedKeys: c.trusted_keys ?? trustedKeys, ...("closure_package" in c ? { closurePackage: c.closure_package } : {}) });
    expect(report).toEqual(c.report);
  });
});

describe("inputs that used to throw fail a check instead", () => {
  const verify = (name: string) => {
    const c = named(vectors.packages, name);
    return verifyClosurePackage(c.package, { trustedKeys, traces: c.options.traces?.map(utf8Encode) });
  };

  it("terms without an acceptance policy on a later event", () => {
    expect(verify("terms without an acceptance policy on a later event, re-signed").valid).toBe(false);
  });

  it("an evidence event without an envelope", () => {
    expect(failedDetails(verify("evidence event without an envelope, re-signed"), "decision_inputs_and_replay")).toEqual([
      expect.stringContaining("replaying the clearing policy produced a different decision"),
    ]);
  });

  it("invalid terms cited by digest are not replayed", () => {
    expect(failedDetails(verify("invalid terms replayed through their digest, re-signed"), "decision_inputs_and_replay")).toContainEqual(expect.stringMatching(/terms sha256:[0-9a-f]{64} not in package$/));
  });

  it("journal totals past the safe integer range", () => {
    expect(failedDetails(verify("journal totals past the safe integer range, re-signed"), "records_match_signed_events")).toContainEqual(expect.stringMatching(/totals differ from its journal event$/));
  });

  it("an attestation whose text holds a fraction is not counted", () => {
    expect(verify("1.1 attestation with a fraction in an unknown member, re-signed").valid).toBe(false);
  });

  it("usage too large to price exactly", () => {
    expect(failedDetails(verify("usage-priced work, usage too large to price exactly, re-signed"), "trace_evidence")).toEqual([expect.stringMatching(/: usage too large to price exactly$/)]);
  });

  it("a verdict's package holding a fraction in an unknown member is not the package read", () => {
    const c = named(vectors.verdicts, "verdict with a package holding a fraction in an unknown member");
    const report = verifyClearingVerdict(c.verdict, { trustedKeys, closurePackage: c.closure_package });
    expect(report.checks.find((check) => check.name === "package_digest")).toEqual({ name: "package_digest", ok: false, details: ["the closure package is not the one the verdict was read from"] });
  });
});
