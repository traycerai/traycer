import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import type { AutoModeRuleDraftWorkspace } from "@/lib/auto-mode/auto-mode-rule-copy";
import type { TabHostSettingsOpts } from "@/stores/tabs/system-overlay-types";

/**
 * Finding: when the approval has no input summary, the "Allow from now on…"
 * draft must still name an action - the action is `inputSummary ?? toolName`
 * (an ACP request's `toolName` is its human title). Only when BOTH are
 * missing (null or whitespace-only) is the link not offered at all.
 *
 * Copied fixtures from `composer-slot-approval-queue.test.tsx` (the
 * `approval(...)` builder, `UNKNOWN_WORKSPACE`, imports) rather than editing
 * that file directly - another agent is concurrently working there.
 */

afterEach(() => {
  cleanup();
});

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

const SOFT_FORCE_PUSH_REASON: NonNullable<ChatApprovalState["reason"]> = {
  rule: "Force Push",
  text: "This rewrites remote history.",
  tier: "soft",
};

describe("<ComposerSlotApprovalQueue /> rule draft action (inputSummary ?? toolName)", () => {
  it("drafts from the tool name when there is no input summary", () => {
    const onOpenSettings = vi.fn<(opts: TabHostSettingsOpts) => void>();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "Run the migration",
            input: null,
            reason: SOFT_FORCE_PUSH_REASON,
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
      draft: {
        section: "allow",
        text: "Force push for `Run the migration`",
      },
    });
  });

  it("includes the workspace clauses when the tool name stands in for the summary", () => {
    const onOpenSettings = vi.fn<(opts: TabHostSettingsOpts) => void>();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "Run the migration",
            input: null,
            reason: SOFT_FORCE_PUSH_REASON,
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

    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "permissions",
      tab: "rules",
      resetToGeneral: false,
      draft: {
        section: "allow",
        text: "In traycerai/traycer: Force push for `Run the migration` on branch feature/x",
      },
    });
  });

  it("offers no draft link when neither the input summary nor the tool name names an action", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "",
            input: null,
            description: "Something happened",
            reason: SOFT_FORCE_PUSH_REASON,
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
    expect(screen.getByTestId("approval-judge-tier-line").textContent).toBe(
      "Sent to you because you didn't ask for this exact action.",
    );
  });

  it("offers no draft link for a generic tool name with no input summary, and still renders the tier line", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "Bash",
            input: null,
            reason: SOFT_FORCE_PUSH_REASON,
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
    expect(screen.getByTestId("approval-judge-tier-line").textContent).toBe(
      "Sent to you because you didn't ask for this exact action.",
    );
  });

  it("still prefers the input summary over the tool name when both are present", () => {
    const onOpenSettings = vi.fn<(opts: TabHostSettingsOpts) => void>();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "bash",
            input: { command: "git push --force" },
            reason: SOFT_FORCE_PUSH_REASON,
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

    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "permissions",
      tab: "rules",
      resetToGeneral: false,
      draft: {
        section: "allow",
        text: "Force push for `git push --force`",
      },
    });
  });

  it("still drafts from the input when the card shows the whole long command as its headline instead of a cut summary", () => {
    // `approvalCardText` drops the first line's cut summary when the
    // description IS the whole command (a Codex or ACP shell approval names
    // the request by its own input), so a long command is shown once, uncut.
    // That is a DISPLAY choice: the draft still has a concrete action, the
    // summary the input derives to, and must not fall back to the generic
    // tool name and vanish.
    const command = `echo ${"a".repeat(100)}; rm -rf /tmp/victim`;
    const summary = deriveToolInputSummary("bash", { command });
    if (summary === null) throw new Error("fixture derives no summary");
    expect(summary.length).toBeLessThan(command.length);
    const onOpenSettings = vi.fn<(opts: TabHostSettingsOpts) => void>();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            toolName: "bash",
            description: command,
            input: { command },
            reason: SOFT_FORCE_PUSH_REASON,
          }),
        ]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={onOpenSettings}
      />,
    );

    // The display half of the contract: the whole command, once.
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.queryByText(summary)).toBeNull();

    fireEvent.click(screen.getByTestId("approval-allow-from-now-on"));

    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "permissions",
      tab: "rules",
      resetToGeneral: false,
      draft: {
        section: "allow",
        text: `Force push for \`${summary}\``,
      },
    });
  });
});
