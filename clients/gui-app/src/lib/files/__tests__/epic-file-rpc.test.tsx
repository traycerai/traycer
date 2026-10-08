import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  EpicFileRpcContext,
  useEpicFileRpc,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";

const HOST_ID = "host-7";
const ADDRESS = {
  epicId: "epic-1",
  path: "files/a.html",
  sha256: "a".repeat(64),
};

const mocks = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<string>>(),
  requestWithSignal:
    vi.fn<
      (method: string, params: unknown, signal: AbortSignal) => Promise<string>
    >(),
  createRequesterForHostId: vi.fn<(hostId: string) => object>(),
  hasBinding: true,
}));

// The tab's host client is built from the app-wide binding by host id.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    mocks.hasBinding
      ? {
          hostClient: {
            createRequesterForHostId: mocks.createRequesterForHostId,
          },
        }
      : null,
}));

function tabWrapper(hostId: string | null, override: EpicFileRpc | null) {
  return function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <TabHostContext.Provider value={hostId}>
        <EpicFileRpcContext.Provider value={override}>
          {props.children}
        </EpicFileRpcContext.Provider>
      </TabHostContext.Provider>
    );
  };
}

beforeEach(() => {
  mocks.hasBinding = true;
  mocks.request.mockReset().mockResolvedValue("answer");
  mocks.requestWithSignal.mockReset().mockResolvedValue("answer");
  mocks.createRequesterForHostId.mockReset().mockReturnValue({
    request: mocks.request,
    requestWithSignal: mocks.requestWithSignal,
  });
});

describe("useEpicFileRpc inside a tab with no override", () => {
  it("sends each call to the tab's host with the method and params it was given", async () => {
    const { result } = renderHook(() => useEpicFileRpc(), {
      wrapper: tabWrapper(HOST_ID, null),
    });
    const signal = new AbortController().signal;

    await result.current.readFile(
      { ...ADDRESS, via: null, want: { kind: "text" } },
      signal,
    );
    await result.current.openFileInBrowser({ ...ADDRESS, via: null });
    await result.current.fetchFile(ADDRESS);
    await result.current.cancelFetchFile(ADDRESS);

    expect(mocks.createRequesterForHostId).toHaveBeenCalledWith(HOST_ID);
    expect(mocks.requestWithSignal).toHaveBeenCalledWith(
      "epic.readFile",
      { ...ADDRESS, via: null, want: { kind: "text" } },
      signal,
    );
    expect(mocks.request.mock.calls).toEqual([
      ["epic.openFileInBrowser", { ...ADDRESS, via: null }],
      ["epic.fetchFile", ADDRESS],
      ["epic.cancelFetchFile", ADDRESS],
    ]);
  });

  it("uses the override when a test supplies one", async () => {
    const override: EpicFileRpc = {
      readFile: vi.fn<EpicFileRpc["readFile"]>(),
      openFileInBrowser: vi.fn<EpicFileRpc["openFileInBrowser"]>(),
      fetchFile: vi.fn<EpicFileRpc["fetchFile"]>().mockResolvedValue({
        kind: "present",
      }),
      cancelFetchFile: vi.fn<EpicFileRpc["cancelFetchFile"]>(),
    };
    const { result } = renderHook(() => useEpicFileRpc(), {
      wrapper: tabWrapper(HOST_ID, override),
    });

    await result.current.fetchFile(ADDRESS);

    expect(override.fetchFile).toHaveBeenCalledWith(ADDRESS);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("useEpicFileRpc with no host to ask", () => {
  it("rejects every call as an unavailable host client outside a tab", async () => {
    const { result } = renderHook(() => useEpicFileRpc(), {
      wrapper: tabWrapper(null, null),
    });

    await expect(result.current.fetchFile(ADDRESS)).rejects.toMatchObject({
      message: "Host client unavailable",
      method: "epic.fetchFile",
    });
    await expect(
      result.current.readFile(
        { ...ADDRESS, via: null, want: { kind: "text" } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ method: "epic.readFile" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects the same way in a tab when the app has no host runtime", async () => {
    mocks.hasBinding = false;
    const { result } = renderHook(() => useEpicFileRpc(), {
      wrapper: tabWrapper(HOST_ID, null),
    });

    await expect(result.current.cancelFetchFile(ADDRESS)).rejects.toMatchObject(
      {
        message: "Host client unavailable",
      },
    );
  });
});
