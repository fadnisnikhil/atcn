/**
 * Canonical JSON following RFC 8785 (JCS) for the subset of JSON that ATCN signs.
 *
 * Signed payloads may contain only strings, booleans, null, arrays, objects, and
 * safe integers. Non-integer numbers are rejected so every SDK language produces
 * byte-identical output without re-implementing ECMAScript number formatting.
 * Object keys are sorted by UTF-16 code units (ATCN keys are ASCII).
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Canonical JSON only permits safe integers (at ${path}: ${value})`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + serialize(v, `${path}.${k}`)).join(",") + "}";
  }
  throw new Error(`Value at ${path} is not representable in canonical JSON`);
}
