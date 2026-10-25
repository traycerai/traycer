import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EnvironmentItemStatus } from "@traycer/protocol/host/environment-schemas";
import {
  APPROVE,
  DISCARD,
  KEEP_AS_SECRET,
  KEEP_AS_VARIABLE,
  LEAVE_ON_THIS_COMPUTER_ONLY,
  RETROSPECTIVE_GOT_IT,
  type HeldApplyChoice,
} from "@/components/settings/move/retrospective-copy";
import { sharedInUseFromItems } from "@/components/settings/move/review-inventory";
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
  kind: "command",
  detail:
    "(MCP server) runs notify.sh --loud. Once approved, it runs on every computer and sandbox running Personal.",
};

const STILL_LOCAL: readonly StillLocalRow[] = [
  { id: "records", summary: "settings are not in Personal yet" },
];

interface SheetOverrides {
  readonly open: boolean;
  readonly inventoryReady: boolean;
  readonly shownAt: number | null;
  readonly onShown: () => void;
  readonly onAcknowledged: () => void;
  readonly onHeldApply: (heldId: string, choice: HeldApplyChoice) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMoveToPersonal: () => void;
  readonly onStopSharing: (() => void) | null;
  readonly evidenceVersion: string | null;
  readonly evidenceAt: number | null;
  readonly heldPendingId: string | null;
}

function sheetElement(overrides: SheetOverrides): ReactNode {
  return (
    <RetrospectiveSheet
      open={overrides.open}
      inventoryReady={overrides.inventoryReady}
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
      heldIssue={null}
      onOpenChange={overrides.onOpenChange}
      onShown={overrides.onShown}
      onAcknowledged={overrides.onAcknowledged}
      onHeldApply={overrides.onHeldApply}
      onMoveToPersonal={overrides.onMoveToPersonal}
      onStopSharing={overrides.onStopSharing}
    />
  );
}

function renderSheet(overrides: SheetOverrides): void {
  render(sheetElement(overrides));
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
    inventoryReady: true,
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
      "You never approved this upload.",
    );
    fireEvent.click(screen.getByTestId("retrospective-got-it"));
    expect(handlers.onAcknowledged).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("button", { name: RETROSPECTIVE_GOT_IT }),
    ).toBeTruthy();
  });

  it("labels the shared files and the held rows", () => {
    openSheet();
    expect(screen.getByText("Shared files")).toBeTruthy();
    expect(
      screen.getByText(
        "The skills folder (6 skills) and the agent selection guide",
      ),
    ).toBeTruthy();
    expect(screen.getByText("On hold until you choose")).toBeTruthy();
    expect(
      within(screen.getByTestId("retrospective-held-commands")).getByText(
        "Commands on hold",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("retrospective-held-values")).queryByText(
        /notify\.sh/,
      ),
    ).toBeNull();
    expect(
      screen.getByTestId("retrospective-held-held-hook").textContent,
    ).toContain(
      "(MCP server) runs notify.sh --loud. Once approved, it runs on every computer and sandbox running Personal.",
    );
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

  it("records shown only once the inventory it shows has loaded", () => {
    const onShown = vi.fn();
    const overrides: SheetOverrides = {
      open: true,
      inventoryReady: false,
      shownAt: null,
      onShown,
      onAcknowledged: vi.fn(),
      onHeldApply: vi.fn(),
      onOpenChange: vi.fn(),
      onMoveToPersonal: vi.fn(),
      onStopSharing: vi.fn(),
      evidenceVersion: null,
      evidenceAt: null,
      heldPendingId: null,
    };
    const { rerender } = render(sheetElement(overrides));
    expect(onShown).not.toHaveBeenCalled();

    rerender(sheetElement({ ...overrides, inventoryReady: true }));
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it("does not render while closed, so it is shown once", () => {
    const onShown = vi.fn();
    renderSheet({
      open: false,
      inventoryReady: true,
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

  it.each([
    [
      "1.5.2",
      OCT_14,
      "Traycer 1.5.2 shared this computer's settings into Personal on 14 Oct without asking.",
    ],
    [
      null,
      OCT_14,
      "An earlier version of Traycer shared this computer's settings into Personal on 14 Oct without asking.",
    ],
    [
      "1.5.2",
      null,
      "Traycer 1.5.2 shared this computer's settings into Personal without asking; the date wasn't recorded.",
    ],
    [
      null,
      null,
      "An earlier version of Traycer shared this computer's settings into Personal without asking; the date wasn't recorded.",
    ],
  ])(
    "names the upload from its evidence (version %s, at %s) without ever saying unknown",
    (evidenceVersion, evidenceAt, line) => {
      renderSheet({
        open: true,
        inventoryReady: true,
        shownAt: null,
        onShown: vi.fn(),
        onAcknowledged: vi.fn(),
        onHeldApply: vi.fn(),
        onOpenChange: vi.fn(),
        onMoveToPersonal: vi.fn(),
        onStopSharing: vi.fn(),
        evidenceVersion,
        evidenceAt,
        heldPendingId: null,
      });
      const sheet = screen.getByTestId("retrospective-sheet");
      expect(within(sheet).getByText(line)).toBeTruthy();
      expect(sheet.textContent).not.toMatch(/unknown/i);
    },
  );

  it("hides Stop using Personal when none is offered, and keeps Got it", () => {
    renderSheet({
      open: true,
      inventoryReady: true,
      shownAt: null,
      onShown: vi.fn(),
      onAcknowledged: vi.fn(),
      onHeldApply: vi.fn(),
      onOpenChange: vi.fn(),
      onMoveToPersonal: vi.fn(),
      onStopSharing: null,
      evidenceVersion: "1.5.2",
      evidenceAt: OCT_14,
      heldPendingId: null,
    });
    expect(screen.queryByTestId("retrospective-stop-sharing")).toBeNull();
    expect(screen.getByTestId("retrospective-got-it")).toBeTruthy();
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

  it("opens the page that owns a shared item, and offers Stop using Personal", () => {
    const { onStopSharing } = openSheet();
    fireEvent.click(screen.getByTestId("retrospective-link-keys"));
    expect(navigateMock).toHaveBeenCalledWith("providers");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop using Personal on this computer",
      }),
    );
    expect(onStopSharing).toHaveBeenCalledTimes(1);
  });

  it("shows an applied notification password as an ordinary secret", () => {
    const smtpPassword: EnvironmentItemStatus = {
      kind: "secret",
      key: "NOTIFICATION_SMTP_PASSWORD",
      os: "macos",
      desiredRevision: 1,
      status: "applied",
      code: "ok",
      args: { exitStatus: null, stage: null, durationMs: null, kind: null },
      brokerEnforced: null,
      minimumHostVersion: null,
      appliedAs: null,
    };
    render(
      <RetrospectiveSheet
        open
        inventoryReady
        hostName="MacBook Pro"
        evidence={{ version: "1.5.2", at: OCT_14 }}
        sharedInUse={sharedInUseFromItems([smtpPassword])}
        roomShared={null}
        appliedOn={["MacBook Pro"]}
        held={[]}
        stillLocal={STILL_LOCAL}
        heldPendingId={null}
        heldIssue={null}
        onOpenChange={vi.fn()}
        onShown={vi.fn()}
        onAcknowledged={vi.fn()}
        onHeldApply={vi.fn()}
        onMoveToPersonal={vi.fn()}
        onStopSharing={vi.fn()}
      />,
    );
    const link = screen.getByRole("button", { name: "1 secret" });
    fireEvent.click(link);
    expect(navigateMock).toHaveBeenCalledWith("secrets");
    expect(screen.queryByText(/mail password/)).toBeNull();
  });
});
