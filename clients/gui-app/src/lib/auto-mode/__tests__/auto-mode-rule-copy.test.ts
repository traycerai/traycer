import { describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
} from "@traycer/protocol/host/worktree-schemas";
import {
  AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL,
  autoJudgeTierLine,
  autoModeRuleDisplayName,
  autoModeRuleDraftAction,
  autoModeRuleDraftText,
  autoModeRuleDraftWorkspace,
  type AutoModeRuleDraftWorkspace,
} from "@/lib/auto-mode/auto-mode-rule-copy";

describe("autoModeRuleDisplayName", () => {
  it("lowercases title-cased words after the first, keeping the first letter raised", () => {
    expect(autoModeRuleDisplayName("Force Push")).toBe("Force push");
  });

  it("lowercases every title-cased word but the first across a longer name", () => {
    expect(autoModeRuleDisplayName("Disabling A Security Control")).toBe(
      "Disabling a security control",
    );
  });

  it("keeps an acronym or mixed-case word as-is", () => {
    expect(autoModeRuleDisplayName("Calling The API")).toBe("Calling the API");
    expect(autoModeRuleDisplayName("Pushing To GitHub")).toBe(
      "Pushing to GitHub",
    );
  });

  it("raises the first letter of a name that arrived lower-case", () => {
    expect(autoModeRuleDisplayName("force push")).toBe("Force push");
  });

  it("keeps a hyphen and lowers both halves after the first word", () => {
    expect(autoModeRuleDisplayName("Read-Only Inspection")).toBe(
      "Read-only inspection",
    );
  });

  it("returns an empty string unchanged", () => {
    expect(autoModeRuleDisplayName("")).toBe("");
  });
});

describe("autoJudgeTierLine", () => {
  it("returns the soft-tier sentence", () => {
    expect(autoJudgeTierLine("soft")).toBe(
      "Sent to you because you didn't ask for this exact action.",
    );
  });

  it("returns the hard-tier sentence", () => {
    expect(autoJudgeTierLine("hard")).toBe("Always sent to you.");
  });

  it("returns the policy-tier sentence", () => {
    expect(autoJudgeTierLine("policy")).toBe(
      "Sent to you by one of your rules.",
    );
  });

  it("returns the unsure-tier sentence", () => {
    expect(autoJudgeTierLine("unsure")).toBe("The judge wasn't sure.");
  });

  it("returns null for a null tier", () => {
    expect(autoJudgeTierLine(null)).toBeNull();
  });
});

describe("AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL", () => {
  it("is the exact link label", () => {
    expect(AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL).toBe("Allow from now on…");
  });
});

function bindingEntry(
  overrides: Partial<WorktreeBindingEntry>,
): WorktreeBindingEntry {
  return {
    workspacePath: "/workspace",
    mode: "worktree",
    repoIdentifier: null,
    worktreePath: null,
    branch: null,
    isPrimary: false,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ...overrides,
  };
}

function binding(
  entries: ReadonlyArray<Partial<WorktreeBindingEntry>>,
): WorktreeBinding {
  return { entries: entries.map(bindingEntry) };
}

describe("autoModeRuleDraftWorkspace", () => {
  it("returns both null when the binding is null", () => {
    expect(autoModeRuleDraftWorkspace(null)).toEqual({
      remote: null,
      branch: null,
    });
  });

  it("reads the remote and branch off the primary entry", () => {
    const result = autoModeRuleDraftWorkspace(
      binding([
        {
          isPrimary: false,
          repoIdentifier: { owner: "wrong", repo: "entry" },
          branch: "wrong-branch",
        },
        {
          isPrimary: true,
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          branch: "feature/x",
        },
      ]),
    );
    expect(result).toEqual({
      remote: "traycerai/traycer",
      branch: "feature/x",
    });
  });

  it("falls back to the first entry when none is marked primary", () => {
    const result = autoModeRuleDraftWorkspace(
      binding([
        {
          isPrimary: false,
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          branch: "main",
        },
      ]),
    );
    expect(result).toEqual({ remote: "traycerai/traycer", branch: "main" });
  });

  it("leaves the branch null for a folder used in place (no branch on its binding)", () => {
    const result = autoModeRuleDraftWorkspace(
      binding([
        {
          isPrimary: true,
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          branch: null,
        },
      ]),
    );
    expect(result).toEqual({ remote: "traycerai/traycer", branch: null });
  });

  it("returns both null when the binding has no entries", () => {
    expect(autoModeRuleDraftWorkspace(binding([]))).toEqual({
      remote: null,
      branch: null,
    });
  });
});

describe("autoModeRuleDraftText", () => {
  const FULL_WORKSPACE: AutoModeRuleDraftWorkspace = {
    remote: "traycerai/traycer",
    branch: "feature/x",
  };
  const UNKNOWN_WORKSPACE: AutoModeRuleDraftWorkspace = {
    remote: null,
    branch: null,
  };

  it("builds the full narrowing template with remote, branch and action", () => {
    expect(
      autoModeRuleDraftText({
        workspace: FULL_WORKSPACE,
        ruleName: "Force push",
        action: "git push --force",
      }),
    ).toBe(
      "In traycerai/traycer: Force push for `git push --force` on branch feature/x",
    );
  });

  it("drops the remote/branch clauses entirely when the workspace is unknown - minimum is 'rule for action'", () => {
    expect(
      autoModeRuleDraftText({
        workspace: UNKNOWN_WORKSPACE,
        ruleName: "Force push",
        action: "git push --force",
      }),
    ).toBe("Force push for `git push --force`");
  });

  // Replaces the old "bare rule name" case: `action` is now REQUIRED and
  // non-empty (callers derive it with `autoModeRuleDraftAction` first), so a
  // draft with no for-clause at all no longer exists - even when the action
  // came from the tool name rather than an input summary.
  it("always includes a for-clause, now that action is mandatory - there is no bare rule name draft", () => {
    expect(
      autoModeRuleDraftText({
        workspace: UNKNOWN_WORKSPACE,
        ruleName: "Force push",
        action: "Run the migration",
      }),
    ).toBe("Force push for `Run the migration`");
  });

  it("includes the remote clause alone when only the remote is known", () => {
    expect(
      autoModeRuleDraftText({
        workspace: { remote: "traycerai/traycer", branch: null },
        ruleName: "Force push",
        action: "git push --force",
      }),
    ).toBe("In traycerai/traycer: Force push for `git push --force`");
  });

  it("includes the branch clause alone when only the branch is known", () => {
    expect(
      autoModeRuleDraftText({
        workspace: { remote: null, branch: "feature/x" },
        ruleName: "Force push",
        action: "git push --force",
      }),
    ).toBe("Force push for `git push --force` on branch feature/x");
  });

  it("uses a longer backtick fence when the action itself contains backticks", () => {
    const text = autoModeRuleDraftText({
      workspace: UNKNOWN_WORKSPACE,
      ruleName: "Run a script",
      action: "echo `date`",
    });
    expect(text).toBe("Run a script for `` echo `date` ``");
  });
});

/**
 * Finding: when the approval has no input summary, the "Allow from now on…"
 * draft must still name an action. The action is `inputSummary ?? toolName`;
 * only when BOTH are missing (null or whitespace-only) does no action exist.
 */
describe("autoModeRuleDraftAction", () => {
  it("returns the input summary, with whitespace collapsed, when one is present", () => {
    expect(
      autoModeRuleDraftAction({
        inputSummary: "git   push\n--force",
        toolName: "bash",
      }),
    ).toBe("git push --force");
  });

  it("falls back to the tool name, trimmed, when there is no input summary", () => {
    expect(
      autoModeRuleDraftAction({
        inputSummary: null,
        toolName: "  Run the migration  ",
      }),
    ).toBe("Run the migration");
  });

  it("falls back to the tool name when the input summary is whitespace-only", () => {
    expect(
      autoModeRuleDraftAction({
        inputSummary: "   ",
        toolName: "Run the migration",
      }),
    ).toBe("Run the migration");
  });

  it("returns null when both the input summary and the tool name are missing", () => {
    expect(
      autoModeRuleDraftAction({
        inputSummary: null,
        toolName: "  ",
      }),
    ).toBeNull();
  });
});
