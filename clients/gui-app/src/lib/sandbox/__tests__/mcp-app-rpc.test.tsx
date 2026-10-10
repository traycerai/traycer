import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  McpAppRpcContext,
  useMcpAppRpc,
  type McpAppRpc,
} from "@/lib/sandbox/mcp-app-rpc";

const HOST_ID = "host-7";
const BLOCK = { epicId: "epic-1", chatId: "chat-1", blockId: "block-1" };

const mocks = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<string>>(),
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

function tabWrapper(hostId: string | null, override: McpAppRpc | null) {
  return function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <TabHostContext.Provider value={hostId}>
        <McpAppRpcContext.Provider value={override}>
          {props.children}
        </McpAppRpcContext.Provider>
      </TabHostContext.Provider>
    );
  };
}

beforeEach(() => {
  mocks.hasBinding = true;
  mocks.request.mockReset().mockResolvedValue("answer");
  mocks.createRequesterForHostId
    .mockReset()
    .mockReturnValue({ request: mocks.request });
});

describe("useMcpAppRpc inside a tab with no override", () => {
  it("sends each call to the tab's host with the method and params it was given", async () => {
    const { result } = renderHook(() => useMcpAppRpc(), {
      wrapper: tabWrapper(HOST_ID, null),
    });
    const call = { ...BLOCK, name: "show", arguments: {}, approvalToken: null };
    const read = { ...BLOCK, uri: "ui://dash/view" };
    const context = { ...BLOCK, content: null, structuredContent: null };

    await result.current.callTool(call);
    await result.current.readResource(read);
    await result.current.updateModelContext(context);

    expect(mocks.createRequesterForHostId).toHaveBeenCalledWith(HOST_ID);
    expect(mocks.request.mock.calls).toEqual([
      ["chat.mcpApp.callTool", call],
      ["chat.mcpApp.readResource", read],
      ["chat.mcpApp.updateModelContext", context],
    ]);
  });

  it("uses the override when a test supplies one", async () => {
    const override: McpAppRpc = {
      callTool: vi.fn<McpAppRpc["callTool"]>(),
      readResource: vi
        .fn<McpAppRpc["readResource"]>()
        .mockResolvedValue({ kind: "result", result: {} }),
      updateModelContext: vi.fn<McpAppRpc["updateModelContext"]>(),
    };
    const { result } = renderHook(() => useMcpAppRpc(), {
      wrapper: tabWrapper(HOST_ID, override),
    });
    const read = { ...BLOCK, uri: "ui://dash/view" };

    await result.current.readResource(read);

    expect(override.readResource).toHaveBeenCalledWith(read);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("useMcpAppRpc with no host to ask", () => {
  it("rejects every call as an unavailable host client outside a tab", async () => {
    const { result } = renderHook(() => useMcpAppRpc(), {
      wrapper: tabWrapper(null, null),
    });

    await expect(
      result.current.readResource({ ...BLOCK, uri: "ui://dash/view" }),
    ).rejects.toMatchObject({
      message: "Host client unavailable",
      method: "chat.mcpApp.readResource",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects the same way in a tab when the app has no host runtime", async () => {
    mocks.hasBinding = false;
    const { result } = renderHook(() => useMcpAppRpc(), {
      wrapper: tabWrapper(HOST_ID, null),
    });

    await expect(
      result.current.updateModelContext({
        ...BLOCK,
        content: null,
        structuredContent: null,
      }),
    ).rejects.toMatchObject({ message: "Host client unavailable" });
  });
});
