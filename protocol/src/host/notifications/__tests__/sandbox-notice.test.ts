import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV25,
  hostNotificationSandboxNoticePayloadSchema,
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV14,
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV15,
  visibleHostNotificationKinds,
  type HostNotificationEntryV25,
  type HostNotificationsSurface,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * `sandbox.notice` rides cloudFeed `@1.5` only. `@1.4` is on staging
 * desktops, whose frame parser reconnects on any row it cannot parse, so one
 * such row on the `@1.4` wire would loop the whole feed.
 */

const ENTRY_BASE = {
  id: "entry-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "sandbox-notice:sbx-1",
  epicId: null,
  chatId: null,
  severity: "info",
  outcome: "completed",
};

function noticeEntry(
  notice: Record<string, unknown>,
  sandboxName: string,
): Record<string, unknown> {
  return {
    ...ENTRY_BASE,
    kind: "sandbox.notice",
    payload: {
      kind: "sandbox_notice",
      sandboxId: "sbx-1",
      sandboxName,
      notice,
    },
  };
}

function snapshotFrame(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    connectionState: "connected",
    version: 1,
    rows: [
      {
        entryId: "0195a1f0-0001-7000-8000-00000000000a",
        originHostId: "host-a",
        coalesceKey: "sandbox-notice:sbx-1",
        entry,
        presentation: { epicTitle: null, chatTitle: null },
      },
    ],
    summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
  };
}

const RESTING_WARNING = noticeEntry(
  { kind: "resting_warning", destroyAt: 1_800_000_000_000, periodMinutes: 5 },
  "e2e-sbx-p2-renamed",
);

describe("sandbox.notice on older clients of the same minor", () => {
  it("is a snapshot the cloudFeed @1.4 parser rejects and @1.5 accepts", () => {
    const frame = snapshotFrame(RESTING_WARNING);
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV14.safeParse(frame)
        .success,
    ).toBe(false);
    expect(
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV15.safeParse(frame)
        .success,
    ).toBe(true);
  });

  it("is a partition snapshot the @1.4 parser rejects and @1.5 accepts", () => {
    const frame = {
      ...snapshotFrame(RESTING_WARNING),
      kind: "partitionSnapshot",
      partition: { home: "cloud", order: 1, nextCursor: null },
    };
    const v14 =
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV14.safeParse(frame);
    const v15 =
      hostNotificationsCloudFeedSubscribeServerFrameSchemaV15.safeParse(frame);
    expect(v14.success).toBe(false);
    expect(v15.success).toBe(true);
  });

  it.each([
    ["list", { method: "host.notifications.list" }, { major: 2, minor: 4 }],
    [
      "feed",
      { method: "host.notifications.feed.subscribe" },
      { major: 1, minor: 6 },
    ],
    [
      "cloudFeed @1.4",
      { method: "host.notifications.cloudFeed.subscribe" },
      { major: 1, minor: 4 },
    ],
  ] satisfies ReadonlyArray<
    readonly [
      string,
      HostNotificationsSurface,
      { major: number; minor: number },
    ]
  >)("%s never carries it", (_label, surface, version) => {
    expect(visibleHostNotificationKinds(surface, version)).not.toContain(
      "sandbox.notice",
    );
  });

  it("is carried from cloudFeed @1.5", () => {
    expect(
      visibleHostNotificationKinds(
        { method: "host.notifications.cloudFeed.subscribe" },
        { major: 1, minor: 5 },
      ),
    ).toContain("sandbox.notice");
  });
});

const NOW = Date.parse("2026-10-25T03:00:00.000Z");

/** The formatter reads the zone on each call, so one process sees both. */
async function formatIn(
  timeZone: string,
  entry: Record<string, unknown>,
): Promise<{ title: string; body: string }> {
  vi.stubEnv("TZ", timeZone);
  return formatHostNotificationPresentation(
    hostNotificationEntrySchemaV25.parse(entry) as HostNotificationEntryV25,
  );
}

function warningAt(iso: string): Record<string, unknown> {
  return noticeEntry(
    { kind: "resting_warning", destroyAt: Date.parse(iso), periodMinutes: 5 },
    "e2e-sbx-p2-renamed",
  );
}

describe("sandbox.notice presentation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reads the destroy time on the viewer's own clock", async () => {
    const entry = warningAt("2026-10-25T05:06:00.000Z");
    expect(await formatIn("Asia/Kolkata", entry)).toEqual({
      title: "e2e-sbx-p2-renamed is destroyed at 10:36 unless you use it",
      body: "Files on this sandbox cannot be recovered; published chats stay readable.",
    });
    expect((await formatIn("America/Los_Angeles", entry)).title).toBe(
      "e2e-sbx-p2-renamed is destroyed at 22:06 unless you use it",
    );
  });

  it("says tomorrow, then the date, for a later destroy time", async () => {
    expect(
      (await formatIn("Asia/Kolkata", warningAt("2026-10-26T05:06:00.000Z")))
        .title,
    ).toBe(
      "e2e-sbx-p2-renamed is destroyed tomorrow at 10:36 unless you use it",
    );
    expect(
      (await formatIn("Asia/Kolkata", warningAt("2026-10-27T05:06:00.000Z")))
        .title,
    ).toBe(
      "e2e-sbx-p2-renamed is destroyed on Oct 27 at 10:36 unless you use it",
    );
  });

  it.each([
    [
      "a resting destroy",
      { kind: "resting_destroyed" },
      "e2e-sbx-p2-renamed was destroyed after resting",
    ],
    [
      "a suspend you confirmed",
      {
        kind: "manual_rest",
        verb: "suspend",
        outcome: "confirmed",
        byYou: true,
        actorName: null,
      },
      "Suspended e2e-sbx-p2-renamed",
    ],
    [
      "another member's suspend",
      {
        kind: "manual_rest",
        verb: "suspend",
        outcome: "confirmed",
        byYou: false,
        actorName: "Priya",
      },
      "Priya suspended e2e-sbx-p2-renamed",
    ],
    [
      "a destroy by an unnamed member",
      { kind: "destroyed_by_member", actorName: null },
      "A member destroyed e2e-sbx-p2-renamed",
    ],
    [
      "a freeze for credits",
      { kind: "frozen", cause: "credits" },
      "e2e-sbx-p2-renamed is frozen",
    ],
    [
      "a frozen sandbox's last day",
      { kind: "frozen_warning", daysLeft: 1 },
      "e2e-sbx-p2-renamed is deleted tomorrow",
    ],
    [
      "a frozen sandbox's deletion",
      { kind: "frozen_destroyed" },
      "e2e-sbx-p2-renamed was deleted",
    ],
    [
      "a failed create",
      { kind: "create_failed" },
      "e2e-sbx-p2-renamed couldn't start",
    ],
    ["a lost sandbox", { kind: "lost" }, "e2e-sbx-p2-renamed was lost"],
  ])("titles %s", async (_label, notice, title) => {
    expect(
      (
        await formatIn(
          "Asia/Kolkata",
          noticeEntry(notice, "e2e-sbx-p2-renamed"),
        )
      ).title,
    ).toBe(title);
  });

  it("degrades a malformed payload to the generic copy", async () => {
    const malformed = {
      ...noticeEntry({ kind: "no_such_notice" }, "e2e-sbx-p2-renamed"),
    };
    expect(await formatIn("Asia/Kolkata", malformed)).toEqual({
      title: "Sandbox",
      body: "Open Details to see what happened",
    });
  });
});

describe("a member's destroy with the confirmed destroy time", () => {
  // 07:51 on 2026-10-25 in Asia/Kolkata, the same day as NOW there (08:30).
  const DESTROYED_AT = Date.parse("2026-10-25T02:21:00.000Z");

  function destroyedBy(
    actorName: string | null,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return noticeEntry(
      { kind: "destroyed_by_member", actorName, ...extra },
      "e2e-sbx-t1",
    );
  }

  it("parses and keeps the additive fields on the notice", () => {
    const entry = destroyedBy("Alex", {
      destroyedAt: DESTROYED_AT,
      stoppedAgentTaskTitles: ["Fix login"],
    });

    const payload = hostNotificationSandboxNoticePayloadSchema.parse(
      entry["payload"],
    );

    expect(payload.notice).toEqual({
      kind: "destroyed_by_member",
      actorName: "Alex",
      destroyedAt: DESTROYED_AT,
      stoppedAgentTaskTitles: ["Fix login"],
    });
  });

  it("parses a notice without the additive fields as before", () => {
    const payload = hostNotificationSandboxNoticePayloadSchema.parse(
      destroyedBy("Alex", {})["payload"],
    );

    expect(payload.notice).toEqual({
      kind: "destroyed_by_member",
      actorName: "Alex",
    });
  });

  it("words the actor, the sandbox and the destroy's clock in the viewer's zone, with the short files line", async () => {
    const entry = destroyedBy("Alex", {
      destroyedAt: DESTROYED_AT,
      stoppedAgentTaskTitles: [],
    });

    expect(await formatIn("Asia/Kolkata", entry)).toEqual({
      title: "Alex destroyed e2e-sbx-t1 at 07:51.",
      body: "Its files are gone.",
    });
    // 19:21 the day before in Los Angeles: the same instant, the viewer's clock.
    expect((await formatIn("America/Los_Angeles", entry)).title).toBe(
      "Alex destroyed e2e-sbx-t1 at 19:21.",
    );
  });

  it("names an unnamed actor as a member", async () => {
    expect(
      (
        await formatIn(
          "Asia/Kolkata",
          destroyedBy(null, { destroyedAt: DESTROYED_AT }),
        )
      ).title,
    ).toBe("A member destroyed e2e-sbx-t1 at 07:51.");
  });

  it("keeps the current copy for a notice without the new fields", async () => {
    expect(await formatIn("Asia/Kolkata", destroyedBy("Alex", {}))).toEqual({
      title: "Alex destroyed e2e-sbx-t1",
      body: "Files on this sandbox cannot be recovered; published chats stay readable.",
    });
  });

  it("adds one sentence per stopped task, in order, after the files line", async () => {
    const entry = destroyedBy("Alex", {
      destroyedAt: DESTROYED_AT,
      stoppedAgentTaskTitles: ["Fix login", "Ship billing"],
    });

    expect(await formatIn("Asia/Kolkata", entry)).toEqual({
      title: "Alex destroyed e2e-sbx-t1 at 07:51.",
      body: "Its files are gone. Your agent in Fix login was stopped. Your agent in Ship billing was stopped.",
    });
  });

  it("adds no sentence for a notice whose task list is absent", async () => {
    expect(
      (
        await formatIn(
          "Asia/Kolkata",
          destroyedBy("Alex", { destroyedAt: DESTROYED_AT }),
        )
      ).body,
    ).toBe("Its files are gone.");
  });

  it("reads the destroy's clock as the time alone, whatever day it was", async () => {
    // Two days before NOW: still `at HH:mm.`, never a date.
    const entry = destroyedBy("Alex", {
      destroyedAt: Date.parse("2026-10-23T02:21:00.000Z"),
    });

    expect((await formatIn("Asia/Kolkata", entry)).title).toBe(
      "Alex destroyed e2e-sbx-t1 at 07:51.",
    );
  });
});

describe("a member's confirmed Suspend or Stop with its time", () => {
  // 07:48 on 2026-10-25 in Asia/Kolkata.
  const CONFIRMED_AT = Date.parse("2026-10-25T02:18:00.000Z");

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function manualRest(
    verb: "suspend" | "stop",
    outcome: "confirmed" | "failed",
    byYou: boolean,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return noticeEntry(
      {
        kind: "manual_rest",
        verb,
        outcome,
        byYou,
        actorName: byYou ? null : "Alex",
        ...extra,
      },
      "e2e-sbx-t1",
    );
  }

  it("parses and keeps an optional confirmedAt on the notice", () => {
    const payload = hostNotificationSandboxNoticePayloadSchema.parse(
      manualRest("suspend", "confirmed", false, { confirmedAt: CONFIRMED_AT })[
        "payload"
      ],
    );

    expect(payload.notice).toEqual({
      kind: "manual_rest",
      verb: "suspend",
      outcome: "confirmed",
      byYou: false,
      actorName: "Alex",
      confirmedAt: CONFIRMED_AT,
    });
  });

  it.each([
    ["suspend", "suspended"],
    ["stop", "stopped"],
  ] as const)(
    "words another member's confirmed %s with the time in the viewer's zone and an empty body",
    async (verb, done) => {
      const entry = manualRest(verb, "confirmed", false, {
        confirmedAt: CONFIRMED_AT,
      });

      expect(await formatIn("Asia/Kolkata", entry)).toEqual({
        title: `Alex ${done} e2e-sbx-t1 at 07:48.`,
        body: "",
      });
      expect((await formatIn("America/Los_Angeles", entry)).title).toBe(
        `Alex ${done} e2e-sbx-t1 at 19:18.`,
      );
    },
  );

  it("keeps the previous copy for a confirmed notice without the time", async () => {
    expect(
      await formatIn(
        "Asia/Kolkata",
        manualRest("suspend", "confirmed", false, {}),
      ),
    ).toEqual({
      title: "Alex suspended e2e-sbx-t1",
      body: "Its files are kept.",
    });
  });

  it("leaves a failed notice and your own receipt as they were, time or not", async () => {
    expect(
      await formatIn(
        "Asia/Kolkata",
        manualRest("stop", "failed", false, { confirmedAt: CONFIRMED_AT }),
      ),
    ).toEqual({
      title: "Alex couldn't stop e2e-sbx-t1",
      body: "It is still running.",
    });
    expect(
      await formatIn(
        "Asia/Kolkata",
        manualRest("suspend", "confirmed", true, { confirmedAt: CONFIRMED_AT }),
      ),
    ).toEqual({
      title: "Suspended e2e-sbx-t1",
      body: "Its files are kept.",
    });
  });
});
