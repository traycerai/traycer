import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostListItemSchema, hostListResponseSchema } from "../host-status";
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
    // Missing the now-required `connectivity` AND carrying the removed
    // fields — `.strict()` rejects on both counts, which is the point: there
    // is no version marker and no dual-parse to fall back to.
    expect(hostListItemSchema.safeParse(legacyItem).success).toBe(false);
  });
});

/**
 * The RELEASED item schema, frozen as of OSS `main`
 * `76459f8d3ed5151a0d946c9dd2d5ec2260bc956d` — the last commit before
 * `commandInterpreter` was added here.
 *
 * A copy, deliberately, and pinned to a NAMED commit rather than a floating
 * head: the compatibility question is "does a binary already in users' hands
 * still parse today's response?", and a binary carries the schema it was built
 * with. Importing the live schema would make this test agree with itself and
 * pass through exactly the change it exists to catch. Re-cut it only when the
 * supported client floor genuinely moves, and name the new commit here.
 */
const RELEASED_HOST_STATUS_DTO_SCHEMA_AT_76459F8D = z
  .object({
    connectivity: z.enum(["connectable", "offline", "unknown", "local-only"]),
    viewerReachability: z.enum(["ok", "failing", "unknown"]),
    clientCloud: z.enum(["ok", "down"]),
    updateState: z.enum([
      "current",
      "available",
      "pending",
      "updating",
      "failed",
      "required",
    ]),
    appVersion: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
  })
  .strict();

const RELEASED_HOST_LIST_ITEM_SCHEMA_AT_76459F8D = z
  .object({
    hostId: z.string(),
    displayName: z.string().nullable(),
    platform: z.string().nullable(),
    kind: z.enum(["personal", "sandbox"]),
    publicKey: z.string(),
    createdAt: z.string(),
    status: RELEASED_HOST_STATUS_DTO_SCHEMA_AT_76459F8D,
    updatePolicy: z.enum(["manual", "auto"]),
  })
  .strict();

describe("commandInterpreter — why the cloud DTO needs a consumer opt-in", () => {
  it("keeps the UN-OPTED response parseable by the released schema", () => {
    // The whole compatibility claim in one assertion: a client built before
    // this field existed still parses a default `GET /api/v3/hosts`.
    expect(
      RELEASED_HOST_LIST_ITEM_SCHEMA_AT_76459F8D.safeParse(
        HOST_LIST_ITEM_GOLDEN_FIXTURE,
      ).success,
    ).toBe(true);
  });

  it("proves the opt-in is REQUIRED: the released schema rejects an item carrying the field", () => {
    // This is why the server may not add it unconditionally. `.strict()` makes
    // the extra key a hard parse failure, and `remote-fetcher.ts` classifies
    // that as a transport failure — the entire hosts panel blanks, on every
    // released desktop, for a field none of them asked for.
    const opted = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      commandInterpreter: "powershell",
    };
    expect(
      RELEASED_HOST_LIST_ITEM_SCHEMA_AT_76459F8D.safeParse(opted).success,
    ).toBe(false);
    // An explicit null is no gentler: it is the same unexpected KEY.
    expect(
      RELEASED_HOST_LIST_ITEM_SCHEMA_AT_76459F8D.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        commandInterpreter: null,
      }).success,
    ).toBe(false);
  });

  it("accepts absence, an explicit null, and every member on the CURRENT schema", () => {
    // Optional-and-nullable, both halves load-bearing: absence is the un-opted
    // response, null is "opted in, and this host never reported one".
    expect(
      hostListItemSchema.safeParse(HOST_LIST_ITEM_GOLDEN_FIXTURE).success,
    ).toBe(true);
    expect(
      hostListItemSchema.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        commandInterpreter: null,
      }).success,
    ).toBe(true);
    for (const interpreter of [
      "posix-shell",
      "git-bash",
      "powershell",
      "cmd",
    ]) {
      expect(
        hostListItemSchema.safeParse({
          ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
          commandInterpreter: interpreter,
        }).success,
      ).toBe(true);
    }
  });

  it("still rejects a token outside the four known interpreters", () => {
    expect(
      hostListItemSchema.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        commandInterpreter: "fish",
      }).success,
    ).toBe(false);
  });

  it("carries an opted-in item through the response envelope", () => {
    expect(
      hostListResponseSchema.safeParse({
        hosts: [
          { ...HOST_LIST_ITEM_GOLDEN_FIXTURE, commandInterpreter: "git-bash" },
        ],
      }).success,
    ).toBe(true);
  });
});
