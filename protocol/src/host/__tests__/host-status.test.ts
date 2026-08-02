import { describe, expect, it } from "vitest";
import {
  hostListItemSchema,
  hostListResponseSchema,
  hostPresenceHealthSchema,
} from "../host-status";
import { HOST_LIST_ITEM_GOLDEN_FIXTURE } from "../__fixtures__/host-status-golden-fixture";

/**
 * Strict-parse invariant (S5 / fix #5, mechanism 2): the client consumer
 * (`remote-fetcher.ts`) must fail loud on a server-added field instead of
 * silently stripping it. `.strict()` is not deep in Zod, so the negative
 * cases below probe every nesting level the fixture touches, not just the
 * top one.
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

  it("rejects a server-added field on HostPresenceHealth", () => {
    const withExtraHealthField = {
      status: "healthy",
      reason: null,
      newHealthField: "unexpected",
    };
    expect(
      hostPresenceHealthSchema.safeParse(withExtraHealthField).success,
    ).toBe(false);
  });

  it("rejects a server-added field on the HostListResponse envelope", () => {
    const response = {
      hosts: [HOST_LIST_ITEM_GOLDEN_FIXTURE],
      presenceHealth: { status: "healthy" as const, reason: null },
    };
    expect(hostListResponseSchema.safeParse(response).success).toBe(true);
    expect(
      hostListResponseSchema.safeParse({
        ...response,
        newEnvelopeField: "unexpected",
      }).success,
    ).toBe(false);
  });
});
