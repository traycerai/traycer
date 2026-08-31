import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  WorkspaceFileListEntry,
  WorkspaceSubscribeFileListServerFrame,
} from "@traycer/protocol/host/workspace/subscribe";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import {
  fileTreeExpansionScopeKey,
  useFileTreeStore,
} from "@/stores/file-tree/file-tree-store";
import {
  useWorkspaceFileListSubscription,
  __resetWorkspaceFileListSubscriptionsForTesting,
  type WorkspaceFileListSubscriptionResult,
} from "../use-workspace-file-list-subscription";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";
const WORKSPACE_PATH = "/work/repo";

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrames: StreamFrameEnvelope[] = [];
  closed = false;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(envelope: StreamFrameEnvelope): void {
    this.clientFrames.push(envelope);
  }

  /** Never negotiates: this fake exercises no version-dependent path. */
  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(frame: WorkspaceSubscribeFileListServerFrame): void {
    this.serverFrameHandler?.(frame, null);
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }

  takeFrames(kind: "watch" | "unwatch"): ReadonlyArray<ReadonlyArray<string>> {
    return this.clientFrames
      .filter((frame) => frame.kind === kind)
      .map((frame) => frame["directoryPaths"] as ReadonlyArray<string>);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly sessions: MockStreamSession[] = [];

  constructor() {
    super({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    const session = new MockStreamSession();
    this.sessions.push(session);
    return session;
  }

  get onlySession(): MockStreamSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error("no session opened");
    return session;
  }
}

function file(path: string): WorkspaceFileListEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: "file",
    ignored: false,
  };
}

function directory(path: string): WorkspaceFileListEntry {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return {
    path,
    name: segments.at(-1) ?? path,
    kind: "directory",
    ignored: false,
  };
}

function listing(
  directoryPath: string,
  entries: ReadonlyArray<WorkspaceFileListEntry>,
): WorkspaceSubscribeFileListServerFrame {
  return {
    kind: "listing",
    directoryPath,
    entries: [...entries],
    truncated: false,
    hasBinaryPayload: false,
  };
}

function setExpanded(paths: ReadonlyArray<string>): void {
  act(() => {
    useFileTreeStore
      .getState()
      .setExpandedPaths(EPIC_ID, HOST_ID, WORKSPACE_PATH, paths);
  });
}

function renderSubscription(
  client: MockWsStreamClient,
  queryClient: QueryClient,
) {
  const wrapper = (props: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <StreamRuntimeContext.Provider
        value={{ wsStreamClient: client, hostId: null }}
      >
        {props.children}
      </StreamRuntimeContext.Provider>
    </QueryClientProvider>
  );
  return renderHook<WorkspaceFileListSubscriptionResult, void>(
    () =>
      useWorkspaceFileListSubscription({
        epicId: EPIC_ID,
        hostId: HOST_ID,
        workspacePath: WORKSPACE_PATH,
        enabled: true,
        streamClient: undefined,
        expandedPathsOverride: null,
        onPrunedOverride: null,
      }),
    { wrapper },
  );
}

describe("useWorkspaceFileListSubscription", () => {
  beforeEach(() => {
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  afterEach(() => {
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  it("projects the root listing the stream opens with", async () => {
    const client = new MockWsStreamClient();
    const { result } = renderSubscription(client, new QueryClient());

    expect(result.current.isPending).toBe(true);
    act(() => {
      client.onlySession.emitFrame(
        listing("", [directory("src/"), file("readme.md")]),
      );
    });

    await waitFor(() => {
      expect([...result.current.paths].toSorted()).toEqual([
        "readme.md",
        "src/",
      ]);
    });
    expect(result.current.isPending).toBe(false);
  });

  it("watches on expand and unwatches (dropping the rows) on collapse", async () => {
    const client = new MockWsStreamClient();
    const { result } = renderSubscription(client, new QueryClient());
    act(() => {
      client.onlySession.emitFrame(listing("", [directory("src/")]));
    });

    setExpanded(["src/"]);
    expect(client.onlySession.takeFrames("watch")).toEqual([["src/"]]);

    act(() => {
      client.onlySession.emitFrame(listing("src/", [file("src/main.ts")]));
    });
    await waitFor(() => {
      expect(result.current.paths).toContain("src/main.ts");
    });

    setExpanded([]);
    expect(client.onlySession.takeFrames("unwatch")).toEqual([["src/"]]);
    // An unwatched directory is no longer live, so its rows go with it.
    await waitFor(() => {
      expect(result.current.paths).not.toContain("src/main.ts");
    });
  });

  it("sends one batched, ancestors-first watch frame on reconnect", () => {
    const client = new MockWsStreamClient();
    renderSubscription(client, new QueryClient());
    setExpanded(["src/", "src/lib/"]);
    const session = client.onlySession;
    expect(session.takeFrames("watch")).toEqual([["src/", "src/lib/"]]);

    act(() => {
      session.emitStatus("reconnecting", null);
      session.emitStatus("open", null);
    });

    // A resubscribe covers only the root, so the whole restored set goes back
    // up as ONE frame - not one frame per directory.
    expect(session.takeFrames("watch")).toEqual([
      ["src/", "src/lib/"],
      ["src/", "src/lib/"],
    ]);
  });

  it("never watches a directory whose parent is collapsed", () => {
    const client = new MockWsStreamClient();
    renderSubscription(client, new QueryClient());

    // `src/lib/` stays remembered so re-expanding `src/` restores it, but the
    // contract refuses a watch whose parent is not covered.
    setExpanded(["src/lib/"]);

    expect(client.onlySession.takeFrames("watch")).toEqual([]);
  });

  it("drops pruned directories with their descendants and collapses them", async () => {
    const client = new MockWsStreamClient();
    const { result } = renderSubscription(client, new QueryClient());
    setExpanded(["src/", "src/lib/"]);
    act(() => {
      client.onlySession.emitFrame(listing("", [directory("src/")]));
      client.onlySession.emitFrame(listing("src/", [directory("src/lib/")]));
      client.onlySession.emitFrame(listing("src/lib/", [file("src/lib/a.ts")]));
    });
    await waitFor(() => {
      expect(result.current.paths).toContain("src/lib/a.ts");
    });

    act(() => {
      client.onlySession.emitFrame({
        kind: "pruned",
        directoryPaths: ["src/"],
        reason: "missing",
        hasBinaryPayload: false,
      });
    });

    // The pruned subtree is gone; the `src/` row itself survives on the root's
    // (not yet refreshed) listing, exactly as the contract describes.
    await waitFor(() => {
      expect(result.current.paths).toEqual(["src/"]);
    });
    expect(
      useFileTreeStore.getState().expandedPathsByScope[
        fileTreeExpansionScopeKey(EPIC_ID, HOST_ID, WORKSPACE_PATH)
      ],
    ).toBeUndefined();
  });

  it("shares one session across consumers and closes it with the last one", async () => {
    const client = new MockWsStreamClient();
    // One QueryClient, as in the app: the shared entry publishes into it once
    // and every consumer's mirror reads the same slot.
    const queryClient = new QueryClient();
    const first = renderSubscription(client, queryClient);
    const second = renderSubscription(client, queryClient);

    expect(client.sessions).toHaveLength(1);
    act(() => {
      client.onlySession.emitFrame(listing("", [file("readme.md")]));
    });
    await waitFor(() => {
      expect(second.result.current.paths).toEqual(["readme.md"]);
    });

    first.unmount();
    expect(client.onlySession.closed).toBe(false);

    second.unmount();
    expect(client.onlySession.closed).toBe(true);
  });

  it("surfaces a terminal close instead of staying pending forever", () => {
    const client = new MockWsStreamClient();
    const { result } = renderSubscription(client, new QueryClient());

    act(() => {
      client.onlySession.emitStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "unknown method",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toContain("INCOMPATIBLE");
  });
});
