import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import {
  AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL,
  type AutoModeRuleDraftWorkspace,
} from "@/lib/auto-mode/auto-mode-rule-copy";
import type { TabHostSettingsOpts } from "@/stores/tabs/system-overlay-types";

afterEach(() => {
  cleanup();
});

// Parsed through the protocol schema (not a hand-typed object literal) so a
// future required field on `chatApprovalStateSchema` fails this fixture loudly
// instead of silently reading `undefined` in the component under test.
function approval(overrides: Partial<ChatApprovalState>): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "approval-1",
    toolName: "bash",
    description: "Run a shell command",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
    reason: null,
    reviewing: null,
    ...overrides,
  });
}

const UNKNOWN_WORKSPACE: AutoModeRuleDraftWorkspace = {
  remote: null,
  branch: null,
};

describe("<ComposerSlotApprovalQueue />", () => {
  it("shows a checking judge row with no Approve/Deny buttons", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "checking" })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    // The single row's own stage line is absorbed into the card's header
    // when it is the only judged row - see the header-copy tests below.
    expect(screen.getByText("Auto mode is checking")).toBeTruthy();
    const row = screen.getByTestId("approval-row");
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("shows a reviewing judge row with no Approve/Deny buttons", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "reviewing" })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Auto mode is reading the conversation"),
    ).toBeTruthy();
    const row = screen.getByTestId("approval-row");
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("renders Approve/Deny for a non-reviewing row and calls onDecision", () => {
    const onDecision = vi.fn();
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: null })]}
        canAct
        onDecision={onDecision}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    within(row).getByRole("button", { name: "Approve" }).click();
    within(row).getByRole("button", { name: "Deny" }).click();

    expect(onDecision).toHaveBeenNthCalledWith(1, "approval-1", true);
    expect(onDecision).toHaveBeenNthCalledWith(2, "approval-1", false);
  });

  it("renders the judge reason's rule (in sentence case) and text on a reviewing row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reviewing: "reviewing",
            reason: {
              rule: "Force Push",
              text: "This rewrites remote history.",
              tier: null,
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(within(row).getByText("Force push")).toBeTruthy();
    expect(within(row).getByText("This rewrites remote history.")).toBeTruthy();
  });

  it("renders the judge reason's rule and text on an actionable (non-reviewing) row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reviewing: null,
            reason: {
              rule: "Force push",
              text: "This rewrites remote history.",
              tier: null,
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(within(row).getByText("Force push")).toBeTruthy();
    expect(within(row).getByText("This rewrites remote history.")).toBeTruthy();
    // Still actionable: buttons remain even though a reason is shown.
    expect(within(row).getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("counts only actionable rows in the header and 'Approve all' skips the reviewing row", () => {
    const onDecision = vi.fn();
    const reviewing = approval({
      approvalId: "reviewing-1",
      reviewing: "checking",
    });
    const actionableA = approval({
      approvalId: "actionable-a",
      reviewing: null,
    });
    const actionableB = approval({
      approvalId: "actionable-b",
      reviewing: null,
    });

    render(
      <ComposerSlotApprovalQueue
        approvals={[reviewing, actionableA, actionableB]}
        canAct
        onDecision={onDecision}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("2 pending")).toBeTruthy();

    screen.getByRole("button", { name: /Approve all/ }).click();

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenCalledWith("actionable-a", true);
    expect(onDecision).toHaveBeenCalledWith("actionable-b", true);
    expect(onDecision).not.toHaveBeenCalledWith("reviewing-1", true);
  });

  it("heads the quiet card with the muted shield and the first judged row's stage, while every row is still with the judge", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "reviewing-2", reviewing: "reviewing" }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    // Nothing is needed from the user yet, so the card must not say it is.
    expect(screen.getByTestId("approval-reviewing-shield")).toBeTruthy();
    expect(
      screen
        .getAllByTestId("approval-reviewing")[0]
        ?.getAttribute("data-placement"),
    ).toBe("header");
    expect(screen.getByText("Auto mode is checking")).toBeTruthy();
    expect(screen.queryByText("Approval needed")).toBeNull();
    // The card is "quiet" chrome, not the alert border.
    expect(
      screen.getByTestId("approval-prompt").getAttribute("data-chrome"),
    ).toBe("quiet");
  });

  it("heads the card 'Approval needed' as soon as one row is answerable", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "actionable-a", reviewing: null }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.queryByTestId("approval-reviewing-shield")).toBeNull();
    expect(
      screen.getByTestId("approval-prompt").getAttribute("data-chrome"),
    ).toBe("alert");
  });

  it("hides the bulk actions when fewer than two rows are actionable", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "actionable-a", reviewing: null }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.queryByText(/pending$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deny all/ })).toBeNull();
  });
});

describe("ComposerSlotApprovalQueue navigation highlight", () => {
  it("flashes only the matching pending approval row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "approval-a" }),
          approval({ approvalId: "approval-b" }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId="approval-b"
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(
      screen
        .getByTestId("approval-prompt")
        .querySelector('[data-approval-id="approval-a"]')
        ?.getAttribute("data-navigation-highlighted"),
    ).toBeNull();
    expect(
      screen
        .getByTestId("approval-prompt")
        .querySelector('[data-approval-id="approval-b"]')
        ?.getAttribute("data-navigation-highlighted"),
    ).toBe("true");
  });

  it("stamps a new highlight generation on a repeated flash of the same row", () => {
    const { rerender } = render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ approvalId: "approval-a" })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId="approval-a"
        highlightedGeneration={1}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(
      screen
        .getByTestId("approval-prompt")
        .querySelector('[data-approval-id="approval-a"]')
        ?.getAttribute("data-navigation-highlight-generation"),
    ).toBe("1");
    rerender(
      <ComposerSlotApprovalQueue
        approvals={[approval({ approvalId: "approval-a" })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId="approval-a"
        highlightedGeneration={2}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(
      screen
        .getByTestId("approval-prompt")
        .querySelector('[data-approval-id="approval-a"]')
        ?.getAttribute("data-navigation-highlight-generation"),
    ).toBe("2");
  });
});

describe("<ComposerSlotApprovalQueue /> approval text", () => {
  function renderOne(overrides: Partial<ChatApprovalState>) {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval(overrides)]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
      />,
    );
    return screen.getByTestId("approval-row");
  }

  it("shows a command once when the description is the command", () => {
    const row = renderOne({
      toolName: "run_command",
      input: { command: "echo parity-check" },
      description: "echo parity-check",
    });
    expect(within(row).getAllByText("echo parity-check")).toHaveLength(1);
  });

  it("shows no headline when the description is the tool name", () => {
    const row = renderOne({
      toolName: "run_command",
      input: { command: "echo hi" },
      description: "run_command",
    });
    expect(within(row).getAllByText("run_command")).toHaveLength(1);
    expect(within(row).getAllByText("echo hi")).toHaveLength(1);
  });

  it("shows a distinct description as well as the summary", () => {
    const row = renderOne({
      toolName: "Bash",
      input: { command: "git status" },
      description: "Show working tree status",
    });
    expect(within(row).getByText("git status")).toBeTruthy();
    expect(within(row).getByText("Show working tree status")).toBeTruthy();
  });

  it("shows a command over 80 characters once and in full, with no truncated copy", () => {
    const command = `echo ${"a".repeat(100)}; rm -rf /tmp/victim`;
    const row = renderOne({
      toolName: "run_command",
      input: { command },
      description: command,
    });
    expect(within(row).getAllByText(command)).toHaveLength(1);
    expect(row.textContent).not.toContain("…");
  });

  it("keeps the cut summary when the description only shares the command's prefix", () => {
    const shared = `echo ${"a".repeat(90)}`;
    const row = renderOne({
      toolName: "run_command",
      input: { command: `${shared}; rm -rf ~` },
      description: `${shared} # tidy`,
    });
    expect(within(row).getAllByText(`${shared} # tidy`)).toHaveLength(1);
    expect(row.textContent).toContain("…");
  });
});

describe("<ComposerSlotApprovalQueue /> tier line", () => {
  const TIER_LINES: ReadonlyArray<
    readonly [NonNullable<ChatApprovalState["reason"]>["tier"], string | null]
  > = [
    ["soft", "Sent to you because you didn't ask for this exact action."],
    ["hard", "Always sent to you."],
    ["policy", "Sent to you by one of your rules."],
    ["unsure", "The judge wasn't sure."],
    [null, null],
  ];

  it.each(TIER_LINES)("renders the tier line for tier=%s", (tier, expected) => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            // An input that names the action: the fixture's bare `bash` tool
            // name does not, so a soft row without it offers no draft link.
            input: { command: "git push --force" },
            reason: {
              rule: "Force push",
              text: "This rewrites history.",
              tier,
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    const line = screen.queryByTestId("approval-judge-tier-line");
    if (expected === null) {
      expect(line).toBeNull();
    } else {
      expect(line?.textContent).toBe(
        tier === "soft"
          ? `${expected} ${AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL}`
          : expected,
      );
    }
  });

  it("shows the 'Allow from now on…' link only for the soft tier", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "This rewrites history.",
              tier: "hard",
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("approval-allow-from-now-on")).toBeNull();
  });

  it("opens a drafted 'allow' rule with the full narrowing template on click", () => {
    const onOpenSettings = vi.fn<(opts: TabHostSettingsOpts) => void>();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "bash",
            input: { command: "git push --force" },
            reason: {
              rule: "Force Push",
              text: "This rewrites remote history.",
              tier: "soft",
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={{
          remote: "traycerai/traycer",
          branch: "feature/x",
        }}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByTestId("approval-allow-from-now-on"));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "permissions",
      tab: "rules",
      resetToGeneral: false,
      draft: {
        section: "allow",
        text: "In traycerai/traycer: Force push for `git push --force` on branch feature/x",
      },
    });
  });

  it("drafts the minimal template when neither remote nor branch is known", () => {
    const onOpenSettings = vi.fn<(opts: TabHostSettingsOpts) => void>();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "bash",
            input: { command: "git push --force" },
            reason: {
              rule: "Force Push",
              text: "This rewrites remote history.",
              tier: "soft",
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByTestId("approval-allow-from-now-on"));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "permissions",
      tab: "rules",
      resetToGeneral: false,
      draft: { section: "allow", text: "Force push for `git push --force`" },
    });
  });
});
