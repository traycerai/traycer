/**
 * The build without environments (`unreleased-features.ts`) keeps
 * Notifications under the Host picker (`settings-sections.ts`), so the panel
 * reads the PICKED host, as it did at 1.5.1, not the window's own host that
 * the Account pages follow: a policy edited under host B must land on B.
 */
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostScopeSelection } from "@/components/settings/host-scope/use-host-scope";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const scopeMocks = vi.hoisted(() => ({
  selections: [] as HostScopeSelection[],
}));

// Mocked at the scope boundary, as the panel's own suite does; the selection
// the panel hands over is the subject, so it is recorded and the scope is a
// fixture of the host that selection names.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const WINDOW_HOST_SELECTION: HostScopeSelection = {
    scopedHostId: null,
    setScopedHostId: () => undefined,
  };
  const useHostScopeFor = (selection: HostScopeSelection) => {
    scopeMocks.selections.push(selection);
    return hostScopeFixture({
      client: null,
      host: hostScopeOptionFixture({
        hostId: selection.scopedHostId ?? "window-host",
      }),
    });
  };
  return {
    WINDOW_HOST_SELECTION,
    useHostScopeFor,
    useHostScope: () => useHostScopeFor(WINDOW_HOST_SELECTION),
    usePersonalHostScope: () => useHostScopeFor(WINDOW_HOST_SELECTION),
    useAccountHostScope: () => useHostScopeFor(WINDOW_HOST_SELECTION),
  };
});

afterEach(() => {
  cleanup();
  useSettingsHostScopeStore.getState().setScopedHostId(null);
  scopeMocks.selections.length = 0;
});

describe("<NotificationsSettingsPanel /> without environments", () => {
  it("reads the host picked in Settings, not the window's host", () => {
    useSettingsHostScopeStore.getState().setScopedHostId("host-b");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationsSettingsPanel />
      </QueryClientProvider>,
    );
    const selection = scopeMocks.selections.at(-1);
    expect(selection?.scopedHostId).toBe("host-b");
    // The picker stays writable from this page, as from every Host page.
    selection?.setScopedHostId("host-c");
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-c");
  });
});
