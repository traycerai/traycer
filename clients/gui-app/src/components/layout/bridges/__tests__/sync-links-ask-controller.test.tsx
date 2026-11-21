import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  SyncLinksFolder,
  SyncLinksListResponse,
  SyncLinksStopRequest,
} from "@traycer/protocol/host/sync-links-schemas";
import { SyncLinksAskController } from "@/components/layout/bridges/sync-links-ask-controller";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const HOST_ID = "host-a";
const HOST_NAME = "This Mac";
const WORK_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const TOAST_TITLE = "Accounts synced with MacBook Air";
const CHOOSE = "Choose\u2026";
const DIALOG_TITLE = "Synced with MacBook Air";
const CLAUDE_ROW = "Claude Code \u00b7 Personal 2";
const CODEX_ROW = "Codex \u00b7 Work";
const STOP = "Stop syncing";
const MOVE = "Move both to Personal";

const PEER = {
  hostId: "host-b",
  displayName: "MacBook Air",
  version: "current",
} as const;

const toastMock = vi.hoisted(() => {
  const toast =
    vi.fn<(message: ReactElement, options: ExternalToast) => string | number>();
  return Object.assign(toast, {
    dismiss: vi.fn<(id: string | number) => string | number>(),
  });
});
vi.mock("sonner", () => ({ toast: toastMock }));

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

interface AskReads {
  listCalls: number;
  stopRequests: SyncLinksStopRequest[];
  listAnswer: SyncLinksListResponse;
}

function linkedFolders(): SyncLinksFolder[] {
  return [
    {
      providerId: "claude-code",
      profileId: "ambient",
      label: "Personal 2",
      accountClass: "renewing",
      hold: "none",
      peers: [PEER],
    },
    {
      providerId: "codex",
      profileId: WORK_PROFILE_ID,
      label: "Work",
      accountClass: "key",
      hold: "none",
      peers: [PEER],
    },
  ];
}

function mountAsk(input: {
  readonly teamComputer: boolean;
  readonly folders: readonly SyncLinksFolder[];
  readonly negotiateList: boolean;
}): AskReads & { rerender: () => void } {
  const reads: AskReads = {
    listCalls: 0,
    stopRequests: [],
    listAnswer: {
      teamComputer: input.teamComputer,
      folders: [...input.folders],
    },
  };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "providers.syncLinks.list": () => {
      reads.listCalls += 1;
      return reads.listAnswer;
    },
    "providers.syncLinks.stop": (request) => {
      reads.stopRequests.push(request);
      const accounts = reads.listAnswer.folders.map((folder) => ({
        providerId: folder.providerId,
        profileId: folder.profileId,
        outcome: "kept" as const,
      }));
      reads.listAnswer = { teamComputer: false, folders: [] };
      return { accounts };
    },
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  directory.computer = { hostId: HOST_ID, hostName: HOST_NAME, client };
  recordNegotiatedHostManifest(
    HOST_ID,
    input.negotiateList
      ? {
          "providers.syncLinks.list": { major: 1, minor: 0 },
          "providers.syncLinks.stop": { major: 1, minor: 0 },
        }
      : { "environment.status": { major: 1, minor: 1 } },
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const tree = (): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <HostReadinessControllerContext.Provider
        value={readinessController(READY_READINESS)}
      >
        <SyncLinksAskController />
      </HostReadinessControllerContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return Object.assign(reads, {
    rerender: () => {
      view.rerender(tree());
    },
  });
}

function lastToastContent(): ReactElement {
  const [messageNode] = toastMock.mock.lastCall ?? [];
  if (messageNode === undefined) {
    throw new Error("expected the ask toast content");
  }
  return messageNode;
}

async function openAsk(): Promise<void> {
  await waitFor(() => expect(toastMock).toHaveBeenCalled());
  // Sonner owns the toast body, so it is mounted beside the controller; the
  // button reaches the controller through the closure it was created with.
  render(<>{lastToastContent()}</>);
  expect(screen.getByText(TOAST_TITLE)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: CHOOSE }));
  expect(
    await screen.findByRole("heading", { name: DIALOG_TITLE }),
  ).toBeTruthy();
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

describe("<SyncLinksAskController />", () => {
  beforeEach(() => {
    toastMock.mockClear();
    toastMock.dismiss.mockClear();
    resetGates();
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    directory.computer = {
      hostId: null,
      hostName: "this computer",
      client: null,
    };
    resetGates();
  });

  it("shows the ask for a listed folder", async () => {
    mountAsk({
      teamComputer: false,
      folders: linkedFolders(),
      negotiateList: true,
    });
    await openAsk();

    expect(screen.getByText(CLAUDE_ROW)).toBeTruthy();
    expect(screen.getByText(CODEX_ROW)).toBeTruthy();
    expect(screen.getByRole("button", { name: STOP })).toBeTruthy();
    expect(screen.getByRole("button", { name: MOVE })).toBeTruthy();
  });

  it("stays quiet when the list has no folder, and still reads the list", async () => {
    const reads = mountAsk({
      teamComputer: false,
      folders: [],
      negotiateList: true,
    });

    await waitFor(() => expect(reads.listCalls).toBeGreaterThan(0));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("stays quiet and does not read when the host has not negotiated the list", () => {
    const reads = mountAsk({
      teamComputer: false,
      folders: linkedFolders(),
      negotiateList: false,
    });

    expect(toastMock).not.toHaveBeenCalled();
    expect(reads.listCalls).toBe(0);
  });

  it("offers only Stop syncing on a team computer", async () => {
    mountAsk({
      teamComputer: true,
      folders: linkedFolders(),
      negotiateList: true,
    });
    await openAsk();

    expect(screen.getByRole("button", { name: STOP })).toBeTruthy();
    expect(screen.queryByRole("button", { name: MOVE })).toBeNull();
  });

  it("Stop syncing sends one stop and the ask goes after the list is read again", async () => {
    const reads = mountAsk({
      teamComputer: false,
      folders: linkedFolders(),
      negotiateList: true,
    });
    await openAsk();
    const toasts = toastMock.mock.calls.length;
    const listed = reads.listCalls;

    fireEvent.click(screen.getByRole("button", { name: STOP }));

    await waitFor(() => expect(reads.listCalls).toBeGreaterThan(listed));
    expect(reads.stopRequests).toEqual([
      {
        scope: {
          kind: "folders",
          folders: [
            { providerId: "claude-code", profileId: "ambient" },
            { providerId: "codex", profileId: WORK_PROFILE_ID },
          ],
        },
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: DIALOG_TITLE })).toBeNull(),
    );
    expect(toastMock).toHaveBeenCalledTimes(toasts);
  });

  it("Move both to Personal opens this computer's move sheet and closes the ask", async () => {
    mountAsk({
      teamComputer: false,
      folders: linkedFolders(),
      negotiateList: true,
    });
    await openAsk();

    fireEvent.click(screen.getByRole("button", { name: MOVE }));

    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: HOST_ID,
      hostName: HOST_NAME,
    });
    expect(screen.queryByRole("heading", { name: DIALOG_TITLE })).toBeNull();
  });

  it("stays quiet while this computer's move ask holds", async () => {
    moveAskHoldMock.value = true;
    const reads = mountAsk({
      teamComputer: false,
      folders: linkedFolders(),
      negotiateList: true,
    });

    await waitFor(() => expect(reads.listCalls).toBeGreaterThan(0));
    // The handler increments before the query commits, so flush that commit
    // before deciding the toast stayed down.
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(toastMock).not.toHaveBeenCalled();

    moveAskHoldMock.value = false;
    reads.rerender();
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });
});
