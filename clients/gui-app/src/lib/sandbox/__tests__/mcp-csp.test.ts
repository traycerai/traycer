import { describe, expect, it } from "vitest";
import {
  mcpAppContentPolicy,
  pageContentPolicy,
  type McpAppContentPolicyResult,
  type McpAppCsp,
} from "../mcp-csp";

/** Every origin the sandbox loader itself is served from, on any client. */
const SANDBOX_ORIGINS = [
  "traycer-sandbox:",
  "capacitor:",
  "localhost",
  "'self'",
  "*",
];

function csp(overrides: Partial<McpAppCsp>): McpAppCsp {
  return {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
    ...overrides,
  };
}

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split("; ").map((part) => {
      const [name = "", ...sources] = part.split(" ");
      return [name, sources.join(" ")];
    }),
  );
}

function policyOf(result: McpAppContentPolicyResult): string {
  if (result.kind !== "ok") throw new Error(`invalid: ${result.reason}`);
  return result.policy;
}

describe("pageContentPolicy", () => {
  it("lets an open page reach the web, localhost and the LAN by scheme", () => {
    expect(directives(pageContentPolicy("open")).get("default-src")).toBe(
      "http: https: ws: wss: data: blob: 'unsafe-inline' 'unsafe-eval'",
    );
  });

  it("limits an https-only page to https, wss and inline data", () => {
    const policy = pageContentPolicy("https-only");
    const parsed = directives(policy);
    expect(parsed.get("default-src")).toBe("https: data: blob:");
    expect(parsed.get("connect-src")).toBe("https: wss: data: blob:");
    expect(parsed.get("frame-src")).toBe("'none'");
    expect(policy).not.toMatch(/(^|[ ;])http:/);
    expect(policy).not.toContain("*");
  });

  it.each(["open", "https-only"] as const)(
    "never admits the sandbox's own origin for an %s page",
    (networkPolicy) => {
      const policy = pageContentPolicy(networkPolicy);
      for (const origin of SANDBOX_ORIGINS) {
        expect(policy).not.toContain(origin);
      }
      expect(directives(policy).get("default-src")).toContain("data:");
    },
  );
});

describe("mcpAppContentPolicy", () => {
  it("denies the network by default when the resource declared no CSP", () => {
    const parsed = directives(policyOf(mcpAppContentPolicy(null)));
    expect(parsed.get("default-src")).toBe("'none'");
    expect(parsed.get("connect-src")).toBe("'none'");
    expect(parsed.get("frame-src")).toBe("'none'");
    expect(parsed.get("script-src")).toBe("'unsafe-inline'");
    expect(parsed.get("img-src")).toBe("data: blob:");
  });

  it("takes fonts from data: only, never the sandbox's own origin", () => {
    const policy = policyOf(mcpAppContentPolicy(null));
    expect(directives(policy).get("font-src")).toBe("data:");
    for (const origin of SANDBOX_ORIGINS) {
      expect(policy).not.toContain(origin);
    }
  });

  it("adds each declared list to exactly the directives it names", () => {
    const parsed = directives(
      policyOf(
        mcpAppContentPolicy(
          csp({
            connectDomains: [
              "https://api.example.com",
              "wss://live.example.com",
            ],
            resourceDomains: ["https://*.cdn.example.com:8443"],
            frameDomains: ["https://embed.example.com"],
          }),
        ),
      ),
    );
    expect(parsed.get("connect-src")).toBe(
      "https://api.example.com wss://live.example.com",
    );
    expect(parsed.get("script-src")).toBe(
      "'unsafe-inline' https://*.cdn.example.com:8443",
    );
    expect(parsed.get("img-src")).toBe(
      "data: blob: https://*.cdn.example.com:8443",
    );
    expect(parsed.get("frame-src")).toBe("https://embed.example.com");
    expect(parsed.get("default-src")).toBe("'none'");
  });

  it("ignores baseUriDomains", () => {
    const base = policyOf(mcpAppContentPolicy(null));
    const withBase = policyOf(
      mcpAppContentPolicy(csp({ baseUriDomains: ["https://a.example.com"] })),
    );
    expect(withBase).toBe(base);
  });

  it.each([
    ["a semicolon", "https://a.example.com; script-src *"],
    ["a quote", "https://a.example.com'"],
    ["a space", "https://a.example.com https://b.example.com"],
    ["a keyword", "'unsafe-eval'"],
    ["a bare wildcard", "*"],
    ["a scheme-only source", "https:"],
    ["plain http", "http://a.example.com"],
    ["ws", "ws://a.example.com"],
    ["a path", "https://a.example.com/x"],
    ["uppercase", "https://A.example.com"],
    ["a newline", "https://a.example.com\nscript-src *"],
  ])("refuses a domain with %s", (_label, domain) => {
    for (const field of [
      "connectDomains",
      "resourceDomains",
      "frameDomains",
    ] as const) {
      const result = mcpAppContentPolicy(csp({ [field]: [domain] }));
      expect(result.kind).toBe("invalid");
    }
  });

  it("accepts wss only through the same pattern as https", () => {
    const result = mcpAppContentPolicy(
      csp({ connectDomains: ["wss://*.live.example.com:443"] }),
    );
    expect(result.kind).toBe("ok");
  });

  it("refuses a list of more than 32 entries and accepts exactly 32", () => {
    const many = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `https://h${i}.example.com`);
    expect(mcpAppContentPolicy(csp({ connectDomains: many(32) })).kind).toBe(
      "ok",
    );
    const refused = mcpAppContentPolicy(csp({ resourceDomains: many(33) }));
    expect(refused.kind).toBe("invalid");
  });
});
