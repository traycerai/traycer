import { describe, expect, it } from "vitest";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  upgradeResponseToVersionWithContext,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostUpdateCheckV10,
  hostUpdateCheckV11,
} from "@traycer/protocol/host/maintenance/contracts";
import {
  hostUpdateCheckRequestSchema,
  hostUpdateCheckRequestSchemaV11,
  hostUpdateCheckResponseSchemaV11,
  type HostAvailableManifest,
} from "@traycer/protocol/host/maintenance/schemas";

const MANIFEST: HostAvailableManifest = {
  schemaVersion: 1,
  generatedAt: "2026-06-22T01:00:00.000Z",
  latest: "1.2.0",
  versions: [],
};

const V10 = hostUpdateCheckV10.schemaVersion;
const V11 = hostUpdateCheckV11.schemaVersion;
const REGISTRY = hostRpcRegistry["host.update.check"];

describe("host.update.check v1.1 request", () => {
  it("carries all three catalog states", () => {
    expect(
      hostUpdateCheckRequestSchemaV11.parse({ includePreReleases: true }),
    ).toEqual({ includePreReleases: true });
    expect(
      hostUpdateCheckRequestSchemaV11.parse({ includePreReleases: false }),
    ).toEqual({ includePreReleases: false });
    // Absent is the third state - derive from the installed host - and it
    // stays absent rather than being defaulted into one of the other two.
    expect(hostUpdateCheckRequestSchemaV11.parse({})).toStrictEqual({});
  });

  it("rejects null, the shape that cannot cross to a v1.0 peer", () => {
    // The third state is an omitted key precisely because `null` fails the
    // v1.0 projection below; accepting it here would let a client build a
    // request that dies at `prepareRequestPayload` against a shipped host.
    expect(
      hostUpdateCheckRequestSchemaV11.safeParse({ includePreReleases: null })
        .success,
    ).toBe(false);
  });
});

/**
 * What `prepareRequestPayload` does when a v1.1 client negotiates v1.0: it
 * PARSES the v1.1 params with the v1.0 request schema and sends the result.
 * These three cases are the whole documented old-host contract.
 */
describe("v1.1 request projected onto a negotiated v1.0 peer", () => {
  it("sends the stable-only default for a derive request", () => {
    const derive = hostUpdateCheckRequestSchemaV11.parse({});
    const projected = hostUpdateCheckRequestSchema.safeParse(derive);
    expect(projected.success).toBe(true);
    expect(projected.success && projected.data).toEqual({
      includePreReleases: false,
    });
  });

  it("preserves an explicit include", () => {
    expect(
      hostUpdateCheckRequestSchema.parse({ includePreReleases: true }),
    ).toEqual({ includePreReleases: true });
  });

  it("collapses explicit exclude onto the same stable-only ask", () => {
    // The v1.1-only distinction between "excluded" and "not stated" is not
    // sent to an old peer; both mean stable-only there, which is what that
    // peer has always done.
    expect(
      hostUpdateCheckRequestSchema.parse({ includePreReleases: false }),
    ).toEqual({ includePreReleases: false });
  });
});

describe("host.update.check v1.1 response", () => {
  it("requires resolved inclusion and provenance on the ok arm", () => {
    expect(
      hostUpdateCheckResponseSchemaV11.safeParse({
        outcome: "ok",
        manifest: MANIFEST,
      }).success,
    ).toBe(false);
    const resolved = {
      outcome: "ok",
      manifest: MANIFEST,
      effectiveIncludePreReleases: true,
      includePreReleasesSource: "installed-rc",
    };
    expect(hostUpdateCheckResponseSchemaV11.parse(resolved)).toEqual(resolved);
  });

  it("rejects a provenance outside the declared set", () => {
    expect(
      hostUpdateCheckResponseSchemaV11.safeParse({
        outcome: "ok",
        manifest: MANIFEST,
        effectiveIncludePreReleases: true,
        includePreReleasesSource: "implicit-rc-line",
      }).success,
    ).toBe(false);
  });

  it("leaves the failure arms untouched - nothing was resolved to report", () => {
    for (const outcome of ["cli-unavailable", "cli-failed", "invalid-output"]) {
      expect(hostUpdateCheckResponseSchemaV11.parse({ outcome })).toEqual({
        outcome,
      });
    }
  });
});

describe("v1.0 -> v1.1 upgrade", () => {
  it("maps a v1.0 true to an explicit include", () => {
    expect(
      upgradeRequestToVersion(REGISTRY, V10, V11, {
        includePreReleases: true,
      }),
    ).toEqual({ includePreReleases: true });
  });

  it("maps a v1.0 false to derive, not to explicit exclude", () => {
    // An old client's `false` was the stable-only DEFAULT, not a deliberate
    // filter - it had no way to express one. Reading it as explicit exclude
    // would pin every old client to stable-only even on an RC host.
    //
    // `toStrictEqual`, NOT `toEqual`: `toEqual` ignores undefined-valued keys,
    // so it passes for `{ includePreReleases: undefined }` too and cannot see
    // the distinction this whole assertion is about.
    expect(
      upgradeRequestToVersion(REGISTRY, V10, V11, {
        includePreReleases: false,
      }),
    ).toStrictEqual({});
  });

  it("reports an old host's true response as an explicit include", () => {
    expect(
      upgradeResponseToVersionWithContext(
        REGISTRY,
        V10,
        V11,
        { outcome: "ok", manifest: MANIFEST },
        { request: { includePreReleases: true }, hostId: "host-1" },
      ),
    ).toEqual({
      outcome: "ok",
      manifest: MANIFEST,
      effectiveIncludePreReleases: true,
      includePreReleasesSource: "explicit-include",
    });
  });

  it("never claims installed-rc provenance from an old host", () => {
    // The old peer derived nothing. `stable-default` is what its contract
    // actually meant; `installed-rc` would fabricate the Settings copy that
    // keys off it.
    expect(
      upgradeResponseToVersionWithContext(
        REGISTRY,
        V10,
        V11,
        { outcome: "ok", manifest: MANIFEST },
        { request: { includePreReleases: false }, hostId: "host-1" },
      ),
    ).toEqual({
      outcome: "ok",
      manifest: MANIFEST,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default",
    });
  });

  it("passes a failure outcome through without inventing provenance", () => {
    expect(
      upgradeResponseToVersionWithContext(
        REGISTRY,
        V10,
        V11,
        { outcome: "cli-unavailable" },
        { request: { includePreReleases: true }, hostId: "host-1" },
      ),
    ).toEqual({ outcome: "cli-unavailable" });
  });

  it("refuses to upgrade an ok response with no request context", () => {
    // Provenance is a fact about the REQUEST. Without it the only options are
    // to guess or to fail, and a guessed provenance is worse than an error.
    expect(() =>
      upgradeResponseToVersion(REGISTRY, V10, V11, {
        outcome: "ok",
        manifest: MANIFEST,
      }),
    ).toThrow(/request context/);
  });
});

/**
 * The representation a resolver actually receives for the derive state.
 *
 * A resolver has to distinguish three requests, and the third is spelled by an
 * absence - so HOW that absence is represented is part of the contract, not an
 * implementation detail. Two paths deliver it: a v1.1 client's request parsed
 * off the wire, and a v1.0 request bridged up. If they disagreed on key
 * presence, `"includePreReleases" in params` would classify one logical state
 * two different ways depending on the peer, and only against an old client -
 * the worst possible place to find out.
 */
describe("the derive state as a resolver sees it", () => {
  it("has no own key when parsed from a v1.1 client's request", () => {
    const parsed = hostUpdateCheckRequestSchemaV11.parse({});
    expect(Object.hasOwn(parsed, "includePreReleases")).toBe(false);
    expect(Object.keys(parsed)).toStrictEqual([]);
  });

  it("has no own key when bridged up from a v1.0 peer either", () => {
    const bridged = upgradeRequestToVersion(REGISTRY, V10, V11, {
      includePreReleases: false,
    });
    expect(Object.hasOwn(bridged, "includePreReleases")).toBe(false);
    expect(Object.keys(bridged)).toStrictEqual([]);
  });

  it("reads as undefined under the documented value test, from either path", () => {
    // `=== undefined` is the rule resolvers must use: it is correct whether or
    // not the own key is present, so it survives a future bridge that spells
    // the absence the other way.
    const fromWire = hostUpdateCheckRequestSchemaV11.parse({});
    const fromBridge = upgradeRequestToVersion(REGISTRY, V10, V11, {
      includePreReleases: false,
    });
    expect(fromWire.includePreReleases).toBe(undefined);
    expect(fromBridge.includePreReleases).toBe(undefined);
  });

  it("keeps the two explicit states distinguishable from it and from each other", () => {
    const include = hostUpdateCheckRequestSchemaV11.parse({
      includePreReleases: true,
    });
    const exclude = hostUpdateCheckRequestSchemaV11.parse({
      includePreReleases: false,
    });
    expect(include).toStrictEqual({ includePreReleases: true });
    expect(exclude).toStrictEqual({ includePreReleases: false });
    // The one that a boolean-only contract could not express: explicit
    // exclude must not read as the derive state.
    expect(exclude.includePreReleases).not.toBe(undefined);
  });
});

describe("host.update.check registry line", () => {
  it("makes v1.1 the current minor of major 1", () => {
    expect(REGISTRY[1].latestMinor).toBe(1);
    expect(REGISTRY[1].versions[1].contract).toBe(hostUpdateCheckV11);
    expect(REGISTRY[1].versions[1].upgradeFromPreviousVersion).not.toBe(null);
  });

  it("adds no cross-major downgrade bridge - v1.0 and v1.1 share major 1", () => {
    expect(REGISTRY[1].downgradePathsFromLatest).toEqual({});
  });

  it("stays an optional method with a declared missing-peer behaviour", () => {
    // A host predating this method has no `host.update.check` at all; the
    // handshake must degrade rather than treat the name-set as incompatible.
    expect(REGISTRY.degrade).toEqual({ kind: "unsupported" });
  });
});
