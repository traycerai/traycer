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
import { SessionImportAnnouncementController } from "@/components/layout/bridges/session-import-announcement-controller";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";
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

const sessionImportAvailableMock = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/session-import/use-session-import-available", () => ({
  useSessionImportAvailable: () => sessionImportAvailableMock.value,
}));

// The controller only asks whether a stream client is live; the dialog it
// opens is stubbed below, so nothing else in the tree reads the transport.
const streamLiveMock = vi.hoisted(() => ({ value: true }));
// What negotiation has said about `sessionImport.scan`; "unknown" is the
// pre-handshake window the claim must wait out.
const scanSupportMock = vi.hoisted(() => ({
  value: "supported" as "unknown" | "supported" | "unsupported",
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => (streamLiveMock.value ? {} : null),
  useStreamMethodSupport: () => scanSupportMock.value,
}));

vi.mock("@/components/session-import/session-import-dialog", () => ({
  SessionImportDialog: (props: { readonly onClose: () => void }) => (
    <div data-testid="session-import-dialog">
      <button type="button" onClick={props.onClose}>
        Close
      </button>
    </div>
  ),
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
  useFeatureAnnouncementsStore.setState({ consumed: {} });
  window.localStorage.clear();
}

function lastToastContent(): ReactElement {
  const [messageNode] = toastMock.mock.lastCall ?? [];
  if (messageNode === undefined) {
    throw new Error("expected the announcement toast content");
  }
  return messageNode;
}

describe("<SessionImportAnnouncementController />", () => {
  beforeEach(() => {
    sessionImportAvailableMock.value = true;
    streamLiveMock.value = true;
    scanSupportMock.value = "supported";
    toastMock.mockClear();
    toastMock.dismiss.mockClear();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("shows once and consumes, so a second mount shows nothing", () => {
    const { unmount } = render(<SessionImportAnnouncementController />);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(
      useFeatureAnnouncementsStore.getState().consumed["session-import"],
    ).toBeDefined();

    unmount();
    toastMock.mockClear();
    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not show when the host cannot import sessions", () => {
    sessionImportAvailableMock.value = false;
    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not show before onboarding is complete", () => {
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("shows for a user who finished onboarding before the feature existed", () => {
    // The whole point of the toast: an older install has a completion
    // stamp and no `session-import` record, since the id did not exist.
    useOnboardingStore.setState({ completedAt: 1, step: 0 });
    render(<SessionImportAnnouncementController />);

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("does not show once the wizard has been met on another surface", () => {
    useFeatureAnnouncementsStore.getState().consume("session-import");
    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("holds while the tour is open, then shows when it closes", () => {
    useOnboardingTourOpenStore.getState().setOpen(true);
    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(false);
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("does not show when signed out", () => {
    useAuthStore.setState({ status: "signed-out" });
    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("holds behind the window narrator, then shows on release", async () => {
    const harness = renderWithReadiness(
      <SessionImportAnnouncementController />,
      LOADING_HOST_READINESS,
    );

    expect(toastMock).not.toHaveBeenCalled();

    harness.rerenderReadiness(READY_READINESS);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });
  });

  it("holds while no stream client is live, then shows once one is, without claiming early", () => {
    streamLiveMock.value = false;
    const { rerender } = render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
    expect(
      useFeatureAnnouncementsStore.getState().consumed["session-import"],
    ).toBeUndefined();

    streamLiveMock.value = true;
    rerender(<SessionImportAnnouncementController />);

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("holds while support is still unknown, then shows once negotiated, without claiming early", () => {
    // Before the handshake `available` already reads true (unknown is not
    // unsupported), which is exactly the window a permanent claim must not
    // fire in: against an older host the toast would be dismissed a render
    // later and the install would never be announced to again.
    scanSupportMock.value = "unknown";
    const { rerender } = render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
    expect(
      useFeatureAnnouncementsStore.getState().consumed["session-import"],
    ).toBeUndefined();

    scanSupportMock.value = "supported";
    rerender(<SessionImportAnnouncementController />);

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("the primary action opens the import dialog in place and dismisses the toast", () => {
    render(<SessionImportAnnouncementController />);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("session-import-dialog")).toBeNull();

    // The toast body renders outside the controller's tree (sonner owns
    // it), so it is mounted beside the controller here; its button reaches
    // the controller through the closure it was created with.
    render(<>{lastToastContent()}</>);
    fireEvent.click(screen.getByRole("button", { name: "Import work…" }));

    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-session-import-announcement",
    );
    expect(screen.queryByTestId("session-import-dialog")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("session-import-dialog")).toBeNull();
  });

  it("does not show when another window already claimed the announcement", () => {
    // Written straight into localStorage, as another renderer's own
    // claim()/consume() would have - never through THIS window's store.
    window.localStorage.setItem(
      persistKey(STORE_KEYS.featureAnnouncements),
      JSON.stringify({
        state: { consumed: { "session-import": 123 } },
        version: 1,
      }),
    );
    expect(useFeatureAnnouncementsStore.getState().consumed).toEqual({});

    render(<SessionImportAnnouncementController />);

    expect(toastMock).not.toHaveBeenCalled();
    expect(
      useFeatureAnnouncementsStore.getState().consumed["session-import"],
    ).toBe(123);
  });

  it("Later dismisses and the announcement stays consumed", () => {
    render(<SessionImportAnnouncementController />);
    const { unmount } = render(<>{lastToastContent()}</>);

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-session-import-announcement",
    );
    unmount();

    toastMock.mockClear();
    render(<SessionImportAnnouncementController />);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("dismisses the toast once the tour opens after it showed", () => {
    render(<SessionImportAnnouncementController />);
    expect(toastMock).toHaveBeenCalledTimes(1);

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(true);
    });

    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-session-import-announcement",
    );
  });

  it("dismisses the toast once availability flips to false after it showed", () => {
    const { rerender } = render(<SessionImportAnnouncementController />);
    expect(toastMock).toHaveBeenCalledTimes(1);

    sessionImportAvailableMock.value = false;
    rerender(<SessionImportAnnouncementController />);

    expect(toastMock.dismiss).toHaveBeenCalledWith(
      "traycer-session-import-announcement",
    );
  });

  it("does NOT dismiss the toast when only a transient gate closes over it", () => {
    const harness = renderWithReadiness(
      <SessionImportAnnouncementController />,
      READY_READINESS,
    );
    expect(toastMock).toHaveBeenCalledTimes(1);

    // The narrator and a stream drop are transient - a toast under a dialog
    // is inert rather than wrong, and a reconnect brings the host back. They
    // must not take the toast down the way sign-out and the tour do, since
    // the claim is permanent.
    harness.rerenderReadiness(LOADING_HOST_READINESS);
    streamLiveMock.value = false;
    harness.rerenderReadiness(LOADING_HOST_READINESS);

    expect(toastMock.dismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss on the tour opening when THIS controller never showed the toast", () => {
    useFeatureAnnouncementsStore.setState({
      consumed: { "session-import": Date.now() },
    });
    render(<SessionImportAnnouncementController />);
    expect(toastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(true);
    });

    expect(toastMock.dismiss).not.toHaveBeenCalled();
  });
});
