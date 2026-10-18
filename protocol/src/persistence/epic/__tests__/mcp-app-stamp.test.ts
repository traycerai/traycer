import { describe, expect, it } from "vitest";

import {
  MCP_UI_CSP_DOMAIN_PATTERN,
  mcpUiCspNormalizedSchema,
  mcpUiPermissionSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * The MCP App stamp's closed vocabularies: CSP origins and device
 * permissions. Every string here is agent-authored and rendered by a client,
 * so each is checked at a parse boundary rather than trusted.
 */

describe("MCP App stamp vocabularies", () => {
  describe("CSP origins", () => {
    it.each([
      "https://example.com",
      "wss://stream.example.com",
      "https://*.example.com",
      "https://example.com:8443",
      "https://cdn-1.example.co.uk",
    ])("admit %s", (origin) => {
      expect(MCP_UI_CSP_DOMAIN_PATTERN.test(origin)).toBe(true);
    });

    it.each([
      ["a directive separator", "https://example.com; script-src *"],
      ["a single quote", "https://example.com'"],
      ["a double quote", 'https://example.com"'],
      ["a space", "https://example.com evil.com"],
      ["a CSP keyword", "'unsafe-inline'"],
      ["a bare keyword", "self"],
      ["a wildcard host", "*"],
      ["a scheme-only source", "https:"],
      ["plain http", "http://example.com"],
      ["a data: source", "data:"],
      ["a path", "https://example.com/path"],
      ["a mid-label wildcard", "https://a.*.example.com"],
      ["a newline", "https://example.com\nscript-src *"],
      ["an uppercase host", "https://Example.com"],
    ])("reject %s", (_label, origin) => {
      expect(MCP_UI_CSP_DOMAIN_PATTERN.test(origin)).toBe(false);
    });

    const emptyCsp = {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    };

    it("is enforced on every one of the four lists", () => {
      for (const key of Object.keys(emptyCsp)) {
        expect(
          mcpUiCspNormalizedSchema.safeParse({
            ...emptyCsp,
            [key]: ["https://example.com"],
          }).success,
        ).toBe(true);
        expect(
          mcpUiCspNormalizedSchema.safeParse({
            ...emptyCsp,
            [key]: ["https://example.com; img-src *"],
          }).success,
        ).toBe(false);
      }
    });

    it("allows 32 entries in a list and rejects 33", () => {
      const origins = (count: number) =>
        Array.from(
          { length: count },
          (_unused, i) => `https://h${i}.example.com`,
        );
      expect(
        mcpUiCspNormalizedSchema.safeParse({
          ...emptyCsp,
          connectDomains: origins(32),
        }).success,
      ).toBe(true);
      expect(
        mcpUiCspNormalizedSchema.safeParse({
          ...emptyCsp,
          connectDomains: origins(33),
        }).success,
      ).toBe(false);
    });

    it("requires every list to be present", () => {
      expect(
        mcpUiCspNormalizedSchema.safeParse({
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
        }).success,
      ).toBe(false);
    });
  });

  describe("device permissions", () => {
    it.each(["camera", "microphone", "geolocation", "clipboard-write"])(
      "admit %s",
      (permission) => {
        expect(mcpUiPermissionSchema.safeParse(permission).success).toBe(true);
      },
    );

    it.each(["clipboard-read", "payment", "camera; microphone", "", "Camera"])(
      "reject %j",
      (permission) => {
        expect(mcpUiPermissionSchema.safeParse(permission).success).toBe(false);
      },
    );
  });
});
