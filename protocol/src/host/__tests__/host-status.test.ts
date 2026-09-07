import { describe, expect, it } from "vitest";
import { hostListItemSchema, hostListResponseSchema } from "../host-status";
import { HOST_LIST_ITEM_GOLDEN_FIXTURE } from "../__fixtures__/host-status-golden-fixture";

/**
 * Strict-parse invariant (S5 / fix #5, mechanism 2): the client consumer (`remote-fetcher.ts`) must fail loud on a server-added field instead of silently stripping it.
 */
describe("host-status.ts strict parsing", () => {
  it("parses the golden fixture unchanged at every level", () => {
    const parsed = hostListItemSchema.parse(HOST_LIST_ITEM_GOLDEN_FIXTURE);
    expect(parsed).toEqual(HOST_LIST_ITEM_GOLDEN_FIXTURE);
  });

  it("rejects a server-added field on the top-level HostListItem", () => {
    const withExtraField = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      newTopLevelField: "unexpected",
    };
    expect(hostListItemSchema.safeParse(withExtraField).success).toBe(false);
  });

  it("rejects a server-added field on the nested HostStatusDTO (the cited host-status.ts:~163 gap)", () => {
    const withExtraStatusField = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      status: {
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE.status,
        newStatusField: "unexpected",
      },
    };
    expect(hostListItemSchema.safeParse(withExtraStatusField).success).toBe(
      false,
    );
  });

  it("rejects a server-added field on the HostListResponse envelope", () => {
    const response = {
      hosts: [HOST_LIST_ITEM_GOLDEN_FIXTURE],
    };
    expect(hostListResponseSchema.safeParse(response).success).toBe(true);
    expect(
      hostListResponseSchema.safeParse({
        ...response,
        newEnvelopeField: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid connectivity value", () => {
    const withInvalidConnectivity = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      status: {
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE.status,
        connectivity: "reconnecting",
      },
    };
    expect(hostListItemSchema.safeParse(withInvalidConnectivity).success).toBe(
      false,
    );
  });

  it("parses every current liveness word and the transitional local-only value", () => {
    for (const connectivity of [
      "connectable",
      "offline",
      "unknown",
      "local-only",
    ]) {
      expect(
        hostListItemSchema.safeParse({
          ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
          status: { ...HOST_LIST_ITEM_GOLDEN_FIXTURE.status, connectivity },
        }).success,
      ).toBe(true);
    }
  });

  it("rejects a payload still carrying the removed presenceLease / busySessionCount fields — the hard cutover has no dual-parse", () => {
    const legacyShapedStatus = {
      presenceLease: "fresh",
      hostRelayAttached: true,
      viewerReachability:
        HOST_LIST_ITEM_GOLDEN_FIXTURE.status.viewerReachability,
      clientCloud: HOST_LIST_ITEM_GOLDEN_FIXTURE.status.clientCloud,
      busy: false,
      busySessionCount: 0,
      updateState: HOST_LIST_ITEM_GOLDEN_FIXTURE.status.updateState,
      appVersion: HOST_LIST_ITEM_GOLDEN_FIXTURE.status.appVersion,
      lastSeenAt: HOST_LIST_ITEM_GOLDEN_FIXTURE.status.lastSeenAt,
    };
    const legacyItem = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      status: legacyShapedStatus,
    };
    expect(hostListItemSchema.safeParse(legacyItem).success).toBe(false);
  });
});
