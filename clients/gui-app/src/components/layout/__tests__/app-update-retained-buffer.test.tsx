import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

/** A reproduction narrows deliberately, and a predicate must not inherit that narrowing - see the mixed-case
 * arm at the bottom for the predicate this distinction rules out. */

/** The toast never reaches the DOM on its own - `showAppUpdateToast` hands its content to sonner, which owns
 * the host. */
const toastMock = vi.hoisted(() => {
  const calls: { last: ReactNode | null } = { last: null };
  const toast = vi.fn((message: ReactNode) => {
    calls.last = message;
  });
  return Object.assign(toast, {
    dismiss: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    calls,
  });
});

vi.mock("sonner", () => ({
  toast: toastMock,
}));

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const IDLE_SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 0,
  status: "idle",
  currentVersion: "1.0.0",
  allowPrerelease: false,
  latestVersion: null,
  latestCompatibilityEpoch: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

function readySnapshot(sequence: number): DesktopAppUpdateSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    sequence,
    status: "ready",
    latestVersion: "1.2.3",
    latestCompatibilityEpoch: null,
    lastCheckedAt: "2026-06-15T00:00:00.000Z",
    lastCheckIntent: "automatic",
  };
}

class FakeAppUpdatesBridge implements DesktopAppUpdatesBridge {
  snapshot: DesktopAppUpdateSnapshot;
  readonly downloadUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  readonly installUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  // Annotated with the full change type.
  readonly setAllowPrerelease = vi.fn(
    (): Promise<DesktopAppUpdateChannelChange> =>
      Promise.resolve({ outcome: "changed", snapshot: this.snapshot }),
  );
  readonly resolveCompatRecovery = vi.fn(() =>
    Promise.resolve({
      route: "manual" as const,
      rcCandidateVersion: null,
      stagedVersion: null,
    }),
  );
  private readonly handlers = new Set<
    (snapshot: DesktopAppUpdateSnapshot) => void
  >();

  constructor(snapshot: DesktopAppUpdateSnapshot) {
    this.snapshot = snapshot;
  }

  getSnapshot(): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  checkForUpdates(
    _intent: DesktopAppUpdateCheckIntent,
  ): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  onChange(handler: (snapshot: DesktopAppUpdateSnapshot) => void): {
    dispose(): void;
  } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(snapshot: DesktopAppUpdateSnapshot): void {
    this.snapshot = snapshot;
    for (const handler of this.handlers) handler(snapshot);
  }

  subscriptionCount(): number {
    return this.handlers.size;
  }
}

function makeHost(appUpdates: DesktopAppUpdatesBridge): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    appUpdates,
  });
}

function renderWithHost(
  ui: ReactNode,
  appUpdates: DesktopAppUpdatesBridge,
): void {
  render(
    <RunnerHostProvider runnerHost={makeHost(appUpdates)}>
      <TooltipProvider>{ui}</TooltipProvider>
    </RunnerHostProvider>,
  );
}

const EPIC_ID = "epic-retained-update";

/** Constructing the retained state any other way would be testing a state the product cannot reach. */
function seedRetainedBuffer(liveDirty: boolean): {
  readonly liveIsDirty: () => boolean;
} {
  const registry = __getOpenEpicRegistryForTests();
  const outgoing = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    // `handle.doc` still resolves because this harness builds the runtime in this thread.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  outgoing.doc.getMap("epic").set("title", "Rewrite the onboarding");
  outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
  registry.acquireMounted(EPIC_ID, () => outgoing);

  const incoming = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    // `handle.doc` still resolves because this harness builds the runtime in this thread.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  registry.replaceMounted(EPIC_ID, outgoing, incoming, {
    hostStamp: "host-a",
    ownerIdentityKey: "key-a",
    editsTransferredToReplacement: false,
  });
  if (liveDirty) {
    incoming.store.setState({ isDirty: true, unsyncedQueueSize: 1 });
  }
  return { liveIsDirty: () => incoming.store.getState().isDirty };
}

function assertRetainedPremise(
  live: { readonly liveIsDirty: () => boolean },
  expectedLiveDirty: boolean,
): void {
  const registry = __getOpenEpicRegistryForTests();
  // `retainedCountForTests` is the only accessor that can see this - the public reads merge live and retained
  // deliberately - which is itself why the fix needs new plumbing.
  expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);
  // Half 2: the live session's dirtiness is pinned, so each arm states which of the three states it is in rather
  // than inheriting whatever the seeding happened to leave.
  expect(live.liveIsDirty()).toBe(expectedLiveDirty);
  // And the merged row exists off the retained buffer alone - which is exactly why `getUnsyncedEdits.length > 0`
  // cannot be the fix's predicate: it is equally true here and in the syncable case.
  expect(registry.getUnsyncedEdits().length).toBe(1);
}

/** "`installUpdate` was not called" alone is an absence, and the absence is also what a build that never wired
 * the button produces. */
async function expectPromptedInsteadOfInstalling(
  bridge: FakeAppUpdatesBridge,
  epicId: string,
): Promise<void> {
  // The dialog therefore opens a microtask after the click rather than inside it.
  await waitFor(() => {
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "update-unsynced-confirm",
    );
  });
  expect(bridge.installUpdate).not.toHaveBeenCalled();
  const dialog = useDesktopDialogStore.getState();
  expect(dialog.updateUnsyncedEpics.map((row) => row.epicId)).toEqual([epicId]);
  // And the work is still there to be decided about.
  expect(__getOpenEpicRegistryForTests().retainedCountForTests(epicId)).toBe(1);
}

/** Installs the desktop-only `appLifecycle` namespace this shell would carry, answering with work held by
 * another window. */
interface WindowWithRunnerHost {
  runnerHost?: unknown;
}

function installOtherWindowUnsyncable(
  entries: ReadonlyArray<{ readonly epicId: string; readonly title: string }>,
): () => void {
  return installAppLifecycle(() =>
    Promise.resolve({
      epics: entries.map((entry) => ({
        epicId: entry.epicId,
        title: entry.title,
        queueSize: 2,
        isDirty: true,
        unsyncable: true,
      })),
      otherWindowsUnknown: false,
    }),
  );
}

function installAppLifecycle(
  unsyncableWorkAcrossWindows: () => Promise<{
    readonly epics: ReadonlyArray<{
      readonly epicId: string;
      readonly title: string;
      readonly queueSize: number;
      readonly isDirty: boolean;
      readonly unsyncable: boolean;
    }>;
    readonly otherWindowsUnknown: boolean;
  }>,
): () => void {
  const target = window as Window & WindowWithRunnerHost;
  const previous = target.runnerHost;
  target.runnerHost = {
    appLifecycle: { unsyncableWorkAcrossWindows },
  };
  return () => {
    target.runnerHost = previous;
  };
}

describe("app update install vs a retained unsynced buffer", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    useDesktopDialogStore.getState().close();
    vi.restoreAllMocks();
  });

  it("the header button prompts instead of installing when work cannot be saved", async () => {
    const live = seedRetainedBuffer(false);
    assertRetainedPremise(live, false);

    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    fireEvent.click(await screen.findByTestId("app-update-header-button"));

    await expectPromptedInsteadOfInstalling(bridge, EPIC_ID);
  });

  it("the toast Restart prompts instead of installing when work cannot be saved", async () => {
    const live = seedRetainedBuffer(false);
    assertRetainedPremise(live, false);

    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });
    act(() => {
      bridge.emit(readySnapshot(1));
    });

    const content = toastMock.calls.last;
    if (content === null) {
      throw new Error("expected the ready-update toast to have been raised");
    }
    render(<>{content}</>);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));

    await expectPromptedInsteadOfInstalling(bridge, EPIC_ID);
  });

  /** The live half will drain through its transport; the retained half never can, and the restart destroys it
   * just the same - so this must prompt. */
  it("a retained buffer beside a DIRTY live session still prompts", async () => {
    const live = seedRetainedBuffer(true);
    assertRetainedPremise(live, true);

    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    fireEvent.click(await screen.findByTestId("app-update-header-button"));

    // Fires even though the live session is dirty: the predicate reads the retention alone. `retained &&
    // !liveDirty` would drop exactly this case.
    await expectPromptedInsteadOfInstalling(bridge, EPIC_ID);
  });

  /** This renderer's own registry is deliberately empty here: every other arm would pass on a build that never
   * asks main, and this one cannot. */
  it("prompts for a retained buffer held by ANOTHER window", async () => {
    const restore = installOtherWindowUnsyncable([
      { epicId: "epic-in-window-b", title: "Rewrite the onboarding" },
    ]);
    try {
      // Premise: nothing local. The old predicate answers "nothing to lose"
      // here, which is exactly the defect.
      expect(__getOpenEpicRegistryForTests().getUnsyncedEdits().length).toBe(0);

      const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
      renderWithHost(<AppUpdateHeaderButton />, bridge);

      fireEvent.click(await screen.findByTestId("app-update-header-button"));

      await waitFor(() => {
        expect(useDesktopDialogStore.getState().activeDialog).toBe(
          "update-unsynced-confirm",
        );
      });
      expect(bridge.installUpdate).not.toHaveBeenCalled();
      // Named, not merely counted: main's answer has to reach the dialog, or the user gets a confirmation about
      // nothing.
      expect(
        useDesktopDialogStore
          .getState()
          .updateUnsyncedEpics.map((row) => row.epicId),
      ).toEqual(["epic-in-window-b"]);
    } finally {
      restore();
    }
  });

  it("a REJECTED app-wide check fails closed: prompts (naming the unchecked windows) instead of installing on this window's answer", async () => {
    // Codex #1243 T-51: window A has nothing local; window B holds a retained buffer; the IPC that would have said
    // so rejects. A failed check is not a clean check.
    const restore = installAppLifecycle(() =>
      Promise.reject(new Error("ipc: main is not answering")),
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(__getOpenEpicRegistryForTests().getUnsyncedEdits().length).toBe(0);

      const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
      renderWithHost(<AppUpdateHeaderButton />, bridge);

      fireEvent.click(await screen.findByTestId("app-update-header-button"));

      await waitFor(() => {
        expect(useDesktopDialogStore.getState().activeDialog).toBe(
          "update-unsynced-confirm",
        );
      });
      expect(bridge.installUpdate).not.toHaveBeenCalled();
      const dialog = useDesktopDialogStore.getState();
      // Nothing local to name, and the prompt must say WHY it is up anyway.
      expect(dialog.updateUnsyncedEpics).toEqual([]);
      expect(dialog.updateUnsyncedOtherWindowsUnknown).toBe(true);
    } finally {
      errorSpy.mockRestore();
      restore();
    }
  });

  it("a RESOLVED app-wide check that main marked incomplete also fails closed", async () => {
    // What it also said is that a window missed its fresh-snapshot deadline and its cached row stood in, so that
    // empty list is a lower bound, not a census.
    const restore = installAppLifecycle(() =>
      Promise.resolve({ epics: [], otherWindowsUnknown: true }),
    );
    try {
      // Premise: this window holds nothing either, so the ONLY thing standing
      // between the click and an install is the flag under test.
      expect(__getOpenEpicRegistryForTests().getUnsyncedEdits().length).toBe(0);

      const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
      renderWithHost(<AppUpdateHeaderButton />, bridge);

      fireEvent.click(await screen.findByTestId("app-update-header-button"));

      await waitFor(() => {
        expect(useDesktopDialogStore.getState().activeDialog).toBe(
          "update-unsynced-confirm",
        );
      });
      expect(bridge.installUpdate).not.toHaveBeenCalled();
      expect(
        useDesktopDialogStore.getState().updateUnsyncedOtherWindowsUnknown,
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it("a syncable dirty session installs with NO prompt - b2a1097a is preserved", async () => {
    // The negative control, and the reason this fix is not a revert of #683. A dirty live session with no
    // retention still holds its transport and drains, which is the world the user removed the confirmation for.
    const registry = __getOpenEpicRegistryForTests();
    const handle = openStoreForTest({
      epicId: "epic-syncable",
      userId: null,
      // `handle.doc` still resolves because this harness builds the runtime in this thread.
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    });
    handle.doc.getMap("epic").set("title", "Syncable");
    handle.store.setState({ isDirty: true, unsyncedQueueSize: 2 });
    registry.acquireMounted("epic-syncable", () => handle);

    // Premise: there IS unsynced work, and none of it is unsyncable. Without
    // the first half this passes on an empty registry.
    expect(registry.getUnsyncedEdits().length).toBe(1);
    expect(registry.retainedCountForTests("epic-syncable")).toBe(0);

    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    fireEvent.click(await screen.findByTestId("app-update-header-button"));

    await waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });
});
