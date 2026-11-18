import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePrepareFoldersResponseV14 } from "@traycer/protocol/host/workspace/unary-schemas";
import type { RecordRecentWorkspaceInput } from "@/hooks/workspace/use-workspace-record-recent-workspace-mutation";
import { useWorkspaceRecordRecentWorkspace } from "@/hooks/workspace/use-workspace-record-recent-workspace-mutation";
import { recentWorkspacesQueryKey } from "@/hooks/workspace/use-workspace-list-recent-workspaces-query";

interface MutationCallbacks {
  readonly onSuccess: (
    result: WorkspacePrepareFoldersResponseV14,
    variables: RecordRecentWorkspaceInput,
    context: { readonly hostId: string | null },
  ) => Promise<void>;
}

const captured = vi.hoisted<{ callbacks: MutationCallbacks | null }>(() => ({
  callbacks: null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { options: MutationCallbacks }) => {
    captured.callbacks = args.options;
    return {};
  },
}));

describe("useWorkspaceRecordRecentWorkspace", () => {
  it("writes the host-returned list through without a follow-up RPC", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useWorkspaceRecordRecentWorkspace({ client: null }), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
    if (captured.callbacks === null) throw new Error("callbacks not captured");

    await captured.callbacks.onSuccess(
      {
        operation: "recordRecentWorkspace",
        folders: [],
        repoIdentifiers: [],
        homeDir: null,
        validation: { ok: true, resolvedPath: "/srv/app" },
        recentWorkspaces: [
          { path: "/srv/app", lastOpenedAt: "2026-08-25T00:00:00.000Z" },
        ],
      },
      {
        path: "/srv/app",
        bumpRecency: true,
        failureFeedback: "silent",
      },
      { hostId: "host-1" },
    );

    const queryKey = recentWorkspacesQueryKey("host-1");
    expect(queryClient.getQueryData(queryKey)).toMatchObject({
      operation: "listRecentWorkspaces",
      recentWorkspaces: [{ path: "/srv/app" }],
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
