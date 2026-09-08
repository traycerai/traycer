import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ReadEpicFileRequest,
  ReadEpicFileResponse,
} from "@traycer/protocol/host/epic/files";

import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import {
  resetEpicFileHostSupportForTests,
  useFileBytes,
  type FileByteSource,
} from "@/lib/files/byte-source";

/**
 * Which PROVIDERS each byte leg actually needs (D27 amendment, ticket 27
 * phase A2).
 *
 * `useFileBytes` mounts all four legs on every render so the hook order
 * cannot shift under a source change, which used to mean every caller
 * inherited the UNION of the legs' provider requirements - `useTabHostId`
 * threw on a chat transcript, which has no tile and therefore no
 * `<TabHostProvider>`. The legs now degrade instead: a source that does not
 * address a tab host leaves the two legs that need one inert.
 *
 * Deliberately mocks as little as possible. The chat-attachment case runs the
 * REAL workspace/git leg (`useFileAsset` -> directory entry -> stream auth ->
 * stream client binding) and the REAL epic-file leg, because those chains are
 * exactly what has to tolerate the absence. Only the named-host client is
 * faked, so the epic case can assert WHICH host the request went to.
 */

const mocks = vi.hoisted(() => ({
  hostId: "host-1",
  requestWithSignal:
    vi.fn<
      (
        method: "epic.readFile",
        params: ReadEpicFileRequest,
        signal: AbortSignal | undefined,
      ) => Promise<ReadEpicFileResponse>
    >(),
  clientsForHostId: [] as Array<string | null>,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useMaybeHostClientForHostId: (hostId: string | null) => {
    mocks.clientsForHostId.push(hostId);
    if (hostId === null) return null;
    return {
      getActiveHostId: () => hostId,
      getRequestContextUserId: () => "user-1",
      requestWithSignal: mocks.requestWithSignal,
    };
  },
}));

const EPIC_FILE_SOURCE: FileByteSource = {
  kind: "epic-file",
  epicId: "epic-1",
  path: "files/a.png",
  sha256: "a".repeat(64),
  mediaType: "image/png",
};

const CHAT_ATTACHMENT_SOURCE: FileByteSource = {
  kind: "chat-attachment",
  hash: "b".repeat(64),
  mediaType: "image/png",
};

const WORKSPACE_SOURCE: FileByteSource = {
  kind: "workspace-path",
  workspacePath: "/repo",
  filePath: "a.png",
};

/** Only the app-wide query client - no tile, no host runtime, no tab host. */
function ProviderlessWrapper(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <WithTestQueryClient>{props.children}</WithTestQueryClient>;
}

function TabWrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <WithTestQueryClient>
      <TabHostProvider hostId={mocks.hostId}>{props.children}</TabHostProvider>
    </WithTestQueryClient>
  );
}

describe("useFileBytes - provider scope", () => {
  beforeEach(() => {
    resetEpicFileHostSupportForTests();
    mocks.requestWithSignal.mockReset();
    mocks.clientsForHostId = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a chat-attachment source outside <TabHostProvider> instead of throwing", () => {
    const { result } = renderHook(() => useFileBytes(CHAT_ATTACHMENT_SOURCE), {
      wrapper: ProviderlessWrapper,
    });

    expect(result.current.status).toBe("loading");
    // The two host-bound legs went inert rather than following the app-wide
    // host: bytes always ride the host the SOURCE names.
    expect(mocks.clientsForHostId).toEqual([null]);
    expect(mocks.requestWithSignal).not.toHaveBeenCalled();
  });

  it("leaves the workspace leg inert (never throwing) with no tab host to stream from", () => {
    const { result } = renderHook(() => useFileBytes(WORKSPACE_SOURCE), {
      wrapper: ProviderlessWrapper,
    });

    expect(result.current.status).toBe("loading");
    expect(result.current.header).toBeNull();
  });

  it("reaches the epic-file leg on the TAB host when there is one", async () => {
    mocks.requestWithSignal.mockResolvedValue({
      kind: "url",
      url: "https://storage.example.com/signed/abc",
      expiresAt: Date.now() + 60_000,
      mediaType: "image/png",
    });

    const { result } = renderHook(() => useFileBytes(EPIC_FILE_SOURCE), {
      wrapper: TabWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocks.clientsForHostId).toContain(mocks.hostId);
    expect(mocks.requestWithSignal).toHaveBeenCalledWith(
      "epic.readFile",
      expect.objectContaining({ epicId: "epic-1", path: "files/a.png" }),
      expect.anything(),
    );
  });

  it("issues no epic.readFile at all when the same source is rendered with no tab host", () => {
    renderHook(() => useFileBytes(EPIC_FILE_SOURCE), {
      wrapper: ProviderlessWrapper,
    });

    expect(mocks.requestWithSignal).not.toHaveBeenCalled();
  });
});
