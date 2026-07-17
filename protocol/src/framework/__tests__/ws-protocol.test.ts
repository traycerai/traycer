import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clientFrameSchema,
  clientOpenFrameSchema,
  clientRequestFrameSchema,
  clientFatalErrorFrameSchema,
  hostFrameSchema,
  hostOpenAckFrameSchema,
  hostResponseFrameSchema,
  hostFatalErrorFrameSchema,
  fatalErrorDetailsSchema,
} from "@traycer/protocol/framework/ws-protocol";

/**
 * Canonical-schema coverage for every WS frame kind.
 *
 * The per-request WebSocket session has a short, fixed frame vocabulary: the
 * client sends `open` → `request` (plus an optional `fatalError`), and the
 * host replies with `openAck` → `response` (plus an optional `fatalError`
 * at any point). These tests assert that the Zod schemas exported from
 * `@traycer/protocol/framework/ws-protocol` accept a minimal representative of
 * each frame shape, so the authoritative wire contract is exercised from one
 * place regardless of which consumer (host-side dispatcher, client-side
 * transport) is parsing.
 */

describe("ws-protocol canonical Zod schemas", () => {
  describe("client frames", () => {
    it("accepts an `open` frame with token and manifest", () => {
      const frame = {
        kind: "open" as const,
        token: "t-0",
        manifest: {
          "host.status": { major: 1, minor: 0 },
          "host.echo": { major: 2, minor: 3 },
        },
      };

      expect(clientOpenFrameSchema.safeParse(frame).success).toBe(true);

      const unionParse = clientFrameSchema.safeParse(frame);
      expect(unionParse.success).toBe(true);
      if (unionParse.success) {
        expect(unionParse.data.kind).toBe("open");
      }
    });

    it("pins current `open` frame wire bytes", () => {
      const frame = {
        kind: "open" as const,
        token: "t-0",
        manifest: {
          "host.status": { major: 1, minor: 0 },
          "worktree.listAllForHost": { major: 1, minor: 1 },
        },
      };

      const parsed = clientOpenFrameSchema.parse(frame);

      expect(JSON.stringify(parsed)).toBe(
        '{"kind":"open","token":"t-0","manifest":{"host.status":{"major":1,"minor":0},"worktree.listAllForHost":{"major":1,"minor":1}}}',
      );
    });

    it("accepts an `open` frame with an optional manifest channel", () => {
      const frame = {
        kind: "open" as const,
        token: "t-0",
        manifest: {
          "host.status": { major: 1, minor: 0 },
        },
        optionalManifest: {
          "future.method": { major: 1, minor: 0 },
        },
      };

      expect(clientOpenFrameSchema.parse(frame)).toEqual(frame);
      expect(clientFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("models a shipped client `open` parser stripping future additive keys", () => {
      const legacyClientOpenFrameSchema = z.object({
        kind: z.literal("open"),
        token: z.string(),
        manifest: z.record(
          z.string(),
          z.object({
            major: z.number().int().nonnegative(),
            minor: z.number().int().nonnegative(),
          }),
        ),
      });

      const parsed = legacyClientOpenFrameSchema.parse({
        kind: "open",
        token: "t-0",
        manifest: { "host.status": { major: 1, minor: 0 } },
        optionalManifest: { "future.method": { major: 1, minor: 0 } },
      });

      expect(parsed).toEqual({
        kind: "open",
        token: "t-0",
        manifest: { "host.status": { major: 1, minor: 0 } },
      });
    });

    it("accepts a `request` frame carrying the dispatch envelope", () => {
      const frame = {
        kind: "request" as const,
        requestId: "req-1",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: { hello: "world" },
      };

      expect(clientRequestFrameSchema.safeParse(frame).success).toBe(true);

      const unionParse = clientFrameSchema.safeParse(frame);
      expect(unionParse.success).toBe(true);
      if (unionParse.success && unionParse.data.kind === "request") {
        expect(unionParse.data.requestId).toBe("req-1");
        expect(unionParse.data.method).toBe("host.status");
        expect(unionParse.data.schemaVersion).toEqual({ major: 1, minor: 0 });
      }
    });

    it("accepts a client `fatalError` frame with full details", () => {
      const frame = {
        kind: "fatalError" as const,
        details: {
          code: "INCOMPATIBLE" as const,
          reason: "Incompatible methods: echo",
          incompatibleMethods: [
            {
              method: "echo",
              clientCanonical: { major: 2, minor: 0 },
              hostCanonical: { major: 1, minor: 1 },
              blocking: "no-bridge" as const,
            },
          ],
          upgradeGuidance: {
            clientShouldUpgrade: false,
            hostShouldUpgrade: true,
          },
        },
      };

      expect(clientFatalErrorFrameSchema.safeParse(frame).success).toBe(true);
      expect(clientFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("rejects an `open` frame missing the manifest", () => {
      const frame = { kind: "open", token: "t-0" };
      expect(clientFrameSchema.safeParse(frame).success).toBe(false);
    });

    it("rejects a `request` frame with an empty requestId", () => {
      const frame = {
        kind: "request",
        requestId: "",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      };
      expect(clientFrameSchema.safeParse(frame).success).toBe(false);
    });

    it("accepts a `fatalError` frame with a domain code", () => {
      const frame = {
        kind: "fatalError",
        details: {
          code: "CHAT_INVALID",
          reason: "Chat could not be read from persisted state",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      };
      expect(clientFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("rejects a `fatalError` frame with an empty code", () => {
      const frame = {
        kind: "fatalError",
        details: {
          code: "",
          reason: "bogus",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      };
      expect(clientFrameSchema.safeParse(frame).success).toBe(false);
    });

    it("rejects a frame with an unknown kind", () => {
      const frame = { kind: "bogus" };
      expect(clientFrameSchema.safeParse(frame).success).toBe(false);
    });
  });

  describe("host frames", () => {
    it("accepts an `openAck` frame with the host manifest", () => {
      const frame = {
        kind: "openAck" as const,
        manifest: { "host.status": { major: 1, minor: 0 } },
      };

      expect(hostOpenAckFrameSchema.safeParse(frame).success).toBe(true);

      const unionParse = hostFrameSchema.safeParse(frame);
      expect(unionParse.success).toBe(true);
      if (unionParse.success) {
        expect(unionParse.data.kind).toBe("openAck");
      }
    });

    it("pins current `openAck` frame wire bytes", () => {
      const frame = {
        kind: "openAck" as const,
        manifest: {
          "host.status": { major: 1, minor: 0 },
          "worktree.listAllForHost": { major: 1, minor: 1 },
        },
      };

      const parsed = hostOpenAckFrameSchema.parse(frame);

      expect(JSON.stringify(parsed)).toBe(
        '{"kind":"openAck","manifest":{"host.status":{"major":1,"minor":0},"worktree.listAllForHost":{"major":1,"minor":1}}}',
      );
    });

    it("accepts an `openAck` frame with an optional manifest channel", () => {
      const frame = {
        kind: "openAck" as const,
        manifest: {
          "host.status": { major: 1, minor: 0 },
        },
        optionalManifest: {
          "future.method": { major: 1, minor: 0 },
        },
      };

      expect(hostOpenAckFrameSchema.parse(frame)).toEqual(frame);
      expect(hostFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("models a shipped client `openAck` parser stripping future additive keys", () => {
      const legacyHostOpenAckFrameSchema = z.object({
        kind: z.literal("openAck"),
        manifest: z.record(
          z.string(),
          z.object({
            major: z.number().int().nonnegative(),
            minor: z.number().int().nonnegative(),
          }),
        ),
      });

      const parsed = legacyHostOpenAckFrameSchema.parse({
        kind: "openAck",
        manifest: { "host.status": { major: 1, minor: 0 } },
        optionalManifest: { "future.method": { major: 1, minor: 0 } },
      });

      expect(parsed).toEqual({
        kind: "openAck",
        manifest: { "host.status": { major: 1, minor: 0 } },
      });
    });

    it("accepts a `response` frame carrying a successful result", () => {
      const frame = {
        kind: "response" as const,
        requestId: "req-1",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        result: { ready: true },
        error: null,
      };

      expect(hostResponseFrameSchema.safeParse(frame).success).toBe(true);

      const unionParse = hostFrameSchema.safeParse(frame);
      expect(unionParse.success).toBe(true);
      if (unionParse.success && unionParse.data.kind === "response") {
        expect(unionParse.data.requestId).toBe("req-1");
        expect(unionParse.data.error).toBeNull();
      }
    });

    it("accepts a `response` frame carrying an error envelope", () => {
      const frame = {
        kind: "response" as const,
        requestId: "req-1",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        result: null,
        error: { code: "RPC_ERROR", message: "resolver failed" },
      };

      expect(hostResponseFrameSchema.safeParse(frame).success).toBe(true);
      expect(hostFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("accepts a host `fatalError` frame with UNAUTHORIZED code", () => {
      const frame = {
        kind: "fatalError" as const,
        details: {
          code: "UNAUTHORIZED" as const,
          reason: "Invalid token",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      };

      expect(hostFatalErrorFrameSchema.safeParse(frame).success).toBe(true);
      expect(hostFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("rejects an `openAck` with a malformed manifest entry", () => {
      const frame = {
        kind: "openAck",
        manifest: { "host.status": { major: -1, minor: 0 } },
      };
      expect(hostFrameSchema.safeParse(frame).success).toBe(false);
    });

    it("rejects a `response` frame missing the method", () => {
      const frame = {
        kind: "response",
        requestId: "req-1",
        schemaVersion: { major: 1, minor: 0 },
        result: null,
        error: null,
      };
      expect(hostFrameSchema.safeParse(frame).success).toBe(false);
    });
  });

  describe("fatalErrorDetailsSchema", () => {
    it("accepts an INCOMPATIBLE detail with null incompatibleMethods", () => {
      const details = {
        code: "INCOMPATIBLE" as const,
        reason: "mirror compat failure",
        incompatibleMethods: null,
        upgradeGuidance: null,
      };
      expect(fatalErrorDetailsSchema.safeParse(details).success).toBe(true);
    });

    it("rejects an unknown blocking reason on an incompatible method", () => {
      const details = {
        code: "INCOMPATIBLE",
        reason: "bad",
        incompatibleMethods: [
          {
            method: "echo",
            clientCanonical: null,
            hostCanonical: null,
            blocking: "not-a-real-blocking",
          },
        ],
        upgradeGuidance: null,
      };
      expect(fatalErrorDetailsSchema.safeParse(details).success).toBe(false);
    });

    it("accepts a `retryable` transient-rejection flag", () => {
      const details = {
        code: "UNAUTHORIZED" as const,
        reason: "Signing key unavailable: request timed out",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      };
      const parsed = fatalErrorDetailsSchema.safeParse(details);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.retryable).toBe(true);
      }
    });

    it("reads `retryable` as undefined when an older host omits it", () => {
      const details = {
        code: "UNAUTHORIZED" as const,
        reason: "Invalid token",
        incompatibleMethods: null,
        upgradeGuidance: null,
      };
      const parsed = fatalErrorDetailsSchema.safeParse(details);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.retryable).toBeUndefined();
      }
    });

    it("rejects a non-boolean `retryable`", () => {
      const details = {
        code: "UNAUTHORIZED",
        reason: "bad",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: "yes",
      };
      expect(fatalErrorDetailsSchema.safeParse(details).success).toBe(false);
    });
  });
});
