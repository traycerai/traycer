import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

/**
 * REPRODUCTION - an app-update install destroys a RETAINED unsynced buffer
 * with nothing asked.
 *
 * Scoped deliberately to a retained buffer rather than to "any unsynced
 * edits". A dirty session that still holds a transport drains through it, and
 * `b2a1097a` removed the restart confirmation on exactly that reasoning; a
 * reproduction seeded with a generic dirty session would therefore reproduce a
 * case we are deliberately NOT fixing, and a fix built from it would revert
 * that commit. Retention is the narrower state `30819ce6` created three weeks
 * afterwards: `retainDirtyHandle` calls `detachTransport()`, so the buffer is
 * a live `Y.Doc` with no socket, un-syncable by construction.
 *
 * Every arm asserts its premise positively before anything is clicked, and
 * names WHICH of the three states it is in rather than inheriting whatever the
 * seeding happened to leave: a retained buffer exists, and the live session is
 * explicitly clean or explicitly dirty. Neither half alone identifies the case
 * - "an unsynced row exists" is equally true of the syncable case, and "the
 * live session is clean" is true of a healthy app with nothing pending at all.
 *
 * The clean arms isolate the case; the dirty arm exists so the isolation is
 * not mistaken for the fix's trigger. A reproduction narrows deliberately, and
 * a predicate must not inherit that narrowing - see the mixed-case arm at the
 * bottom for the predicate this distinction rules out.
 */

/**
 * The toast never reaches the DOM on its own - `showAppUpdateToast` hands its
 * content to sonner, which owns the host. Mocked so the fixture can render the
 * real toast content and click the real "Restart" affordance, rather than
 * calling the `onRestart` callback directly: invoking the handler would prove
 * the handler installs, not that the SURFACE a user actually clicks does.
 */
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
    lastCheckedAt: "2026-06-15T00:00:00.000Z",
    lastCheckIntent: "automatic",
  };
}

class FakeAppUpdatesBridge implements DesktopAppUpdatesBridge {
  snapshot: DesktopAppUpdateSnapshot;
  readonly downloadUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  readonly installUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  readonly setAllowPrerelease = vi.fn(() => Promise.resolve(this.snapshot));
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

/**
 * Drives the real retention path rather than poking the registry's internals:
 * a dirty outgoing handle replaced by a clean incoming one is what
 * `replaceMounted` turns into a retention, and `retainDirtyHandle` is what
 * detaches its transport. Constructing the retained state any other way would
 * be testing a state the product cannot reach.
 */
function seedRetainedBuffer(liveDirty: boolean): {
  readonly liveIsDirty: () => boolean;
} {
  const registry = __getOpenEpicRegistryForTests();
  const outgoing = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  outgoing.doc.getMap("epic").set("title", "Rewrite the onboarding");
  outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
  registry.acquireMounted(EPIC_ID, () => outgoing);

  const incoming = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  registry.replaceMounted(EPIC_ID, outgoing, incoming, {
    hostStamp: "host-a",
    ownerIdentityKey: "key-a",
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
  // Half 1: the un-syncable buffer really is retained. `retainedCountForTests`
  // is the ONLY accessor that can see this - the public reads merge live and
  // retained deliberately - which is itself why the fix needs new plumbing.
  expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);
  // Half 2: the live session's dirtiness is PINNED, so each arm states which
  // of the three states it is in rather than inheriting whatever the seeding
  // happened to leave. The clean arms are what keep this fixture off the
  // syncable case that `b2a1097a` deliberately left alone.
  expect(live.liveIsDirty()).toBe(expectedLiveDirty);
  // And the merged row exists off the retained buffer alone - which is exactly
  // why `getUnsyncedEdits().length > 0` cannot be the fix's predicate: it is
  // equally true here and in the syncable case.
  expect(registry.getUnsyncedEdits().length).toBe(1);
}

/**
 * The fixed behaviour, asserted as a POSITIVE consequence.
 *
 * "`installUpdate` was not called" alone is an absence, and the absence is also
 * what a build that never wired the button produces - so it is paired with the
 * confirmation actually being raised, NAMING the epic whose work is at risk.
 * A gate that fired but raised nothing would be a worse bug than the one being
 * fixed: the user would click Restart and simply get nothing.
 */
function expectPromptedInsteadOfInstalling(
  bridge: FakeAppUpdatesBridge,
  epicId: string,
): void {
  expect(bridge.installUpdate).not.toHaveBeenCalled();
  const dialog = useDesktopDialogStore.getState();
  expect(dialog.activeDialog).toBe("update-unsynced-confirm");
  expect(dialog.updateUnsyncedEpics.map((row) => row.epicId)).toEqual([epicId]);
  // And the work is still there to be decided about.
  expect(
    __getOpenEpicRegistryForTests().retainedCountForTests(epicId),
  ).toBe(1);
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

    expectPromptedInsteadOfInstalling(bridge, EPIC_ID);
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

    expectPromptedInsteadOfInstalling(bridge, EPIC_ID);
  });

  /**
   * The MIXED case, and the one a predicate mirroring this fixture's premise
   * pair would silently drop.
   *
   * An epic can hold a retained buffer AND a dirty live session at once. The
   * live half will drain through its transport; the retained half never can,
   * and the restart destroys it just the same - so this must prompt. A
   * predicate written as `retained && !liveDirty`, which is the natural thing
   * to write from the two arms above, drops exactly this case, and drops it in
   * the direction of data loss.
   *
   * `unsyncableWork()` must therefore read the retained bucket ALONE and ignore
   * live state entirely - which is also the honest reading of its name: which
   * work here can never sync? Without this arm the two candidate predicates are
   * indistinguishable on the fixture set.
   */
  it("a retained buffer beside a DIRTY live session still prompts", async () => {
    const live = seedRetainedBuffer(true);
    assertRetainedPremise(live, true);

    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    fireEvent.click(await screen.findByTestId("app-update-header-button"));

    // Fires even though the live session is dirty: the predicate reads the
    // retention ALONE. `retained && !liveDirty` would drop exactly this case.
    expectPromptedInsteadOfInstalling(bridge, EPIC_ID);
  });

  it("a syncable dirty session installs with NO prompt - b2a1097a is preserved", async () => {
    // The negative control, and the reason this fix is not a revert of #683.
    // A dirty LIVE session with no retention still holds its transport and
    // drains, which is the world the user removed the confirmation for. If this
    // ever starts prompting, the scope has widened into their decision.
    const registry = __getOpenEpicRegistryForTests();
    const handle = createOpenEpicStore({
      epicId: "epic-syncable",
      streamClientFactory: noopStreamClientFactory,
      userId: null,
      onAuthError: null,
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

    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });
});
