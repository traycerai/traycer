import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fetchWorkspaceFileExists } from "@/lib/host/probe-workspace-file-exists";
import type { WorkspaceReadFileResponse } from "@traycer/protocol/host/workspace/unary-schemas";

const HOST_ID = "host-1";

type ReadFileRequest = (
  method: string,
  params: unknown,
) => Promise<WorkspaceReadFileResponse>;

function makeArgs(queryClient: QueryClient, request: Mock<ReadFileRequest>) {
  return {
    queryClient,
    client: { request } as never,
    hostId: HOST_ID,
    workspacePath: "/repo",
    filePath: "src/app.ts",
  };
}

describe("fetchWorkspaceFileExists", () => {
  it("resolves true when the host reports content for the file", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = vi.fn<ReadFileRequest>();
    request.mockResolvedValue({
      workspacePath: "/repo",
      filePath: "src/app.ts",
      content: "x",
      truncated: true,
      error: null,
    });

    expect(await fetchWorkspaceFileExists(makeArgs(queryClient, request))).toBe(
      true,
    );
    expect(request).toHaveBeenCalledWith(
      "workspace.readFile",
      expect.objectContaining({
        workspacePath: "/repo",
        filePath: "src/app.ts",
        maxBytes: 1,
      }),
    );
  });

  it("resolves false when the host reports no content (missing file)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = vi.fn<ReadFileRequest>();
    request.mockResolvedValue({
      workspacePath: "/repo",
      filePath: "src/app.ts",
      content: null,
      truncated: false,
      error: "not found",
    });

    expect(await fetchWorkspaceFileExists(makeArgs(queryClient, request))).toBe(
      false,
    );
  });

  it("resolves false rather than rejecting on a transport error", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = vi.fn<ReadFileRequest>();
    request.mockRejectedValue(new Error("transport"));

    await expect(
      fetchWorkspaceFileExists(makeArgs(queryClient, request)),
    ).resolves.toBe(false);
  });

  it("re-probes a file that was missing on an earlier click instead of serving a cached miss", async () => {
    // A click-time existence probe exists specifically to catch a file the
    // agent just created after an earlier failed click - a positive staleTime
    // on a MISS would keep re-clicks failing silently until the window
    // expired, so a miss must be evicted immediately (unlike a HIT, which
    // keeps its 5s window to collapse a double-click).
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = vi.fn<ReadFileRequest>();
    request.mockResolvedValueOnce({
      workspacePath: "/repo",
      filePath: "src/app.ts",
      content: null,
      truncated: false,
      error: "not found",
    });
    request.mockResolvedValueOnce({
      workspacePath: "/repo",
      filePath: "src/app.ts",
      content: "x",
      truncated: true,
      error: null,
    });

    expect(await fetchWorkspaceFileExists(makeArgs(queryClient, request))).toBe(
      false,
    );
    expect(await fetchWorkspaceFileExists(makeArgs(queryClient, request))).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
