import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hostStreamOpenAckFrameSchema,
  clientStreamCredentialUpdateFrameSchema,
  STREAM_CAPABILITY_CREDENTIAL_UPDATE,
} from "@traycer/protocol/framework/stream-ws-protocol";

/**
 * Cross-version compatibility contract for the `/stream` control frames.
 *
 * Clients and the host ship independently, so the `openAck` capabilities
 * mechanism and the `credentialUpdate` frame MUST degrade gracefully across a
 * version skew. The frames are framework-level (not per-method version
 * negotiated), so that safety rests entirely on Zod tolerance + the client's
 * capability gate. These tests pin that behaviour so a future edit can't
 * silently make a schema `.strict()` (which would make an older client reject a
 * newer host's `openAck` and drop the connection).
 */
describe("stream-ws-protocol cross-version compatibility", () => {
  const manifest = { "epic.subscribe": { major: 1, minor: 0 } };

  describe("hostStreamOpenAckFrame (host -> client)", () => {
    it("strips unknown keys instead of rejecting (older client tolerates a newer host's additive fields)", () => {
      // A future host adds a field this version's client has never heard of.
      // The schema MUST strip it, not reject — otherwise the connection drops.
      const parsed = hostStreamOpenAckFrameSchema.safeParse({
        kind: "openAck",
        manifest,
        capabilities: [STREAM_CAPABILITY_CREDENTIAL_UPDATE],
        someFutureField: { nested: true },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect("someFutureField" in parsed.data).toBe(false);
      }
    });

    it("defaults `capabilities` to [] when absent (newer client tolerates an older host's ack)", () => {
      const parsed = hostStreamOpenAckFrameSchema.safeParse({
        kind: "openAck",
        manifest,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.capabilities).toEqual([]);
      }
    });

    it("preserves an advertised capabilities array", () => {
      const parsed = hostStreamOpenAckFrameSchema.safeParse({
        kind: "openAck",
        manifest,
        capabilities: [STREAM_CAPABILITY_CREDENTIAL_UPDATE],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.capabilities).toContain(
          STREAM_CAPABILITY_CREDENTIAL_UPDATE,
        );
      }
    });

    it("models an older client's openAck schema (kind + manifest only) accepting a newer host's ack", () => {
      // Reconstruct the pre-capabilities schema a previously-shipped client
      // carries, and prove a newer host's ack (with `capabilities`) still parses.
      const legacyOpenAck = z.object({
        kind: z.literal("openAck"),
        manifest: z.record(
          z.string(),
          z.object({ major: z.number(), minor: z.number() }),
        ),
      });
      const parsed = legacyOpenAck.safeParse({
        kind: "openAck",
        manifest,
        capabilities: [STREAM_CAPABILITY_CREDENTIAL_UPDATE],
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("clientStreamCredentialUpdateFrame (client -> host)", () => {
    it("accepts a valid frame", () => {
      const parsed = clientStreamCredentialUpdateFrameSchema.safeParse({
        kind: "credentialUpdate",
        token: "rotated-bearer",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects a missing or empty token", () => {
      expect(
        clientStreamCredentialUpdateFrameSchema.safeParse({
          kind: "credentialUpdate",
        }).success,
      ).toBe(false);
      expect(
        clientStreamCredentialUpdateFrameSchema.safeParse({
          kind: "credentialUpdate",
          token: "",
        }).success,
      ).toBe(false);
    });
  });

  it("pins the wire value of the credentialUpdate capability tag", () => {
    // This string is on the wire; changing it silently breaks negotiation.
    expect(STREAM_CAPABILITY_CREDENTIAL_UPDATE).toBe("credentialUpdate");
  });
});
