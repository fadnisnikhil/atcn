import { describe, expect, it } from "vitest";
import algovoiEdge from "../test-vectors/external/jcs_edge_v1.json";
import atcnJcs from "../test-vectors/atcn_jcs_v1.json";
import { canonicalize, digestOf } from "../src/index.js";

interface JcsVector {
  vector_id: string;
  preimage: unknown;
  expected_jcs_bytes_b64: string;
  expected_sha256: string;
}

function checkVector(vector: JcsVector): void {
  const canonical = canonicalize(vector.preimage);
  expect(Buffer.from(canonical, "utf8").toString("base64"), vector.vector_id).toBe(vector.expected_jcs_bytes_b64);
  expect(digestOf(vector.preimage), vector.vector_id).toBe(`sha256:${vector.expected_sha256}`);
}

describe("RFC 8785 vectors shared with other implementations (A2A discussion #2038)", () => {
  it("reproduces every AlgoVoi jcs_edge_v1 vector byte for byte", () => {
    expect(algovoiEdge.vectors).toHaveLength(10);
    for (const vector of algovoiEdge.vectors) checkVector(vector);
  });

  it("gives 1.0 and 1 the same canonical bytes, because JSON parsing keeps only the value", () => {
    const [float, int] = ["jcs-edge-005-number-one-float", "jcs-edge-006-number-one-int"].map((id) => algovoiEdge.vectors.find((v) => v.vector_id === id)!);
    expect(digestOf(float.preimage)).toBe(digestOf(int.preimage));
  });

  it("orders keys by UTF-16 code units, so U+1F600 sorts before U+FFFF", () => {
    expect(canonicalize({ "\uffff": 1, "\u{1F600}": 2 })).toBe('{"\u{1F600}":2,"\uffff":1}');
  });

  it("reproduces ATCN's own published vectors", () => {
    for (const vector of atcnJcs.vectors) checkVector(vector);
  });
});
