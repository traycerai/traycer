import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clientStreamOpenFrameSchema,
  hostStreamOpenAckFrameSchema,
  clientStreamCredentialUpdateFrameSchema,
  clientStreamHostCredentialProvisionFrameSchema,
  STREAM_CAPABILITY_CREDENTIAL_UPDATE,
  STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
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

  describe("clientStreamOpenFrame (client -> host)", () => {
    it("strips unknown additive fields instead of rejecting", () => {
      const parsed = clientStreamOpenFrameSchema.safeParse({
        kind: "open",
        token: "bearer",
        manifest,
        someFutureField: { nested: true },
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect("someFutureField" in parsed.data).toBe(false);
      }
    });
  });

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
      if (parsed.success) {
        expect("capabilities" in parsed.data).toBe(false);
      }
    });

    it("defaults hostCredentialState to null when an older host omits it", () => {
      // Pre-delegated-credential hosts send neither the capability nor the
      // state field. null means "did not report" — never trigger a mint.
      const parsed = hostStreamOpenAckFrameSchema.safeParse({
        kind: "openAck",
        manifest,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.hostCredentialState).toBe(null);
        expect(parsed.data.capabilities).toEqual([]);
      }
    });

    it("preserves an explicit hostCredentialState when present", () => {
      const parsed = hostStreamOpenAckFrameSchema.safeParse({
        kind: "openAck",
        manifest,
        capabilities: [STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION],
        hostCredentialState: "missing",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.hostCredentialState).toBe("missing");
      }
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

  it("pins the wire value of the hostCredentialProvision capability tag", () => {
    expect(STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION).toBe(
      "hostCredentialProvision",
    );
  });

  describe("clientStreamHostCredentialProvisionFrame (client -> host)", () => {
    const validFrame = {
      kind: "hostCredentialProvision" as const,
      token: "host-access-jws",
      refreshToken: "host-refresh-jwe",
      familyId: "family-host-1",
      provisionedAt: "2026-07-08T12:00:00.123Z",
    };

    it("accepts a valid provision frame including the adoption tuple", () => {
      const parsed =
        clientStreamHostCredentialProvisionFrameSchema.safeParse(validFrame);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.familyId).toBe("family-host-1");
        expect(parsed.data.provisionedAt).toBe("2026-07-08T12:00:00.123Z");
      }
    });

    it("rejects empty token, refreshToken, or familyId", () => {
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          token: "",
        }).success,
      ).toBe(false);
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          refreshToken: "",
        }).success,
      ).toBe(false);
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          familyId: "",
        }).success,
      ).toBe(false);
    });

    it("rejects an unparseable provisionedAt (phase-3 adoption must not see NaN)", () => {
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          provisionedAt: "not-a-timestamp",
        }).success,
      ).toBe(false);
    });

    // `Date.parse` accepts all four of the following, so a permissive
    // `refine(!Number.isNaN(Date.parse(value)))` schema would let them
    // through. `isoMillisecondTimestampSchema` requires an offset and
    // millisecond precision instead, so this is what actually pins the
    // tightening rather than re-testing what the old schema already rejected.
    it("rejects date-only, human-readable, and non-millisecond-precision provisionedAt", () => {
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          provisionedAt: "2026-07-08",
        }).success,
      ).toBe(false);
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          provisionedAt: "Tue, 08 Jul 2026 12:00:00 GMT",
        }).success,
      ).toBe(false);
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          provisionedAt: "2026-07-08T12:00:00.123456Z",
        }).success,
      ).toBe(false);
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse({
          ...validFrame,
          provisionedAt: "2026-07-08T12:00:00Z",
        }).success,
      ).toBe(false);
    });

    it("accepts the canonical toISOString() millisecond-precision form", () => {
      const parsed = clientStreamHostCredentialProvisionFrameSchema.safeParse({
        ...validFrame,
        provisionedAt: new Date("2026-07-08T12:00:00.123Z").toISOString(),
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects a frame missing familyId or provisionedAt", () => {
      const { familyId: _f, ...withoutFamily } = validFrame;
      void _f;
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse(withoutFamily)
          .success,
      ).toBe(false);
      const { provisionedAt: _p, ...withoutAt } = validFrame;
      void _p;
      expect(
        clientStreamHostCredentialProvisionFrameSchema.safeParse(withoutAt)
          .success,
      ).toBe(false);
    });
  });
});
