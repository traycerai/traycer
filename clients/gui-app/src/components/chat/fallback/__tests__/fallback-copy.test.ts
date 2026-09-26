import { describe, expect, it } from "vitest";
import {
  FALLBACK_ACTION_OUTCOMES,
  FALLBACK_RUNG_REFUSAL_KINDS,
  type FallbackRungRefusalKind,
} from "@traycer/protocol/host/chat-fallback";
import * as copy from "@/components/chat/fallback/fallback-copy";
import {
  describeFallbackOutcome,
  describeListTargetsOutcome,
  describeManualRungRefusal,
  describeRefusalDetail,
  describeSwitchDisposition,
  describeWaitDisposition,
  fallbackLowUsageClause,
  fallbackReasonLabelFor,
  joinCostClauses,
  queuedMessagesMovingText,
  queuedMessagesReturningText,
  queuedMovingClause,
  queuedReturningClause,
  queuedWaitingClause,
  siblingSwitchingClause,
  switchConsequencesText,
  switchDestinationConsequence,
  type ManualRungKind,
  type RefusalRemainingActions,
} from "@/components/chat/fallback/fallback-copy";

describe("describeFallbackOutcome", () => {
  it("returns null for applied and a sentence for every other FALLBACK_ACTION_OUTCOMES member", () => {
    for (const outcome of FALLBACK_ACTION_OUTCOMES) {
      const text = describeFallbackOutcome(outcome);
      if (outcome === "applied") {
        expect(text).toBeNull();
      } else {
        expect(text).not.toBeNull();
        expect(text).not.toBe("");
      }
    }
  });
});

describe("fallbackReasonLabelFor", () => {
  it("returns the shared label for a known code", () => {
    expect(fallbackReasonLabelFor("auth")).toBe("Signed out");
    expect(fallbackReasonLabelFor("rate_limit")).toBe("Rate limit reached");
  });

  it("returns null for an unrecognised code rather than echoing it", () => {
    // Falsification: make fallbackReasonLabelFor return the raw reason string as a fallback and THIS assertion must go red.
    expect(
      fallbackReasonLabelFor("something_this_build_has_never_heard_of"),
    ).toBeNull();
  });
});

describe("queued message copy family", () => {
  it("hides the sentence helpers at zero and uses singular vs plural above it", () => {
    expect(queuedMessagesMovingText(0)).toBeNull();
    expect(queuedMessagesReturningText(0)).toBeNull();

    expect(queuedMessagesMovingText(1)).toBe(
      "1 queued message will run on the new settings too.",
    );
    expect(queuedMessagesReturningText(1)).toBe(
      " and moves 1 queued message back",
    );

    expect(queuedMessagesMovingText(3)).toBe(
      "3 queued messages will run on the new settings too.",
    );
    expect(queuedMessagesReturningText(3)).toBe(
      " and moves 3 queued messages back",
    );
  });

  it("hides the card clauses at zero and uses singular vs plural above it", () => {
    for (const clause of [
      queuedMovingClause,
      queuedWaitingClause,
      queuedReturningClause,
    ]) {
      expect(clause(0)).toBeNull();
    }
    expect(queuedMovingClause(1)).toBe("1 queued message moves with it");
    expect(queuedMovingClause(3)).toBe("3 queued messages move with it");
    expect(queuedWaitingClause(1)).toBe("1 queued message waits with it");
    expect(queuedWaitingClause(3)).toBe("3 queued messages wait with it");
    expect(queuedReturningClause(1)).toBe("moves 1 queued message back");
    expect(queuedReturningClause(3)).toBe("moves 3 queued messages back");
  });

  it("keeps the three clauses saying different things on purpose", () => {
    const moving = queuedMovingClause(2);
    const waiting = queuedWaitingClause(2);
    const returning = queuedReturningClause(2);
    expect(moving).not.toBe(waiting);
    expect(moving).not.toBe(returning);
    expect(waiting).not.toBe(returning);
    expect(moving).toMatch(/move with it/);
    expect(waiting).toMatch(/wait with it/);
    expect(returning).toMatch(/back/);
  });
});

describe("fallbackLowUsageClause", () => {
  it("says 'running low' for near_limit with no named family", () => {
    // Falsification: swap the severity check so hard_limit renders "running low" and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "near_limit",
        limitedFamilies: [],
      }),
    ).toBe("work-account is running low on usage");
  });

  it("says 'reached its rate limit' for hard_limit with no named family", () => {
    // Falsification: swap the severity check so near_limit renders "has reached its" and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "hard_limit",
        limitedFamilies: [],
      }),
    ).toBe("work-account has reached its rate limit");
  });

  it("names a single family as the qualifier before 'usage'", () => {
    // Falsification: drop the limitedFamilies qualifier from the near_limit branch and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "near_limit",
        limitedFamilies: ["Fable"],
      }),
    ).toBe("work-account is running low on Fable usage");
  });

  it("joins multiple families with ', ' before 'rate limit'", () => {
    // Falsification: join limitedFamilies with " and " instead of ", " and THIS assertion must go red.
    expect(
      fallbackLowUsageClause({
        accountName: "work-account",
        severity: "hard_limit",
        limitedFamilies: ["Fable", "Opus"],
      }),
    ).toBe("work-account has reached its Fable, Opus rate limit");
  });
});

describe("siblingSwitchingClause", () => {
  it("is null at zero and singular vs plural above it", () => {
    expect(siblingSwitchingClause(0)).toBeNull();
    expect(siblingSwitchingClause(1)).toBe(
      "1 other chat in this task is also switching",
    );
    expect(siblingSwitchingClause(4)).toBe(
      "4 other chats in this task are also switching",
    );
  });
});

describe("joinCostClauses", () => {
  it("joins the true clauses with a middle dot and is null when none is", () => {
    expect(joinCostClauses([null, null])).toBeNull();
    expect(joinCostClauses([queuedMovingClause(2), null])).toBe(
      "2 queued messages move with it",
    );
    expect(
      joinCostClauses([queuedMovingClause(1), siblingSwitchingClause(2)]),
    ).toBe(
      "1 queued message moves with it · 2 other chats in this task are also switching",
    );
  });
});

describe("removed exports", () => {
  it("no longer exports the retired labels and helpers", () => {
    // The names the routing cards replaced; a resurrected export would put the
    // old link-styled actions and the "keeps the error" helper back in reach.
    const exported = new Set(Object.keys(copy));
    for (const removed of [
      "CHOOSE_DIFFERENTLY_LABEL",
      "SWITCH_INSTEAD_LABEL",
      "KEEPS_THE_ERROR_HELPER",
      "queuedMessagesWaitingText",
      "siblingSwitchingText",
    ]) {
      expect(exported.has(removed)).toBe(false);
    }
  });
});

const HOST_LABEL = "Surya's MacBook";

/**
 * The spec's Flow 4 table, written out literally: what each kind says and which
 * buttons it leaves when the host reports `retryable: false`. Deliberately not
 * derived from the copy module, so a change to the module is a change here.
 */
const REFUSAL_TABLE: ReadonlyArray<{
  readonly kind: FallbackRungRefusalKind;
  readonly text: string | null;
  readonly remaining: RefusalRemainingActions;
}> = [
  {
    kind: "turn_running",
    text: "This chat is busy. The actions come back when the current turn ends.",
    remaining: "none",
  },
  { kind: "routing_active", text: null, remaining: "none" },
  {
    kind: "worktree_missing",
    text: `This chat's worktree no longer exists on ${HOST_LABEL}. Start a new chat from this task.`,
    remaining: "none",
  },
  {
    kind: "no_workspace",
    text: "This chat has no folder to run in any more. Start a new chat from this task.",
    remaining: "none",
  },
  {
    kind: "message_changed",
    text: "The original message changed, so it can't be replayed. Send it again from the composer.",
    remaining: "none",
  },
  {
    kind: "prelaunch_failed",
    text: "Couldn't start the replacement turn. Try again, or switch.",
    remaining: "retry_and_switch",
  },
  {
    kind: "reset_passed",
    text: "That limit has reset. Retry instead.",
    remaining: "retry_and_switch",
  },
  {
    kind: "no_verified_reset",
    text: "The provider hasn't said when this limit resets, so there's nothing to wait for.",
    remaining: "retry_and_switch",
  },
  {
    kind: "host_unavailable",
    text: "This chat's host is restarting. Try again in a moment.",
    remaining: "all",
  },
  {
    kind: "settings_missing",
    text: "This chat has no model set. Pick one in the composer and send again.",
    remaining: "none",
  },
  {
    kind: "storage_failed",
    text: "Couldn't save this chat's state just now. Try again.",
    remaining: "all",
  },
  {
    kind: "target_unusable",
    text: "That model can't be used right now. Pick another.",
    remaining: "switch",
  },
];

describe("describeRefusalDetail", () => {
  it("covers every protocol kind except the host's residue in the table", () => {
    const covered = new Set(REFUSAL_TABLE.map((row) => row.kind));
    for (const kind of FALLBACK_RUNG_REFUSAL_KINDS) {
      if (kind === "unknown") continue;
      expect(covered.has(kind)).toBe(true);
    }
  });

  it.each(REFUSAL_TABLE)(
    "says the table's sentence for $kind and leaves $remaining when pressing again cannot help",
    ({ kind, text, remaining }) => {
      expect(
        describeRefusalDetail(
          { kind, label: "the host's own sentence", retryable: false },
          HOST_LABEL,
        ),
      ).toEqual({ text, remaining });
    },
  );

  it.each(REFUSAL_TABLE)(
    "keeps every button for $kind when the host says retryable, except where the chat is busy",
    ({ kind, text }) => {
      const hidden = kind === "turn_running" || kind === "routing_active";
      expect(
        describeRefusalDetail(
          { kind, label: "the host's own sentence", retryable: true },
          HOST_LABEL,
        ),
      ).toEqual({ text, remaining: hidden ? "none" : "all" });
    },
  );

  it("names the machine only from the tab host label, and omits it when there is none", () => {
    const detail = {
      kind: "worktree_missing",
      label: "Some other machine",
      retryable: false,
    };
    expect(describeRefusalDetail(detail, "Surya's MacBook").text).toBe(
      "This chat's worktree no longer exists on Surya's MacBook. Start a new chat from this task.",
    );
    expect(describeRefusalDetail(detail, null).text).toBe(
      "This chat's worktree no longer exists on its host. Start a new chat from this task.",
    );
  });

  it("renders the host's label for the residue kind and keeps every button", () => {
    expect(
      describeRefusalDetail(
        { kind: "unknown", label: "Something went wrong.", retryable: false },
        HOST_LABEL,
      ),
    ).toEqual({ text: "Something went wrong.", remaining: "all" });
  });

  it("renders the host's label for a kind this build has never heard of and keeps every button", () => {
    expect(
      describeRefusalDetail(
        {
          kind: "a_kind_from_a_newer_host",
          label: "The newer host's sentence.",
          retryable: false,
        },
        HOST_LABEL,
      ),
    ).toEqual({ text: "The newer host's sentence.", remaining: "all" });
  });

  it("has no sentence for a blank host label rather than an empty one", () => {
    expect(
      describeRefusalDetail(
        { kind: "a_kind_from_a_newer_host", label: "   ", retryable: false },
        HOST_LABEL,
      ),
    ).toEqual({ text: null, remaining: "all" });
    expect(
      describeRefusalDetail(
        { kind: "unknown", label: "", retryable: true },
        HOST_LABEL,
      ),
    ).toEqual({ text: null, remaining: "all" });
  });
});

describe("describeManualRungRefusal", () => {
  const RUNGS: ReadonlyArray<{
    readonly rung: ManualRungKind;
    readonly neutral: string;
  }> = [
    { rung: "retry", neutral: "Couldn't retry just now." },
    { rung: "wait_once", neutral: "Couldn't start the wait just now." },
    { rung: "switch", neutral: "Couldn't switch just now." },
  ];

  it("is null for applied, whose feedback is the frame that follows", () => {
    expect(
      describeManualRungRefusal({
        outcome: "applied",
        detail: null,
        rung: "retry",
        hostLabel: null,
      }),
    ).toBeNull();
  });

  it("says the chat moved on, with the next step and no buttons, for attempt_not_latest", () => {
    expect(
      describeManualRungRefusal({
        outcome: "attempt_not_latest",
        detail: null,
        rung: "retry",
        hostLabel: null,
      }),
    ).toEqual({
      text: "This chat has moved on since that message. Send a new message to continue.",
      remaining: "none",
    });
  });

  it.each(RUNGS)(
    "says the neutral sentence for $rung when the host gave no detail, with every button left",
    ({ rung, neutral }) => {
      expect(
        describeManualRungRefusal({
          outcome: "rung_unavailable",
          detail: null,
          rung,
          hostLabel: null,
        }),
      ).toEqual({ text: neutral, remaining: "all" });
    },
  );

  it.each(RUNGS)(
    "says the neutral sentence for $rung through a blank host label",
    ({ rung, neutral }) => {
      expect(
        describeManualRungRefusal({
          outcome: "rung_unavailable",
          detail: { kind: "unknown", label: " ", retryable: false },
          rung,
          hostLabel: HOST_LABEL,
        }),
      ).toEqual({ text: neutral, remaining: "all" });
    },
  );

  it("keeps only the switch when the destination stopped validating and the host said nothing more", () => {
    expect(
      describeManualRungRefusal({
        outcome: "rung_target_unavailable",
        detail: null,
        rung: "switch",
        hostLabel: null,
      }),
    ).toEqual({
      text: "That destination isn't available right now.",
      remaining: "switch",
    });
  });

  it("hides the row and stays silent for routing_active, because the routing card is the explanation", () => {
    expect(
      describeManualRungRefusal({
        outcome: "rung_unavailable",
        detail: { kind: "routing_active", label: "x", retryable: false },
        rung: "retry",
        hostLabel: null,
      }),
    ).toEqual({ text: null, remaining: "none" });
  });

  it("goes through the detail table when the host explained the refusal", () => {
    expect(
      describeManualRungRefusal({
        outcome: "rung_unavailable",
        detail: { kind: "reset_passed", label: "x", retryable: false },
        rung: "wait_once",
        hostLabel: null,
      }),
    ).toEqual({
      text: "That limit has reset. Retry instead.",
      remaining: "retry_and_switch",
    });
  });

  it("answers every non-applied outcome with a sentence", () => {
    for (const outcome of FALLBACK_ACTION_OUTCOMES) {
      if (outcome === "applied") continue;
      const note = describeManualRungRefusal({
        outcome,
        detail: null,
        rung: "retry",
        hostLabel: null,
      });
      expect(note).not.toBeNull();
      expect(note?.text ?? "").not.toBe("");
    }
  });
});

/** Every refusal sentence the failed-turn card can write. */
function everyRefusalString(): ReadonlyArray<string> {
  const strings: string[] = [];
  const collect = (value: string | null): void => {
    if (value !== null) strings.push(value);
  };
  for (const hostLabel of [null, HOST_LABEL]) {
    for (const kind of FALLBACK_RUNG_REFUSAL_KINDS) {
      for (const retryable of [true, false]) {
        collect(
          describeRefusalDetail({ kind, label: "", retryable }, hostLabel).text,
        );
      }
    }
    for (const outcome of FALLBACK_ACTION_OUTCOMES) {
      for (const rung of ["retry", "wait_once", "switch"] as const) {
        collect(
          describeManualRungRefusal({
            outcome,
            detail: null,
            rung,
            hostLabel,
          })?.text ?? null,
        );
        collect(
          describeManualRungRefusal({
            outcome,
            detail: { kind: "unknown", label: "", retryable: false },
            rung,
            hostLabel,
          })?.text ?? null,
        );
      }
    }
  }
  return strings;
}

/**
 * Everything a routing surface can say, gathered from the module: every string
 * export, and every function's output over its inputs. The sweep below runs
 * over this whole set, so a new label is checked without anyone remembering to
 * add it.
 */
function everyUserFacingString(): ReadonlyArray<string> {
  const strings: string[] = [];
  for (const value of Object.values(copy)) {
    if (typeof value === "string") strings.push(value);
  }
  const collect = (value: string | null): void => {
    if (value !== null) strings.push(value);
  };
  for (const outcome of FALLBACK_ACTION_OUTCOMES) {
    collect(describeFallbackOutcome(outcome));
  }
  for (const outcome of [
    "listed",
    "no_active_traversal",
    "traversal_advanced",
    "attempt_not_latest",
    "state_unreadable",
  ] as const) {
    collect(describeListTargetsOutcome(outcome));
  }
  for (const disposition of [
    "eligible",
    "checking",
    "no_verified_reset",
    "beyond_cap",
    "attempt_unavailable",
  ] as const) {
    collect(describeWaitDisposition(disposition, null));
    collect(describeWaitDisposition(disposition, "3:00 PM"));
  }
  for (const disposition of [
    "eligible",
    "unknown",
    "no_destination",
  ] as const) {
    collect(describeSwitchDisposition(disposition, "Claude Code · default"));
  }
  for (const count of [0, 1, 3]) {
    collect(queuedMessagesMovingText(count));
    collect(queuedMessagesReturningText(count));
    collect(queuedMovingClause(count));
    collect(queuedWaitingClause(count));
    collect(queuedReturningClause(count));
    collect(siblingSwitchingClause(count));
    strings.push(switchConsequencesText(count));
    const consequence = switchDestinationConsequence("Fable · high", count);
    strings.push(consequence.lead, consequence.destination, consequence.trail);
  }
  strings.push(switchConsequencesText(null));
  strings.push(...everyRefusalString());
  return strings;
}

describe("user-facing vocabulary", () => {
  it("gathers a meaningful set of strings, so the sweep cannot pass over nothing", () => {
    expect(everyUserFacingString().length).toBeGreaterThan(80);
  });

  it("never says fallback, tier, ladder, rung, grace or inherit", () => {
    for (const text of everyUserFacingString()) {
      expect(text).not.toMatch(
        /\b(fallback|tier|ladder|rung|grace|inherit)\b/i,
      );
    }
  });

  it("never prints a raw reason or kind code", () => {
    // snake_case is how every code on the wire is spelled.
    for (const text of everyUserFacingString()) {
      expect(text).not.toMatch(/\b[a-z]+(?:_[a-z]+)+\b/);
    }
  });

  it("carries no text-link action words the retired links used", () => {
    for (const text of everyUserFacingString()) {
      expect(text).not.toMatch(
        /Choose differently|Switch instead|keeps the error/i,
      );
    }
  });
});
