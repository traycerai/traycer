/**
 * The real artifact reference card over a real task session, for the cases that
 * prove what the card's READER does to the shared session: real
 * `BotArtifactReferenceCard`, real controller token, real tab commands, a real
 * authorised snapshot of a seeded task delivered through the in-process
 * runtime worker's stream, and the test-only browser frame driver.
 *
 * A test file that uses it declares the three `vi.mock`s itself (they are
 * hoisted per file): `@tanstack/react-router` (`useNavigate`), the sandbox
 * frame replaced by `ArtifactFrameBrowserDriver`, and the pane-visibility
 * hooks. It then calls `installReaderCardHarness()` once at the top level.
 */
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { BridgeMessageEventLike } from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { ListChatRecordsRequest } from "@traycer/protocol/host/epic/chat-records";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import { ReaderCardTree } from "@/components/bots/__tests__/artifact-reader-card-harness";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { __resetEpicParkingForTests } from "@/lib/epics/epic-parking";
import { answerArtifactObjectRead } from "@/lib/host/test-support/artifact-object-answer";
import { resetFakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";
import {
  createTestHostClient,
  createTestRemoteHostClient,
  resetTestHostClients,
  type TestHostHandlers,
} from "@/lib/host/test-support/test-host-client";
import {
  getEpicSessionController,
  type ArtifactReaderToken,
  type EpicSessionController,
} from "@/lib/registries/epic-session-controller";
import { __setEpicRuntimeWorkerFactoryForTests } from "@/lib/registries/epic-runtime-worker-factory-slot";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  defaultTestEpicSessionEnvironment,
  installTestEpicSessionEnvironment,
  setTestEffectiveHost,
  snapshotMeta,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import { setArtifactFieldsInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { createInProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { seedActiveEpicTabInTabsStore } from "@/stores/tabs/test-support/tabs-store-fixtures";
import {
  openEpicSource,
  resetStores,
} from "@/stores/tabs/test-support/tab-layout-test-support";

export const EPIC_ID = "task-card";
export const HOST_ID = "host-task";
export const ROW_KEY = "row-1";
export const VIEWER_ID = AUTHENTICATED_USER_FIXTURE_ID;
export const SERVER_TITLE = "Rollout plan";
/** The title the transcript authored for the card, distinct from the artifact's own. */
export const AUTHORED_TITLE = "Authored title";

export type ArtifactSurface = Extract<
  BotSurfaceReference,
  { kind: "artifact" }
>;

export const SURFACE: ArtifactSurface = {
  kind: "artifact",
  epicId: EPIC_ID,
  hostId: HOST_ID,
  artifactPath: "rollout/index.html",
  resolution: null,
};

/** A path no artifact of the seeded task answers. */
export const MISSING_PATH: ArtifactSurface = {
  ...SURFACE,
  artifactPath: "no-such-artifact/index.html",
};

/** What the run has seen, reset before each case. */
let acquireSpy: MockInstance<
  EpicSessionController["acquireArtifactReader"]
> | null = null;

export const seen = {
  objectReads: 0,
  /** The next this-many object reads find the object missing. */
  objectReadsToFail: 0,
  /** Worker constructions: one per session the registry built. */
  constructions: 0,
  /** Stream subscribes by any session. */
  subscribes: 0,
  /** Streams closed by the session that owned them. */
  streamCloses: 0,
  /** The real tokens the card acquired, in order (read off the call-through spy). */
  get tokens(): ArtifactReaderToken[] {
    return acquireSpy === null
      ? []
      : acquireSpy.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        );
  },
  /** While true, object reads wait until `releaseHeldObjectReads()`. */
  holdObjectReads: false,
  /** What the host answers the authority probe (`epic.listChatRecords`) with. */
  authority: "permitted" as "permitted" | "forbidden",
  authorityProbes: 0,
  /** The last authority probe request the host received. */
  lastProbe: null as ListChatRecordsRequest | null,
  /** Who the host client of every host is signed in as; null = the directory has no client for it. */
  clientUser: VIEWER_ID as string | null,
  /** When set, every host is a remote one published under this key; changing it is a key rotation. */
  remotePublicKey: null as string | null,
};

const heldObjectReads: Array<() => void> = [];

/** Let every object read that was held answer. */
export function releaseHeldObjectReads(): void {
  seen.holdObjectReads = false;
  for (const release of heldObjectReads.splice(0)) release();
}

const streamCallbacks = new Map<string, EpicStreamCallbacks>();
/** The message listeners of every worker the registry built, so a case can kill the live one. */
const workerListeners: Array<Set<(event: BridgeMessageEventLike) => void>> = [];
const queryClient = new QueryClient();
const handlers: TestHostHandlers = {
  "epic.readArtifactObject": (request) => {
    seen.objectReads += 1;
    if (seen.objectReadsToFail > 0) {
      seen.objectReadsToFail -= 1;
      return { kind: "unavailable", reason: "missing" };
    }
    const answer = answerArtifactObjectRead(
      request,
      "<html></html>",
      "text/html",
    );
    if (!seen.holdObjectReads) return answer;
    return new Promise((resolve) => {
      heldObjectReads.push(() => resolve(answer));
    });
  },
  "epic.listChatRecords": (request) => {
    seen.authorityProbes += 1;
    seen.lastProbe = request;
    if (seen.authority === "forbidden")
      throw new Error("The host refused: no access to this task.");
    return { kind: "snapshot", listStamp: null, chats: [] };
  },
};

const recordingStream: EpicStreamClientFactory = (epicId, callbacks) => {
  seen.subscribes += 1;
  streamCallbacks.set(epicId, callbacks);
  return {
    applyUpdate: () => undefined,
    awareness: () => undefined,
    applyArtifactRoomUpdate: () => undefined,
    artifactRoomAwareness: () => undefined,
    retryMigration: () => undefined,
    close: () => {
      seen.streamCloses += 1;
    },
  };
};

/** Observers the card registered, so a case decides what is on screen. */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    private readonly callback: (
      entries: Array<{ target: Element; isIntersecting: boolean }>,
    ) => void,
  ) {
    FakeIntersectionObserver.all.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  deliver(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
    this.callback(entries);
  }
  fire(isIntersecting: boolean): void {
    const entries = [...this.targets].map((target) => ({
      target,
      isIntersecting,
    }));
    if (entries.length > 0) this.callback(entries);
  }
}

/** Tell every observed card it is (not) in view, as the scroller would. */
export function intersectAll(isIntersecting: boolean): void {
  act(() => {
    for (const observer of FakeIntersectionObserver.all)
      observer.fire(isIntersecting);
  });
}

/** Tell only the cards inside `container` they are (not) in view. */
export function intersectIn(container: Element, isIntersecting: boolean): void {
  act(() => {
    for (const observer of FakeIntersectionObserver.all) {
      const entries = [...observer.targets]
        .filter((target) => container.contains(target))
        .map((target) => ({ target, isIntersecting }));
      if (entries.length > 0) observer.deliver(entries);
    }
  });
}

export function observedCardCount(): number {
  return FakeIntersectionObserver.all.reduce(
    (total, observer) => total + observer.targets.size,
    0,
  );
}

let previousAuth: AuthState;
const detaches: Array<() => void> = [];

/** The host client the directory would resolve for `hostId`, per the case's signed-in user and key. */
function hostClientFor(hostId: string) {
  if (seen.clientUser === null) return null;
  if (seen.remotePublicKey === null)
    return createTestHostClient(hostId, seen.clientUser, queryClient, handlers);
  return createTestRemoteHostClient({
    hostId,
    userId: seen.clientUser,
    publicKey: seen.remotePublicKey,
    queryClient,
    handlers,
  });
}

/** Registers the per-case setup and teardown; call once at a test file's top level. */
export function installReaderCardHarness(): void {
  beforeEach(() => {
    resetStores();
    streamCallbacks.clear();
    workerListeners.length = 0;
    FakeIntersectionObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    seen.objectReads = 0;
    seen.objectReadsToFail = 0;
    seen.constructions = 0;
    seen.subscribes = 0;
    seen.streamCloses = 0;
    acquireSpy = null;
    seen.holdObjectReads = false;
    seen.authority = "permitted";
    seen.authorityProbes = 0;
    seen.lastProbe = null;
    seen.clientUser = VIEWER_ID;
    seen.remotePublicKey = null;
    heldObjectReads.length = 0;
    resetTestHostClients();
    __getOpenEpicRegistryForTests().disposeAll();
    __resetEpicParkingForTests();
    __setAgentActivityPlaneAnsweringForTests();
    resetFakeDurableStreamTransports();
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      resolveHostClient: hostClientFor,
    });
    setTestEffectiveHost(HOST_ID, true);
    __setEpicRuntimeWorkerFactoryForTests(() => {
      seen.constructions += 1;
      const worker = createInProcessEpicRuntimeWorker({
        streamClientFactory: recordingStream,
        laneSelection: null,
      }).createWorker();
      const listeners = new Set<(event: BridgeMessageEventLike) => void>();
      workerListeners.push(listeners);
      const addEventListener = worker.addEventListener.bind(worker);
      worker.addEventListener = (type, listener) => {
        listeners.add(listener);
        addEventListener(type, listener);
      };
      return worker;
    });
    previousAuth = useAuthStore.getState();
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: VIEWER_ID,
        userName: "Viewer",
        email: "viewer@example.com",
        avatarUrl: null,
      },
      contextMetadata: { userId: VIEWER_ID, username: "Viewer" },
    });
  });

  afterEach(() => {
    cleanup();
    for (const detach of detaches.splice(0)) detach();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __getOpenEpicRegistryForTests().disposeAll();
    __resetAgentActivityStoreForTests();
    __setEpicRuntimeWorkerFactoryForTests(null);
    useAuthStore.setState(previousAuth, true);
  });
}

const SERVER_SHA = "a".repeat(64);
const SERVER_CLIENT_ID = 1;
const LOCAL_CLIENT_ID = 2;

function seedArtifact(doc: Y.Doc, title: string, sha: string): void {
  setArtifactFieldsInDocForTests(doc, "artifact-rollout", {
    kind: "html",
    title,
    folderName: "rollout",
    parentId: null,
    createdAt: 1,
    updatedAt: 2,
    createdManually: true,
    head: {
      files: {
        "index.html": {
          sha256: sha,
          byteLength: 13,
          mediaType: "text/html",
          status: "published",
        },
      },
      capturedAt: 5,
    },
  });
}

/** The task as the host serves it. */
export function serverUpdate(): Uint8Array {
  const donor = new Y.Doc();
  // Fixed identities: every build of the served task is the same operations,
  // so an edit made on top of it and the delivered snapshot never race.
  donor.clientID = SERVER_CLIENT_ID;
  seedArtifact(donor, SERVER_TITLE, SERVER_SHA);
  const update = Y.encodeStateAsUpdate(donor);
  donor.destroy();
  return update;
}

/** A LOCAL edit the host has not seen: the artifact renamed, on top of the served task. */
export function localTitleEdit(title: string): Uint8Array {
  const donor = new Y.Doc();
  Y.applyUpdate(donor, serverUpdate());
  donor.clientID = LOCAL_CLIENT_ID;
  seedArtifact(donor, title, SERVER_SHA);
  const update = Y.encodeStateAsUpdate(donor);
  donor.destroy();
  return update;
}

/** The artifact's entry record changes (a save): the same task with a new head on top of what is served. */
export function localHeadEdit(sha: string): Uint8Array {
  const donor = new Y.Doc();
  Y.applyUpdate(donor, serverUpdate());
  donor.clientID = LOCAL_CLIENT_ID;
  seedArtifact(donor, SERVER_TITLE, sha);
  const update = Y.encodeStateAsUpdate(donor);
  donor.destroy();
  return update;
}

/** The host answering the task's subscribe: open, then the served task. */
export function deliverSnapshot(): void {
  deliverSnapshotTo(EPIC_ID);
}

/** The same, for any task whose session has opened its stream. */
export function deliverSnapshotTo(epicId: string): void {
  const callbacks = streamCallbacks.get(epicId);
  if (callbacks === undefined) throw new Error(`${epicId} opened no stream`);
  const update = serverUpdate();
  act(() => {
    callbacks.onConnectionStatus("open", null, false, null);
    callbacks.onSnapshot(snapshotMeta(epicId), update);
  });
}

/** A fatal close from the host, by code, through the session's own stream callback. */
export function failStream(code: string): void {
  const callbacks = streamCallbacks.get(EPIC_ID);
  if (callbacks === undefined) throw new Error("the task opened no stream");
  const details: FatalErrorDetails = {
    code,
    reason: `The host closed the task: ${code}.`,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
  act(() => {
    callbacks.onConnectionStatus(
      "closed",
      { kind: "fatalError", details },
      false,
      null,
    );
  });
}

/** The runtime worker of the most recently built session dies, as it does on an unrecoverable fault. */
export function killLatestWorker(): void {
  const listeners = workerListeners.at(-1);
  if (listeners === undefined) throw new Error("no worker was built");
  act(() => {
    for (const listener of [...listeners]) {
      listener({
        data: {
          frame: "event",
          event: {
            kind: "fatal",
            message: "the runtime worker died",
            stack: null,
          },
        },
      });
    }
  });
}

/** The host reconnecting: no error, the session still has its content. */
export function reconnectStream(): void {
  const callbacks = streamCallbacks.get(EPIC_ID);
  if (callbacks === undefined) throw new Error("the task opened no stream");
  act(() => {
    callbacks.onConnectionStatus("reconnecting", null, true, null);
  });
}

/** A task tab in the committed strip with a pane showing it, so it builds the session. */
export function openShownTaskTab(): { readonly tabId: string } {
  const { tabId } = openEpicSource(EPIC_ID, "Task");
  seedActiveEpicTabInTabsStore(tabId);
  __syncEpicParkingOpenTabsForTests();
  detaches.push(getEpicSessionController().attachSurface(EPIC_ID, tabId));
  return { tabId };
}

/** The pane showing the tab goes away (the tab stays open but hidden). */
export function detachTaskSurfaces(): void {
  for (const detach of detaches.splice(0)) detach();
}

/** The real close; then what the app does as the pane unmounts and membership is re-told. */
export function closeTab(tabId: string): void {
  expect(tabCommandCoordinator.closeRef({ kind: "epic", id: tabId })).toBe(
    true,
  );
  for (const detach of detaches.splice(0)) detach();
  __syncEpicParkingOpenTabsForTests();
}

/** The real card; the controller's own `acquireArtifactReader` is spied THROUGH so each real token can be read back. */
export function mountCard(
  surface: ArtifactSurface,
  rowKey: string,
): RenderResult {
  const controller = getEpicSessionController();
  // Spied once, calling through: a second card in the same case reuses the
  // spy, and every real token it returned is read back off it.
  acquireSpy ??= vi.spyOn(controller, "acquireArtifactReader");
  return render(
    createElement(ReaderCardTree, {
      surface,
      rowKey,
      title: AUTHORED_TITLE,
      queryClient,
    }),
  );
}

/** A task tab and a card on it, the card in view and the served task delivered. */
export async function showCardOnTask(surface: ArtifactSurface): Promise<{
  readonly tabId: string;
  readonly view: RenderResult;
}> {
  const { tabId } = openShownTaskTab();
  const view = mountCard(surface, ROW_KEY);
  intersectAll(true);
  await waitFor(() => expect(streamCallbacks.has(EPIC_ID)).toBe(true));
  deliverSnapshot();
  return { tabId, view };
}

/** The card admitted and showing the artifact's frame, its entry read made. */
export async function showCardAndFrame(): Promise<{
  readonly tabId: string;
  readonly view: RenderResult;
}> {
  const shown = await showCardOnTask(SURFACE);
  await screen.findByTestId("artifact-frame-driver");
  await waitFor(() => expect(seen.objectReads).toBeGreaterThan(0));
  return shown;
}

/** A card with no tab: only the reader holds the session. */
export async function showCardAlone(
  surface: ArtifactSurface,
  rowKey: string,
): Promise<RenderResult> {
  const view = mountCard(surface, rowKey);
  intersectAll(true);
  await waitFor(() => expect(streamCallbacks.has(EPIC_ID)).toBe(true));
  return view;
}

export function admittedHandle(): OpenEpicStoreHandle {
  const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
  if (handle === null) throw new Error("the task has no live session");
  return handle;
}

/** The figure's accessible name: the card's visible title, or the generic one. */
export function figureLabel(): string | null {
  return screen.getByTestId("artifact-row").getAttribute("aria-label");
}

/** `count` other tasks, each with a tab a pane is showing, through the real attach path. */
export function openShownTabs(
  count: number,
  prefix: string,
): { readonly firstTabId: string } {
  const controller = getEpicSessionController();
  const canvas = useEpicCanvasStore.getState();
  let firstTabId = "";
  for (let index = 0; index < count; index += 1) {
    const epicId = `${prefix}-${String(index)}`;
    const tabId = canvas.openEpicTab(epicId, "Other");
    if (index === 0) {
      firstTabId = tabId;
      seedActiveEpicTabInTabsStore(tabId);
    }
    __syncEpicParkingOpenTabsForTests();
    controller.attachSurface(epicId, tabId);
  }
  return { firstTabId };
}

/** The first real token the card acquired; throws when it acquired none. */
export function firstToken(): ArtifactReaderToken {
  const token = seen.tokens.at(0);
  if (token === undefined) throw new Error("the card acquired no reader");
  return token;
}
