/**
 * `hostRowTitle`'s gate in a build without sandboxes
 * (`unreleased-features.ts`): given composer mode, the row still names this
 * computer by its name, as every other list does, rather than
 * `This computer` beside sandbox rows it does not have. No surface reaches
 * composer mode in that build — `useSandboxStaging` answers `null`, which
 * `host-picker-unreleased-off.test.tsx` holds — so this covers the prop
 * contract, not a picker a person meets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
    // The name is the title, said once: the line below carries only the
    // platform and the status. A screen reader still hears what the row is,
    // as it does on every other list.
    expect(within(row).getByText("Laptop")).toBeDefined();
    expect(within(row).queryByText(/Laptop ·/)).toBeNull();
    expect(
      within(row).queryByText("This computer", {
        ignore: ".sr-only, script, style",
      }),
    ).toBeNull();
  });
});
