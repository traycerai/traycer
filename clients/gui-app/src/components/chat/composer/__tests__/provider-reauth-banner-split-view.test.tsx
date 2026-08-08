import {
  cleanup,
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoginCapability } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-schemas";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [{ hostId: HOST_ID, kind: "local" }],
  }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    getActiveHostId: () => HOST_ID,
    request: mocks.request,
  }),
}));
vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () => ({ hostClient: { id: "real-client" } }),
  };
});

import { ProviderReauthBanner } from "@/components/chat/composer/provider-reauth-banner";

function QueryWrapper({ children }: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function render(ui: ReactElement) {
  return baseRender(ui, { wrapper: QueryWrapper });
}

const COPILOT_TERMINAL_CAP: ProviderLoginCapability = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: {},
};

function copilotState() {
  return {
    providerId: "copilot" as const,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unauthenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: COPILOT_TERMINAL_CAP,
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  };
}

// Row 9 of the terminal-login contract table: in a split view each pane
// renders its own `ProviderReauthBanner` with its OWN `viewTabId` prop. The
// terminal must open in the CLICKING pane's tab, never the other pane's or
// some app-wide active view.
//
// If `TerminalLoginRow` ever stopped honouring the `viewTabId` prop it
// receives (e.g. derived it from an app-wide "active view" hook instead), a
// click in pane B would open its terminal into pane A's canvas tab instead -
// this test would go red because pane B's tab would stay empty while pane
// A's gained a second, unexpected tile.
describe("<ProviderReauthBanner /> in a split view", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    nestedFocusBoundaryMock.navigateNested.mockClear();
    mocks.request.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the terminal in the clicking pane's own tab, not the other pane's", async () => {
    mocks.request.mockImplementation(() =>
      Promise.resolve({ sessionId: "term-pane-b", replacedSessionId: null }),
    );
    const store = useEpicCanvasStore.getState();
    const tabA = store.openEpicTab(EPIC_ID, "Pane A");
    const tabB = store.openEpicTab(EPIC_ID, "Pane B");

    render(
      <>
        <div data-testid="pane-a">
          <ProviderReauthBanner
            epicId={EPIC_ID}
            viewTabId={tabA}
            providerId="copilot"
            state={copilotState()}
            reason="provider_unauthenticated"
            profileId={null}
            profileLabel={null}
            onContinueOnAmbient={null}
          />
        </div>
        <div data-testid="pane-b">
          <ProviderReauthBanner
            epicId={EPIC_ID}
            viewTabId={tabB}
            providerId="copilot"
            state={copilotState()}
            reason="provider_unauthenticated"
            profileId={null}
            profileLabel={null}
            onContinueOnAmbient={null}
          />
        </div>
      </>,
    );

    const paneB = screen.getByTestId("pane-b");
    fireEvent.click(
      within(paneB).getByRole("button", { name: /Sign in from a terminal/ }),
    );

    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    await waitFor(() => {
      const canvasB = useEpicCanvasStore.getState().canvasByTabId[tabB];
      if (canvasB === undefined) throw new Error("expected pane B canvas");
      expect(collectPanes(canvasB.root)).not.toHaveLength(0);
    });

    const canvasA = useEpicCanvasStore.getState().canvasByTabId[tabA];
    const canvasB = useEpicCanvasStore.getState().canvasByTabId[tabB];
    if (canvasA === undefined || canvasB === undefined) {
      throw new Error("expected both pane canvases");
    }

    // Pane B (the one clicked) gained the terminal tile.
    const paneBTile = collectPanes(canvasB.root)[0];
    const activeInPaneB =
      canvasB.tilesByInstanceId[paneBTile.activeTabId ?? ""] ?? null;
    expect(activeInPaneB?.type).toBe("terminal");
    if (activeInPaneB === null || activeInPaneB.type !== "terminal") {
      throw new Error("expected pane B to hold the new terminal tile");
    }
    expect(activeInPaneB.id).toBe("term-pane-b");

    // Pane A (not clicked) stays untouched - empty canvas, no stray tile.
    expect(canvasA.root).toBeNull();
  });
});
