/**
 * The build without sandboxes (`unreleased-features.ts`): the composer's
 * host picker names this computer by its name, as every other list does,
 * rather than `This computer` beside sandbox rows it does not have.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherComposerMode } from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

afterEach(() => {
  cleanup();
});

const LAPTOP = hostScopeOptionFixture({
  hostId: "laptop",
  name: "Laptop",
  isLocalMachine: true,
  isActive: true,
});

const COMPOSER: HostSwitcherComposerMode = {
  viewerUserId: "user-me",
  inThisTask: null,
  subLinesFor: () => [],
  tagFor: () => null,
  newRows: [],
  rememberedConfigurationKey: null,
  stagedConfigurationKey: null,
  stagedLabel: null,
  stagedBusy: false,
  onPickHost: () => undefined,
  onPickNew: () => undefined,
  onOpenShape: () => undefined,
  onManage: () => undefined,
};

describe("<HostSwitcher /> composer mode without sandboxes", () => {
  it("names this computer by its name", () => {
    render(
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={[LAPTOP]}
        selected={LAPTOP}
        activeHostId={LAPTOP.hostId}
        onSelect={() => undefined}
        action={null}
        surface="field"
        intent="pin"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        environmentLabelForHost={null}
        composer={COMPOSER}
      />,
    );
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    const row = screen.getByTestId("settings-host-switcher-option-laptop");
    expect(row.textContent).toContain("Laptop");
    expect(row.textContent).not.toContain("This computer");
  });
});
