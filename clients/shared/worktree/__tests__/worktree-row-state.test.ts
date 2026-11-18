import { describe, expect, it } from "vitest";
import type {
  WorktreeBindingEntryMode,
  WorktreeBindingSelectorDisabledReason,
  WorktreeSetupState,
} from "@traycer/protocol/host/index";
import {
  worktreeBindingEntryModeSchema,
  worktreeBindingSelectorDisabledReasonSchema,
  worktreeSetupStateSchema,
} from "@traycer/protocol/host/index";
import {
  hasBlockingWorktreeSelectorReason,
  isWorkspaceResolvePending,
  worktreeRowState,
  type WorktreeRowState,
  type WorktreeRowStateInput,
} from "../worktree-row-state";

/**
 * A row that is ready by every rung: no reason, setup finished, git facts
 * resolved. Every case below states only what it changes, so a case that stops
 * exercising the rung it names is visible as a case that changed nothing.
 */
function row(overrides: Partial<WorktreeRowStateInput>): WorktreeRowStateInput {
  return {
    disabledReason: null,
    isGitRepo: true,
    mode: "worktree",
    setupState: "succeeded",
    isGitResolvePending: false,
    ...overrides,
  };
}

/**
 * The full input domain, enumerated rather than sampled. `worktreeRowState`
 * reads exactly these five fields (that is what `WorktreeRowStateInput` says),
 * and `mode`/`isGitRepo`/`isGitResolvePending` are booleans-or-pairs, so the
 * product is small enough to walk whole - which is the only way to be sure the
 * ladder's rungs are ordered as documented rather than merely reachable.
 */
const DISABLED_REASONS: ReadonlyArray<WorktreeBindingSelectorDisabledReason | null> =
  [
    null,
    "setup_pending",
    "setup_running",
    "setup_failed",
    "setup_cancelled",
    "missing_worktree_path",
  ];

const SETUP_STATES: ReadonlyArray<WorktreeSetupState> = [
  "not_required",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

const MODES: ReadonlyArray<WorktreeBindingEntryMode> = ["local", "worktree"];

function everyInput(): ReadonlyArray<WorktreeRowStateInput> {
  const rows: WorktreeRowStateInput[] = [];
  for (const disabledReason of DISABLED_REASONS) {
    for (const setupState of SETUP_STATES) {
      for (const mode of MODES) {
        for (const isGitRepo of [true, false]) {
          for (const isGitResolvePending of [true, false]) {
            rows.push({
              disabledReason,
              setupState,
              mode,
              isGitRepo,
              isGitResolvePending,
            });
          }
        }
      }
    }
  }
  return rows;
}

/**
 * The lists above are hand-written, and TypeScript only catches a value that
 * was REMOVED from a protocol enum or misspelled - it says nothing about one
 * that was ADDED. Without this, a new `setupState` or disabled reason would
 * quietly shrink "the entire input domain" to a subset, and every exhaustive
 * claim below would keep passing while covering less. Pin them to the schemas.
 */
describe("the enumerated domain", () => {
  it("covers every value the protocol enums declare", () => {
    expect([...DISABLED_REASONS].sort()).toStrictEqual(
      [...worktreeBindingSelectorDisabledReasonSchema.options, null].sort(),
    );
    expect([...SETUP_STATES].sort()).toStrictEqual(
      [...worktreeSetupStateSchema.options].sort(),
    );
    expect([...MODES].sort()).toStrictEqual(
      [...worktreeBindingEntryModeSchema.options].sort(),
    );
  });

  it("is the full product of those values", () => {
    expect(everyInput().length).toBe(
      DISABLED_REASONS.length * SETUP_STATES.length * MODES.length * 2 * 2,
    );
  });
});

describe("hasBlockingWorktreeSelectorReason", () => {
  it("does not block a row with no reason", () => {
    expect(hasBlockingWorktreeSelectorReason(row({}))).toBe(false);
  });

  it("blocks a missing worktree path unconditionally", () => {
    expect(
      hasBlockingWorktreeSelectorReason(
        row({ disabledReason: "missing_worktree_path" }),
      ),
    ).toBe(true);
    // Even for a row whose other facts all look healthy.
    expect(
      hasBlockingWorktreeSelectorReason(
        row({
          disabledReason: "missing_worktree_path",
          mode: "local",
          isGitRepo: true,
        }),
      ),
    ).toBe(true);
  });

  it.each([
    "setup_pending",
    "setup_running",
    "setup_failed",
    "setup_cancelled",
  ] as const)(
    "relaxes the legacy %s reason once disk truth shows the worktree exists",
    (disabledReason) => {
      // The whole point of the relaxation: a new client must unlock promptly
      // against an old host that still projects setup as a disabled reason.
      expect(
        hasBlockingWorktreeSelectorReason(
          row({ disabledReason, mode: "worktree", isGitRepo: true }),
        ),
      ).toBe(false);
      // ...but a worktree row that is not actually a git repo stays blocked.
      expect(
        hasBlockingWorktreeSelectorReason(
          row({ disabledReason, mode: "worktree", isGitRepo: false }),
        ),
      ).toBe(true);
      // A local folder is never expected to be a worktree, so `!isGitRepo` is
      // not evidence of absence there.
      expect(
        hasBlockingWorktreeSelectorReason(
          row({ disabledReason, mode: "local", isGitRepo: false }),
        ),
      ).toBe(false);
    },
  );
});

describe("isWorkspaceResolvePending", () => {
  it("reports the host's marker rather than re-deriving it", () => {
    expect(isWorkspaceResolvePending({ isGitResolvePending: true })).toBe(true);
    expect(isWorkspaceResolvePending({ isGitResolvePending: false })).toBe(
      false,
    );
  });
});

describe("worktreeRowState", () => {
  it("is ready when nothing is wrong", () => {
    expect(worktreeRowState(row({}))).toBe("ready");
  });

  it.each(["not_required", "succeeded"] as const)(
    "treats %s as ready rather than a setup state",
    (setupState) => {
      expect(worktreeRowState(row({ setupState }))).toBe("ready");
    },
  );

  it("reports a blocked row as missing", () => {
    expect(
      worktreeRowState(row({ disabledReason: "missing_worktree_path" })),
    ).toBe("missing");
  });

  it("reports a blocked row whose git facts are unresolved as checking", () => {
    // The regression this rung exists for: the host derives
    // `missing_worktree_path` from an `isGitRepo` it has not verified, so
    // calling the row missing asserts something the next sweep may retract.
    expect(
      worktreeRowState(
        row({
          disabledReason: "missing_worktree_path",
          isGitResolvePending: true,
        }),
      ),
    ).toBe("checking");
  });

  it("does not report an unblocked row as checking, however pending", () => {
    // `checking` is a flavour of blocked, not a state of its own - a healthy
    // row whose git facts are still resolving is usable and reads as such.
    expect(worktreeRowState(row({ isGitResolvePending: true }))).toBe("ready");
    expect(
      worktreeRowState(
        row({ setupState: "running", isGitResolvePending: true }),
      ),
    ).toBe("setting-up");
  });

  it.each([
    ["pending", "setup-pending"],
    ["running", "setting-up"],
    ["failed", "setup-failed"],
    ["cancelled", "setup-cancelled"],
  ] as const)("maps the live setupState %s to %s", (setupState, expected) => {
    expect(worktreeRowState(row({ setupState }))).toBe(expected);
  });

  it.each([
    ["setup_pending", "setup-pending"],
    ["setup_running", "setting-up"],
    ["setup_failed", "setup-failed"],
    ["setup_cancelled", "setup-cancelled"],
  ] as const)(
    "maps a legacy host's %s reason to %s",
    (disabledReason, expected) => {
      // An old host reports the lifecycle as a reason and leaves `setupState`
      // at its default; the row must still read as that setup state, and must
      // not be blocked (the worktree demonstrably exists).
      expect(
        worktreeRowState(
          row({ disabledReason, setupState: "not_required", isGitRepo: true }),
        ),
      ).toBe(expected);
    },
  );

  it("reports a failed setup that only setupState knows about", () => {
    // The exact CLI defect this consolidation locks down: the current host
    // leaves a failed-setup row selectable with `disabledReason: null` and
    // reports the failure solely in `setupState`. Keying on the reason alone
    // printed `ready` over a worktree whose setup script had failed.
    expect(
      worktreeRowState(row({ disabledReason: null, setupState: "failed" })),
    ).toBe("setup-failed");
  });

  it("prefers the earlier rung when setupState and the reason disagree", () => {
    // Precedence is the contract, so pin it where the two inputs point at
    // different rungs rather than only where they agree.
    expect(
      worktreeRowState(
        row({ disabledReason: "setup_cancelled", setupState: "running" }),
      ),
    ).toBe("setting-up");
    expect(
      worktreeRowState(
        row({ disabledReason: "setup_running", setupState: "cancelled" }),
      ),
    ).toBe("setting-up");
  });

  it("prefers blocked over any setup state", () => {
    expect(
      worktreeRowState(
        row({ disabledReason: "missing_worktree_path", setupState: "running" }),
      ),
    ).toBe("missing");
  });

  it("returns a declared state for every input the row type allows", () => {
    const declared: ReadonlySet<WorktreeRowState> = new Set([
      "checking",
      "missing",
      "setup-pending",
      "setting-up",
      "setup-failed",
      "setup-cancelled",
      "ready",
    ] satisfies WorktreeRowState[]);
    const produced = new Set<WorktreeRowState>();
    for (const input of everyInput()) {
      const state = worktreeRowState(input);
      expect(declared.has(state)).toBe(true);
      produced.add(state);
    }
    // And every declared state is genuinely reachable - a state no input can
    // produce is either dead copy in two clients or a rung wired wrong.
    expect([...produced].sort()).toStrictEqual([...declared].sort());
  });

  it("never blocks a row that carries no reason", () => {
    // The usability guarantee both clients depend on: setup progress and
    // outcomes are reported, never a reason to withhold the directory.
    const usable = everyInput().filter(
      (input) => input.disabledReason === null,
    );
    for (const input of usable) {
      expect(worktreeRowState(input)).not.toBe("missing");
      expect(worktreeRowState(input)).not.toBe("checking");
    }
  });

  it("agrees with hasBlockingWorktreeSelectorReason across the domain", () => {
    // The two are exported separately (pickers gate on the predicate, tables
    // render the state) so they must not disagree about a row.
    for (const input of everyInput()) {
      const state = worktreeRowState(input);
      const blocked = state === "checking" || state === "missing";
      expect(blocked).toBe(hasBlockingWorktreeSelectorReason(input));
    }
  });
});
