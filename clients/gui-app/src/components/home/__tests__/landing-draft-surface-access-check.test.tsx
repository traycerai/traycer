import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { LandingDraftSurface } from "@/components/home/landing-draft-surface";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  clearHostDoorState,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";

vi.mock("@/providers/draft-surface-hooks", () => ({
  useDraftSurfaceId: () => null,
}));
vi.mock("@/components/layout/tab-surface-activity-hooks", () => ({
  useTabSurfaceActivity: () => ({ focused: true, visible: false }),
}));
vi.mock("@/components/epic-canvas/pane-activation", () => ({
  usePaneActivationFocusIntent: () => ({
    shouldYieldAutoFocus: () => true,
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouterState: () => false };
});
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
}));
vi.mock("@/components/layout/tabs/mobile-strip-form-context", () => ({
  useMobileStripForm: () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openHistory: vi.fn(),
    openSettings: vi.fn(),
  }),
}));
vi.mock("@/components/home/composer/landing-composer", () => ({
  LandingComposer: () => <div data-testid="landing-composer-fixture" />,
}));
vi.mock("@/components/home/composer/surface-activity-context", () => ({
  SurfaceActivityProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/home/host-update-banner", () => ({
  HostUpdateBanner: () => <div data-testid="host-update-banner-fixture" />,
}));
vi.mock("@/components/home/home-hero", () => ({ HomeHero: () => null }));
vi.mock("@/components/home/current-tasks-section", () => ({
  CurrentTasksSection: () => null,
}));
vi.mock("@/components/home/landing-appearance-wallpaper", () => ({
  LandingAppearanceWallpaper: () => null,
}));
vi.mock("@/components/home/visible-draft-image-prefetch", () => ({
  LandingVisibleDraftImagePrefetch: () => null,
}));
vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskLandingGuide: () => null,
}));
vi.mock("@/components/layout/shell/mobile-drawer-history-gate", () => ({
  MobileDrawerTaskPaintReporter: () => null,
}));

const HOST_ID = "landing-surface-host";

function selectWindowHost(): void {
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: HOST_ID,
      targetHostId: HOST_ID,
      effectiveHostId: HOST_ID,
      leases: [{ hostId: HOST_ID, status: "ready", dead: null }],
      selectionRevision: 1,
    });
    noteHostDoorState({
      hostId: HOST_ID,
      kind: "access-check-delayed",
      detail: null,
    });
  });
}

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  useHostDoorStateStore.setState({ byHost: new Map() });
});

describe("LandingDraftSurface access-check notice", () => {
  it("mounts board C2's quiet line in the real landing surface and clears it", () => {
    selectWindowHost();
    render(<LandingDraftSurface />);

    const surface = screen.getByTestId("landing-draft-surface");
    const banner = within(surface).getByTestId("host-update-banner-fixture");
    const notice = within(surface).getByTestId("access-check-notice");
    expect(notice.textContent).toBe(
      "Access checks are delayed. You can keep working.",
    );
    expect(
      banner.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(within(notice).queryByRole("button")).toBeNull();

    act(() => {
      clearHostDoorState(HOST_ID);
    });
    expect(within(surface).queryByTestId("access-check-notice")).toBeNull();
  });
});
