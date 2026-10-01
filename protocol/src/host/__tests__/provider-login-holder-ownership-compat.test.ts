import { describe, expect, it } from "vitest";
import {
  providersCancelLoginRequestSchemaV11,
  providersCancelLoginRequestSchemaV12,
  providersStartLoginRequestSchemaV11,
  providersStartLoginRequestSchemaV14,
} from "@traycer/protocol/host/provider-schemas";
import {
  providersCancelLoginUpgradeV11ToV12,
  providersStartLoginUpgradeV13ToV14,
} from "@traycer/protocol/host/registry";

/**
 * Compatibility coverage for the two new minors
 * (epics/368a3163-5475-4713-ad06-634f47cc913a/artifacts/v1-4-1-cherry-pick-list/login-cancel-ownership):
 *
 *   - `providers.startLogin@1.4` adds `holderId: string | null`
 *   - `providers.cancelLogin@1.2` adds `holderId: string | null`
 *
 * `null` is what an upgraded-from-older-peer request fills in, and the host
 * "treats it exactly as it does today" (spec) - i.e. an anonymous/ambient
 * claim, the released scope-keyed behavior. These tests decode through the
 * FROZEN older schema first (what an old peer's payload actually looks like
 * on the wire, never built by omitting a key from a live request), then
 * apply the real upgrade path - the same discipline
 * `provider-login-remote-safe-marker.test.ts` uses for `remoteSafe`, since a
 * suite that only builds a "request minus one key" object by hand can pass
 * while a bridge silently drops the wrong thing.
 */

describe("providers.startLogin@1.4 — holderId compatibility", () => {
  it("the live v1.4 schema accepts an explicit holder id", () => {
    const parsed = providersStartLoginRequestSchemaV14.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: "holder-abc",
    });
    expect(parsed.holderId).toBe("holder-abc");
  });

  it("the live v1.4 schema defaults an absent holderId to null", () => {
    const parsed = providersStartLoginRequestSchemaV14.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
    });
    expect(parsed.holderId).toBeNull();
  });

  it("upgrading a v1.3-shaped request from an older peer fills holderId with null", () => {
    // What a v1.3 (pre-ownership) client actually sends on the wire - no
    // `holderId` key at all, decoded through the FROZEN v1.1-request shape
    // v1.3 still carries (the request schema did not change between v1.1
    // and v1.3, only the response did).
    const oldRequest = providersStartLoginRequestSchemaV11.parse({
      providerId: "codex",
      profileId: "profile-1",
      createProfile: null,
    });

    const upgraded = providersStartLoginUpgradeV13ToV14.upgradeRequest(
      oldRequest as never,
    );

    expect(upgraded).toEqual({
      providerId: "codex",
      profileId: "profile-1",
      createProfile: null,
      holderId: null,
    });
    // The upgraded shape must itself satisfy the live v1.4 request schema -
    // not merely resemble it.
    expect(() =>
      providersStartLoginRequestSchemaV14.parse(upgraded),
    ).not.toThrow();
  });

  it("upgradeResponse is the identity - v1.4 changed only the request", () => {
    const response = {
      url: null,
      started: false,
      profileId: null,
      userCode: null,
      failure: null,
      pending: "starting" as const,
      pack: null,
    };
    expect(providersStartLoginUpgradeV13ToV14.upgradeResponse(response)).toBe(
      response,
    );
  });
});

describe("providers.cancelLogin@1.2 — holderId compatibility", () => {
  it("the live v1.2 schema accepts an explicit holder id", () => {
    const parsed = providersCancelLoginRequestSchemaV12.parse({
      providerId: "codex",
      profileId: null,
      holderId: "holder-abc",
    });
    expect(parsed.holderId).toBe("holder-abc");
  });

  it("the live v1.2 schema defaults an absent holderId to null", () => {
    const parsed = providersCancelLoginRequestSchemaV12.parse({
      providerId: "codex",
      profileId: null,
    });
    expect(parsed.holderId).toBeNull();
  });

  it("upgrading a v1.1-shaped request from an older peer fills holderId with null, ending the scope's child exactly as released", () => {
    // What a v1.1 client actually sends - no `holderId` key - decoded
    // through the frozen v1.1 request shape.
    const oldRequest = providersCancelLoginRequestSchemaV11.parse({
      providerId: "codex",
      profileId: "profile-1",
    });

    const upgraded = providersCancelLoginUpgradeV11ToV12.upgradeRequest(
      oldRequest as never,
    );

    expect(upgraded).toEqual({
      providerId: "codex",
      profileId: "profile-1",
      holderId: null,
    });
    expect(() =>
      providersCancelLoginRequestSchemaV12.parse(upgraded),
    ).not.toThrow();
  });

  it("upgradeResponse is the identity - v1.2 changed only the request", () => {
    const response = { cancelled: true };
    expect(providersCancelLoginUpgradeV11ToV12.upgradeResponse(response)).toBe(
      response,
    );
  });
});
