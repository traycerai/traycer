import { describe, expect, it } from "vitest";
import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  EnvironmentReviewEntryV12,
  EnvironmentStatusResponse,
  EnvironmentWriteOutcome,
  LocalOverride,
  LocalOverrideTarget,
  RemoteAccessState,
} from "@traycer/protocol/host/environment-schemas";
import {
  keepLocalTarget,
  keepLocalText,
  keptUndoFailedText,
  localOverrideLabel,
  MOVED_NOTICE_TEXT,
  movedNoticeShown,
  noticeText,
  REMOTE_ACCESS_QUESTION,
  REMOTE_ACCESS_TEXT,
  remoteAccessQuestionShown,
  reviewText,
  sameOverrideTarget,
  SETUP_STEPS,
  setupView,
  shownRemoteAccess,
  teamOwnedText,
  undoRefusalText,
} from "@/components/settings/host-scope/host-access-model";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";

type Setup = EnvironmentStatusResponse["setup"];

function setup(stage: string, state: string): Setup {
  return { stage, state };
}

function notice(overrides: Partial<EnvironmentNotice>): EnvironmentNotice {
  return {
    noticeId: "notice-1",
    kind: "variable",
    key: "LOG_LEVEL",
    os: "any",
    source: "offline",
    from: { kind: "host", hostId: "host-a", hostLabel: "dev-box" },
    writtenAt: 1,
    undoAvailable: true,
    ...overrides,
  };
}

/** A review entry as an `environment.review@1.2` host sends it. */
function reviewEntryV12(
  overrides: Partial<EnvironmentReviewEntryV12>,
): EnvironmentReviewEntryV12 {
  return {
    ...reviewEntry({}),
    command: null,
    event: null,
    description: null,
    harness: null,
    value: null,
    ...overrides,
  };
}

function reviewEntry(
  overrides: Partial<EnvironmentReviewEntry>,
): EnvironmentReviewEntry {
  return {
    entryId: "entry-1",
    reason: "credential_like_value",
    kind: "variable",
    key: "DATABASE_URL",
    os: "any",
    hostId: null,
    heldAt: 1,
    ...overrides,
  };
}

describe("the fixed copy", () => {
  it("states the question and the three remote-access answers in the person's words", () => {
    expect(REMOTE_ACCESS_QUESTION).toBe(
      "Allow other devices and agents on your account to reach this computer?",
    );
    expect(REMOTE_ACCESS_TEXT).toEqual({
      on: "On. Other devices and agents signed in to your account can reach this computer.",
      turning_off:
        "Turning off. Other devices and agents are being disconnected.",
      off: "Off. Other devices and agents can't reach this computer. Your settings still reach it.",
    });
  });

  it("names the setup steps in order", () => {
    expect(SETUP_STEPS).toEqual([
      { stage: "registering", label: "Registering this host" },
      {
        stage: "moving_settings",
        label: "Moving this host's settings to Personal",
      },
      { stage: "applying", label: "Applying your settings" },
    ]);
  });

  it("words the moved notice and the team line", () => {
    expect(MOVED_NOTICE_TEXT).toBe(
      "Your settings moved to Personal. Review what changed.",
    );
    expect(teamOwnedText("Acme")).toBe("These settings belong to Acme.");
    expect(keepLocalText("dev-box")).toBe("Keep dev-box's value on dev-box");
    expect(keptUndoFailedText("dev-box")).toBe(
      "Kept on dev-box, but couldn't undo the change everywhere.",
    );
  });
});

describe("shownRemoteAccess", () => {
  const cases: ReadonlyArray<
    [
      label: string,
      status: RemoteAccessState,
      lastAnswer: RemoteAccessState | null,
      shown: RemoteAccessState,
    ]
  > = [
    ["no answer, status on", "on", null, "on"],
    ["no answer, status off", "off", null, "off"],
    ["no answer, status turning_off", "turning_off", null, "turning_off"],
    ["turning_off answer, status still on", "on", "turning_off", "turning_off"],
    [
      "turning_off answer, status turning_off",
      "turning_off",
      "turning_off",
      "turning_off",
    ],
    ["turning_off answer, status off confirms it", "off", "turning_off", "off"],
    ["an on answer falls through to a status of off", "off", "on", "off"],
    ["an on answer falls through to a status of on", "on", "on", "on"],
    ["an off answer falls through to a status of on", "on", "off", "on"],
  ];
  it.each(cases)("%s", (_label, status, lastAnswer, shown) => {
    expect(shownRemoteAccess(status, lastAnswer)).toBe(shown);
  });
});

describe("remoteAccessQuestionShown", () => {
  const personal = { kind: "personal" } as const;
  const team = { kind: "team", teamName: "Acme" } as const;
  const cases: ReadonlyArray<
    [
      label: string,
      overrides: Partial<EnvironmentStatusResponse>,
      answered: boolean,
      shown: boolean,
    ]
  > = [
    [
      "personal, off, unanswered",
      { principal: personal, remoteAccess: "off" },
      false,
      true,
    ],
    [
      "personal, off, already answered",
      { principal: personal, remoteAccess: "off" },
      true,
      false,
    ],
    ["team principal", { principal: team, remoteAccess: "off" }, false, false],
    [
      "no principal yet",
      { principal: null, remoteAccess: "off" },
      false,
      false,
    ],
    [
      "personal, remote access on",
      { principal: personal, remoteAccess: "on" },
      false,
      false,
    ],
    [
      "personal, turning off",
      { principal: personal, remoteAccess: "turning_off" },
      false,
      false,
    ],
  ];
  it.each(cases)("%s", (_label, overrides, answered, shown) => {
    expect(
      remoteAccessQuestionShown(environmentStatusFixture(overrides), answered),
    ).toBe(shown);
  });
});

describe("setupView", () => {
  it("is nothing without a setup record", () => {
    expect(setupView(null)).toBeNull();
  });

  it("is nothing once the setup is done, by state or by stage", () => {
    expect(setupView(setup("applying", "done"))).toBeNull();
    expect(setupView(setup("done", "running"))).toBeNull();
    expect(setupView(setup("done", "done"))).toBeNull();
    // A stage that is done wins over a failure recorded beside it.
    expect(setupView(setup("done", "failed"))).toBeNull();
  });

  const running: ReadonlyArray<[stage: string, stepIndex: number]> = [
    ["registering", 0],
    ["moving_settings", 1],
    ["applying", 2],
  ];
  it.each(running)("%s running names step index %i", (stage, stepIndex) => {
    expect(setupView(setup(stage, "running"))).toEqual({
      kind: "running",
      stepIndex,
    });
  });

  const stopped: ReadonlyArray<
    [stage: string, state: string, stepIndex: number, text: string]
  > = [
    ["registering", "stalled", 0, "Setup stopped while registering this host."],
    ["registering", "failed", 0, "Setup stopped while registering this host."],
    [
      "moving_settings",
      "stalled",
      1,
      "Setup stopped while moving this host's settings to Personal.",
    ],
    ["applying", "stalled", 2, "Setup stopped while applying your settings."],
    ["applying", "failed", 2, "Setup stopped while applying your settings."],
  ];
  it.each(stopped)(
    "%s %s reads as stopped at step index %i",
    (stage, state, stepIndex, text) => {
      expect(setupView(setup(stage, state))).toEqual({
        kind: "stopped",
        stepIndex,
        text,
      });
    },
  );

  it("gives a failed move its own sentence", () => {
    expect(setupView(setup("moving_settings", "failed"))).toEqual({
      kind: "stopped",
      stepIndex: 1,
      text: "Moving this host's settings to Personal failed.",
    });
  });

  it("reads a stage newer than this desktop as running with no step named", () => {
    expect(setupView(setup("provisioning", "running"))).toEqual({
      kind: "running",
      stepIndex: -1,
    });
  });

  it("stops without naming a step for an unknown stage that stalled or failed", () => {
    expect(setupView(setup("provisioning", "stalled"))).toEqual({
      kind: "stopped",
      stepIndex: -1,
      text: "Setup stopped.",
    });
    expect(setupView(setup("provisioning", "failed"))).toEqual({
      kind: "stopped",
      stepIndex: -1,
      text: "Setup stopped.",
    });
  });

  it("reads a state newer than this desktop as running at its known step", () => {
    expect(setupView(setup("applying", "queued"))).toEqual({
      kind: "running",
      stepIndex: 2,
    });
  });
});

describe("movedNoticeShown", () => {
  const migration = notice({ source: "migration" });
  const offline = notice({ source: "offline" });
  interface MovedCase {
    readonly label: string;
    readonly setupRecord: Setup;
    readonly notices: readonly EnvironmentNotice[];
    readonly dismissed: boolean;
    readonly shown: boolean;
  }
  const cases: readonly MovedCase[] = [
    {
      label: "setup done by state with a migration notice",
      setupRecord: setup("applying", "done"),
      notices: [migration],
      dismissed: false,
      shown: true,
    },
    {
      label: "setup done by stage with a migration notice",
      setupRecord: setup("done", "running"),
      notices: [offline, migration],
      dismissed: false,
      shown: true,
    },
    {
      label: "dismissed on this desktop",
      setupRecord: setup("applying", "done"),
      notices: [migration],
      dismissed: true,
      shown: false,
    },
    {
      label: "no setup record",
      setupRecord: null,
      notices: [migration],
      dismissed: false,
      shown: false,
    },
    {
      label: "setup still running",
      setupRecord: setup("moving_settings", "running"),
      notices: [migration],
      dismissed: false,
      shown: false,
    },
    {
      label: "setup stopped",
      setupRecord: setup("moving_settings", "failed"),
      notices: [migration],
      dismissed: false,
      shown: false,
    },
    {
      label: "no migration notice",
      setupRecord: setup("applying", "done"),
      notices: [offline],
      dismissed: false,
      shown: false,
    },
    {
      label: "no notices at all",
      setupRecord: setup("applying", "done"),
      notices: [],
      dismissed: false,
      shown: false,
    },
  ];
  it.each(cases)("$label", (movedCase) => {
    expect(
      movedNoticeShown(
        environmentStatusFixture({ setup: movedCase.setupRecord }),
        movedCase.notices,
        movedCase.dismissed,
      ),
    ).toBe(movedCase.shown);
  });
});

describe("localOverrideLabel and sameOverrideTarget", () => {
  function override(target: LocalOverrideTarget): LocalOverride {
    return { target, os: "any", value: "v", setAt: 1 };
  }

  it("names a variable by its key and a provider's variable by the provider and the key", () => {
    expect(localOverrideLabel(override({ kind: "variable", key: "A" }))).toBe(
      "A",
    );
    expect(
      localOverrideLabel(
        override({
          kind: "env_override",
          providerId: "claude-code",
          key: "ANTHROPIC_API_KEY",
        }),
      ),
    ).toBe("ANTHROPIC_API_KEY (Claude Code)");
    expect(
      localOverrideLabel(
        override({ kind: "env_override", providerId: "codex", key: "K" }),
      ),
    ).toBe("K (Codex)");
  });

  const variableA: LocalOverrideTarget = { kind: "variable", key: "A" };
  const variableB: LocalOverrideTarget = { kind: "variable", key: "B" };
  const claudeK: LocalOverrideTarget = {
    kind: "env_override",
    providerId: "claude-code",
    key: "K",
  };
  const codexK: LocalOverrideTarget = {
    kind: "env_override",
    providerId: "codex",
    key: "K",
  };
  const claudeL: LocalOverrideTarget = {
    kind: "env_override",
    providerId: "claude-code",
    key: "L",
  };
  const comparisons: ReadonlyArray<
    [
      label: string,
      a: LocalOverrideTarget,
      b: LocalOverrideTarget,
      same: boolean,
    ]
  > = [
    ["the same variable", variableA, { kind: "variable", key: "A" }, true],
    ["two variables", variableA, variableB, false],
    ["the same provider variable", claudeK, { ...claudeK }, true],
    ["another provider, same key", claudeK, codexK, false],
    ["the same provider, another key", claudeK, claudeL, false],
    ["a variable and a provider variable", variableA, claudeK, false],
    ["a provider variable and a variable", claudeK, variableA, false],
  ];
  it.each(comparisons)("%s", (_label, a, b, same) => {
    expect(sameOverrideTarget(a, b)).toBe(same);
  });
});

describe("noticeText", () => {
  it("names the dashboard", () => {
    expect(
      noticeText(notice({ key: "DATABASE_URL", from: { kind: "dashboard" } })),
    ).toBe("DATABASE_URL from the dashboard now applies everywhere.");
  });

  it("names the host that made the change by its label", () => {
    expect(
      noticeText(
        notice({
          key: "DATABASE_URL",
          from: { kind: "host", hostId: "host-a", hostLabel: "dev-box" },
        }),
      ),
    ).toBe("DATABASE_URL from dev-box now applies everywhere.");
  });

  it("says another host when the host has no label", () => {
    expect(
      noticeText(
        notice({
          key: "DATABASE_URL",
          from: { kind: "host", hostId: "host-a", hostLabel: null },
        }),
      ),
    ).toBe("DATABASE_URL from another host now applies everywhere.");
  });

  it("labels a provider's variable by the variable and a singleton by its page", () => {
    expect(
      noticeText(
        notice({
          kind: "env_override",
          key: "claude-code:ANTHROPIC_API_KEY",
        }),
      ),
    ).toBe("ANTHROPIC_API_KEY from dev-box now applies everywhere.");
    expect(noticeText(notice({ kind: "shell", key: "shell" }))).toBe(
      "The shell from dev-box now applies everywhere.",
    );
  });
});

describe("keepLocalTarget", () => {
  const fromDevBox = {
    kind: "host",
    hostId: "host-a",
    hostLabel: "dev-box",
  } as const;
  const cases: ReadonlyArray<
    [
      label: string,
      notice: Partial<EnvironmentNotice>,
      windowHostId: string | null,
      target: LocalOverrideTarget | null,
    ]
  > = [
    [
      "a variable changed on the window's host",
      { kind: "variable", key: "LOG_LEVEL", from: fromDevBox },
      "host-a",
      { kind: "variable", key: "LOG_LEVEL" },
    ],
    [
      "a provider's variable, parsed from <providerId>:<variable>",
      { kind: "env_override", key: "claude-code:ANTHROPIC_API_KEY" },
      "host-a",
      {
        kind: "env_override",
        providerId: "claude-code",
        key: "ANTHROPIC_API_KEY",
      },
    ],
    [
      "a provider's variable whose name holds another colon",
      { kind: "env_override", key: "codex:A:B" },
      "host-a",
      { kind: "env_override", providerId: "codex", key: "A:B" },
    ],
    [
      "a provider id this desktop does not know",
      { kind: "env_override", key: "not-a-provider:KEY" },
      "host-a",
      null,
    ],
    [
      "an env override key with no colon",
      { kind: "env_override", key: "ANTHROPIC_API_KEY" },
      "host-a",
      null,
    ],
    ["a shell item", { kind: "shell", key: "shell" }, "host-a", null],
    [
      "an MCP server item",
      { kind: "mcp_server", key: "linear" },
      "host-a",
      null,
    ],
    [
      "a change that came from the dashboard",
      { kind: "variable", key: "LOG_LEVEL", from: { kind: "dashboard" } },
      "host-a",
      null,
    ],
    [
      "a change that came from another host",
      {
        kind: "variable",
        key: "LOG_LEVEL",
        from: { kind: "host", hostId: "host-b", hostLabel: "laptop" },
      },
      "host-a",
      null,
    ],
    [
      "a change whose undo is no longer available",
      { kind: "variable", key: "LOG_LEVEL", undoAvailable: false },
      "host-a",
      null,
    ],
    [
      "a window with no host",
      { kind: "variable", key: "LOG_LEVEL" },
      null,
      null,
    ],
  ];
  it.each(cases)("%s", (_label, overrides, windowHostId, target) => {
    expect(
      keepLocalTarget(notice({ from: fromDevBox, ...overrides }), windowHostId),
    ).toEqual(target);
  });
});

describe("undoRefusalText", () => {
  const saved: EnvironmentWriteOutcome = { outcome: "saved", revision: 3 };
  const pending: EnvironmentWriteOutcome = {
    outcome: "pending",
    uploadId: "upload-1",
  };
  const stale: EnvironmentWriteOutcome = {
    outcome: "stale",
    currentRevision: 4,
    changedBy: { kind: "dashboard" },
  };
  const needsGrant: EnvironmentWriteOutcome = { outcome: "needs_grant" };
  const kept = { hostName: "dev-box" } as const;

  it("says nothing for an undo that went through, kept or not", () => {
    expect(undoRefusalText(saved, "LOG_LEVEL", null)).toBeNull();
    expect(undoRefusalText(saved, "LOG_LEVEL", kept)).toBeNull();
  });

  it("says the undo waits for a reconnect", () => {
    expect(undoRefusalText(pending, "LOG_LEVEL", null)).toBe(
      "Undo applies when this host reconnects.",
    );
    expect(undoRefusalText(pending, "LOG_LEVEL", kept)).toBe(
      "Kept on dev-box. The change everywhere is undone when this host reconnects.",
    );
  });

  it("says the value was changed again since", () => {
    expect(undoRefusalText(stale, "LOG_LEVEL", null)).toBe(
      "Couldn't undo: LOG_LEVEL was changed again since.",
    );
    expect(undoRefusalText(stale, "LOG_LEVEL", kept)).toBe(
      "Kept on dev-box, but couldn't undo the change everywhere: LOG_LEVEL was changed again since.",
    );
  });

  it("says the undo needs the person's confirmation", () => {
    expect(undoRefusalText(needsGrant, "LOG_LEVEL", null)).toBe(
      "Couldn't undo: it needs your confirmation. Sign in again and retry.",
    );
    expect(undoRefusalText(needsGrant, "LOG_LEVEL", kept)).toBe(
      "Kept on dev-box, but couldn't undo the change everywhere: it needs your confirmation. Sign in again and retry.",
    );
  });
});

describe("reviewText", () => {
  const cases: ReadonlyArray<[reason: string, text: string]> = [
    [
      "credential_like_value",
      "DATABASE_URL looks like a key and is on hold until you choose",
    ],
    [
      "executable_entry",
      "DATABASE_URL (variable) changes how programs start and is on hold until you choose",
    ],
    [
      "needs_grant",
      "DATABASE_URL is waiting for you: was changed without your confirmation.",
    ],
    ["a_reason_from_a_newer_host", "DATABASE_URL is waiting for you."],
  ];
  it.each(cases)("reason %s", (reason, text) => {
    expect(reviewText(reviewEntry({ reason }))).toBe(text);
  });

  it("names a held MCP server's command and says it waits for a choice", () => {
    expect(
      reviewText(
        reviewEntryV12({
          kind: "mcp_server",
          key: "env-e2e-memory",
          reason: "executable_entry",
          command: "npx -y @mcp/memory",
        }),
      ),
    ).toBe(
      "env-e2e-memory (MCP server) runs npx -y @mcp/memory and is on hold until you choose",
    );
  });

  it("names a held hook's command and event", () => {
    expect(
      reviewText(
        reviewEntryV12({
          kind: "hook",
          key: "notify",
          reason: "executable_entry",
          command: "notify.sh",
          event: "stop",
        }),
      ),
    ).toBe(
      "notify (hook) runs notify.sh on stop and is on hold until you choose",
    );
  });

  it("words a held environment setting by the program it changes", () => {
    expect(
      reviewText(
        reviewEntryV12({
          kind: "env_override",
          key: "claude:NODE_OPTIONS",
          reason: "executable_entry",
          harness: "claude",
          value: "--inspect",
        }),
      ),
    ).toBe(
      "NODE_OPTIONS (variable) changes how Claude Code starts: NODE_OPTIONS=--inspect and is on hold until you choose",
    );
  });

  it("words a held setup script by when a sandbox runs it", () => {
    expect(
      reviewText(
        reviewEntryV12({
          kind: "setup_script",
          key: "setup",
          reason: "executable_entry",
          command: "brew bundle",
        }),
      ),
    ).toBe(
      "setup (setup script) runs brew bundle when a sandbox first gets it or it changes and is on hold until you choose",
    );
  });

  it("names the kind alone for a held command from a host that does not send it", () => {
    expect(
      reviewText(
        reviewEntry({
          kind: "mcp_server",
          key: "linear",
          reason: "executable_entry",
        }),
      ),
    ).toBe("linear (MCP server) is on hold until you choose");
  });
});
