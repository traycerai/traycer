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
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
  SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { persistKey, STORE_KEYS } from "@/lib/persist";

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

/**
 * Minimal `SystemTabModalApi`. Published by default so the existing suite
 * keeps testing gates other than `settingsReachable` - the controller only
 * ever reads it through `useSystemTabModalApiPublished()`, never calls a
 * method on it, since `@/lib/settings-navigation` is mocked above.
 */
function buildFakeSystemTabModalApi(): SystemTabModalApi {
  return {
    active: null,
    openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
    openHistory: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    setSection: vi.fn<(section: SettingsSectionId) => void>(),
    promoteToTab: vi.fn<() => void>(),
    isOverlayActive: vi.fn<(kind: SystemOverlayKind) => boolean>(() => false),
  };
}

describe("<LoginImportAnnouncementController />", () => {
  beforeEach(() => {
    loginImportAvailableMock.value = true;
    toastMock.mockClear();
    toastMock.dismiss.mockClear();
    navigateToSettingsSectionMock.mockClear();
    resetStores();
    setSystemTabModalApi(buildFakeSystemTabModalApi());
  });

  afterEach(() => {
    cleanup();
    resetStores();
    setSystemTabModalApi(null);
    // "the primary action..." test spies on the real
    // useBrowserFocusStore.getState().requestImportLogins with
    // mockImplementation; nothing here auto-restores it, so a leaked spy
    // would silently swallow that store's real action in every later test.
    vi.restoreAllMocks();
    navigateToSettingsSectionMock.mockReset();
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

  it("does not show when another window already claimed the announcement", () => {
    // Written straight into localStorage, as another renderer's own
    // claim()/consume() would have - never through THIS window's store.
    window.localStorage.setItem(
      persistKey(STORE_KEYS.featureAnnouncements),
      JSON.stringify({
        state: { consumed: { "login-import": 123 } },
        version: 1,
      }),
    );
    // This window's in-memory copy still starts out empty.
    expect(useFeatureAnnouncementsStore.getState().consumed).toEqual({});

    render(<LoginImportAnnouncementController />);

    // claim()'s own rehydrate adopts the other window's record before the
    // controller decides whether to show anything.
    expect(toastMock).not.toHaveBeenCalled();
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBe(123);
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

  it("dismisses the toast once the tour opens after it showed", () => {
    render(<LoginImportAnnouncementController />);
    expect(toastMock).toHaveBeenCalledTimes(1);

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(true);
    });

    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-login-import-announcement",
    );
  });

  it("dismisses the toast once availability flips to false after it showed", () => {
    const { rerender } = render(<LoginImportAnnouncementController />);
    expect(toastMock).toHaveBeenCalledTimes(1);

    loginImportAvailableMock.value = false;
    rerender(<LoginImportAnnouncementController />);

    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-login-import-announcement",
    );
  });

  it("does NOT dismiss the toast when only the window narrator gate closes over it", () => {
    const harness = renderWithReadiness(
      <LoginImportAnnouncementController />,
      READY_READINESS,
    );
    expect(toastMock).toHaveBeenCalledTimes(1);

    // The narrator gate is transient - a toast under its dialog is inert
    // rather than wrong, and comes back live when the dialog goes. It must
    // not take the toast down the way saving-off, sign-out and the tour do.
    harness.rerenderReadiness(LOADING_HOST_READINESS);

    expect(toastMock.dismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss on the tour opening when THIS controller never showed the toast", () => {
    // Already consumed - by another window, or a prior mount - so this
    // controller's own shown-tracking never flips true.
    useFeatureAnnouncementsStore.setState({
      consumed: { "login-import": Date.now() },
    });
    render(<LoginImportAnnouncementController />);
    expect(toastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(true);
    });

    expect(toastMock.dismiss).not.toHaveBeenCalled();
  });

  it("holds the toast while no Settings surface is reachable, then shows once the system-tab modal API publishes", () => {
    setSystemTabModalApi(null);
    render(<LoginImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeUndefined();

    act(() => {
      setSystemTabModalApi(buildFakeSystemTabModalApi());
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
