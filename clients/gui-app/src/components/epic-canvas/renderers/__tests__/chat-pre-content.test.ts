import { describe, expect, it } from "vitest";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  HostReachabilityHostKind,
  HostReachabilityStatus,
} from "@/hooks/agent/use-host-reachability";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";
import {
  CHAT_LOAD_DEADLINE_MS,
  chatLoadAttemptsThisWait,
  chatLoadWaitBeganAt,
  chatPreContentElapsed,
  chatPreContentEvidence,
  chatPreContentFatal,
  chatPreContentHost,
  chatPreContentReport,
  chatPreContentStrip,
  classifyChatPreContent,
  describeChatPreContent,
  STALLED_CHAT_LOAD_ATTEMPTS,
  STALLED_CHAT_LOAD_ELAPSED_MS,
  type ChatPreContentAxes,
  type ChatPreContentElapsed,
  type ChatPreContentEvidence,
  type ChatPreContentFatal,
  type ChatPreContentHost,
  type ChatPreContentInput,
  type ChatPreContentKind,
  type ChatPreContentSession,
  type ChatPreContentStrip,
  type ChatPreContentView,
  type ChatTileFatalDetails,
} from "../chat-pre-content";

/**
 * The chat tile's pre-content matrix, asserted without mounting anything.
 *
 * Every pin asserts WORDS or a decision, never only an absence: "no spinner"
 * passes vacuously on an empty mount, and "no button" passes on a body that
 * never rendered. The component suite (`chat-tile-runtime-gate.test.tsx`)
 * covers the deadlines, the clicks and the handle arriving mid-wait.
 */

const LABEL = "MacBook Pro";
const KEEPS_RETRYING = "This keeps retrying on its own.";

const VERDICT: ChatTileFatalDetails = {
  code: "CHAT_INVALID",
  reason: "CHAT_INVALID: this agent no longer exists",
  upgradeGuidance: null,
};

function lease(
  status: "connecting" | "ready" | "degraded" | "restarting-expected",
): HostLeaseSnapshot {
  return { hostId: "host-1", status, dead: null };
}

const DEAD_OFFLINE: HostLeaseSnapshot = {
  hostId: "host-1",
  status: "dead",
  dead: { reason: "offline" },
};

/** A session whose streak, if any, is all from this wait. */
function stream(
  connectionStatus: StreamConnectionStatus,
  attempts: number,
): ChatPreContentSession {
  return {
    fatalClose: null,
    connectionStatus,
    retries:
      attempts === 0
        ? null
        : { count: attempts, firstAt: 1_000, code: null, reason: null },
    attemptsThisWait: attempts,
  };
}

function input(overrides: Partial<ChatPreContentInput>): ChatPreContentInput {
  return {
    session: stream("connecting", 0),
    lease: lease("ready"),
    reachabilityStatus: "reachable",
    hostKind: "local",
    hostLabel: LABEL,
    hostBehindClient: false,
    elapsed: "early",
    ...overrides,
  };
}

function axes(overrides: Partial<ChatPreContentAxes>): ChatPreContentAxes {
  return {
    fatal: "none",
    host: "up",
    strip: "none",
    evidence: "connecting",
    elapsed: "early",
    ...overrides,
  };
}

const FATALS: readonly ChatPreContentFatal[] = [
  "none",
  "verdict",
  "host-update",
];
const HOSTS: readonly ChatPreContentHost[] = [
  "dead",
  "up",
  "restarting",
  "starting",
  "unknown",
];
const STRIPS: readonly ChatPreContentStrip[] = ["starting", "offline", "none"];
const EVIDENCE: readonly ChatPreContentEvidence[] = [
  "no-handle",
  "stalled-closed",
  "refused",
  "silent",
  "reconnecting",
  "connecting",
];
const ELAPSED: readonly ChatPreContentElapsed[] = ["early", "slow", "overdue"];

function everyAxes(): ChatPreContentAxes[] {
  return FATALS.flatMap((fatal) =>
    HOSTS.flatMap((host) =>
      STRIPS.flatMap((strip) =>
        EVIDENCE.flatMap((evidence) =>
          ELAPSED.map((elapsed) => ({ fatal, host, strip, evidence, elapsed })),
        ),
      ),
    ),
  );
}

/** A broad grid of real inputs, for the negative controls. */
function everyInput(): ChatPreContentInput[] {
  const sessions: ReadonlyArray<ChatPreContentSession | null> = [
    null,
    stream("connecting", 0),
    stream("reconnecting", 1),
    stream("reconnecting", STALLED_CHAT_LOAD_ATTEMPTS),
    stream("open", 0),
    stream("closed", 0),
    { ...stream("closed", 0), fatalClose: VERDICT },
    {
      ...stream("closed", 0),
      fatalClose: {
        code: HOST_OLDER_THAN_DATA_FATAL_CODE,
        reason: "HOST_OLDER_THAN_DATA: written by a newer build",
        upgradeGuidance: null,
      },
    },
  ];
  const leases: ReadonlyArray<HostLeaseSnapshot | null> = [
    null,
    lease("connecting"),
    lease("ready"),
    lease("degraded"),
    lease("restarting-expected"),
    DEAD_OFFLINE,
  ];
  const statuses: readonly HostReachabilityStatus[] = [
    "checking",
    "reachable",
    "unreachable",
    "host-starting",
  ];
  const kinds: readonly HostReachabilityHostKind[] = ["local", "remote"];
  const labels: ReadonlyArray<string | null> = [LABEL, null];
  return sessions.flatMap((session) =>
    leases.flatMap((leaseValue) =>
      statuses.flatMap((reachabilityStatus) =>
        kinds.flatMap((hostKind) =>
          labels.flatMap((hostLabel) =>
            [true, false].flatMap((hostBehindClient) =>
              ELAPSED.map((elapsed) => ({
                session,
                lease: leaseValue,
                reachabilityStatus,
                hostKind,
                hostLabel,
                hostBehindClient,
                elapsed,
              })),
            ),
          ),
        ),
      ),
    ),
  );
}

function bodyText(value: ChatPreContentInput): string {
  const view = describeChatPreContent(value);
  return view.detail === null
    ? view.headline
    : `${view.headline} ${view.detail}`;
}

describe("the chat load constants (D1)", () => {
  it("adds a line at 20 s, offers buttons at 60 s, and escalates early after three refusals", () => {
    expect(STALLED_CHAT_LOAD_ELAPSED_MS).toBe(20_000);
    expect(CHAT_LOAD_DEADLINE_MS).toBe(60_000);
    expect(STALLED_CHAT_LOAD_ATTEMPTS).toBe(3);
  });

  it("arrives with the pill's own escalation, so the two never contradict each other", () => {
    expect(CHAT_LOAD_DEADLINE_MS).toBe(LINK_DOWN_ESCALATION_MS);
  });
});

describe("the wait anchor", () => {
  it("lets a first render inherit an older streak, and never a newer one", () => {
    const first = {
      startedAt: 10_000,
      attemptsBefore: 0,
      inheritsStreak: true,
    };
    expect(
      chatLoadWaitBeganAt(first, {
        count: 1,
        firstAt: 4_000,
        code: null,
        reason: null,
      }),
    ).toBe(4_000);
    expect(
      chatLoadWaitBeganAt(first, {
        count: 1,
        firstAt: 12_000,
        code: null,
        reason: null,
      }),
    ).toBe(10_000);
    expect(chatLoadWaitBeganAt(first, null)).toBe(10_000);
  });

  it("dates a Try again's wait from the click, however old the kept streak is", () => {
    expect(
      chatLoadWaitBeganAt(
        { startedAt: 10_000, attemptsBefore: 3, inheritsStreak: false },
        { count: 3, firstAt: 4_000, code: null, reason: null },
      ),
    ).toBe(10_000);
  });

  it("counts only the refusals since the wait began", () => {
    const afterClick = {
      startedAt: 10_000,
      attemptsBefore: 3,
      inheritsStreak: false,
    };
    expect(
      chatLoadAttemptsThisWait(afterClick, {
        count: 5,
        firstAt: 4_000,
        code: null,
        reason: null,
      }),
    ).toBe(2);
    // A rebuilt store starts its own streak below the old count.
    expect(
      chatLoadAttemptsThisWait(afterClick, {
        count: 1,
        firstAt: 11_000,
        code: null,
        reason: null,
      }),
    ).toBe(0);
    expect(chatLoadAttemptsThisWait(afterClick, null)).toBe(0);
  });
});

describe("the axes", () => {
  it.each<[HostReachabilityStatus, ChatPreContentStrip]>([
    ["host-starting", "starting"],
    ["unreachable", "offline"],
    ["reachable", "none"],
    ["checking", "none"],
  ])("reads reachability %s as the %s strip", (status, strip) => {
    expect(chatPreContentStrip(status)).toBe(strip);
  });

  it.each<[HostLeaseSnapshot | null, ChatPreContentStrip, ChatPreContentHost]>([
    [null, "none", "unknown"],
    [null, "offline", "unknown"],
    [DEAD_OFFLINE, "offline", "dead"],
    [lease("ready"), "none", "up"],
    [lease("degraded"), "starting", "up"],
    // The lease says up while the strip on screen says offline.
    [lease("ready"), "offline", "unknown"],
    [lease("degraded"), "offline", "unknown"],
    [lease("restarting-expected"), "starting", "restarting"],
    [lease("connecting"), "none", "starting"],
  ])("reads lease %o under the %s strip as %s", (leaseValue, strip, host) => {
    expect(chatPreContentHost(leaseValue, strip)).toBe(host);
  });

  it.each<[string, ChatPreContentSession | null, ChatPreContentEvidence]>([
    ["no handle", null, "no-handle"],
    [
      "closed with nothing retrying, even past three refusals",
      stream("closed", 5),
      "stalled-closed",
    ],
    [
      "closed under a fatal close, which is its own axis",
      { ...stream("closed", 0), fatalClose: VERDICT },
      "connecting",
    ],
    ["three refusals", stream("reconnecting", 3), "refused"],
    ["three refusals, even while open", stream("open", 3), "refused"],
    ["open with nothing sent", stream("open", 0), "silent"],
    ["open after two refusals", stream("open", 2), "silent"],
    ["one refusal", stream("reconnecting", 1), "reconnecting"],
    ["a later attempt connecting", stream("connecting", 2), "reconnecting"],
    ["a first attempt connecting", stream("connecting", 0), "connecting"],
  ])("reads %s as %s", (_label, session, evidence) => {
    expect(chatPreContentEvidence(session)).toBe(evidence);
  });

  it.each<[boolean, boolean, ChatPreContentElapsed]>([
    [false, false, "early"],
    [true, false, "slow"],
    [true, true, "overdue"],
  ])("reads slow=%s and overdue=%s as %s", (slow, overdue, elapsed) => {
    expect(chatPreContentElapsed(slow, overdue)).toBe(elapsed);
  });

  it.each<[ChatTileFatalDetails | null, ChatPreContentFatal]>([
    [null, "none"],
    [VERDICT, "verdict"],
    [
      {
        code: HOST_OLDER_THAN_DATA_FATAL_CODE,
        reason: "HOST_OLDER_THAN_DATA: written by a newer build",
        upgradeGuidance: null,
      },
      "host-update",
    ],
  ])("reads fatal close %o as %s", (fatalClose, fatal) => {
    expect(chatPreContentFatal(fatalClose)).toBe(fatal);
  });
});

describe("classifyChatPreContent", () => {
  it("returns exactly the six arms over every combination of the axes", () => {
    const kinds = new Set(everyAxes().map(classifyChatPreContent));
    expect([...kinds].sort()).toEqual(
      [
        "failed",
        "failed-host-update",
        "host-gone",
        "taking-too-long",
        "waiting-for-host",
        "loading",
      ].sort(),
    );
  });

  it("lets a verdict beat a dead lease, the deadline and a stalled store", () => {
    const worst = {
      host: "dead" as const,
      evidence: "stalled-closed" as const,
      elapsed: "overdue" as const,
    };
    expect(classifyChatPreContent(axes({ ...worst, fatal: "verdict" }))).toBe(
      "failed",
    );
    expect(
      classifyChatPreContent(axes({ ...worst, fatal: "host-update" })),
    ).toBe("failed-host-update");
  });

  it("lets a dead lease beat the deadline and a stalled store", () => {
    expect(
      classifyChatPreContent(
        axes({ host: "dead", evidence: "stalled-closed", elapsed: "overdue" }),
      ),
    ).toBe("host-gone");
  });

  it.each(["up", "restarting", "starting", "unknown"] as const)(
    "escalates a stalled store at once, whatever the host (%s)",
    (host) => {
      expect(
        classifyChatPreContent(
          axes({ host, evidence: "stalled-closed", elapsed: "early" }),
        ),
      ).toBe("taking-too-long");
    },
  );

  it("escalates every wait at the deadline that no verdict has ended", () => {
    for (const host of ["up", "restarting", "starting", "unknown"] as const) {
      for (const evidence of EVIDENCE) {
        for (const strip of STRIPS) {
          expect(
            classifyChatPreContent(
              axes({ host, evidence, strip, elapsed: "overdue" }),
            ),
          ).toBe("taking-too-long");
        }
      }
    }
  });

  it("escalates early on three refusals only while the host is up", () => {
    expect(
      classifyChatPreContent(axes({ host: "up", evidence: "refused" })),
    ).toBe("taking-too-long");
    for (const host of ["restarting", "starting", "unknown"] as const) {
      for (const elapsed of ["early", "slow"] as const) {
        expect(
          classifyChatPreContent(axes({ host, evidence: "refused", elapsed })),
        ).toBe("waiting-for-host");
      }
    }
  });

  it("names an ordinary wait by whether the host is up, and time alone moves nothing before the deadline", () => {
    for (const evidence of [
      "no-handle",
      "silent",
      "reconnecting",
      "connecting",
    ] as const) {
      for (const elapsed of ["early", "slow"] as const) {
        expect(
          classifyChatPreContent(axes({ host: "up", evidence, elapsed })),
        ).toBe("loading");
        for (const host of ["restarting", "starting", "unknown"] as const) {
          expect(
            classifyChatPreContent(axes({ host, evidence, elapsed })),
          ).toBe("waiting-for-host");
        }
      }
    }
  });
});

describe("arms 1 and 2: the host's verdict", () => {
  function failed(
    fatalClose: ChatTileFatalDetails,
    hostBehindClient: boolean,
  ): ChatPreContentView {
    return describeChatPreContent(
      input({
        session: { ...stream("closed", 0), fatalClose },
        hostBehindClient,
      }),
    );
  }

  it("offers the host update when HOST_OLDER_THAN_DATA proves the host is behind", () => {
    const view = failed(
      {
        code: HOST_OLDER_THAN_DATA_FATAL_CODE,
        reason:
          "HOST_OLDER_THAN_DATA: Chat store at ... was written by a newer build",
        upgradeGuidance: {
          hostShouldUpgrade: true,
          clientShouldUpgrade: false,
        },
      },
      true,
    );
    expect(view).toEqual({
      kind: "failed-host-update",
      headline: "Host update needed",
      detail: "Chat store at ... was written by a newer build",
      settled: true,
      spinner: false,
      layout: "card",
      offersHostUpdate: true,
      offersTryAgain: true,
      offersReport: true,
      code: HOST_OLDER_THAN_DATA_FATAL_CODE,
    });
  });

  it("says the agent could not be opened for a plain verdict, with the reason and no update", () => {
    const view = failed(VERDICT, false);
    expect(view.kind).toBe("failed");
    expect(view.headline).toBe("This agent could not be opened.");
    expect(view.detail).toBe("this agent no longer exists");
    expect(view.offersHostUpdate).toBe(false);
    expect(view.offersTryAgain).toBe(true);
    expect(view.settled).toBe(true);
  });

  it("keeps the host update for a disk-format refusal even when the host is newer than the app", () => {
    // HOST_OLDER_THAN_DATA is a fact about the host's own reader, so no app
    // version can make updating the app the fix.
    const view = failed(
      {
        code: HOST_OLDER_THAN_DATA_FATAL_CODE,
        reason: "HOST_OLDER_THAN_DATA: written by a newer build",
        upgradeGuidance: null,
      },
      false,
    );
    expect(view.kind).toBe("failed-host-update");
    expect(view.headline).toBe("Host update needed");
  });

  it("offers the host update from guidance alone on a code this build has never heard of", () => {
    const view = failed(
      {
        code: "SOME_FUTURE_CODE",
        reason: "SOME_FUTURE_CODE: the host says so",
        upgradeGuidance: {
          hostShouldUpgrade: true,
          clientShouldUpgrade: false,
        },
      },
      false,
    );
    expect(view.kind).toBe("failed-host-update");
  });

  it("keeps the generic body for CHAT_STORE_UNUSABLE, whose remedy is a repair or a report", () => {
    const view = failed(
      {
        code: "CHAT_STORE_UNUSABLE",
        reason: "CHAT_STORE_UNUSABLE: integrity verification failed",
        upgradeGuidance: null,
      },
      true,
    );
    expect(view.kind).toBe("failed");
    expect(view.headline).toBe("This agent could not be opened.");
    expect(view.offersHostUpdate).toBe(false);
  });

  it("offers no host update when the guidance says both legs should upgrade", () => {
    const view = failed(
      {
        code: "SOME_OTHER_CODE",
        reason: "SOME_OTHER_CODE: both are stale",
        upgradeGuidance: { hostShouldUpgrade: true, clientShouldUpgrade: true },
      },
      false,
    );
    expect(view.kind).toBe("failed");
    expect(view.offersHostUpdate).toBe(false);
  });

  it("words a verdict as a verdict under a dead lease and past the deadline", () => {
    const view = describeChatPreContent(
      input({
        session: { ...stream("closed", 0), fatalClose: VERDICT },
        lease: DEAD_OFFLINE,
        reachabilityStatus: "unreachable",
        elapsed: "overdue",
      }),
    );
    expect(view.headline).toBe("This agent could not be opened.");
  });
});

describe("arm 3: the host is gone", () => {
  it.each<[HostLeaseSnapshot, string]>([
    [
      DEAD_OFFLINE,
      `Host "${LABEL}" is offline, so this agent can't be loaded. It will load once that host is back.`,
    ],
    [
      { hostId: "host-1", status: "dead", dead: { reason: "plan-restricted" } },
      `Host "${LABEL}" is local only on your current plan, so this agent can't be reached from here. Upgrade to use that host remotely, or open it on that machine.`,
    ],
    [
      { hostId: "host-1", status: "dead", dead: { reason: "removed" } },
      `Host "${LABEL}" was removed from your account, so this agent can't be loaded.`,
    ],
  ])("says the lease's own sentence for %o", (dead, sentence) => {
    const view = describeChatPreContent(
      input({ lease: dead, reachabilityStatus: "unreachable" }),
    );
    expect(view.kind).toBe("host-gone");
    expect(view.headline).toBe(sentence);
    expect(view.detail).toBeNull();
  });

  it("offers Try again only once a handle exists, and never spins", () => {
    const withHandle = describeChatPreContent(input({ lease: DEAD_OFFLINE }));
    const withoutHandle = describeChatPreContent(
      input({ lease: DEAD_OFFLINE, session: null }),
    );
    expect(withHandle.offersTryAgain).toBe(true);
    expect(withoutHandle.offersTryAgain).toBe(false);
    expect([withHandle.spinner, withoutHandle.spinner]).toEqual([false, false]);
    expect([withHandle.offersReport, withoutHandle.offersReport]).toEqual([
      true,
      true,
    ]);
    expect(withHandle.settled).toBe(false);
  });
});

describe("arm 4: taking too long", () => {
  it("says the agent hasn't loaded yet, or names the host update when the host is behind", () => {
    const plain = describeChatPreContent(input({ elapsed: "overdue" }));
    expect(plain.kind).toBe("taking-too-long");
    expect(plain.headline).toBe("This agent hasn't loaded yet.");
    expect(plain.offersHostUpdate).toBe(false);

    const behind = describeChatPreContent(
      input({ elapsed: "overdue", hostBehindClient: true }),
    );
    expect(behind.headline).toBe("Host update needed");
    expect(behind.offersHostUpdate).toBe(true);
  });

  it.each<[string, Partial<ChatPreContentInput>, string]>([
    [
      "a stalled store",
      { session: stream("closed", 0) },
      `The connection to "${LABEL}" was lost.`,
    ],
    [
      "an offline strip",
      { reachabilityStatus: "unreachable", lease: null, elapsed: "overdue" },
      `It will open here once "${LABEL}" is available.`,
    ],
    [
      "a host restarting",
      {
        reachabilityStatus: "host-starting",
        lease: lease("restarting-expected"),
        elapsed: "overdue",
      },
      `"${LABEL}" is still restarting. ${KEEPS_RETRYING}`,
    ],
    [
      "a local host starting",
      { lease: lease("connecting"), hostKind: "local", elapsed: "overdue" },
      `"${LABEL}" hasn't started yet. ${KEEPS_RETRYING}`,
    ],
    [
      "a remote host starting",
      { lease: lease("connecting"), hostKind: "remote", elapsed: "overdue" },
      `"${LABEL}" hasn't answered yet. ${KEEPS_RETRYING}`,
    ],
    [
      "a host nothing has spoken for",
      { lease: null, elapsed: "overdue" },
      `"${LABEL}" hasn't answered yet. ${KEEPS_RETRYING}`,
    ],
    [
      "three refusals from a host that is up",
      { session: stream("reconnecting", 3) },
      `"${LABEL}" has not opened it after 3 attempts. ${KEEPS_RETRYING}`,
    ],
    [
      "a silent host",
      { session: stream("open", 0), elapsed: "overdue" },
      `"${LABEL}" is connected but hasn't sent it yet. It will appear here as soon as it arrives.`,
    ],
    [
      "a first connection never accepted",
      { session: stream("connecting", 0), elapsed: "overdue" },
      `"${LABEL}" hasn't accepted the connection yet. ${KEEPS_RETRYING}`,
    ],
    [
      "a reconnect still running",
      { session: stream("reconnecting", 1), elapsed: "overdue" },
      `Still reconnecting to "${LABEL}". ${KEEPS_RETRYING}`,
    ],
    [
      "no handle while the host is up",
      { session: null, elapsed: "overdue" },
      `"${LABEL}" hasn't answered.`,
    ],
  ])("says the right second line for %s", (_label, overrides, detail) => {
    const view = describeChatPreContent(input(overrides));
    expect(view.kind).toBe("taking-too-long");
    expect(view.detail).toBe(detail);
  });

  it("counts the whole streak in its words, not only this wait's share of it", () => {
    const view = describeChatPreContent(
      input({
        session: {
          fatalClose: null,
          connectionStatus: "reconnecting",
          retries: { count: 6, firstAt: 1_000, code: null, reason: null },
          attemptsThisWait: 3,
        },
      }),
    );
    expect(view.detail).toBe(
      `"${LABEL}" has not opened it after 6 attempts. ${KEEPS_RETRYING}`,
    );
  });

  it("spins while something is retrying, and offers Try again only with a handle", () => {
    const retrying = describeChatPreContent(input({ elapsed: "overdue" }));
    expect([retrying.spinner, retrying.offersTryAgain]).toEqual([true, true]);

    const stalled = describeChatPreContent(
      input({ session: stream("closed", 0) }),
    );
    expect([stalled.spinner, stalled.offersTryAgain]).toEqual([false, true]);

    const noHandle = describeChatPreContent(
      input({ session: null, elapsed: "overdue" }),
    );
    expect([noHandle.spinner, noHandle.offersTryAgain]).toEqual([false, false]);
    expect(noHandle.offersReport).toBe(true);
  });

  it("names the host as the host when the directory has no label", () => {
    const view = describeChatPreContent(
      input({ session: stream("reconnecting", 3), hostLabel: null }),
    );
    expect(view.detail).toBe(
      `The host has not opened it after 3 attempts. ${KEEPS_RETRYING}`,
    );
    const reconnecting = describeChatPreContent(
      input({
        session: stream("reconnecting", 1),
        hostLabel: null,
        elapsed: "overdue",
      }),
    );
    expect(reconnecting.detail).toBe(
      `Still reconnecting to the host. ${KEEPS_RETRYING}`,
    );
  });
});

describe("arm 5: waiting for the host", () => {
  it.each<
    [
      HostReachabilityStatus,
      HostLeaseSnapshot | null,
      HostReachabilityHostKind,
      string,
    ]
  >([
    [
      "host-starting",
      lease("restarting-expected"),
      "remote",
      `This agent will open once "${LABEL}" is ready.`,
    ],
    [
      "host-starting",
      lease("connecting"),
      "local",
      `This agent will open once "${LABEL}" is ready.`,
    ],
    [
      "host-starting",
      null,
      "local",
      `This agent will open once "${LABEL}" is ready.`,
    ],
    [
      "reachable",
      lease("restarting-expected"),
      "remote",
      `Waiting for "${LABEL}" to restart…`,
    ],
    [
      "reachable",
      lease("connecting"),
      "local",
      `Waiting for "${LABEL}" to start…`,
    ],
    ["reachable", lease("connecting"), "remote", `Connecting to "${LABEL}"…`],
    ["checking", null, "unknown", `Connecting to "${LABEL}"…`],
    [
      "unreachable",
      lease("connecting"),
      "local",
      `This agent will open once "${LABEL}" is available.`,
    ],
    [
      "unreachable",
      null,
      "remote",
      `This agent will open once "${LABEL}" is available.`,
    ],
    [
      "unreachable",
      lease("ready"),
      "remote",
      `This agent will open once "${LABEL}" is available.`,
    ],
  ])(
    "under reachability %s with lease %o on a %s host, says the right headline",
    (reachabilityStatus, leaseValue, hostKind, headline) => {
      const view = describeChatPreContent(
        input({ reachabilityStatus, lease: leaseValue, hostKind }),
      );
      expect(view.kind).toBe("waiting-for-host");
      expect(view.headline).toBe(headline);
      expect([
        view.offersHostUpdate,
        view.offersTryAgain,
        view.offersReport,
      ]).toEqual([false, false, false]);
    },
  );

  it("adds that it keeps retrying from 20 s, and only while a handle exists", () => {
    const starting = input({
      reachabilityStatus: "host-starting",
      lease: lease("connecting"),
    });
    expect(describeChatPreContent(starting).detail).toBeNull();
    expect(
      describeChatPreContent({ ...starting, elapsed: "slow" }).detail,
    ).toBe(KEEPS_RETRYING);
    expect(
      describeChatPreContent({ ...starting, elapsed: "slow", session: null })
        .detail,
    ).toBeNull();
  });

  it("does not spin under an offline strip with no handle, because nothing is running", () => {
    const offline = input({ reachabilityStatus: "unreachable", lease: null });
    expect(describeChatPreContent({ ...offline, session: null }).spinner).toBe(
      false,
    );
    expect(describeChatPreContent(offline).spinner).toBe(true);
    expect(
      describeChatPreContent(
        input({
          reachabilityStatus: "host-starting",
          lease: null,
          session: null,
        }),
      ).spinner,
    ).toBe(true);
  });
});

describe("arm 6: loading", () => {
  it("names the host from the first frame, spins, and offers nothing", () => {
    expect(describeChatPreContent(input({}))).toEqual({
      kind: "loading",
      headline: `Loading this agent from "${LABEL}"…`,
      detail: null,
      settled: false,
      spinner: true,
      layout: "plain",
      offersHostUpdate: false,
      offersTryAgain: false,
      offersReport: false,
      code: null,
    });
  });

  it.each<[string, ChatPreContentSession | null, string]>([
    [
      "a silent host",
      stream("open", 0),
      `Taking longer than usual. It will appear here as soon as "${LABEL}" sends it.`,
    ],
    [
      "a first connection",
      stream("connecting", 0),
      `Still connecting to "${LABEL}". ${KEEPS_RETRYING}`,
    ],
    [
      "a reconnect",
      stream("reconnecting", 1),
      `Reconnecting to "${LABEL}". ${KEEPS_RETRYING}`,
    ],
    ["no handle yet", null, "Taking longer than usual."],
  ])("adds the right line from 20 s for %s", (_label, session, detail) => {
    const view = describeChatPreContent(input({ session, elapsed: "slow" }));
    expect(view.kind).toBe("loading");
    expect(view.detail).toBe(detail);
  });

  it("names the host as the host when the directory has no label", () => {
    expect(describeChatPreContent(input({ hostLabel: null })).headline).toBe(
      "Loading this agent from the host…",
    );
  });
});

describe("negative controls over every input", () => {
  const inputs = everyInput();

  it("never pairs an offline strip with Waiting… or Loading…", () => {
    for (const value of inputs) {
      if (value.reachabilityStatus !== "unreachable") continue;
      expect(bodyText(value)).not.toMatch(/^(Waiting|Loading)/);
    }
  });

  it("never repeats the strip's sentence", () => {
    for (const value of inputs) {
      const text = bodyText(value);
      if (value.reachabilityStatus === "host-starting") {
        expect(text).not.toContain("Waiting for the host to start");
      }
      // The dead-tile banner's sentence opens with the bound host.
      expect(text).not.toContain("Bound host");
    }
  });

  it("styles nothing as an error without a verdict from the host", () => {
    for (const value of inputs) {
      const view = describeChatPreContent(value);
      expect(view.settled).toBe((value.session?.fatalClose ?? null) !== null);
    }
  });

  it("never offers Try again without a handle, and never offers anything in a calm wait", () => {
    for (const value of inputs) {
      const view = describeChatPreContent(value);
      if (value.session === null) expect(view.offersTryAgain).toBe(false);
      if (view.kind === "loading" || view.kind === "waiting-for-host") {
        expect([
          view.offersHostUpdate,
          view.offersTryAgain,
          view.offersReport,
        ]).toEqual([false, false, false]);
      }
    }
  });

  it("classifies every input into one of the six arms the view reports", () => {
    const kinds = new Set<ChatPreContentKind>(
      inputs.map((value) => describeChatPreContent(value).kind),
    );
    expect(kinds.size).toBe(6);
  });
});

describe("chatPreContentReport", () => {
  it("carries the host's code and every stage token, from fixed words only", () => {
    const report = chatPreContentReport(
      input({
        session: {
          fatalClose: null,
          connectionStatus: "reconnecting",
          retries: {
            count: 3,
            firstAt: 1_000,
            code: "SESSION_NOT_READY",
            reason: "SESSION_NOT_READY: chat session storage is not ready",
          },
          attemptsThisWait: 3,
        },
      }),
      12_345,
    );
    expect(report).toEqual({
      title: "This agent hasn't loaded",
      message:
        "stage=taking-too-long evidence=refused attempts=3 elapsedS=12 stream=reconnecting lease=ready strip=none",
      code: "SESSION_NOT_READY",
      source: "Chat",
    });
  });

  it("says there is no stream before the handle, and names a dead lease's reason", () => {
    const report = chatPreContentReport(
      input({
        session: null,
        lease: {
          hostId: "host-1",
          status: "dead",
          dead: { reason: "plan-restricted" },
        },
        reachabilityStatus: "unreachable",
      }),
      61_000,
    );
    expect(report.message).toBe(
      "stage=host-gone evidence=no-handle attempts=0 elapsedS=61 stream=none lease=dead:plan-restricted strip=offline",
    );
    expect(report.code).toBeNull();
  });

  it("reports a verdict as the verdict, with its code", () => {
    expect(
      chatPreContentReport(
        input({ session: { ...stream("closed", 0), fatalClose: VERDICT } }),
        5_000,
      ),
    ).toEqual({
      title: "This agent could not be opened",
      message: "The agent could not be opened.",
      code: "CHAT_INVALID",
      source: "Chat",
    });
  });

  it("never reports a negative elapsed time", () => {
    expect(chatPreContentReport(input({}), -5).message).toContain(
      "elapsedS=0 ",
    );
  });
});
