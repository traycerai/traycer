import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileEditRecoveryEntry } from "@/lib/workspace/file-edit-runtime";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error("missing deferred resolve");
      resolvePromise(value);
    },
  };
}

const state = vi.hoisted(() => ({
  pendingLoad: null as Deferred<FileEditRecoveryEntry | null> | null,
}));

// The reconciliation effect under test races an auto-attached runtime's own
// recovery (IndexedDB journal load) against a reactivation refetch. The real
// `fileEditRuntimeRegistry` singleton is fixed to the real IndexedDB journal
// at module load, so this substitutes a test-controllable journal for just
// this file - other test files' use of the shared singleton is unaffected
// (Vitest module mocks are scoped per test file).
vi.mock("@/lib/workspace/file-edit-recovery-store", () => ({
  indexedDbFileEditRecoveryJournal: {
    load: (): Promise<FileEditRecoveryEntry | null> => {
      const pending = deferred<FileEditRecoveryEntry | null>();
      state.pendingLoad = pending;
      return pending.promise;
    },
    save: (): Promise<void> => Promise.resolve(),
    remove: (): Promise<void> => Promise.resolve(),
  },
}));

import { useFileEditSession } from "@/hooks/workspace/use-file-edit-session";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

const IDENTITY = {
  userId: "user-1",
  hostId: "host-1",
  workspacePath: "/repo",
  filePath: "src/file.ts",
};

function currentRuntimeState() {
  return fileEditRuntimeRegistry.get(IDENTITY)?.store.getState();
}

describe("useFileEditSession reconciliation vs recovery race (RESUME13)", () => {
  afterEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    state.pendingLoad = null;
    cleanup();
  });

  it("applies a reactivation refetch's fresh disk content once recovery settles, instead of dropping it silently", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { rerender } = renderHook(
      (props: { diskContent: string }) =>
        useFileEditSession({
          client: null,
          identity: IDENTITY,
          diskContent: props.diskContent,
          surfaceId: "surface-a",
          autoAttach: true,
        }),
      { initialProps: { diskContent: "V1" }, wrapper: Wrapper },
    );

    // The auto-attach effect has captured its own `fileContentRevision("V1")`
    // and called `registry.attach`, which starts recovery - still pending.
    // `fileContentRevision` goes through real `crypto.subtle.digest`, so this
    // polls rather than assuming a fixed microtask count settles it.
    await waitFor(() => {
      expect(state.pendingLoad).not.toBeNull();
    });
    expect(currentRuntimeState()?.status).toBe("recovering");

    // A reactivation refetch resolves with different content while recovery
    // is still in flight - the exact race this fix closes.
    rerender({ diskContent: "V2" });
    expect(currentRuntimeState()?.status).toBe("recovering");

    // Real, unmocked `fileContentRevision` (crypto.subtle.digest) gets ample
    // time here to resolve and reach `refreshCleanDisk` - deterministically
    // BEFORE recovery settles, since `pendingLoad` is still held open. This
    // is what actually forces the race: without it, the two promises could
    // resolve in either order and the assertion below would pass by luck
    // regardless of whether the reconciliation waits for recovery.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(currentRuntimeState()?.status).toBe("recovering");

    state.pendingLoad?.resolve(null);

    await waitFor(() => {
      expect(currentRuntimeState()?.status).toBe("clean");
    });
    expect(currentRuntimeState()?.draftContent).toBe("V2");
  });
});
