import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import React from "react";
import type {
  GitListChangedFilesResponseV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hasDirtySubmodulesForRefresh,
  useGitListChangedFilesWithSubmodules,
} from "../use-git-list-changed-files-with-submodules";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import {
  bumpRichSlotStreamGeneration,
  createRichSlotRequest,
  richSlotOrderingKey,
} from "@/lib/git/git-rich-slot-ordering";

const streamState = vi.hoisted(() => ({
  client: null as MockWsStreamClient | null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => streamState.client,
}));

type SnapshotRequest = (
  method: string,
  params: { readonly ignoreWhitespace: boolean },
) => Promise<unknown>;

// A distinct request spy per host so we can prove the RPC is routed through the
// client bound to the SELECTED worktree host, not the app-wide active host.
const requestByHost = new Map<string, Mock<SnapshotRequest>>();
function clientForHost(hostId: string) {
  let entry = requestByHost.get(hostId);
  if (entry === undefined) {
    entry = vi.fn<SnapshotRequest>();
    requestByHost.set(hostId, entry);
  }
  return { request: entry };
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  version: SchemaVersion | null = { major: 1, minor: 0 };
  private readonly supportListeners = new Set<() => void>();

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
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

  override getMethodSchemaVersion<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): SchemaVersion | null {
    return this.version;
  }

  override subscribeMethodSupport(listener: () => void): () => void {
    this.supportListeners.add(listener);
    return () => {
      this.supportListeners.delete(listener);
    };
  }

  notifySupportChanged(): void {
    this.supportListeners.forEach((listener) => listener());
  }
}

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId === "" ? null : { hostId },
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (entry: { hostId: string } | null) =>
    entry === null ? null : clientForHost(entry.hostId),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: unknown) => ({
    hostId: "any",
    requestContextUserId: null,
    isReady: client !== null,
  }),
}));

const cleanPointer: SubmodulePointer = {
  kind: "normal",
  recordedPinSha: "1111111111",
  submoduleHeadSha: "1111111111",
  diverged: false,
  commitChanged: false,
  modifiedContent: false,
  untrackedContent: false,
};

function submodule(overrides: Partial<SubmoduleChangeset>): SubmoduleChangeset {
  return {
    repoRoot: "/repo/sub",
    parentPath: "sub",
    branch: "main",
    repoState: { kind: "clean" },
    files: [],
    pointer: cleanPointer,
    availability: { state: "ok" },
    ...overrides,
  };
}

function snapshot(fingerprint: string): GitListChangedFilesResponseV11 {
  return {
    runningDir: "/repo",
    headSha: "abc123",
    branch: "main",
    files: [],
    fingerprint,
    repoMode: "normal" as const,
    repoState: { kind: "clean" as const },
    submodules: [],
  };
}

describe("hasDirtySubmodulesForRefresh", () => {
  it("does not keep polling for clean initialized submodules", () => {
    expect(
      hasDirtySubmodulesForRefresh({
        ...snapshot("clean"),
        submodules: [submodule({})],
      }),
    ).toBe(false);
  });

  it("keeps polling for dirty, unavailable, or populated submodule sections", () => {
    expect(
      hasDirtySubmodulesForRefresh({
        ...snapshot("dirty-pointer"),
        submodules: [
          submodule({
            pointer: { ...cleanPointer, modifiedContent: true },
          }),
        ],
      }),
    ).toBe(true);
    expect(
      hasDirtySubmodulesForRefresh({
        ...snapshot("unavailable"),
        submodules: [
          submodule({
            availability: { state: "unavailable", reason: "git-error" },
          }),
        ],
      }),
    ).toBe(true);
    expect(
      hasDirtySubmodulesForRefresh({
        ...snapshot("files"),
        submodules: [
          submodule({
            files: [
              {
                path: "src/app.ts",
                previousPath: null,
                status: "modified",
                stage: "unstaged",
                isBinary: false,
                insertions: 1,
                deletions: 0,
                sizeBytes: 1,
                stagedOid: null,
                worktreeOid: null,
                gitlink: null,
              },
            ],
          }),
        ],
      }),
    ).toBe(true);
  });
});

describe("useGitListChangedFilesWithSubmodules", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    requestByHost.clear();
    vi.clearAllMocks();
    streamState.client = new MockWsStreamClient();
  });

  afterEach(() => {
    streamState.client = null;
    queryClient.clear();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  it("routes the fetch through the selected worktree host, not the default host", async () => {
    clientForHost("selected-host").request.mockResolvedValue(snapshot("fp-1"));

    const { result } = renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "selected-host",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: "fp-1",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(clientForHost("selected-host").request).toHaveBeenCalledWith(
      "git.listChangedFiles",
      {
        hostId: "selected-host",
        runningDir: "/repo",
        ignoreWhitespace: false,
        includeSubmodules: true,
      },
    );
    // The default/other host's client is never used.
    expect(requestByHost.get("default-host")).toBeUndefined();
  });

  it("refetches when the parent change token changes", async () => {
    clientForHost("h").request.mockResolvedValue(snapshot("fp-1"));

    const { result, rerender } = renderHook(
      (props: { changeToken: string }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: props.changeToken,
        }),
      { wrapper, initialProps: { changeToken: "fp-1" } },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(clientForHost("h").request).toHaveBeenCalledTimes(1);

    rerender({ changeToken: "fp-2" });

    await waitFor(() =>
      expect(clientForHost("h").request).toHaveBeenCalledTimes(2),
    );
  });

  it("does not refetch on an identity change carrying a stale token", async () => {
    clientForHost("h1").request.mockResolvedValue(snapshot("shared-fp"));
    clientForHost("h2").request.mockResolvedValue(snapshot("shared-fp"));

    const { rerender } = renderHook(
      (props: { hostId: string }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: props.hostId,
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: "shared-fp",
        }),
      { wrapper, initialProps: { hostId: "h1" } },
    );

    await waitFor(() =>
      expect(clientForHost("h1").request).toHaveBeenCalledTimes(1),
    );

    // Same token value, different source host → the new key mounts its own
    // fetch, and the carried token must NOT force an extra refetch.
    rerender({ hostId: "h2" });
    await waitFor(() =>
      expect(clientForHost("h2").request).toHaveBeenCalledTimes(1),
    );
    expect(clientForHost("h1").request).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when disabled", () => {
    renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: false,
          changeToken: null,
        }),
      { wrapper },
    );
    expect(clientForHost("h").request).not.toHaveBeenCalled();
  });

  it("transitions between unary fallback and stream ownership without stale writes", async () => {
    const request = clientForHost("h").request;
    let resolveFirst = (_value: unknown): void => undefined;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const streamClient = streamState.client;
    if (streamClient === null) throw new Error("Stream client missing");

    const { result } = renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: null,
        }),
      { wrapper },
    );

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const streamValue = snapshot("stream-value");
    queryClient.setQueryData(
      gitQueryKeys.listChangedFilesWithSubmodules("h", "/repo", false),
      streamValue,
    );
    streamClient.version = { major: 1, minor: 1 };
    streamClient.notifySupportChanged();

    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("stream-value"),
    );
    resolveFirst(snapshot("stale-unary-value"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.data?.fingerprint).toBe("stream-value");

    streamClient.version = { major: 1, minor: 0 };
    request.mockResolvedValueOnce(snapshot("fallback-value"));
    streamClient.notifySupportChanged();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("fallback-value"),
    );
  });

  it("forces a unary refetch when fallback mounts over a stream-owned rich cache", async () => {
    const request = clientForHost("h").request;
    request.mockResolvedValue(snapshot("fallback"));
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "h",
      "/repo",
      false,
    );
    queryClient.setQueryData(richKey, snapshot("stream"));
    bumpRichSlotStreamGeneration(
      richSlotOrderingKey({
        hostId: "h",
        runningDir: "/repo",
        ignoreWhitespace: false,
      }),
    );

    const { result } = renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: null,
        }),
      { wrapper },
    );

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("fallback"),
    );
  });

  it("does not refetch a fallback cache whose last writer was unary", async () => {
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "h",
      "/repo",
      false,
    );
    const seedRequest = createRichSlotRequest({
      queryClient,
      hostId: "h",
      runningDir: "/repo",
      ignoreWhitespace: false,
      request: () => Promise.resolve(snapshot("unary")),
    });
    await seedRequest({ signal: new AbortController().signal });
    queryClient.setQueryData(richKey, snapshot("unary"));
    const request = clientForHost("h").request;

    renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: null,
        }),
      { wrapper },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).not.toHaveBeenCalled();
  });

  it("performs one fallback fetch when changeToken changed while stream ownership was active", async () => {
    const streamClient = streamState.client;
    if (streamClient === null) throw new Error("Stream client missing");
    streamClient.version = { major: 1, minor: 1 };
    const request = clientForHost("h").request;
    request.mockResolvedValue(snapshot("fallback"));
    queryClient.setQueryData(
      gitQueryKeys.listChangedFilesWithSubmodules("h", "/repo", false),
      snapshot("stream"),
    );

    const { rerender, result } = renderHook(
      (props: { changeToken: string | null }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: props.changeToken,
        }),
      { wrapper, initialProps: { changeToken: "token-1" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).not.toHaveBeenCalled();

    rerender({ changeToken: "token-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    streamClient.version = { major: 1, minor: 0 };
    streamClient.notifySupportChanged();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("fallback"),
    );
  });

  it("coalesces disabled-token and fallback recovery into one unary fetch on resume", async () => {
    const streamClient = streamState.client;
    if (streamClient === null) throw new Error("Stream client missing");
    streamClient.version = { major: 1, minor: 1 };
    const request = clientForHost("h").request;
    request.mockResolvedValue(snapshot("fallback"));
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "h",
      "/repo",
      false,
    );
    queryClient.setQueryData(richKey, snapshot("stream"));
    bumpRichSlotStreamGeneration(
      richSlotOrderingKey({
        hostId: "h",
        runningDir: "/repo",
        ignoreWhitespace: false,
      }),
    );

    const { rerender, result } = renderHook(
      (props: { enabled: boolean; changeToken: string }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: props.enabled,
          changeToken: props.changeToken,
        }),
      {
        wrapper,
        initialProps: { enabled: true, changeToken: "token-1" },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).not.toHaveBeenCalled();

    rerender({ enabled: false, changeToken: "token-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    streamClient.version = { major: 1, minor: 0 };
    streamClient.notifySupportChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).not.toHaveBeenCalled();

    rerender({ enabled: true, changeToken: "token-2" });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("fallback"),
    );
    expect(queryClient.getQueryData(richKey)).toMatchObject({
      fingerprint: "fallback",
    });
  });

  it("refetches once for a token advanced while disabled when fallback ownership stays unary", async () => {
    const streamClient = streamState.client;
    if (streamClient === null) throw new Error("Stream client missing");
    streamClient.version = { major: 1, minor: 0 };
    const request = clientForHost("h").request;
    request
      .mockResolvedValueOnce(snapshot("unary-1"))
      .mockResolvedValueOnce(snapshot("unary-2"));

    const { rerender, result } = renderHook(
      (props: { enabled: boolean; changeToken: string }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: props.enabled,
          changeToken: props.changeToken,
        }),
      {
        wrapper,
        initialProps: { enabled: true, changeToken: "token-1" },
      },
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("unary-1"),
    );

    rerender({ enabled: false, changeToken: "token-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rerender({ enabled: true, changeToken: "token-2" });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.data?.fingerprint).toBe("unary-2"),
    );
    expect(
      queryClient.getQueryData<GitListChangedFilesResponseV11>(
        gitQueryKeys.listChangedFilesWithSubmodules("h", "/repo", false),
      ),
    ).toMatchObject({ fingerprint: "unary-2" });
  });
});
