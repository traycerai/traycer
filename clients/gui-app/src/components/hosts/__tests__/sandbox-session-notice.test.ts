import { describe, expect, it } from "vitest";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  SandboxOperation,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSessionNotice } from "@/components/hosts/sandbox-card-model";

/**
 * The notice a sandbox card shows about the person's paused session: the retry
 * of a wake that never answered, what a restart or a stop cost the session,
 * and, from a week ahead, the day a suspended session is lost.
 */

const NOW = 1_791_460_800_000;
const DAY = 24 * 60 * 60 * 1000;

function operationOf(
  state: HostSandboxState,
  outcomeDetail: string | null,
): SandboxOperation {
  return {
    at: NOW - 60_000,
    fromState: "suspended",
    state,
    cause: "wake",
    outcomeCause: "wake",
    outcomeDetail,
    actor: null,
    gesture: null,
  };
}

function summaryOf(
  state: HostSandboxState,
  overrides: Partial<SandboxSummary>,
): SandboxSummary {
  return {
    id: "sbx_1",
    hostId: "host-1",
    kind: "agent",
    provider: "tensorlake",
    region: "us-east",
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    displayName: "build-box",
    state,
    frozen: false,
    failureCode: null,
    idleMinutes: null,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    createdAt: NOW - 30 * DAY,
    lastTransitionAt: NOW - 60_000,
    lastActivityAt: null,
    destroyedAt: null,
    frozenAt: null,
    guestConfigured: null,
    guestConfigFailureReason: null,
    phase: null,
    routes: null,
    priceMcPerHour: null,
    environmentId: null,
    createdBy: null,
    wakePayer: null,
    keptBy: null,
    restingSince: null,
    destroyAfterRestingMinutes: null,
    destroyAt: null,
    createdByTaskId: null,
    createdByAgentName: null,
    createdByTaskTitle: null,
    keptAt: null,
    operation: null,
    regionLabel: null,
    withdrawalEndsAt: null,
    ...overrides,
  };
}

/** The notice for a row whose resolved state is the state its summary carries. */
function noticeOfAgreeingRow(
  summary: SandboxSummary,
  now: number,
  filesOutcomeStated: boolean,
): string | null {
  return sandboxSessionNotice(summary, summary.state, now, filesOutcomeStated);
}

/** The day a loss is announced for, spelled from its instant the way a person reads it. */
function dayOf(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

describe("the restart of a wake that never answered", () => {
  it.each(["starting", "resuming"] as const)(
    "says the sandbox is restarting while it is %s",
    (state) => {
      const notice = noticeOfAgreeingRow(
        summaryOf(state, { operation: operationOf(state, "wake-retry") }),
        NOW,
        false,
      );

      expect(notice).toBe("Restarting your sandbox");
    },
  );

  it.each(["awake", "suspended", "stopping", "suspending"] as const)(
    "does not say it while the row is %s, the state word being the card's own",
    (state) => {
      const notice = noticeOfAgreeingRow(
        summaryOf(state, { operation: operationOf(state, "wake-retry") }),
        NOW,
        false,
      );

      expect(notice).not.toBe("Restarting your sandbox");
    },
  );

  it("says nothing while the row is starting for an ordinary wake", () => {
    expect(
      noticeOfAgreeingRow(
        summaryOf("starting", { operation: operationOf("starting", null) }),
        NOW,
        false,
      ),
    ).toBeNull();
  });
});

describe("what a restart or a stop cost the paused session", () => {
  it("tells an awake sandbox that its paused session was lost and its files are unchanged", () => {
    const notice = noticeOfAgreeingRow(
      summaryOf("awake", { operation: operationOf("awake", "wake-retried") }),
      NOW,
      false,
    );

    expect(notice).toContain("Your paused session was lost");
    expect(notice).toContain("restarted");
    expect(notice).toContain("Your files are unchanged.");
  });

  it.each([null, "wake-retry", "suspended-session-lost"])(
    "says nothing of a restart to an awake sandbox whose last operation ended %s",
    (detail) => {
      expect(
        noticeOfAgreeingRow(
          summaryOf("awake", { operation: operationOf("awake", detail) }),
          NOW,
          false,
        ),
      ).toBeNull();
    },
  );

  it("does not tell a sandbox that is not awake that it restarted", () => {
    expect(
      noticeOfAgreeingRow(
        summaryOf("suspended", {
          operation: operationOf("suspended", "wake-retried"),
        }),
        NOW,
        false,
      ),
    ).toBeNull();
  });

  it.each([
    ["a conversion", "suspended-session-lost"],
    ["a retry that failed", "wake-retry-failed"],
  ])(
    "tells a stopped sandbox after %s that its paused session was lost when it stopped",
    (_label, detail) => {
      const notice = noticeOfAgreeingRow(
        summaryOf("stopped", { operation: operationOf("stopped", detail) }),
        NOW,
        false,
      );

      expect(notice).toContain("Your paused session was lost");
      expect(notice).toContain("stopped");
      expect(notice).toContain("Your files are unchanged.");
    },
  );

  it("does not repeat the files clause when the card already states what happened to them", () => {
    const notice = noticeOfAgreeingRow(
      summaryOf("stopped", {
        operation: operationOf("stopped", "suspended-session-lost"),
      }),
      NOW,
      true,
    );

    expect(notice).toContain("Your paused session was lost");
    expect(notice).not.toContain("files");
  });
});

describe("the notice a week ahead of a suspended session's end", () => {
  it("names the day, from the instant the server sent", () => {
    const at = NOW + 3 * DAY;

    const notice = noticeOfAgreeingRow(
      summaryOf("suspended", { suspendedSessionEndsAt: at }),
      NOW,
      false,
    );

    expect(notice).toContain(dayOf(at));
    expect(notice).toContain("Resume your sandbox before then to keep it.");
  });

  it("starts exactly seven days ahead and not a millisecond earlier", () => {
    const inside = noticeOfAgreeingRow(
      summaryOf("suspended", { suspendedSessionEndsAt: NOW + 7 * DAY }),
      NOW,
      false,
    );
    const outside = noticeOfAgreeingRow(
      summaryOf("suspended", { suspendedSessionEndsAt: NOW + 7 * DAY + 1 }),
      NOW,
      false,
    );

    expect(inside).not.toBeNull();
    expect(outside).toBeNull();
  });

  it("keeps showing it on the end day and after the instant has passed", () => {
    expect(
      noticeOfAgreeingRow(
        summaryOf("suspended", { suspendedSessionEndsAt: NOW - DAY }),
        NOW,
        false,
      ),
    ).not.toBeNull();
  });

  it.each([
    ["a server that sends no end", {}],
    ["no limit declared", { suspendedSessionEndsAt: null }],
  ])("says nothing for %s", (_label, fields) => {
    expect(
      noticeOfAgreeingRow(summaryOf("suspended", fields), NOW, false),
    ).toBeNull();
  });

  it.each(["awake", "stopped", "resuming", "starting"] as const)(
    "says nothing once the row is %s, whatever end the server still carries",
    (state) => {
      expect(
        noticeOfAgreeingRow(
          summaryOf(state, { suspendedSessionEndsAt: NOW + DAY }),
          NOW,
          false,
        ),
      ).toBeNull();
    },
  );
});

describe("a suspended session being converted to stopped", () => {
  const CONVERTING =
    "Your paused session has expired. Your sandbox is being stopped.";

  it("says the session expired while the conversion resumes the sandbox", () => {
    const notice = noticeOfAgreeingRow(
      summaryOf("resuming", {
        operation: operationOf("resuming", "suspended-session-expiry"),
      }),
      NOW,
      false,
    );

    expect(notice).toBe(CONVERTING);
  });

  it("says the same while the conversion is stopping it", () => {
    const notice = noticeOfAgreeingRow(
      summaryOf("stopping", {
        operation: operationOf("stopping", "suspended-session-lost"),
      }),
      NOW,
      false,
    );

    expect(notice).toBe(CONVERTING);
  });

  it("says nothing of a conversion while a stop is for another reason or a wake is ordinary", () => {
    expect(
      noticeOfAgreeingRow(
        summaryOf("stopping", { operation: operationOf("stopping", null) }),
        NOW,
        false,
      ),
    ).toBeNull();
    expect(
      noticeOfAgreeingRow(
        summaryOf("resuming", { operation: operationOf("resuming", null) }),
        NOW,
        false,
      ),
    ).toBeNull();
  });

  it("takes the expiry detail for the resume and the loss detail for the stop, not each other's", () => {
    expect(
      noticeOfAgreeingRow(
        summaryOf("resuming", {
          operation: operationOf("resuming", "suspended-session-lost"),
        }),
        NOW,
        false,
      ),
    ).toBeNull();
    expect(
      noticeOfAgreeingRow(
        summaryOf("stopping", {
          operation: operationOf("stopping", "suspended-session-expiry"),
        }),
        NOW,
        false,
      ),
    ).toBeNull();
  });
});

describe("the state the caller resolved, not the summary's", () => {
  const lostDetail = "suspended-session-lost";

  it("gives no resume warning for a summary that still says suspended once the row is resolved stopped", () => {
    const summary = summaryOf("suspended", {
      suspendedSessionEndsAt: NOW + DAY,
    });

    expect(sandboxSessionNotice(summary, "stopped", NOW, false)).toBeNull();
    expect(sandboxSessionNotice(summary, "suspended", NOW, false)).toContain(
      "Resume your sandbox before then to keep it.",
    );
  });

  it("warns for a row resolved suspended whose summary has not caught up", () => {
    const summary = summaryOf("stopped", { suspendedSessionEndsAt: NOW + DAY });

    expect(sandboxSessionNotice(summary, "suspended", NOW, false)).toContain(
      dayOf(NOW + DAY),
    );
  });

  it("says restarting only for a resolved starting or resuming row, whatever the summary says", () => {
    const retrying = summaryOf("awake", {
      operation: operationOf("starting", "wake-retry"),
    });
    const stale = summaryOf("starting", {
      operation: operationOf("starting", "wake-retry"),
    });

    expect(sandboxSessionNotice(retrying, "resuming", NOW, false)).toBe(
      "Restarting your sandbox",
    );
    expect(sandboxSessionNotice(stale, "awake", NOW, false)).toBeNull();
  });

  it("takes the stopped loss sentence from the resolved state alone", () => {
    const summary = summaryOf("awake", {
      operation: operationOf("stopped", lostDetail),
    });

    expect(sandboxSessionNotice(summary, "stopped", NOW, false)).toContain(
      "lost when your sandbox stopped",
    );
    expect(sandboxSessionNotice(summary, "awake", NOW, false)).toBeNull();
  });

  it("says nothing while the state is unresolved, whatever the summary carries", () => {
    expect(
      sandboxSessionNotice(
        summaryOf("stopped", {
          operation: operationOf("stopped", lostDetail),
          suspendedSessionEndsAt: NOW + DAY,
        }),
        null,
        NOW,
        false,
      ),
    ).toBeNull();
  });

  it("leaves the files clause to the caller's say, not the summary's frozen flag", () => {
    const frozenSummary = summaryOf("stopped", {
      frozen: true,
      operation: operationOf("stopped", lostDetail),
    });

    expect(
      sandboxSessionNotice(frozenSummary, "stopped", NOW, false),
    ).toContain("Your files are unchanged.");
    expect(
      sandboxSessionNotice(frozenSummary, "stopped", NOW, true),
    ).not.toContain("files");
  });
});

describe("which wake-retry details end a stopped row's session", () => {
  const STOPPED_LOSS = "lost when your sandbox stopped";

  function stoppedWith(detail: string): string | null {
    return sandboxSessionNotice(
      summaryOf("stopped", { operation: operationOf("stopped", detail) }),
      "stopped",
      NOW,
      false,
    );
  }

  it.each([
    "wake-retry",
    "wake-retry-failed",
    "wake-retry:credit-gate:denied",
    "wake-retry:a-code-the-server-adds-next-year",
  ])(
    "tells a stopped row ended by %s that its paused session was lost",
    (detail) => {
      expect(stoppedWith(detail)).toContain(STOPPED_LOSS);
    },
  );

  it.each([
    "wake-retried",
    "wake-retry-exhausted",
    "wake-retrying",
    "wake-retr",
  ])("says nothing for a stopped row ended by the unlisted %s", (detail) => {
    expect(stoppedWith(detail)).toBeNull();
  });
});
