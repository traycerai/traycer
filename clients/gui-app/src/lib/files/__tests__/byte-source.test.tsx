import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EpicFileUnavailableReason,
  ReadEpicFileRequest,
  ReadEpicFileResponse,
} from "@traycer/protocol/host/epic/files";

import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import {
  resetEpicFileHostSupportForTests,
  useFileBytes,
  type EpicFileByteSource,
} from "@/lib/files/byte-source";

/**
 * The epic-file byte chain: `epic.readFile` on the TAB host resolves an
 * ADDRESS (never a payload), and `useFileBytes` decides url-vs-blob delivery
 * from the sniffed family (D10). The two other legs of `useFileBytes`
 * (workspace/git via `useFileAsset`, chat via `useChatAttachmentBlobSrc`) are
 * stubbed inert below - this suite only drives the epic-file leg.
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
  hostVersion: "1.0.0",
  coLocatedHostId: "colocated-host",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    getActiveHostId: () => mocks.hostId,
    getRequestContextUserId: () => "user-1",
    requestWithSignal: mocks.requestWithSignal,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ version: mocks.hostVersion }),
}));

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => mocks.coLocatedHostId,
}));

// The other two legs of `useFileBytes` - inert, so they can't accidentally
// satisfy an assertion meant for the epic-file leg, and so mounting them
// doesn't drag a WebSocket transport into this suite.
vi.mock("@/hooks/assets/use-file-asset", () => ({
  useFileAsset: () => ({
    status: "loading",
    url: null,
    meta: null,
    reason: null,
    totalBytes: null,
    servedFromCache: false,
  }),
}));
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useChatAttachmentBlobSrc: () => ({ status: "loading", src: null }),
}));

const EPIC_ID = "epic-1";
const SHA256 = "a".repeat(64);
const SIGNED_URL = "https://storage.example.com/signed/abc123";
const LOOPBACK_URL = "http://127.0.0.1:47100/epic-1/preview";

function epicFileSource(path: string, mediaType: string): EpicFileByteSource {
  return {
    kind: "epic-file",
    epicId: EPIC_ID,
    path,
    sha256: SHA256,
    mediaType,
  };
}

function urlResponse(mediaType: string): ReadEpicFileResponse {
  return {
    kind: "url",
    url: SIGNED_URL,
    expiresAt: Date.now() + 60_000,
    mediaType,
  };
}

function loopbackResponse(): ReadEpicFileResponse {
  return { kind: "loopback", url: LOOPBACK_URL };
}

function unavailableResponse(
  reason: EpicFileUnavailableReason,
): ReadEpicFileResponse {
  return { kind: "unavailable", reason };
}

function unsupportedRpcError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "unsupported",
    requestId: "req-1",
    method: "epic.readFile",
    fatalDetails: null,
  });
}

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <WithTestQueryClient>
      <TabHostProvider hostId={mocks.hostId}>{props.children}</TabHostProvider>
    </WithTestQueryClient>
  );
}

function renderEpicFileBytes(source: EpicFileByteSource) {
  return renderHook(() => useFileBytes(source), { wrapper: Wrapper });
}

const fetchMock = vi.fn(
  (_input: string, _init: { signal?: AbortSignal }): Promise<Response> => {
    const body = new Uint8Array([1, 2, 3, 4]).buffer;
    const fakeResponse: Response = {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(body),
    } as Response;
    return Promise.resolve(fakeResponse);
  },
);

beforeEach(() => {
  resetEpicFileHostSupportForTests();
  imageBlobCache.clear();
  mocks.requestWithSignal.mockReset();
  mocks.hostVersion = "1.0.0";
  mocks.coLocatedHostId = "colocated-host";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:mock-object-url"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useFileBytes - epic-file source, delivery decision (D10)", () => {
  it("hands an image signed url straight to the caller and never fetches it", async () => {
    mocks.requestWithSignal.mockResolvedValue(urlResponse("image/png"));
    const { result } = renderEpicFileBytes(
      epicFileSource("a.png", "image/png"),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current).toEqual({
      status: "ready",
      src: SIGNED_URL,
      mediaType: "image/png",
      delivery: "url",
      reason: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands a video signed url straight to the caller and never fetches it", async () => {
    mocks.requestWithSignal.mockResolvedValue(urlResponse("video/mp4"));
    const { result } = renderEpicFileBytes(
      epicFileSource("a.mp4", "video/mp4"),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current).toMatchObject({
      status: "ready",
      src: SIGNED_URL,
      mediaType: "video/mp4",
      delivery: "url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a pdf signed url into a blob rather than handing the url to the caller", async () => {
    mocks.requestWithSignal.mockResolvedValue(urlResponse("application/pdf"));
    const { result } = renderEpicFileBytes(
      epicFileSource("a.pdf", "application/pdf"),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, expect.anything());
    expect(result.current.delivery).toBe("blob");
    expect(result.current.src).not.toBeNull();
    expect(result.current.src).not.toBe(SIGNED_URL);
  });

  it("fetches an html signed url into a blob rather than handing the url to the caller", async () => {
    mocks.requestWithSignal.mockResolvedValue(urlResponse("text/html"));
    const { result } = renderEpicFileBytes(
      epicFileSource("a.html", "text/html"),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, expect.anything());
    expect(result.current.delivery).toBe("blob");
    expect(result.current.src).not.toBe(SIGNED_URL);
  });

  it("delivers a loopback url directly for an image-family source media type", async () => {
    mocks.requestWithSignal.mockResolvedValue(loopbackResponse());
    const { result } = renderEpicFileBytes(
      epicFileSource("a.png", "image/png"),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current).toEqual({
      status: "ready",
      src: LOOPBACK_URL,
      mediaType: "image/png",
      delivery: "url",
      reason: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a loopback url into a blob for a non-image/video source media type", async () => {
    mocks.requestWithSignal.mockResolvedValue(loopbackResponse());
    const { result } = renderEpicFileBytes(
      epicFileSource("a.pdf", "application/pdf"),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(fetchMock).toHaveBeenCalledWith(LOOPBACK_URL, expect.anything());
    expect(result.current.delivery).toBe("blob");
    expect(result.current.src).not.toBe(LOOPBACK_URL);
  });
});

describe("useFileBytes - epic-file source, settled unavailable states", () => {
  it.each<EpicFileUnavailableReason>(["deleted", "upload-pending"])(
    "settles to unavailable with reason %s",
    async (reason) => {
      mocks.requestWithSignal.mockResolvedValue(unavailableResponse(reason));
      const { result } = renderEpicFileBytes(
        epicFileSource("a.png", "image/png"),
      );

      await waitFor(() => expect(result.current.status).toBe("unavailable"));

      expect(result.current).toEqual({
        status: "unavailable",
        src: null,
        mediaType: null,
        delivery: null,
        reason,
      });
    },
  );
});

describe("useFileBytes - epic-file source, E_HOST_UNSUPPORTED memoization", () => {
  it("settles to unsupported and remembers the verdict per (hostId, hostVersion) so a sibling row issues no further request", async () => {
    mocks.requestWithSignal.mockRejectedValue(unsupportedRpcError());

    const first = renderEpicFileBytes(epicFileSource("a.png", "image/png"));
    await waitFor(() =>
      expect(first.result.current.status).toBe("unsupported"),
    );
    expect(mocks.requestWithSignal).toHaveBeenCalledTimes(1);

    // A second file on the same host build: the verdict is memoized, so no
    // further `epic.readFile` request is issued for it.
    const second = renderEpicFileBytes(epicFileSource("b.png", "image/png"));
    await waitFor(() =>
      expect(second.result.current.status).toBe("unsupported"),
    );
    expect(mocks.requestWithSignal).toHaveBeenCalledTimes(1);
  });
});

describe("useFileBytes - epic-file source, co-located vantage", () => {
  it("carries useReactiveLocalHostId's value as coLocatedHostId on the request", async () => {
    mocks.coLocatedHostId = "the-declared-vantage-host";
    mocks.requestWithSignal.mockResolvedValue(urlResponse("image/png"));

    const { result } = renderEpicFileBytes(
      epicFileSource("a.png", "image/png"),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(mocks.requestWithSignal).toHaveBeenCalledWith(
      "epic.readFile",
      expect.objectContaining({ coLocatedHostId: "the-declared-vantage-host" }),
      expect.anything(),
    );
  });
});
