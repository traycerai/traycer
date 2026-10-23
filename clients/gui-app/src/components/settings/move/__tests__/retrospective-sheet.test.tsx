import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE,
  DISCARD,
  KEEP_AS_SECRET,
  KEEP_AS_VARIABLE,
  LEAVE_ON_THIS_COMPUTER_ONLY,
  NO_MOVE_SHEET_ACCEPTANCE,
  RETROSPECTIVE_EVIDENCE_UNKNOWN,
  RETROSPECTIVE_GOT_IT,
  RETROSPECTIVE_STOP_SHARING,
  type HeldApplyChoice,
} from "@/components/settings/move/retrospective-copy";
import {
  RetrospectiveSheet,
  type HeldRow,
  type SharedInUseItem,
  type StillLocalRow,
} from "@/components/settings/move/retrospective-sheet";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: (section: string): void => {
    navigateMock(section);
  },
}));

afterEach(() => {
  cleanup();
  navigateMock.mockReset();
});

const OCT_14 = Date.UTC(2026, 9, 14, 12, 0, 0);

const SHARED: readonly SharedInUseItem[] = [
  {
    id: "keys",
    label: "2 API keys",
    names: ["Codex", "OpenCode"],
    page: "providers",
    includesMailPassword: false,
  },
  {
    id: "mail",
    label: "notification settings",
    names: ["mail password"],
    page: "notifications",
    includesMailPassword: true,
  },
];

const HELD_VALUE: HeldRow = {
  heldId: "held-token",
  name: "LOG_TOKEN",
  kind: "value",
  detail: "looked like a key and was held.",
};

const HELD_HOOK: HeldRow = {
  heldId: "held-hook",
  name: "notify.sh",
  kind: "hook",
  detail: "runs on a notification and was held.",
};

const STILL_LOCAL: readonly StillLocalRow[] = [
  { id: "records", summary: "settings have not moved" },
];

function renderSheet(overrides: {
  readonly open: boolean;
  readonly shownAt: number | null;
  readonly onShown: () => void;
  readonly onAcknowledged: () => void;
  readonly onHeldApply: (heldId: string, choice: HeldApplyChoice) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMoveToPersonal: () => void;
  readonly onStopSharing: () => void;
  readonly evidenceVersion: string | null;
  readonly evidenceAt: number | null;
  readonly heldPendingId: string | null;
}): void {
  render(
    <RetrospectiveSheet
      open={overrides.open}
      hostName="MacBook Pro"
      evidence={{
        version: overrides.evidenceVersion,
        at: overrides.evidenceAt,
      }}
      sharedInUse={SHARED}
      roomShared="The skills folder (6 skills) and the agent selection guide"
      appliedOn={["MacBook Pro", "dev-box"]}
      held={[HELD_VALUE, HELD_HOOK]}
      stillLocal={STILL_LOCAL}
      heldPendingId={overrides.heldPendingId}
      onOpenChange={overrides.onOpenChange}
      onShown={overrides.onShown}
      onAcknowledged={overrides.onAcknowledged}
      onHeldApply={overrides.onHeldApply}
      onMoveToPersonal={overrides.onMoveToPersonal}
      onStopSharing={overrides.onStopSharing}
    />,
  );
}

function openSheet() {
  const onShown = vi.fn();
  const onAcknowledged = vi.fn();
  const onHeldApply = vi.fn();
  const onOpenChange = vi.fn();
  const onMoveToPersonal = vi.fn();
  const onStopSharing = vi.fn();
  renderSheet({
    open: true,
    shownAt: null,
    onShown,
    onAcknowledged,
    onHeldApply,
    onOpenChange,
    onMoveToPersonal,
    onStopSharing,
    evidenceVersion: "1.5.2",
    evidenceAt: OCT_14,
    heldPendingId: null,
  });
  return {
    onShown,
    onAcknowledged,
    onHeldApply,
    onOpenChange,
    onMoveToPersonal,
    onStopSharing,
  };
}

describe("RetrospectiveSheet", () => {
  it("records shown when it opens and acknowledged only on Got it", () => {
    const handlers = openSheet();
    expect(handlers.onShown).toHaveBeenCalledTimes(1);
    expect(handlers.onAcknowledged).not.toHaveBeenCalled();
    expect(screen.getByTestId("retrospective-no-consent").textContent).toBe(
      NO_MOVE_SHEET_ACCEPTANCE,
    );
    fireEvent.click(screen.getByTestId("retrospective-got-it"));
    expect(handlers.onAcknowledged).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("button", { name: RETROSPECTIVE_GOT_IT }),
    ).toBeTruthy();
  });

  it("records no acknowledgement when the sheet is closed", () => {
    const handlers = openSheet();
    fireEvent.keyDown(screen.getByTestId("retrospective-sheet"), {
      key: "Escape",
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onAcknowledged).not.toHaveBeenCalled();
    expect(handlers.onShown).toHaveBeenCalledTimes(1);
  });

  it("does not render while closed, so it is shown once", () => {
    const onShown = vi.fn();
    renderSheet({
      open: false,
      shownAt: null,
      onShown,
      onAcknowledged: vi.fn(),
      onHeldApply: vi.fn(),
      onOpenChange: vi.fn(),
      onMoveToPersonal: vi.fn(),
      onStopSharing: vi.fn(),
      evidenceVersion: "1.5.2",
      evidenceAt: OCT_14,
      heldPendingId: null,
    });
    expect(onShown).not.toHaveBeenCalled();
    expect(screen.queryByTestId("retrospective-sheet")).toBeNull();
  });

  it("names the upload from evidence, or unknown where none exists", () => {
    openSheet();
    expect(
      screen.getByText(
        "Traycer 1.5.2 uploaded these into Personal on 14 Oct without asking you.",
      ),
    ).toBeTruthy();
    cleanup();
    renderSheet({
      open: true,
      shownAt: null,
      onShown: vi.fn(),
      onAcknowledged: vi.fn(),
      onHeldApply: vi.fn(),
      onOpenChange: vi.fn(),
      onMoveToPersonal: vi.fn(),
      onStopSharing: vi.fn(),
      evidenceVersion: null,
      evidenceAt: null,
      heldPendingId: null,
    });
    expect(screen.getByText(RETROSPECTIVE_EVIDENCE_UNKNOWN)).toBeTruthy();
  });

  it("sends each held value choice through heldApply", () => {
    const { onHeldApply } = openSheet();
    const choices: readonly HeldApplyChoice[] = [
      "secret",
      "variable",
      "stays",
      "discard",
    ];
    const labels = [
      KEEP_AS_SECRET,
      KEEP_AS_VARIABLE,
      LEAVE_ON_THIS_COMPUTER_ONLY,
      DISCARD,
    ];
    const row = screen.getByTestId("retrospective-held-held-token");
    labels.forEach((label, index) => {
      fireEvent.click(within(row).getByRole("button", { name: label }));
      expect(onHeldApply).toHaveBeenNthCalledWith(
        index + 1,
        "held-token",
        choices[index],
      );
    });
  });

  it("sends Approve and Discard on a held hook", () => {
    const { onHeldApply } = openSheet();
    const row = screen.getByTestId("retrospective-held-held-hook");
    fireEvent.click(within(row).getByRole("button", { name: APPROVE }));
    fireEvent.click(within(row).getByRole("button", { name: DISCARD }));
    expect(onHeldApply.mock.calls).toEqual([
      ["held-hook", "approve"],
      ["held-hook", "discard"],
    ]);
  });

  it("opens the page that owns a shared item, and offers Stop sharing", () => {
    const { onStopSharing } = openSheet();
    fireEvent.click(screen.getByTestId("retrospective-link-keys"));
    expect(navigateMock).toHaveBeenCalledWith("providers");
    fireEvent.click(screen.getByTestId("retrospective-link-mail"));
    expect(navigateMock).toHaveBeenCalledWith("notifications");
    expect(
      screen.getByText(/including the mail password as a secret/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: RETROSPECTIVE_STOP_SHARING }),
    );
    expect(onStopSharing).toHaveBeenCalledTimes(1);
  });
});
