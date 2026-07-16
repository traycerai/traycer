import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const fakeClient = { __isFakeClient: true };
vi.mock("@/lib/host", () => ({
  useHostClient: () => fakeClient,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => fakeClient,
}));

let capturedArgs: {
  client: unknown;
  method: string;
  options: {
    mutationKey?: ReadonlyArray<unknown>;
    onError?: (e: unknown) => void;
    onSuccess?: (response: unknown, variables: { editorId: string }) => void;
  };
} | null = null;
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: NonNullable<typeof capturedArgs>) => {
    capturedArgs = args;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import { toast } from "sonner";
import { renderHook } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { useEditorOpen } from "@/hooks/editor/use-editor-open-mutation";
import { editorMutationKeys } from "@/lib/query-keys";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

function makeError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-1",
    method: "editor.openPaths",
    fatalDetails: null,
  });
}

describe("useEditorOpen", () => {
  it("targets editor.openPaths with the host client and the editor mutation key", () => {
    renderHook(() => useEditorOpen("workspace"));
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs?.method).toBe("editor.openPaths");
    expect(capturedArgs?.client).toBe(fakeClient);
    expect(capturedArgs?.options.mutationKey).toEqual(
      editorMutationKeys.openPaths(),
    );
  });

  it("passes the host error message through as the toast for generic RPC errors", () => {
    renderHook(() => useEditorOpen("workspace"));
    capturedArgs?.options.onError?.(
      makeError("RPC_ERROR", "Windsurf isn't installed on this machine."),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Windsurf isn't installed on this machine.",
    );
  });

  it("uses the FORBIDDEN copy for permission errors", () => {
    renderHook(() => useEditorOpen("workspace"));
    capturedArgs?.options.onError?.(makeError("FORBIDDEN", "denied"));
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("emits workspace_opened_in_editor only for the workspace intent", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    try {
      renderHook(() => useEditorOpen("file"));
      capturedArgs?.options.onSuccess?.({}, { editorId: "vscode" });
      expect(track).not.toHaveBeenCalled();

      renderHook(() => useEditorOpen("workspace"));
      capturedArgs?.options.onSuccess?.({}, { editorId: "vscode" });
      expect(track).toHaveBeenCalledWith(
        AnalyticsEvent.WorkspaceOpenedInEditor,
        { source: "direct_ui", editor: "vscode" },
      );
    } finally {
      track.mockRestore();
    }
  });
});
