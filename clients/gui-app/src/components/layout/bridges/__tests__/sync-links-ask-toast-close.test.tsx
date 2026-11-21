import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SyncLinksFolder } from "@traycer/protocol/host/sync-links-schemas";
import { SyncLinksAskController } from "@/components/layout/bridges/sync-links-ask-controller";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { Toaster } from "@/components/ui/sonner";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const moveAskHoldMock = vi.hoisted(() => ({ value: false }));
vi.mock("@/components/settings/move/use-move-ask-holds-announcements", () => ({
  useMoveAskHoldsAnnouncements: () => moveAskHoldMock.value,
}));

const directory = vi.hoisted((): { computer: ThisComputer } => ({
  computer: { hostId: null, hostName: "this computer", client: null },
}));
vi.mock("@/components/settings/move/this-computer", () => ({
  useThisComputer: (): ThisComputer => directory.computer,
}));

const HOST_ID = "host-a";
const CHOOSE = "Choose\u2026";
const CLOSE_TOAST = "Close toast";

const READINESS_STUB_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  ensureFailure: null,
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

function readinessController(
  readiness: SurfaceReadiness,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: READINESS_STUB_PRESENTATION,
    hasBeenDefaultHostReady: true,
  };
}

function linkedFolder(): SyncLinksFolder {
  return {
    providerId: "claude-code",
    profileId: "ambient",
    label: "Personal 2",
    accountClass: "renewing",
    hold: "none",
    peers: [
      { hostId: "host-b", displayName: "MacBook Air", version: "current" },
    ],
  };
}

function resetGates(): void {
  moveAskHoldMock.value = false;
  useAuthStore.setState({ status: "signed-in" });
  useOnboardingStore.setState({ completedAt: Date.now(), step: 0 });
  useOnboardingTourOpenStore.getState().setOpen(false);
  useFirstTaskGuideStore.getState().prepare();
  useMoveSheetStore.setState({ target: null });
  window.localStorage.clear();
}

function renderAsk(): void {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "providers.syncLinks.list": () => ({
      teamComputer: false,
      folders: [linkedFolder()],
    }),
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  directory.computer = { hostId: HOST_ID, hostName: "This Mac", client };
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.syncLinks.list": { major: 1, minor: 0 },
    "providers.syncLinks.stop": { major: 1, minor: 0 },
  });
  const tree: ReactElement = (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <HostReadinessControllerContext.Provider
        value={readinessController(READY_READINESS)}
      >
        <SyncLinksAskController />
      </HostReadinessControllerContext.Provider>
      <Toaster />
    </QueryClientProvider>
  );
  render(tree);
}

describe("sync-links ask toast close control", () => {
  beforeEach(() => {
    resetGates();
  });

  afterEach(() => {
    toast.dismiss();
    cleanup();
    resetNegotiatedManifests();
    directory.computer = {
      hostId: null,
      hostName: "this computer",
      client: null,
    };
    resetGates();
  });

  it("does not give the ask toast a close control", async () => {
    renderAsk();

    expect(await screen.findByRole("button", { name: CHOOSE })).toBeTruthy();
    expect(screen.queryByRole("button", { name: CLOSE_TOAST })).toBeNull();
  });

  it("still gives a plain toast the toaster's close control", async () => {
    render(<Toaster />);

    act(() => {
      toast("x");
    });

    expect(
      await screen.findByRole("button", { name: CLOSE_TOAST }),
    ).toBeTruthy();
  });
});
