import type { BrowserPeekNode } from "@/components/epic-canvas/renderers/browser-peek-tile";
import type {
  MediaPeer,
  MediaPeerHandlers,
} from "@/lib/browser-view/tiles/webrtc-media-registry";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";

type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export class FakeStreamSession {
  readonly sentFrames: Array<Record<string, unknown>> = [];
  private serverHandler:
    | ((
        envelope: Record<string, unknown>,
        binaryPayload: Uint8Array | null,
      ) => void)
    | null = null;
  private statusHandler: ((status: StreamStatus, reason: null) => void) | null =
    null;
  private currentStatus: StreamStatus = "connecting";
  closed = false;

  /**
   * Drops anything handed to it before the stream is open or after it is
   * closed, exactly as `WsStreamSession.sendClientFrame` does while it is
   * disposed or its phase is not `subscribed` - silently, with no retry. A
   * fixture that recorded regardless
   * is what let a viewport bridge which only ever wrote into the pre-subscribe
   * window pass its tests and state nothing in the field.
   */
  sendClientFrame(frame: Record<string, unknown>): void {
    if (this.closed || this.currentStatus !== "open") return;
    this.sentFrames.push(frame);
  }

  onServerFrame(
    handler: (
      envelope: Record<string, unknown>,
      binaryPayload: Uint8Array | null,
    ) => void,
  ): void {
    this.serverHandler = handler;
  }

  onStatusChange(handler: (status: StreamStatus, reason: null) => void): void {
    this.statusHandler = handler;
    if (this.currentStatus === "open") handler("open", null);
  }

  close(): void {
    this.closed = true;
  }

  emitStatus(status: StreamStatus): void {
    this.currentStatus = status;
    this.statusHandler?.(status, null);
  }

  emit(
    envelope: Record<string, unknown>,
    binaryPayload: Uint8Array | null,
  ): void {
    this.serverHandler?.(envelope, binaryPayload);
  }
}

export class FakeStreamClient {
  readonly sessions: FakeStreamSession[] = [];
  readonly subscribes: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];

  constructor(private readonly autoOpen: boolean) {}

  subscribe(method: string, params: unknown): FakeStreamSession {
    const session = new FakeStreamSession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    if (this.autoOpen) session.emitStatus("open");
    return session;
  }
}

/**
 * Shared `beforeEach`-populated state behind the tile's hook mocks below.
 * Every suite owns its own instance via `vi.hoisted` (module state is
 * per-test-file), then wires it into the mock factories here.
 */
export interface PeekHookState {
  streamClient: FakeStreamClient | null;
  visible: boolean;
}

/** The one `BrowserPeekNode` every non-WebRTC suite renders against. */
export const PEEK_NODE: BrowserPeekNode = {
  id: "browser-peek-headless-1",
  instanceId: "peek-instance-1",
  hostId: "host-test",
  sessionId: "headless-1",
  tabId: "headless-tab-1",
  initialUrl: "http://localhost:3000",
};

/**
 * A fresh node per test for the WebRTC suites: the media registry is
 * module-scoped and its entries outlive a test by the release grace, so a
 * shared session id would carry a previous test's round into the next one.
 */
export function makeFreshPeekNode(
  sessionPrefix: string,
): () => BrowserPeekNode {
  let counter = 0;
  return () => {
    counter += 1;
    return {
      id: "browser-peek-headless-1",
      instanceId: "peek-instance-1",
      hostId: "host-test",
      sessionId: `${sessionPrefix}-${counter}`,
      tabId: "headless-tab-1",
      initialUrl: "http://localhost:3000",
    };
  };
}

/** Latest stream session (React StrictMode remount may open more than one). */
export function liveStream(hookState: {
  readonly streamClient: FakeStreamClient | null;
}): FakeStreamSession {
  const stream = hookState.streamClient?.sessions.at(-1);
  if (stream === undefined) {
    throw new Error("expected browser.sessions stream");
  }
  return stream;
}

export function tabHostIdModule(): { useTabHostId: () => string } {
  return { useTabHostId: () => "host-test" };
}

export function tileBodyVisibleModule(hookState: PeekHookState): {
  useTileBodyVisible: () => boolean;
} {
  return { useTileBodyVisible: () => hookState.visible };
}

export function hostDirectoryEntryModule(): {
  useHostDirectoryEntry: () => { hostId: string };
} {
  return { useHostDirectoryEntry: () => ({ hostId: "host-test" }) };
}

export function hostStreamClientForModule(hookState: PeekHookState): {
  useHostStreamClientFor: () => FakeStreamClient | null;
} {
  return { useHostStreamClientFor: () => hookState.streamClient };
}

/**
 * The toolbar/input-capture suites additionally read the authenticated-key
 * helpers off this module (armed-store ownership keys); the WebRTC suites
 * never touch them.
 */
export function hostStreamClientForWithAuthModule(hookState: PeekHookState): {
  useHostStreamClientFor: () => FakeStreamClient | null;
  authenticatedHostStreamKey: () => string;
  authenticatedOwnerIdentityKey: () => string;
} {
  return {
    useHostStreamClientFor: () => hookState.streamClient,
    authenticatedHostStreamKey: () => "authenticated-host-test",
    authenticatedOwnerIdentityKey: () => "local\u0000host-test\u0000user-test",
  };
}

/**
 * The `tile` control tier. `screencastRoleForShell` reads `browserView` off
 * the runner host and a bare test tree has no `RunnerHostProvider` at all, so
 * without this a peek suite renders the read-only `viewer` presentation (H12)
 * and there is no arm affordance left to drive.
 */
export function tileRoleRunnerHostModule(): {
  useRunnerHostOrNull: () => { browserView: object };
} {
  return { useRunnerHostOrNull: () => ({ browserView: {} }) };
}

/**
 * The runner bridge behind the toolbar's "open in default browser" affordance,
 * which only renders once a runner host exists - so it is exactly the suites
 * that declare the `tile` role above that need it. Stubbed rather than
 * provided, because the real hook is a react-query mutation and these trees
 * carry no `QueryClientProvider`.
 */
export function runnerOpenExternalLinkModule(): {
  useRunnerOpenExternalLink: () => {
    isPending: boolean;
    mutate: (url: string) => void;
  };
} {
  return {
    useRunnerOpenExternalLink: () => ({
      isPending: false,
      mutate: (_url: string) => {},
    }),
  };
}

export function streamAuthRevalidatorModule(): {
  useStreamAuthRevalidator: () => null;
} {
  return { useStreamAuthRevalidator: () => null };
}

export function epicNestedFocusNavigationModule(): {
  useEpicNestedFocusNavigation: () => (
    epicId: string,
    tabId: string,
    prepare: () => unknown,
  ) => unknown;
} {
  return {
    useEpicNestedFocusNavigation:
      () =>
      (_epicId: string, _tabId: string, prepare: () => unknown): unknown =>
        prepare(),
  };
}

/** Releases the screencast-armed store's held owner between tests. */
export function clearScreencastOwner(): void {
  const store = useScreencastArmedStore.getState();
  if (store.ownerId !== null) store.release(store.ownerId);
}

/**
 * The `createBrowserMediaPeer` fake shared by every suite that drives the
 * video plane through the real `webrtc-media-registry`: jsdom has no
 * `RTCPeerConnection`, so only the peer connection is stood in, through the
 * registry's own `createPeer` seam. Gathering finishes before the answer
 * settles - the A12 batching mechanics are `webrtc-media-registry.test.ts`'s
 * to pin, not this fake's.
 */
export function createFakeMediaPeer(
  peers: Array<{ readonly handlers: MediaPeerHandlers; closed: boolean }>,
): (handlers: MediaPeerHandlers) => MediaPeer {
  return (handlers) => {
    const peer = { handlers, closed: false };
    peers.push(peer);
    return {
      answerOffer: (sdp) => {
        handlers.onIceGatheringComplete();
        return Promise.resolve(`answer-for:${sdp}`);
      },
      addRemoteCandidate: () => Promise.resolve(),
      getStats: () => Promise.resolve(new Map()),
      close: () => {
        peer.closed = true;
      },
    };
  };
}

/** Wraps {@link createFakeMediaPeer} as a `vi.mock` factory for the registry module. */
export function fakeMediaPeerModule(
  peers: Array<{ readonly handlers: MediaPeerHandlers; closed: boolean }>,
): (
  original: () => Promise<
    typeof import("@/lib/browser-view/tiles/webrtc-media-registry")
  >,
) => Promise<typeof import("@/lib/browser-view/tiles/webrtc-media-registry")> {
  return async (original) => {
    const actual = await original();
    return { ...actual, createBrowserMediaPeer: createFakeMediaPeer(peers) };
  };
}

/** jsdom has no `MediaStream`; only its identity travels to `srcObject`. */
export function fakeMediaStream(id: string): MediaStream {
  const partial: Pick<MediaStream, "id"> = { id };
  return partial as MediaStream;
}
