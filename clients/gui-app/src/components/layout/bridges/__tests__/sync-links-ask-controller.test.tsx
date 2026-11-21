import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ExternalToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
  readonly listAfterFirst?: SyncLinksListResponse;
  readonly stopError?: HostRpcError;
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
      if (reads.listCalls > 1 && input.listAfterFirst !== undefined) {
        return input.listAfterFirst;
      }
      return reads.listAnswer;
    },
    "providers.syncLinks.stop": (request) => {
      reads.stopRequests.push(request);
      if (input.stopError !== undefined) throw input.stopError;
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
    const held: SyncLinksFolder = {
      providerId: "grok",
      profileId: "22222222-2222-4222-8222-222222222222",
      label: "Studio",
      accountClass: "renewing",
      hold: "held-for-personal",
      peers: [PEER],
    };
    const [claude, codex] = linkedFolders();
    const reads = mountAsk({
      teamComputer: false,
      folders: [claude, held, codex],
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

  it("a changed list reloads the dialog and shows no refusal line", async () => {
    const message = "Sync links changed";
    const [claude, codex] = linkedFolders();
    const reads = mountAsk({
      teamComputer: false,
      folders: [claude, codex],
      negotiateList: true,
      listAfterFirst: { teamComputer: false, folders: [codex] },
      stopError: new HostRpcError({
        code: "sync-links-changed",
        message,
        requestId: "r",
        method: "providers.syncLinks.stop",
        fatalDetails: null,
      }),
    });
    await openAsk();
    const listed = reads.listCalls;

    fireEvent.click(screen.getByRole("button", { name: STOP }));

    await waitFor(() => expect(reads.listCalls).toBeGreaterThan(listed));
    expect(screen.getByRole("heading", { name: DIALOG_TITLE })).toBeTruthy();
    expect(screen.getByText(CODEX_ROW)).toBeTruthy();
    expect(screen.queryByText(CLAUDE_ROW)).toBeNull();
    expect(screen.queryByText(message)).toBeNull();
    expect(within(screen.getByRole("dialog")).queryByRole("status")).toBeNull();
  });

  it("any other refusal stays in the dialog as a status line", async () => {
    const message = "Stop could not be saved";
    const [claude, codex] = linkedFolders();
    const reads = mountAsk({
      teamComputer: false,
      folders: [claude, codex],
      negotiateList: true,
      listAfterFirst: { teamComputer: false, folders: [codex] },
      stopError: new HostRpcError({
        code: "RPC_ERROR",
        message,
        requestId: "r",
        method: "providers.syncLinks.stop",
        fatalDetails: null,
      }),
    });
    await openAsk();
    const listed = reads.listCalls;

    fireEvent.click(screen.getByRole("button", { name: STOP }));

    await waitFor(() => expect(reads.listCalls).toBeGreaterThan(listed));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status").textContent).toBe(message);
    expect(screen.getByRole("heading", { name: DIALOG_TITLE })).toBeTruthy();
    expect(screen.getByText(CODEX_ROW)).toBeTruthy();
    expect(screen.queryByText(CLAUDE_ROW)).toBeNull();
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

const DETAILS = "Details";
const MOVE_DETAIL =
  "Move both to Personal: they keep working on both computers. MacBook Air moves too.";
const RENEWING_STOP_DETAIL_TWO =
  "Stop syncing: they stay on both computers. One of them may need to sign in again later.";
const RENEWING_STOP_DETAIL_MORE =
  "Stop syncing: they stay on every computer. One of them may need to sign in again later.";
const KEY_ONLY_STOP_DETAIL =
  "Stop syncing: they keep working on both computers.";
const KEY_ONLY_STOP_DETAIL_MORE =
  "Stop syncing: they keep working on every computer.";
const SECOND_PEER = {
  hostId: "host-c",
  displayName: "Mac mini",
  version: "current",
} as const;

function keyOnlyFolders(): SyncLinksFolder[] {
  return linkedFolders().map((folder) => ({ ...folder, accountClass: "key" }));
}

function withTwoPeers(folders: SyncLinksFolder[]): SyncLinksFolder[] {
  return folders.map((folder) => ({ ...folder, peers: [PEER, SECOND_PEER] }));
}

async function openAskWithTwoPeers(): Promise<void> {
  await waitFor(() => expect(toastMock).toHaveBeenCalled());
  render(<>{lastToastContent()}</>);
  fireEvent.click(screen.getByRole("button", { name: CHOOSE }));
  await screen.findByRole("heading", {
    name: "Synced with MacBook Air and Mac mini",
  });
}

function openDetails(): void {
  fireEvent.click(screen.getByRole("button", { name: DETAILS }));
}

describe("<SyncLinksAskController /> Stop ends only the sync", () => {
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

  it("says one of two computers may sign in again when the list holds a renewing account", async () => {
    mountAsk({
      teamComputer: false,
      folders: linkedFolders(),
      negotiateList: true,
    });
    await openAsk();
    openDetails();

    expect(await screen.findByText(RENEWING_STOP_DETAIL_TWO)).toBeTruthy();
    expect(screen.getByText(MOVE_DETAIL)).toBeTruthy();
  });

  it("says every computer when three or more hold a renewing account", async () => {
    mountAsk({
      teamComputer: false,
      folders: withTwoPeers(linkedFolders()),
      negotiateList: true,
    });
    await openAskWithTwoPeers();
    openDetails();

    expect(await screen.findByText(RENEWING_STOP_DETAIL_MORE)).toBeTruthy();
    expect(screen.queryByText(RENEWING_STOP_DETAIL_TWO)).toBeNull();
  });

  it("gives a key-only list the key-only Stop line", async () => {
    mountAsk({
      teamComputer: false,
      folders: keyOnlyFolders(),
      negotiateList: true,
    });
    await openAsk();
    openDetails();

    expect(await screen.findByText(KEY_ONLY_STOP_DETAIL)).toBeTruthy();
    expect(screen.getByText(MOVE_DETAIL)).toBeTruthy();
  });

  it("says every computer on a key-only list with three or more computers", async () => {
    mountAsk({
      teamComputer: false,
      folders: withTwoPeers(keyOnlyFolders()),
      negotiateList: true,
    });
    await openAskWithTwoPeers();
    openDetails();

    expect(await screen.findByText(KEY_ONLY_STOP_DETAIL_MORE)).toBeTruthy();
    expect(screen.queryByText(KEY_ONLY_STOP_DETAIL)).toBeNull();
  });

  it("gives a team computer with a renewing account only the renewing Stop line", async () => {
    mountAsk({
      teamComputer: true,
      folders: linkedFolders(),
      negotiateList: true,
    });
    await openAsk();
    openDetails();

    expect(await screen.findByText(RENEWING_STOP_DETAIL_TWO)).toBeTruthy();
    expect(screen.queryByText(MOVE_DETAIL)).toBeNull();
  });

  it("keeps the update line for a computer on 1.5.4, beside the same Stop line", async () => {
    mountAsk({
      teamComputer: false,
      folders: linkedFolders().map((folder) => ({
        ...folder,
        peers: [{ ...PEER, version: "needs-update" }],
      })),
      negotiateList: true,
    });
    await openAsk();

    expect(
      screen.getByText("MacBook Air needs the latest Traycer."),
    ).toBeTruthy();
    openDetails();
    expect(await screen.findByText(RENEWING_STOP_DETAIL_TWO)).toBeTruthy();
  });
});
