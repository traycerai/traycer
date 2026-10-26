import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stopRowAddress,
  stopSharingConfirmEnabled,
  type StopChoiceEntry,
  type StopManagedRow,
  type StopNeedsChoiceRow,
} from "@/components/settings/move/stop-sharing-choices";
import {
  KEEP_ON_THIS_COMPUTER,
  REMOVE_FROM_THIS_COMPUTER,
} from "@/components/settings/move/stop-sharing-copy";
import { StopSharingSheet } from "@/components/settings/move/stop-sharing-sheet";
import {
  stopManagedFromPreview,
  stopNeedsChoiceFromPreview,
} from "@/components/settings/move/stop-preview-rows";

afterEach(() => {
  cleanup();
});

const NEEDS: readonly StopNeedsChoiceRow[] = [
  {
    kind: "variable",
    key: "LOG_LEVEL",
    label: "LOG_LEVEL",
    detail: "warn",
    origin: "changed_here",
    usedBy: [],
  },
  {
    kind: "variable",
    key: "EDITOR",
    label: "EDITOR",
    detail: null,
    origin: "depended_on",
    usedBy: ["work", "home"],
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
        [editor]: "remove_from_this_computer",
      }),
    ).toBe(true);
  });

  it("is true when nothing needs a choice", () => {
    expect(stopSharingConfirmEnabled([], {})).toBe(true);
  });
});

describe("StopSharingSheet row names", () => {
  it("names page-held and env-override rows from a preview by their page or provider", () => {
    const row = (kind: string, key: string, label: string) => ({
      kind,
      key,
      os: "any" as const,
      label,
      detail: null,
    });
    const preview = {
      managed: [row("fallback_policy", "fallback", "fallback / owner")],
      needsChoice: [
        {
          row: row("browser_agent_access", "browser", "browser / agentAccess"),
          reason: "edited_here" as const,
          origin: "changed_here" as const,
          usedBy: [],
        },
        {
          row: row(
            "env_override",
            "claude-code:ANTHROPIC_BASE_URL",
            "ANTHROPIC_BASE_URL",
          ),
          reason: "edited_here" as const,
          origin: "from_this_computer" as const,
          usedBy: [],
        },
      ],
    };
    render(
      <StopSharingSheet
        open
        hostName="MacBook Pro"
        managed={stopManagedFromPreview(preview)}
        needsChoice={stopNeedsChoiceFromPreview(preview)}
        changedRows={null}
        previewStatus="ready"
        confirmPending={false}
        onOpenChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const text = document.body.textContent;
    expect(text).toContain("Model routing");
    expect(text).toContain("Browser agent access");
    expect(text).toContain("ANTHROPIC_BASE_URL (Claude Code)");
    expect(text).not.toContain("fallback / owner");
    expect(text).not.toContain("browser / agentAccess");
  });
});

describe("StopSharingSheet", () => {
  it("keeps Stop using Personal disabled until every choice is made, then sends them", () => {
    const onStop = vi.fn();
    renderSheet(onStop);
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Stop using Personal");
    expect(
      screen.getByRole("heading", {
        name: "Stop using Personal on this computer",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

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
          origin: "changed_here",
          usedBy: [],
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
          origin: "depended_on",
          usedBy: [],
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

    fireEvent.click(
      screen.getAllByRole("button", { name: KEEP_ON_THIS_COMPUTER })[0],
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: REMOVE_FROM_THIS_COMPUTER })[1],
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    expect(onStop).toHaveBeenCalledWith([
      { kind: "variable", key: "BUILD", choice: "keep_locally" },
      { kind: "skill", key: "BUILD", choice: "remove_from_this_computer" },
    ]);
  });

  it("offers only Keep on this computer and Remove from this computer on each row", () => {
    renderSheet(vi.fn());
    expect(
      screen.getAllByRole("button", { name: "Keep on this computer" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Remove from this computer" }),
    ).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(
      screen
        .getByTestId("stop-sharing-needs-choice")
        .querySelectorAll("button"),
    ).toHaveLength(4);
  });

  it.each([
    [
      "from_this_computer",
      [],
      "Came from this computer. Choose what happens to it here when you stop.",
    ],
    [
      "changed_here",
      [],
      "Changed on this computer. Choose what happens to it here when you stop.",
    ],
    [
      "depended_on",
      ["work", "home"],
      "Used by work, home. Choose what happens to it here when you stop.",
    ],
    [
      "depended_on",
      [],
      "Other settings use it. Choose what happens to it here when you stop.",
    ],
  ] as const)(
    "reads the %s row (used by %j) as: %s",
    (origin, usedBy, line) => {
      render(
        <StopSharingSheet
          open
          hostName="MacBook Pro"
          managed={[]}
          needsChoice={[
            {
              kind: "variable",
              key: "ONLY",
              label: "ONLY",
              detail: null,
              origin,
              usedBy,
            },
          ]}
          changedRows={null}
          previewStatus="ready"
          confirmPending={false}
          onOpenChange={vi.fn()}
          onStop={vi.fn()}
        />,
      );

      expect(screen.getByText(line)).toBeTruthy();
    },
  );
});

describe("StopSharingSheet groups", () => {
  const REMOVED_ROW: StopManagedRow = {
    kind: "variable",
    key: "NODE_OPTIONS",
    label: "NODE_OPTIONS",
    detail: null,
  };

  function renderGroups(
    managed: readonly StopManagedRow[],
    needsChoice: readonly StopNeedsChoiceRow[],
  ): void {
    render(
      <StopSharingSheet
        open
        hostName="MacBook Pro"
        managed={managed}
        needsChoice={needsChoice}
        changedRows={null}
        previewStatus="ready"
        confirmPending={false}
        onOpenChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );
  }

  it("shows both groups, a needs-choice row only under its heading and a removed row only under its own", () => {
    renderGroups(
      [
        REMOVED_ROW,
        ...NEEDS.map(({ kind, key, label, detail }) => ({
          kind,
          key,
          label,
          detail,
        })),
      ],
      NEEDS,
    );

    const choosing = screen.getByTestId("stop-sharing-needs-choice");
    const removed = screen.getByTestId("stop-sharing-managed");
    expect(choosing.textContent).toContain(
      "Choose what stays on this computer",
    );
    expect(removed.textContent).toContain(
      "Removed from this computer when you stop",
    );
    expect(removed.textContent).toContain(
      "These came from Personal. Stopping removes them from this computer only; they stay in Personal and come back if you move this computer to Personal again.",
    );
    expect(removed.textContent).toContain("NODE_OPTIONS");
    expect(removed.textContent).not.toContain("LOG_LEVEL");
    expect(choosing.textContent).toContain("LOG_LEVEL");
    expect(choosing.textContent).not.toContain("NODE_OPTIONS");
    expect(screen.queryByTestId("stop-sharing-managed-empty")).toBeNull();
  });

  it("shows only the removed group when no row needs a choice, with confirm enabled", () => {
    renderGroups([REMOVED_ROW], []);

    expect(screen.queryByTestId("stop-sharing-needs-choice")).toBeNull();
    expect(screen.getByTestId("stop-sharing-managed")).toBeTruthy();
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(
      false,
    );
  });

  it("shows only the choice group when every row needs one", () => {
    renderGroups(
      NEEDS.map(({ kind, key, label, detail }) => ({
        kind,
        key,
        label,
        detail,
      })),
      NEEDS,
    );

    expect(screen.getByTestId("stop-sharing-needs-choice")).toBeTruthy();
    expect(screen.queryByTestId("stop-sharing-managed")).toBeNull();
  });

  it("says nothing from Personal is on this computer when both groups are empty", () => {
    renderGroups([], []);

    expect(screen.queryByTestId("stop-sharing-needs-choice")).toBeNull();
    expect(screen.queryByTestId("stop-sharing-managed")).toBeNull();
    expect(screen.getByTestId("stop-sharing-managed-empty").textContent).toBe(
      "Nothing from Personal is on this computer.",
    );
  });
});
