import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostOverviewHeaderActions } from "@/components/settings/panels/host-overview-status-card";

/**
 * The window binding on the Overview's header cluster is offered only for a
 * row a picker would offer (`hostOptionCanActivate`). The panel passes
 * `onMakeActive: null` for the rest; the cluster then draws no Activate,
 * inline or in the phone menu, while "Active" still shows for a row the
 * window is already on.
 */

function renderActions(args: {
  readonly isActive: boolean;
  readonly onMakeActive: (() => void) | null;
  readonly activateInMenu: boolean;
}): void {
  render(
    <HostOverviewHeaderActions
      hostName="Build box"
      primaryAction={null}
      restartDegrade={null}
      doctorDegrade={null}
      restartPending={false}
      anyPending={false}
      isActive={args.isActive}
      connectable
      onResetName={null}
      resetNameDegrade={null}
      onRestart={() => undefined}
      onOpenDoctor={() => undefined}
      onMakeActive={args.onMakeActive}
      activateBusy={false}
      onCopyHostId={() => undefined}
      activateInMenu={args.activateInMenu}
    />,
  );
}

async function openMenu(): Promise<void> {
  fireEvent.pointerDown(await screen.findByTestId("host-overview-menu"), {
    button: 0,
  });
  await screen.findByTestId("host-overview-restart");
}

afterEach(cleanup);

describe("HostOverviewHeaderActions Activate gate", () => {
  it("draws the inline Activate when the row can be activated, and it calls through", () => {
    const onMakeActive = vi.fn();
    renderActions({ isActive: false, onMakeActive, activateInMenu: false });

    fireEvent.click(screen.getByTestId("host-make-active"));

    expect(onMakeActive).toHaveBeenCalledTimes(1);
  });

  it("draws no inline Activate for a management-only row", () => {
    renderActions({
      isActive: false,
      onMakeActive: null,
      activateInMenu: false,
    });

    expect(screen.queryByTestId("host-make-active")).toBeNull();
    expect(screen.queryByTestId("host-active-in-window")).toBeNull();
  });

  it("still says Active inline when the window is already on the row, whatever onMakeActive is", () => {
    renderActions({
      isActive: true,
      onMakeActive: null,
      activateInMenu: false,
    });

    expect(screen.getByTestId("host-active-in-window").textContent).toContain(
      "Active",
    );
    expect(screen.queryByTestId("host-make-active")).toBeNull();
  });

  it("puts Activate first in the phone menu when the row can be activated", async () => {
    renderActions({
      isActive: false,
      onMakeActive: () => undefined,
      activateInMenu: true,
    });
    await openMenu();

    expect(screen.getByTestId("host-make-active")).not.toBeNull();
    expect(screen.queryByTestId("host-active-in-window")).toBeNull();
  });

  it("draws no Activate in the phone menu for a management-only row", async () => {
    renderActions({
      isActive: false,
      onMakeActive: null,
      activateInMenu: true,
    });
    await openMenu();

    expect(screen.queryByTestId("host-make-active")).toBeNull();
    expect(screen.queryByTestId("host-active-in-window")).toBeNull();
    // The rest of the menu is intact.
    expect(screen.getByTestId("host-overview-restart")).not.toBeNull();
  });

  it("still says Active in the phone menu when the window is already on the row", async () => {
    renderActions({ isActive: true, onMakeActive: null, activateInMenu: true });
    await openMenu();

    expect(screen.getByTestId("host-active-in-window").textContent).toContain(
      "Active",
    );
    expect(screen.queryByTestId("host-make-active")).toBeNull();
  });
});
