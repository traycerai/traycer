import type { ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ExternalToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginImportAnnouncementController } from "@/components/layout/bridges/login-import-announcement-controller";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useBrowserFocusStore } from "@/stores/settings/browser-focus-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

// Typed to the two sonner calls the controller makes, so `mock.lastCall`
// destructures to a real tuple and not `any`.
const toastMock = vi.hoisted(() => {
  const toast =
    vi.fn<(message: ReactElement, options: ExternalToast) => string | number>();
  return Object.assign(toast, {
    dismiss: vi.fn<(id: string | number) => string | number>(),
  });
});
vi.mock("sonner", () => ({ toast: toastMock }));

const loginImportAvailableMock = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/browser/use-login-import-available", () => ({
  useLoginImportAvailable: () => loginImportAvailableMock.value,
}));

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

const READINESS_STUB_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

const READY_READINESS: SurfaceReadiness = { kind: "ready" };
const LOADING_HOST_READINESS: SurfaceReadiness = { kind: "loading-host" };

function readinessController(
  readiness: SurfaceReadiness,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: READINESS_STUB_PRESENTATION,
    // Post-latch: the app has been ready at least once this window, so a
    // narrator-owned kind (loading-host) suppresses the toast behind its
    // dead-pointer-events overlay rather than blocking the app from mounting.
    hasBeenDefaultHostReady: true,
  };
}

function renderWithReadiness(
  ui: ReactElement,
  readiness: SurfaceReadiness,
): { readonly rerenderReadiness: (next: SurfaceReadiness) => void } {
  function tree(forReadiness: SurfaceReadiness): ReactElement {
    return (
      <HostReadinessControllerContext.Provider
        value={readinessController(forReadiness)}
      >
        {ui}
      </HostReadinessControllerContext.Provider>
    );
  }
  const view = render(tree(readiness));
  return {
    rerenderReadiness: (next) => {
      view.rerender(tree(next));
    },
  };
}

function resetStores(): void {
  useAuthStore.setState({ status: "signed-in" });
  useOnboardingStore.setState({ completedAt: Date.now(), step: 0 });
  useOnboardingTourOpenStore.getState().setOpen(false);
  useBrowserFocusStore.setState({ openImportLogins: false });
  useFeatureAnnouncementsStore.setState({ consumed: {} });
  window.localStorage.clear();
}

describe("<LoginImportAnnouncementController />", () => {
  beforeEach(() => {
    loginImportAvailableMock.value = true;
    toastMock.mockClear();
    toastMock.dismiss.mockClear();
    navigateToSettingsSectionMock.mockClear();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("shows once and consumes, so a second mount shows nothing", () => {
    const { unmount } = render(<LoginImportAnnouncementController />);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeDefined();

    unmount();
    toastMock.mockClear();
    render(<LoginImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not show without a bridge (login import unavailable)", () => {
    loginImportAvailableMock.value = false;
    render(<LoginImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not show before onboarding is complete", () => {
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    render(<LoginImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("holds while the tour is open, then shows when it closes", () => {
    useOnboardingTourOpenStore.getState().setOpen(true);
    render(<LoginImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(false);
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("does not show when signed out", () => {
    useAuthStore.setState({ status: "signed-out" });
    render(<LoginImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("holds behind the window narrator, then shows on release", async () => {
    const harness = renderWithReadiness(
      <LoginImportAnnouncementController />,
      LOADING_HOST_READINESS,
    );

    expect(toastMock).not.toHaveBeenCalled();

    harness.rerenderReadiness(READY_READINESS);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });
  });

  it("the primary action requests the import intent then navigates, and dismisses the toast", () => {
    render(<LoginImportAnnouncementController />);

    expect(toastMock).toHaveBeenCalledTimes(1);
    const [messageNode] = toastMock.mock.lastCall ?? [];
    if (messageNode === undefined) {
      throw new Error("expected the announcement toast content");
    }
    render(<>{messageNode}</>);

    const order: string[] = [];
    vi.spyOn(
      useBrowserFocusStore.getState(),
      "requestImportLogins",
    ).mockImplementation(() => {
      order.push("request");
    });
    navigateToSettingsSectionMock.mockImplementation(() => {
      order.push("navigate");
    });

    fireEvent.click(screen.getByRole("button", { name: "Import logins…" }));

    expect(order).toEqual(["request", "navigate"]);
    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-login-import-announcement",
    );
  });

  it("Later dismisses and the announcement stays consumed", () => {
    render(<LoginImportAnnouncementController />);

    const [messageNode] = toastMock.mock.lastCall ?? [];
    if (messageNode === undefined) {
      throw new Error("expected the announcement toast content");
    }
    const { unmount } = render(<>{messageNode}</>);

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-login-import-announcement",
    );
    unmount();

    toastMock.mockClear();
    render(<LoginImportAnnouncementController />);
    expect(toastMock).not.toHaveBeenCalled();
  });
});
