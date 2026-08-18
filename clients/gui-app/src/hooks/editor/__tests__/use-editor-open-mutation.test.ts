import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The APP-WIDE client. `useEditorOpen` is the wrapper kept for the one caller
// that is genuinely app-wide - the dead-tile "open in editor" button, a
// FOLLOWING surface with no host of its own (selection model §2). Every
// Epic-scoped caller now uses `useEditorOpenForClient` with its own tab client,
// which is what `routesToThePassedClient` below pins (D15).
const fakeClient = { __isFakeClient: true };
vi.mock("@/lib/host", () => ({
  useHostClient: () => fakeClient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => fakeClient,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => fakeClient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => fakeClient,
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
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import {
  useEditorOpen,
  useEditorOpenForClient,
} from "@/hooks/editor/use-editor-open-mutation";
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

// D15. `editor.openPaths` resolves its paths on the host it is SENT to, so a
// diff tile bound to host A that dispatched on the app-wide client asked
// whichever machine the app was pointed at to open A's file. The tile's own
// client is a plain argument now; the app-wide mock above is still installed
// and must stay unused.
describe("useEditorOpenForClient", () => {
  it("targets editor.openPaths with the PASSED client, not the app-wide one", () => {
    // A real client over a mock messenger, not a chained assertion - the repo's
    // lint forbids `as unknown as` in tests too.
    const tileClient: HostClient<HostRpcRegistry> =
      new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        invalidator: { invalidateHostScope: () => undefined },
        messenger: new MockHostMessenger<HostRpcRegistry>({
          registry: hostRpcRegistry,
          requestId: () => "req-editor-open-for-client",
          handlers: {},
        }),
      });

    renderHook(() => useEditorOpenForClient(tileClient, "file"));

    expect(capturedArgs?.method).toBe("editor.openPaths");
    expect(capturedArgs?.client).toBe(tileClient);
    // Non-vacuous: the app-wide mock above is still installed and answering -
    // it is simply not what an Epic-scoped caller may dispatch on.
    expect(capturedArgs?.client).not.toBe(fakeClient);
  });
});
