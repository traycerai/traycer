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
  JUDGE_FIX_IN_SETTINGS_LABEL,
  JUDGE_NO_VERDICT_HUMAN_LINE,
  JUDGE_OUT_OF_TIME_HUMAN_LINE,
} from "@/components/chat/segments/approval-card-disclosure";
import type { AutoModeRuleDraftWorkspace } from "@/lib/auto-mode/auto-mode-rule-copy";

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

describe("<ComposerSlotApprovalQueue /> judge-unavailable human line", () => {
  it("renders the machine string verbatim, the couldn't-run sentence with its cause, and the settings link", () => {
    const onOpenSettings = vi.fn();
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "auto: judge unavailable (traycer: not signed in)",
              tier: null,
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

    const row = screen.getByTestId("approval-row");
    expect(
      within(row).getByText("auto: judge unavailable (traycer: not signed in)"),
    ).toBeTruthy();
    expect(
      within(row).getByTestId("approval-judge-unavailable-line").textContent,
    ).toBe(
      `The judge couldn't run: traycer: not signed in. ${JUDGE_FIX_IN_SETTINGS_LABEL}.`,
    );

    fireEvent.click(within(row).getByTestId("approval-fix-in-judge-settings"));
    expect(onOpenSettings).toHaveBeenCalledWith({
      section: "permissions",
      tab: "judge",
      draft: null,
      resetToGeneral: false,
    });
  });

  it("renders the bare couldn't-run sentence plus the settings link for a cause-less did-not-run reason", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "auto: no judge configured",
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
    expect(
      within(row).getByTestId("approval-judge-unavailable-line").textContent,
    ).toBe(`The judge couldn't run. ${JUDGE_FIX_IN_SETTINGS_LABEL}.`);
  });

  it("renders no unavailable line for the judge's ordinary reasoning prose", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
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
    expect(
      within(row).queryByTestId("approval-judge-unavailable-line"),
    ).toBeNull();
  });

  it("renders the no-verdict human line, with no settings link, for a 'ran without deciding' reason", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "auto: judge returned no verdict",
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
    expect(
      within(row).getByText("auto: judge returned no verdict"),
    ).toBeTruthy();
    expect(
      within(row).getByTestId("approval-judge-unavailable-line").textContent,
    ).toBe(JUDGE_NO_VERDICT_HUMAN_LINE);
    expect(
      within(row).queryByTestId("approval-fix-in-judge-settings"),
    ).toBeNull();
  });

  it("renders the out-of-time human line, with no settings link, for a 'ran out of time' reason", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "auto: judge timed out",
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
    expect(within(row).getByText("auto: judge timed out")).toBeTruthy();
    expect(
      within(row).getByTestId("approval-judge-unavailable-line").textContent,
    ).toBe(JUDGE_OUT_OF_TIME_HUMAN_LINE);
    expect(
      within(row).queryByTestId("approval-fix-in-judge-settings"),
    ).toBeNull();
  });

  it("keeps the machine string verbatim and names only the first balanced group when the host appends a stage-one explanation", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "auto: judge unavailable (the judge provider is not signed in) (This rewrites remote history.)",
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
    expect(
      within(row).getByText(
        "auto: judge unavailable (the judge provider is not signed in) (This rewrites remote history.)",
      ),
    ).toBeTruthy();
    expect(
      within(row).getByTestId("approval-judge-unavailable-line").textContent,
    ).toBe(
      `The judge couldn't run: the judge provider is not signed in. ${JUDGE_FIX_IN_SETTINGS_LABEL}.`,
    );
  });
});
