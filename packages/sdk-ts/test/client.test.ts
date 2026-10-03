import { describe, expect, it } from "vitest";
import { AtcnClient, SDK_HEADER, SDK_VERSION } from "../src/index.js";
import sdkPackage from "../package.json";

function recordingFetch(seen: Headers[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("AtcnClient headers", () => {
  it("names the SDK and its version on every request, and nothing else about the caller", async () => {
    const seen: Headers[] = [];
    const client = new AtcnClient({ baseUrl: "http://api.test", apiKey: "k", fetch: recordingFetch(seen) });
    await client.serviceKeys();
    await client.request("POST", "/v1/tasks", { external_ref: "x" });
    for (const headers of seen) expect(headers.get(SDK_HEADER)).toBe(`typescript/${SDK_VERSION}`);
    expect([...seen[0].keys()].sort()).toEqual(["atcn-sdk", "authorization"]);
  });

  it("sends the caller's default headers on every request", async () => {
    const seen: Headers[] = [];
    const client = new AtcnClient({ baseUrl: "http://api.test", apiKey: "k", fetch: recordingFetch(seen), headers: { "atcn-workflow": "demo" } });
    await client.serviceKeys();
    expect(seen[0].get("atcn-workflow")).toBe("demo");
  });

  it("reports the SDK version published in package.json", () => {
    expect(SDK_VERSION).toBe(sdkPackage.version);
  });
});
