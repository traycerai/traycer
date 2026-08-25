import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/schemas";
import {
  decodeResponsePayloadWithContext,
  prepareRequestPayload,
} from "../host-transport/ws-rpc-client";

/**
 * Two-sided negotiation for `host.update.check`, through the REAL transport
 * helpers rather than the schemas alone.
 *
 * This is the case the v1.1 wire shape was chosen for. Within one major there
 * is no request-downgrade bridge, so a v1.1 client talking to an already
 * shipped v1.0 host projects its params by PARSING them with the v1.0 request
 * schema. Any tri-state encoding whose third state is a VALUE the v1.0 schema
 * refuses (an explicit `null`, say) turns every default catalog load against
 * an old host into `DOWNGRADE_UNSUPPORTED`. Encoding it as an absent key makes
 * that same load arrive as v1.0's stable-only default, which is what the
 * rollout promises.
 */
const REGISTRY = hostRpcRegistry["host.update.check"];
const CLIENT_V11 = { major: 1, minor: 1 } as const;
const HOST_V10 = { major: 1, minor: 0 } as const;
const HOST_V11 = { major: 1, minor: 1 } as const;

const MANIFEST: HostAvailableManifest = {
  schemaVersion: 1,
  generatedAt: "2026-06-22T01:00:00.000Z",
  latest: "1.2.0",
  versions: [],
};

function prepare(params: { includePreReleases?: boolean }): {
  readonly onWireVersion: { readonly major: number; readonly minor: number };
  readonly onWirePayload: unknown;
} {
  return prepareRequestPayload(
    REGISTRY,
    CLIENT_V11,
    HOST_V10,
    params,
    "req-1",
    "host.update.check",
  );
}

describe("a v1.1 client negotiating v1.0", () => {
  it("sends a derive request as the old stable-only default, not an error", () => {
    const prepared = prepare({});
    expect(prepared.onWireVersion).toEqual(HOST_V10);
    expect(prepared.onWirePayload).toEqual({ includePreReleases: false });
  });

  it("sends an explicit include as the old include", () => {
    expect(prepare({ includePreReleases: true }).onWirePayload).toEqual({
      includePreReleases: true,
    });
  });

  it("sends an explicit exclude as the old stable-only ask", () => {
    // The v1.1-only distinction between "excluded" and "not stated" simply is
    // not expressible to that peer; both mean stable-only there.
    expect(prepare({ includePreReleases: false }).onWirePayload).toEqual({
      includePreReleases: false,
    });
  });

  it("upgrades the old host's answer with provenance derived from the wire request", () => {
    const prepared = prepare({});
    const decoded = decodeResponsePayloadWithContext(
      REGISTRY,
      CLIENT_V11,
      HOST_V10,
      { outcome: "ok", manifest: MANIFEST },
      "req-1",
      "host.update.check",
      prepared.onWirePayload,
      "host-1",
    );

    // Stable-default, never installed-rc: the old host derived nothing, and a
    // fabricated provenance would drive Settings copy that is simply untrue.
    expect(decoded).toEqual({
      outcome: "ok",
      manifest: MANIFEST,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default",
    });
  });

  it("reports an explicit include against an old host as explicit-include", () => {
    const prepared = prepare({ includePreReleases: true });
    expect(
      decodeResponsePayloadWithContext(
        REGISTRY,
        CLIENT_V11,
        HOST_V10,
        { outcome: "ok", manifest: MANIFEST },
        "req-1",
        "host.update.check",
        prepared.onWirePayload,
        "host-1",
      ),
    ).toEqual({
      outcome: "ok",
      manifest: MANIFEST,
      effectiveIncludePreReleases: true,
      includePreReleasesSource: "explicit-include",
    });
  });
});

describe("a v1.1 client negotiating v1.1", () => {
  it("passes the tri-state through untouched in both directions", () => {
    const prepared = prepareRequestPayload(
      REGISTRY,
      CLIENT_V11,
      HOST_V11,
      {},
      "req-1",
      "host.update.check",
    );
    expect(prepared.onWireVersion).toEqual(HOST_V11);
    // Absent stays absent - the host, not the client, resolves it.
    expect(prepared.onWirePayload).toEqual({});

    const answer = {
      outcome: "ok",
      manifest: MANIFEST,
      effectiveIncludePreReleases: true,
      includePreReleasesSource: "installed-rc",
    };
    expect(
      decodeResponsePayloadWithContext(
        REGISTRY,
        CLIENT_V11,
        HOST_V11,
        answer,
        "req-1",
        "host.update.check",
        prepared.onWirePayload,
        "host-1",
      ),
    ).toEqual(answer);
  });
});
