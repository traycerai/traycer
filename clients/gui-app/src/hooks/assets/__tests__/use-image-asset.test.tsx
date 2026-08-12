import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { AssetStreamServerFrame } from "@traycer/protocol/host/asset-stream-schemas";
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

import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { useImageAsset, type ImageAssetRequest } from "../use-image-asset";
import type { AssetStreamFailureReason } from "@traycer-clients/shared/host-transport/asset-stream-client";

const tabHostIdRef = vi.hoisted(() => ({ value: "host-1" }));
const wsStreamClientRef = vi.hoisted(() => ({
  value: null as WsStreamClient<HostStreamRpcRegistry> | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => tabHostIdRef.value,
}));

vi.mock("@/lib/host", () => ({
  useHostDirectory: () => ({
    onChange: () => ({ dispose() {} }),
    findById: () => null,
  }),
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => wsStreamClientRef.value,
}));

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(
    frame: AssetStreamServerFrame,
    binaryPayload: Uint8Array | null,
  ): void {
    const handler = this.serverFrameHandler;
    if (handler === null) return;
    const envelope = { ...frame } satisfies StreamFrameEnvelope;
    handler(envelope, binaryPayload);
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly sessions: MockStreamSession[] = [];
  readonly requests: { readonly method: string; readonly params: unknown }[] =
    [];

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
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
    method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    const session = new MockStreamSession();
    this.sessions.push(session);
    this.requests.push({ method, params });
    return session;
  }
}

const WORKSPACE_REQUEST: ImageAssetRequest = {
  method: "workspace",
  workspacePath: "/repo",
  filePath: "images/logo.png",
};

const GIT_REQUEST: ImageAssetRequest = {
  method: "git",
  runningDir: "/repo",
  filePath: "images/logo.png",
  previousPath: "images/old-logo.png",
  side: "old",
  stage: "staged",
};

interface PaneTestState {
  focused: boolean;
  visible: boolean;
}

function makePaneWrapper(state: PaneTestState) {
  return ({ children }: { readonly children: ReactNode }) => (
    <PaneSurfaceActivityContext.Provider
      value={{ focused: state.focused, visible: state.visible }}
    >
      <PaneVisibilityContext.Provider value={state.visible}>
        {children}
      </PaneVisibilityContext.Provider>
    </PaneSurfaceActivityContext.Provider>
  );
}

function headerFrame(
  contentIdentity: string,
  sizeBytes: number,
): AssetStreamServerFrame {
  return {
    kind: "assetHeader",
    hasBinaryPayload: false,
    mediaType: "image/png",
    sizeBytes,
    width: 120,
    height: 80,
    contentIdentity,
  };
}

function emitHeader(
  session: MockStreamSession,
  contentIdentity: string,
  sizeBytes: number,
): void {
  session.emitFrame(headerFrame(contentIdentity, sizeBytes), null);
}

function emitBytes(session: MockStreamSession, bytes: readonly number[]): void {
  session.emitFrame(
    {
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: bytes.length,
    },
    new Uint8Array(bytes),
  );
  session.emitFrame({ kind: "assetComplete", hasBinaryPayload: false }, null);
}

function emitLengthMismatchAfterHeader(session: MockStreamSession): void {
  session.emitFrame(
    {
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 1,
    },
    new Uint8Array([1]),
  );
  session.emitFrame({ kind: "assetComplete", hasBinaryPayload: false }, null);
}

function emitFailure(
  session: MockStreamSession,
  reason: AssetStreamFailureReason,
): void {
  switch (reason) {
    case "unsupported-method":
      session.emitStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "workspace.streamAsset is unsupported",
          incompatibleMethods: [
            {
              method: "workspace.streamAsset",
              clientCanonical: null,
              hostCanonical: null,
              blocking: "host-missing-method",
            },
          ],
          upgradeGuidance: {
            clientShouldUpgrade: false,
            hostShouldUpgrade: true,
          },
        },
      });
      return;
    case "fatal":
      session.emitStatus("closed", {
        kind: "fatalError",
        details: {
          code: "FATAL",
          reason: "stream failed",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      return;
    case "interrupted":
      session.emitStatus("closed", null);
      return;
    case "length-mismatch":
      emitHeader(session, "length-mismatch", 3);
      session.emitFrame(
        {
          kind: "assetChunk",
          hasBinaryPayload: true,
          index: 0,
          byteLength: 1,
        },
        new Uint8Array([1]),
      );
      session.emitFrame(
        { kind: "assetComplete", hasBinaryPayload: false },
        null,
      );
      return;
    case "not-found":
    case "not-image":
    case "mismatch":
    case "too-large":
    case "too-many-pixels":
    case "read-failed":
      session.emitFrame(
        {
          kind: "assetError",
          hasBinaryPayload: false,
          error: `host reported ${reason}`,
          reason,
        },
        null,
      );
      return;
  }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FALLBACK_CASES = [
  {
    reason: "unsupported-method",
    expected: "This host does not support image previews yet.",
    totalBytes: null,
  },
  {
    reason: "fatal",
    expected: "This image could not be loaded.",
    totalBytes: null,
  },
  {
    reason: "interrupted",
    expected: "The image transfer was interrupted.",
    totalBytes: null,
  },
  {
    reason: "length-mismatch",
    expected: "The image transfer did not complete.",
    totalBytes: 3,
  },
  {
    reason: "not-found",
    expected: "This file could not be found.",
    totalBytes: null,
  },
  {
    reason: "not-image",
    expected: "This file is not one of the supported image formats.",
    totalBytes: null,
  },
  {
    reason: "mismatch",
    expected: "This file's contents do not match its extension.",
    totalBytes: null,
  },
  {
    reason: "too-large",
    expected: "This image is too large to preview.",
    totalBytes: null,
  },
  {
    reason: "too-many-pixels",
    expected: "This image's dimensions are too large to preview.",
    totalBytes: null,
  },
  {
    reason: "read-failed",
    expected: "This image could not be read.",
    totalBytes: null,
  },
] satisfies readonly {
  readonly reason: AssetStreamFailureReason;
  readonly expected: string;
  readonly totalBytes: number | null;
}[];

let mockWsStreamClient: MockWsStreamClient;
let urlCounter = 0;
const createObjectUrlMock = vi.fn(
  (_blob: Blob) => `blob:image/${++urlCounter}`,
);
const revokeObjectUrlMock = vi.fn((_url: string) => undefined);
const originalCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

function restoreUrlMethod(
  name: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(URL, name);
    return;
  }
  Object.defineProperty(URL, name, descriptor);
}

beforeEach(() => {
  vi.useFakeTimers();
  urlCounter = 0;
  createObjectUrlMock.mockClear();
  revokeObjectUrlMock.mockClear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: createObjectUrlMock,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: revokeObjectUrlMock,
  });

  mockWsStreamClient = new MockWsStreamClient();
  wsStreamClientRef.value = mockWsStreamClient;
  tabHostIdRef.value = "host-1";
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  // "session"-retention entries (immutable git object identities) never
  // revoke on their own - advancing timers above only clears grace-retention
  // ones. This is the shared app-wide singleton, so a leftover session entry
  // from one test would otherwise leak into every later test's size()/URL
  // assertions.
  imageBlobCache.clear();
  wsStreamClientRef.value = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  restoreUrlMethod("createObjectURL", originalCreateObjectURLDescriptor);
  restoreUrlMethod("revokeObjectURL", originalRevokeObjectURLDescriptor);
});

describe("useImageAsset", () => {
  it("surfaces the header before bytes finish and then resolves a blob URL", async () => {
    const { result, unmount } = renderHook(() =>
      useImageAsset(WORKSPACE_REQUEST),
    );

    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const session = mockWsStreamClient.sessions[0];

    expect(result.current.status).toBe("loading");
    act(() => {
      emitHeader(session, "workspace-identity", 3);
    });

    const { reportDecodeFailure, ...headerState } = result.current;
    expect(typeof reportDecodeFailure).toBe("function");
    expect(headerState).toEqual({
      status: "header",
      url: null,
      meta: {
        mediaType: "image/png",
        sizeBytes: 3,
        width: 120,
        height: 80,
      },
      reason: null,
      receivedBytes: 0,
      totalBytes: 3,
      servedFromCache: false,
    });
    expect(createObjectUrlMock).not.toHaveBeenCalled();

    act(() => {
      session.emitFrame(
        {
          kind: "assetChunk",
          hasBinaryPayload: true,
          index: 0,
          byteLength: 3,
        },
        new Uint8Array([1, 2, 3]),
      );
    });
    expect(result.current.status).toBe("header");

    act(() => {
      session.emitFrame(
        { kind: "assetComplete", hasBinaryPayload: false },
        null,
      );
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");

    expect(result.current.url).toBe("blob:image/1");
    expect(result.current.receivedBytes).toBe(3);
    unmount();
  });

  it("creates one URL per identity, shares it, and revokes it after the last release", async () => {
    const first = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const firstSession = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(firstSession, "shared-identity", 3);
    });

    const second = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(2);
    const secondSession = mockWsStreamClient.sessions[1];
    act(() => {
      emitHeader(secondSession, "shared-identity", 3);
      emitBytes(firstSession, [1, 2, 3]);
    });

    await flushPromises();
    expect(first.result.current.status).toBe("ready");
    expect(second.result.current.status).toBe("ready");

    expect(first.result.current.url).toBe("blob:image/1");
    expect(second.result.current.url).toBe("blob:image/1");
    // `first` owns the fetch (its header triggered the fetcher that
    // `emitBytes` above feeds); `second` resolves from the shared cache
    // without ever invoking its own fetcher - a genuine cache hit, and
    // exactly the case a fresh `<img>` remount can't detect via
    // `img.complete` (ticket 07 closing E2E item).
    expect(first.result.current.servedFromCache).toBe(false);
    expect(second.result.current.servedFromCache).toBe(true);
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    // Owning session self-closes once ITS OWN assetComplete lands
    // (de02da59: every terminal path closes), same as the redundant
    // second session closing immediately on the cache hit.
    expect(firstSession.closed).toBe(true);
    expect(secondSession.closed).toBe(true);

    first.unmount();
    expect(revokeObjectUrlMock).not.toHaveBeenCalled();
    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:image/1");
    expect(revokeObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(imageBlobCache.size()).toBe(0);
  });

  it("reports a browser decode failure by discarding the ready asset", async () => {
    const { result, unmount } = renderHook(() =>
      useImageAsset(WORKSPACE_REQUEST),
    );
    const session = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(session, "decode-failure", 3);
      emitBytes(session, [1, 2, 3]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");
    const url = result.current.url;

    act(() => {
      result.current.reportDecodeFailure();
    });

    expect(revokeObjectUrlMock).toHaveBeenCalledWith(url);
    expect(imageBlobCache.size()).toBe(0);
    expect(result.current).toMatchObject({
      status: "fallback",
      url: null,
      meta: null,
      reason: "This image could not be decoded.",
    });
    unmount();
  });

  it("discards an immutable git asset on browser decode failure", async () => {
    const { result, unmount } = renderHook(() => useImageAsset(GIT_REQUEST));
    const session = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(session, "decode-session", 3);
      emitBytes(session, [4, 5, 6]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");

    act(() => {
      result.current.reportDecodeFailure();
    });

    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:image/1");
    expect(imageBlobCache.size()).toBe(0);
    expect(result.current.reason).toBe("This image could not be decoded.");
    unmount();
  });

  it("makes repeated decode-failure reports idempotent", async () => {
    const { result, unmount } = renderHook(() =>
      useImageAsset(WORKSPACE_REQUEST),
    );
    const session = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(session, "decode-twice", 3);
      emitBytes(session, [1, 2, 3]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");

    act(() => {
      result.current.reportDecodeFailure();
      result.current.reportDecodeFailure();
    });

    expect(revokeObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(imageBlobCache.size()).toBe(0);
    expect(result.current.status).toBe("fallback");
    expect(result.current.reason).toBe("This image could not be decoded.");
    unmount();
  });

  it("discards the ready asset when a stale decode error arrives after unmount", async () => {
    const { result, unmount } = renderHook(() => useImageAsset(GIT_REQUEST));
    const session = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(session, "decode-after-unmount", 3);
      emitBytes(session, [4, 5, 6]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");
    const reportDecodeFailure = result.current.reportDecodeFailure;

    unmount();
    expect(() => reportDecodeFailure()).not.toThrow();
    expect(imageBlobCache.size()).toBe(0);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:image/1");
  });

  it("opens a fresh stream after a decode failure discards the old entry", async () => {
    const first = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    const firstSession = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(firstSession, "decode-remount", 3);
      emitBytes(firstSession, [1, 2, 3]);
    });
    await flushPromises();
    expect(first.result.current.status).toBe("ready");

    act(() => {
      first.result.current.reportDecodeFailure();
    });
    first.unmount();

    const second = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(2);
    const secondSession = mockWsStreamClient.sessions[1];
    act(() => {
      emitHeader(secondSession, "decode-remount", 3);
      emitBytes(secondSession, [7, 8, 9]);
    });
    await flushPromises();

    expect(second.result.current.status).toBe("ready");
    expect(createObjectUrlMock).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("keeps the owning stream alive when its first mount unmounts mid-fetch", async () => {
    const first = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const firstSession = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(firstSession, "shared-in-flight", 3);
    });

    const second = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(2);
    const secondSession = mockWsStreamClient.sessions[1];
    act(() => {
      emitHeader(secondSession, "shared-in-flight", 3);
    });

    first.unmount();
    expect(firstSession.closed).toBe(false);

    act(() => {
      emitBytes(firstSession, [1, 2, 3]);
    });
    await flushPromises();

    expect(second.result.current.status).toBe("ready");
    expect(second.result.current.url).toBe("blob:image/1");
    expect(firstSession.closed).toBe(true);
    expect(secondSession.closed).toBe(true);
    second.unmount();
  });

  it("retries a shared identity after the owning stream fails", async () => {
    const first = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const firstSession = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(firstSession, "retryable-identity", 3);
    });

    const second = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(2);
    const secondSession = mockWsStreamClient.sessions[1];
    act(() => {
      emitHeader(secondSession, "retryable-identity", 3);
      emitLengthMismatchAfterHeader(firstSession);
    });
    await flushPromises();

    expect(first.result.current.status).toBe("fallback");
    expect(second.result.current.status).toBe("fallback");
    expect(imageBlobCache.size()).toBe(0);

    const third = renderHook(() => useImageAsset(WORKSPACE_REQUEST));
    expect(mockWsStreamClient.sessions).toHaveLength(3);
    const thirdSession = mockWsStreamClient.sessions[2];
    act(() => {
      emitHeader(thirdSession, "retryable-identity", 3);
    });

    expect(third.result.current.status).toBe("header");
    expect(thirdSession.closed).toBe(false);
    expect(imageBlobCache.size()).toBe(1);

    first.unmount();
    second.unmount();
    third.unmount();
  });

  it("opens the git stream and keys the old side separately", async () => {
    const acquireSpy = vi.spyOn(imageBlobCache, "acquire");
    const { result, unmount } = renderHook(() => useImageAsset(GIT_REQUEST));

    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const session = mockWsStreamClient.sessions[0];
    expect(mockWsStreamClient.requests[0]).toEqual({
      method: "git.streamFileAsset",
      params: {
        runningDir: "/repo",
        filePath: "images/logo.png",
        previousPath: "images/old-logo.png",
        side: "old",
        stage: "staged",
      },
    });

    act(() => {
      emitHeader(session, "git-oid", 3);
      emitBytes(session, [4, 5, 6]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");
    unmount();

    expect(acquireSpy).toHaveBeenCalledWith(
      "host-1|git-old|/repo::images/logo.png|git-oid",
      "image/png",
      expect.any(Function),
      "session",
    );
  });

  it.each(FALLBACK_CASES)(
    "maps $reason to its exact fallback message",
    async ({ reason, expected, totalBytes }) => {
      const { result, unmount } = renderHook(() =>
        useImageAsset(WORKSPACE_REQUEST),
      );
      expect(mockWsStreamClient.sessions).toHaveLength(1);
      const session = mockWsStreamClient.sessions[0];

      act(() => {
        emitFailure(session, reason);
      });
      await flushPromises();
      expect(result.current.status).toBe("fallback");

      expect(result.current.reason).toBe(expected);
      expect(result.current.meta).toBeNull();
      expect(result.current.totalBytes).toBe(totalBytes);
      unmount();
    },
  );

  it("closes the stream and releases the cache entry on unmount mid-stream", () => {
    const acquireSpy = vi.spyOn(imageBlobCache, "acquire");
    const { result, unmount } = renderHook(() =>
      useImageAsset(WORKSPACE_REQUEST),
    );
    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const session = mockWsStreamClient.sessions[0];

    act(() => {
      emitHeader(session, "cancelled-identity", 3);
    });
    expect(result.current.status).toBe("header");

    unmount();

    expect(session.closed).toBe(true);
    expect(acquireSpy).toHaveBeenCalledWith(
      "host-1|workspace|/repo::images/logo.png|cancelled-identity",
      "image/png",
      expect.any(Function),
      "grace",
    );
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    expect(imageBlobCache.size()).toBe(0);
  });

  it("ignores frames from a superseded request", async () => {
    const secondRequest: ImageAssetRequest = {
      method: "workspace",
      workspacePath: "/repo",
      filePath: "images/second.png",
    };
    const { result, rerender, unmount } = renderHook(
      ({ request }: { readonly request: ImageAssetRequest }) =>
        useImageAsset(request),
      { initialProps: { request: WORKSPACE_REQUEST } },
    );

    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const firstSession = mockWsStreamClient.sessions[0];

    rerender({ request: secondRequest });
    expect(mockWsStreamClient.sessions).toHaveLength(2);
    const secondSession = mockWsStreamClient.sessions[1];
    expect(firstSession.closed).toBe(true);
    expect(result.current.status).toBe("loading");

    act(() => {
      emitHeader(firstSession, "stale-identity", 3);
      emitBytes(firstSession, [1, 2, 3]);
    });
    expect(result.current.status).toBe("loading");

    act(() => {
      emitHeader(secondSession, "current-identity", 3);
      emitBytes(secondSession, [4, 5, 6]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");
    expect(result.current.meta?.sizeBytes).toBe(3);
    expect(result.current.url).toBe("blob:image/1");
    unmount();
  });

  it("reopens a worktree-backed request on a blurred-to-focused transition", async () => {
    const paneState: PaneTestState = { focused: true, visible: true };
    const wrapper = makePaneWrapper(paneState);
    const { result, rerender, unmount } = renderHook(
      () => useImageAsset(WORKSPACE_REQUEST),
      { wrapper },
    );

    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const firstSession = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(firstSession, "focus-refresh", 3);
      emitBytes(firstSession, [1, 2, 3]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");

    paneState.focused = false;
    rerender();
    expect(mockWsStreamClient.sessions).toHaveLength(1);

    paneState.focused = true;
    rerender();
    await flushPromises();
    expect(mockWsStreamClient.sessions).toHaveLength(2);
    unmount();
  });

  it("does not reopen an immutable git-object request on refocus", async () => {
    const paneState: PaneTestState = { focused: true, visible: true };
    const wrapper = makePaneWrapper(paneState);
    const { result, rerender, unmount } = renderHook(
      () => useImageAsset(GIT_REQUEST),
      { wrapper },
    );

    expect(mockWsStreamClient.sessions).toHaveLength(1);
    const firstSession = mockWsStreamClient.sessions[0];
    act(() => {
      emitHeader(firstSession, "immutable-git-oid", 3);
      emitBytes(firstSession, [4, 5, 6]);
    });
    await flushPromises();
    expect(result.current.status).toBe("ready");

    paneState.focused = false;
    rerender();
    paneState.focused = true;
    rerender();
    await flushPromises();

    expect(mockWsStreamClient.sessions).toHaveLength(1);
    unmount();
  });
});
