import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";

const PERSIST_KEY = persistKey(STORE_KEYS.sessionImportUnseen);
const ENTRY_COUNT = 3_000;

function persistedUnseen(count: number): Record<string, "claude" | null> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`epic-${index}`, "claude"]),
  );
}

async function reloadStore(unseen: Record<string, "claude" | "codex" | null>) {
  localStorage.clear();
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({ state: { unseen }, version: 1 }),
  );
  vi.resetModules();
  const [{ useImportedUnseenStore }, { ImportedUnseenDot }] = await Promise.all(
    [
      import("@/stores/session-import/imported-unseen-store"),
      import("@/components/session-import/imported-unseen-dot"),
    ],
  );
  if (!useImportedUnseenStore.persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      useImportedUnseenStore.persist.onFinishHydration(() => resolve());
    });
  }
  return { useImportedUnseenStore, ImportedUnseenDot };
}

function makeProfilerCounts(): {
  readonly callback: ProfilerOnRenderCallback;
  readonly counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const callback: ProfilerOnRenderCallback = (id) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  return { callback, counts };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("imported unseen store", () => {
  it("does not persist replays for marked or neutral entries among 3,000 hydrated entries", async () => {
    const unseen = persistedUnseen(ENTRY_COUNT);
    unseen["already-neutral"] = null;
    const { useImportedUnseenStore } = await reloadStore(unseen);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    useImportedUnseenStore.getState().markImported("epic-0", "claude");
    useImportedUnseenStore.getState().markImported("already-neutral", "codex");

    expect(
      setItem.mock.calls.filter(([key]) => key === PERSIST_KEY),
    ).toHaveLength(0);
  });

  it("writes a new mark once, synchronously, with all entries in the persisted format", async () => {
    const { useImportedUnseenStore } = await reloadStore(
      persistedUnseen(ENTRY_COUNT),
    );
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockClear();

    useImportedUnseenStore.getState().markImported("epic-new", "codex");

    const writes = setItem.mock.calls.filter(([key]) => key === PERSIST_KEY);
    expect(writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const persisted = JSON.parse(writes[0][1]) as {
      state: Record<string, unknown>;
      version: number;
    };
    expect(persisted.version).toBe(1);
    expect(Object.keys(persisted.state)).toEqual(["unseen"]);
    const savedUnseen = persisted.state.unseen as Record<string, string | null>;
    expect(Object.keys(savedUnseen)).toHaveLength(ENTRY_COUNT + 1);
    expect(savedUnseen["epic-new"]).toBe("codex");
    expect(savedUnseen["epic-0"]).toBe("claude");
  });

  it("updates each real dot in the action's act without rerendering the other epic", async () => {
    const { useImportedUnseenStore, ImportedUnseenDot } = await reloadStore({});
    const unseenReference = useImportedUnseenStore.getState().unseen;
    const profilers = makeProfilerCounts();

    render(
      <>
        <Profiler id="epic-a" onRender={profilers.callback}>
          <ImportedUnseenDot epicId="epic-a" />
        </Profiler>
        <Profiler id="epic-b" onRender={profilers.callback}>
          <ImportedUnseenDot epicId="epic-b" />
        </Profiler>
      </>,
    );
    const epicBCommits = profilers.counts.get("epic-b") ?? 0;

    act(() => {
      useImportedUnseenStore.getState().markImported("epic-a", "claude");
    });
    expect(
      screen.getByRole("img", {
        name: "Imported from Claude Code, not opened yet",
      }),
    ).toBeTruthy();
    expect(profilers.counts.get("epic-b") ?? 0).toBe(epicBCommits);
    expect(useImportedUnseenStore.getState().unseen).toBe(unseenReference);

    act(() => {
      useImportedUnseenStore.getState().markSeen("epic-a");
    });
    expect(screen.queryByTestId("imported-unseen-dot")).toBeNull();
    expect(useImportedUnseenStore.getState().unseen).toBe(unseenReference);
    expect(profilers.counts.get("epic-b") ?? 0).toBe(epicBCommits);
  });
});
