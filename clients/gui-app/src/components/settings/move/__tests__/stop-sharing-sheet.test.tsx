import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stopRowAddress,
  stopSharingConfirmEnabled,
  type StopChoiceEntry,
  type StopNeedsChoiceRow,
} from "@/components/settings/move/stop-sharing-choices";
import {
  KEEP_LOCALLY,
  REMOVE_FROM_THIS_COMPUTER,
  RESOLVE,
  STOP_SHARING_CONFIRM,
} from "@/components/settings/move/stop-sharing-copy";
import { StopSharingSheet } from "@/components/settings/move/stop-sharing-sheet";
import { stopNeedsChoiceFromPreview } from "@/components/settings/move/stop-preview-rows";

afterEach(() => {
  cleanup();
});

const NEEDS: readonly StopNeedsChoiceRow[] = [
  {
    kind: "variable",
    key: "LOG_LEVEL",
    label: "LOG_LEVEL",
    detail: "warn",
    reason: "edited_here",
  },
  {
    kind: "variable",
    key: "EDITOR",
    label: "EDITOR",
    detail: null,
    reason: "depended_on",
  },
];

function renderSheet(
  onStop: (choices: readonly StopChoiceEntry[]) => void,
): void {
  render(
    <StopSharingSheet
      open
      hostName="MacBook Pro"
      managed={[
        {
          kind: "variable",
          key: "NODE_OPTIONS",
          label: "NODE_OPTIONS",
          detail: "--max-old-space-size=4096",
        },
      ]}
      needsChoice={NEEDS}
      changedRows={null}
      previewStatus="ready"
      confirmPending={false}
      onOpenChange={vi.fn()}
      onStop={onStop}
    />,
  );
}

describe("stopSharingConfirmEnabled", () => {
  it("is false until every needs-choice row has a choice", () => {
    expect(stopSharingConfirmEnabled(NEEDS, {})).toBe(false);
    const [logLevel, editor] = NEEDS.map(stopRowAddress);
    expect(
      stopSharingConfirmEnabled(NEEDS, { [logLevel]: "keep_locally" }),
    ).toBe(false);
    expect(
      stopSharingConfirmEnabled(NEEDS, {
        [logLevel]: "keep_locally",
        [editor]: "resolve",
      }),
    ).toBe(true);
  });

  it("is true when nothing needs a choice", () => {
    expect(stopSharingConfirmEnabled([], {})).toBe(true);
  });
});

describe("StopSharingSheet", () => {
  it("keeps Stop sharing disabled until every choice is made, then sends them", () => {
    const onStop = vi.fn();
    renderSheet(onStop);
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain(STOP_SHARING_CONFIRM);

    fireEvent.click(
      screen.getByTestId("stop-sharing-choice-variable-LOG_LEVEL-keep_locally"),
    );
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);
    fireEvent.click(
      screen.getByTestId(
        "stop-sharing-choice-variable-EDITOR-remove_from_this_computer",
      ),
    );
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(
      false,
    );

    fireEvent.click(confirm);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith([
      { kind: "variable", key: "LOG_LEVEL", choice: "keep_locally" },
      { kind: "variable", key: "EDITOR", choice: "remove_from_this_computer" },
    ]);
  });

  it("answers two preview rows that share a key but differ in kind separately", () => {
    const onStop = vi.fn();
    const needsChoice = stopNeedsChoiceFromPreview({
      managed: [],
      needsChoice: [
        {
          row: {
            kind: "variable",
            key: "BUILD",
            os: "any",
            label: "BUILD",
            detail: null,
          },
          reason: "edited_here",
        },
        {
          row: {
            kind: "skill",
            key: "BUILD",
            os: null,
            label: "BUILD",
            detail: null,
          },
          reason: "depended_on",
        },
      ],
    });
    render(
      <StopSharingSheet
        open
        hostName="MacBook Pro"
        managed={[]}
        needsChoice={needsChoice}
        changedRows={null}
        previewStatus="ready"
        confirmPending={false}
        onOpenChange={vi.fn()}
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: KEEP_LOCALLY })[0]);
    fireEvent.click(
      screen.getAllByRole("button", { name: REMOVE_FROM_THIS_COMPUTER })[1],
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    expect(onStop).toHaveBeenCalledWith([
      { kind: "variable", key: "BUILD", choice: "keep_locally" },
      { kind: "skill", key: "BUILD", choice: "remove_from_this_computer" },
    ]);
  });

  it("offers Keep locally, Remove from this computer and Resolve on each row", () => {
    renderSheet(vi.fn());
    expect(screen.getAllByRole("button", { name: KEEP_LOCALLY })).toHaveLength(
      2,
    );
    expect(
      screen.getAllByRole("button", { name: REMOVE_FROM_THIS_COMPUTER }),
    ).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: RESOLVE })).toHaveLength(2);
  });
});
