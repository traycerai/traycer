import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  ALL_HOST_NOTIFICATION_KINDS,
  RELEASED_HOST_NOTIFICATION_KINDS,
  formatHostNotificationPresentation,
  hiddenHostNotificationKinds,
  hostNotificationEntrySchema,
  hostNotificationEntrySchemaV21,
  hostNotificationsFeedSubscribeV10,
  hostNotificationsFeedSubscribeV11,
  hostNotificationsListDowngradeV21ToV10,
  hostNotificationsListResponseSchema,
  hostNotificationsListResponseSchemaV10,
  hostNotificationsListResponseSchemaV21,
  hostNotificationsListUpgradeV20ToV21,
  hostNotificationsListV20,
  hostNotificationsListV21,
  hostNotificationsSubscribeServerFrameSchema,
  hostNotificationsSubscribeServerFrameSchemaV10,
  hostNotificationsSubscribeServerFrameSchemaV11,
  hostOperationKnownCopy,
  isReleasedHostNotificationEntry,
  parseHostOperationCommonPayload,
  parseKnownHostNotificationPayload,
  streamCarriesChannelEmissionFrame,
  visibleHostNotificationKinds,
  type HostNotificationEntryV21,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * The one-time compatibility cutover for `host.operation.finished`.
 *
 * A leaked arm is not a hidden row: on the unary path the host re-parses its
 * downgraded result against the caller's own contract and answers 500 for the
 * whole page; on the feed path a failed frame parse reads as connection
 * corruption and the client reconnects into a snapshot carrying the same row.
 * These tests pin the boundary that makes that unreachable.
 */

const AGENT_STOPPED_ENTRY = {
  id: "agent.stopped:chat-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "chat-1",
  severity: "done" as const,
  epicId: "epic-1",
  chatId: "chat-1",
  kind: "agent.stopped" as const,
  outcome: "completed" as const,
  payload: { outcome: "completed" as const },
};

const OPERATION_FINISHED_ENTRY = {
  id: "worktree.deletion:2f1d0a2c-0000-4000-8000-000000000000",
  updatedAt: 1_700_000_000_001,
  readAt: null,
  sourceRef: "2f1d0a2c-0000-4000-8000-000000000000",
  severity: "done" as const,
  epicId: null,
  chatId: null,
  kind: "host.operation.finished" as const,
  outcome: "completed" as const,
  payload: {
    operation: "some.future.operation",
    title: "Deleted 3 worktrees",
    message: "All 3 worktrees were removed.",
  },
};

describe("host.operation.finished outer arm", () => {
  it("is rejected by every released entry parser and accepted by @2.1", () => {
    expect(
      hostNotificationEntrySchema.safeParse(OPERATION_FINISHED_ENTRY).success,
    ).toBe(false);
    expect(
      hostNotificationEntrySchemaV21.safeParse(OPERATION_FINISHED_ENTRY)
        .success,
    ).toBe(true);
  });

  it("keeps every released arm parsing identically on both unions", () => {
    expect(hostNotificationEntrySchema.parse(AGENT_STOPPED_ENTRY)).toEqual(
      hostNotificationEntrySchemaV21.parse(AGENT_STOPPED_ENTRY),
    );
  });

  it("carries no resolvedAt, operation name, or structured detail", () => {
    const parsed = hostNotificationEntrySchemaV21.parse({
      ...OPERATION_FINISHED_ENTRY,
      resolvedAt: 1_700_000_000_002,
      destination: { kind: "hostSurface" },
    });
    expect(parsed).not.toHaveProperty("resolvedAt");
    expect(parsed).not.toHaveProperty("destination");
    expect(parsed.kind).toBe("host.operation.finished");
  });

  it("accepts both terminal outcomes and rejects a null one", () => {
    for (const outcome of ["completed", "errored", "stopped"] as const) {
      expect(
        hostNotificationEntrySchemaV21.safeParse({
          ...OPERATION_FINISHED_ENTRY,
          outcome,
        }).success,
      ).toBe(true);
    }
    expect(
      hostNotificationEntrySchemaV21.safeParse({
        ...OPERATION_FINISHED_ENTRY,
        outcome: null,
      }).success,
    ).toBe(false);
  });

  it("narrows back to the released union", () => {
    expect(
      isReleasedHostNotificationEntry(
        hostNotificationEntrySchemaV21.parse(AGENT_STOPPED_ENTRY),
      ),
    ).toBe(true);
    expect(
      isReleasedHostNotificationEntry(
        hostNotificationEntrySchemaV21.parse(OPERATION_FINISHED_ENTRY),
      ),
    ).toBe(false);
  });
});

describe("released schemas stay frozen", () => {
  it("leaves list @1.0 / @2.0 responses unable to carry the new arm", () => {
    const page = { entries: [OPERATION_FINISHED_ENTRY], nextCursor: null };
    expect(hostNotificationsListResponseSchemaV10.safeParse(page).success).toBe(
      false,
    );
    expect(hostNotificationsListResponseSchema.safeParse(page).success).toBe(
      false,
    );
    expect(hostNotificationsListResponseSchemaV21.safeParse(page).success).toBe(
      true,
    );
  });

  it("leaves every released feed frame unable to carry the new arm", () => {
    const upserted = {
      kind: "upserted" as const,
      hasBinaryPayload: false as const,
      entry: OPERATION_FINISHED_ENTRY,
      removedIds: [],
      summary: { unreadCount: 1, attentionCount: 0 },
    };
    expect(
      hostNotificationsSubscribeServerFrameSchema.safeParse(upserted).success,
    ).toBe(false);
    expect(
      hostNotificationsSubscribeServerFrameSchemaV11.safeParse(upserted)
        .success,
    ).toBe(true);
    expect(
      hostNotificationsSubscribeServerFrameSchemaV10.safeParse({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: OPERATION_FINISHED_ENTRY,
      }).success,
    ).toBe(false);
  });

  it("keeps the released contracts byte-identical to their frozen sources", () => {
    const dump = (schema: z.ZodType): unknown =>
      z.toJSONSchema(schema, { unrepresentable: "any" });
    // The `@1.0` feed and the `@1.1` feed share one open request and one
    // client frame union; only the server frame widens.
    expect(dump(hostNotificationsFeedSubscribeV10.openRequestSchema)).toEqual(
      dump(hostNotificationsFeedSubscribeV11.openRequestSchema),
    );
    expect(dump(hostNotificationsFeedSubscribeV10.clientFrameSchema)).toEqual(
      dump(hostNotificationsFeedSubscribeV11.clientFrameSchema),
    );
    expect(
      dump(hostNotificationsFeedSubscribeV10.serverFrameSchema),
    ).not.toEqual(dump(hostNotificationsFeedSubscribeV11.serverFrameSchema));
    // Requests are untouched by the response widening.
    expect(dump(hostNotificationsListV20.requestSchema)).toEqual(
      dump(hostNotificationsListV21.requestSchema),
    );
  });
});

describe("registry wiring", () => {
  it("advertises @2.1 as the canonical list minor with @2.0 still installed", () => {
    const line = hostRpcRegistry["host.notifications.list"][2];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(hostNotificationsListV20);
    expect(line.versions[1].contract).toBe(hostNotificationsListV21);
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      hostNotificationsListUpgradeV20ToV21,
    );
    expect(line.downgradePathsFromLatest[1]).toBe(
      hostNotificationsListDowngradeV21ToV10,
    );
  });

  it("advertises feed @1.1 with @1.0 still installed for older peers", () => {
    const line = hostStreamRpcRegistry["host.notifications.feed.subscribe"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(hostNotificationsFeedSubscribeV10);
    expect(line.versions[1].contract).toBe(hostNotificationsFeedSubscribeV11);
  });

  it("keeps the legacy subscribe stream frozen at @1.0", () => {
    const line = hostStreamRpcRegistry["host.notifications.subscribe"][1];
    expect(line.latestMinor).toBe(0);
    expect(Object.keys(line.versions)).toEqual(["0"]);
  });
});

describe("negotiated-version visibility projection", () => {
  it("hides the new kind from every released version and shows it on the successors", () => {
    const cases: ReadonlyArray<{
      readonly surface: Parameters<typeof visibleHostNotificationKinds>[0];
      readonly version: { major: number; minor: number };
      readonly sees: boolean;
    }> = [
      { surface: { method: "host.notifications.list" }, version: { major: 1, minor: 0 }, sees: false },
      { surface: { method: "host.notifications.list" }, version: { major: 2, minor: 0 }, sees: false },
      { surface: { method: "host.notifications.list" }, version: { major: 2, minor: 1 }, sees: true },
      { surface: { method: "host.notifications.feed.subscribe" }, version: { major: 1, minor: 0 }, sees: false },
      { surface: { method: "host.notifications.feed.subscribe" }, version: { major: 1, minor: 1 }, sees: true },
      { surface: { method: "host.notifications.subscribe" }, version: { major: 1, minor: 0 }, sees: false },
    ];
    for (const { surface, version, sees } of cases) {
      const visible = visibleHostNotificationKinds(surface, version);
      const hidden = hiddenHostNotificationKinds(surface, version);
      expect(visible.includes("host.operation.finished")).toBe(sees);
      expect(hidden.includes("host.operation.finished")).toBe(!sees);
      // Released kinds are visible on every version, always.
      for (const kind of RELEASED_HOST_NOTIFICATION_KINDS) {
        expect(visible).toContain(kind);
        expect(hidden).not.toContain(kind);
      }
      expect([...visible, ...hidden].sort()).toEqual(
        [...ALL_HOST_NOTIFICATION_KINDS].sort(),
      );
    }
  });

  it("fails closed for an unknown future major on every surface", () => {
    // Majors are breaking by definition, so "newer than the majors I know"
    // must not read as "carries everything I know" - a `list@3.0` could close
    // its union around a different set of arms.
    for (const surface of [
      { method: "host.notifications.list" } as const,
      { method: "host.notifications.feed.subscribe" } as const,
      { method: "host.notifications.subscribe" } as const,
    ]) {
      for (const version of [
        { major: 3, minor: 0 },
        { major: 3, minor: 9 },
        { major: 99, minor: 99 },
        { major: 0, minor: 0 },
      ]) {
        expect(visibleHostNotificationKinds(surface, version)).toEqual(
          RELEASED_HOST_NOTIFICATION_KINDS,
        );
        expect(hiddenHostNotificationKinds(surface, version)).toEqual([
          "host.operation.finished",
        ]);
      }
    }
  });

  it("keeps a fully-capable caller's exclusion empty", () => {
    expect(
      hiddenHostNotificationKinds(
        { method: "host.notifications.feed.subscribe" },
        { major: 1, minor: 1 },
      ),
    ).toEqual([]);
  });

  it("covers every kind the entry unions can carry", () => {
    const armKinds = hostNotificationEntrySchemaV21.options.map(
      (option) => option.shape.kind.value,
    );
    expect([...ALL_HOST_NOTIFICATION_KINDS].sort()).toEqual(
      [...armKinds].sort(),
    );
    const releasedArmKinds = hostNotificationEntrySchema.options.map(
      (option) => option.shape.kind.value,
    );
    expect([...RELEASED_HOST_NOTIFICATION_KINDS].sort()).toEqual(
      [...releasedArmKinds].sort(),
    );
  });
});

describe("channel-emission capability", () => {
  it("is declared by every installed stream version and closed for the rest", () => {
    const feed = { method: "host.notifications.feed.subscribe" } as const;
    const legacy = { method: "host.notifications.subscribe" } as const;
    expect(streamCarriesChannelEmissionFrame(feed, { major: 1, minor: 0 })).toBe(
      true,
    );
    expect(streamCarriesChannelEmissionFrame(feed, { major: 1, minor: 1 })).toBe(
      true,
    );
    expect(
      streamCarriesChannelEmissionFrame(legacy, { major: 1, minor: 0 }),
    ).toBe(true);
    // Unknown lines, and a unary method that has no frames at all.
    expect(streamCarriesChannelEmissionFrame(feed, { major: 2, minor: 0 })).toBe(
      false,
    );
    expect(
      streamCarriesChannelEmissionFrame(legacy, { major: 1, minor: 1 }),
    ).toBe(false);
    expect(
      streamCarriesChannelEmissionFrame(
        { method: "host.notifications.list" },
        { major: 2, minor: 1 },
      ),
    ).toBe(false);
  });
});

describe("@2.1 -> @1.0 downgrade", () => {
  it("cannot hand a v1.1.7 caller an arm it has no parser for", () => {
    const result = hostNotificationsListDowngradeV21ToV10.downgradeResponse({
      entries: [AGENT_STOPPED_ENTRY, OPERATION_FINISHED_ENTRY],
      nextCursor: { kind: "chronological", updatedAt: 1, id: "x" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.id)).toEqual([
      AGENT_STOPPED_ENTRY.id,
    ]);
    expect(
      hostNotificationsListResponseSchemaV10.safeParse(result.value).success,
    ).toBe(true);
  });
});

describe("three-tier presentation", () => {
  const entry = (
    payload: Record<string, unknown>,
    outcome: "completed" | "errored" | "stopped",
  ): HostNotificationEntryV21 =>
    hostNotificationEntrySchemaV21.parse({
      ...OPERATION_FINISHED_ENTRY,
      outcome,
      payload,
    });

  it("tier 2: reads host-composed common fields off an unknown operation", () => {
    expect(
      formatHostNotificationPresentation(
        entry(
          {
            operation: "some.future.operation",
            title: "Cleaned up 4 test boxes",
            message: "All 4 test boxes were released.",
          },
          "completed",
        ),
      ),
    ).toEqual({
      title: "Cleaned up 4 test boxes",
      body: "All 4 test boxes were released.",
    });
  });

  it("tier 3: falls back to generic copy keyed off the durable outcome", () => {
    expect(formatHostNotificationPresentation(entry({}, "completed"))).toEqual({
      title: "Host operation finished",
      body: "Host operation • Done",
    });
    expect(formatHostNotificationPresentation(entry({}, "errored"))).toEqual({
      title: "Host operation failed",
      body: "Host operation • Failed",
    });
    expect(formatHostNotificationPresentation(entry({}, "stopped"))).toEqual({
      title: "Host operation finished",
      body: "Host operation • Stopped",
    });
  });

  it("tier 3: rejects a partial or wrongly-typed common payload", () => {
    for (const payload of [
      { operation: "x", title: "only a title" },
      { operation: "", title: "t", message: "m" },
      { operation: "x", title: "", message: "m" },
      { operation: "x", title: "t", message: 7 },
    ]) {
      expect(parseHostOperationCommonPayload(payload)).toBeNull();
      expect(
        formatHostNotificationPresentation(entry(payload, "errored")).title,
      ).toBe("Host operation failed");
    }
  });

  it("tier 1: no existing known arm may supply copy for a host-wide row", () => {
    // The regression this guards: a first-match-wins tier-1 branch that
    // derived its title from `knownPresentationContext` would render "Task"
    // and a generic body the moment an arm started matching this kind -
    // strictly worse than the tier-2 copy the same row shows today. Every arm
    // that exists is chat-scoped and must decline, so the chain falls through.
    const armPayloads: readonly Record<string, unknown>[] = [
      { kind: "chat", epicId: "e", chatId: "c", agentName: "a", taskTitle: "t", outcome: "completed" },
      { kind: "epic", epicId: "e", tuiAgentId: "t", agentName: "a", taskTitle: "t", outcome: "completed" },
      { kind: "agent_stalled", epicId: "e", chatId: "c", agentId: "a", agentName: "a", taskTitle: "t", reason: "r", title: "x", outcome: "errored" },
      { kind: "approval", epicId: "e", chatId: "c", chatTitle: "c", taskTitle: "t", approvalId: "a" },
      { kind: "interview", epicId: "e", chatId: "c", chatTitle: "c", taskTitle: "t", interviewBlockId: "i" },
      { kind: "workspace_operation_failed", epicId: "e", chatId: "c", chatTitle: "c", taskTitle: "t", operation: "setup", title: "x", message: "m", outcome: "errored" },
    ];
    for (const armPayload of armPayloads) {
      const known = parseKnownHostNotificationPayload(armPayload);
      expect(known).not.toBeNull();
      if (known === null) continue;
      expect(hostOperationKnownCopy(known)).toBeNull();
    }
  });

  it("tier 1 can never render worse than tier 2 for the same payload", () => {
    // A payload that satisfies BOTH the common convention and an existing
    // known arm's shape still renders the host-composed copy.
    //
    // Today this passes because the kind guard keeps tier 1 unreachable; the
    // test above is what pins the branch itself. Kept as the end-to-end
    // statement of the property so it starts covering the live path the
    // moment `payloadKindMatchesNotificationKind` returns an operation arm.
    const hybrid = entry(
      {
        kind: "workspace_operation_failed",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Some chat",
        taskTitle: "Some task",
        operation: "worktree.deletion",
        title: "Deleted 3 worktrees",
        message: "All 3 worktrees were removed.",
        outcome: "errored",
      },
      "errored",
    );
    expect(formatHostNotificationPresentation(hybrid)).toEqual({
      title: "Deleted 3 worktrees",
      body: "All 3 worktrees were removed.",
    });
  });

  it("keeps released kinds' copy unchanged", () => {
    expect(
      formatHostNotificationPresentation(
        hostNotificationEntrySchemaV21.parse(AGENT_STOPPED_ENTRY),
      ),
    ).toEqual(
      formatHostNotificationPresentation(
        hostNotificationEntrySchema.parse(AGENT_STOPPED_ENTRY),
      ),
    );
  });
});
