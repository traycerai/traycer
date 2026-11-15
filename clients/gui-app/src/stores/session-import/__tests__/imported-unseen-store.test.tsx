import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist/keys";

const storageKey = persistKey(STORE_KEYS.sessionImportUnseen);

function readPersistedUnseen(): Record<string, string | null> {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) throw new Error("Imported unseen state was not persisted");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("state" in parsed) ||
    typeof parsed.state !== "object" ||
    parsed.state === null ||
    !("unseen" in parsed.state) ||
    typeof parsed.state.unseen !== "object" ||
    parsed.state.unseen === null
  ) {
    throw new Error("Imported unseen state had an unexpected persisted shape");
  }
  return parsed.state.unseen as Record<string, string | null>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetModules();
  localStorage.clear();
});

describe("imported unseen persistence", () => {
  it("keeps the wipe fence closed for timers and pagehide", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { stopImportedUnseenWrites, useImportedUnseenStore } =
      await import("@/stores/session-import/imported-unseen-store");

    act(() => {
      useImportedUnseenStore.getState().markImported("before-wipe", "claude");
    });
    stopImportedUnseenWrites();
    act(() => {
      useImportedUnseenStore.getState().markImported("after-wipe", "codex");
    });
    await vi.advanceTimersByTimeAsync(1_001);
    window.dispatchEvent(new Event("pagehide"));

    expect(
      setItem.mock.calls.filter(([key]) => key === storageKey),
    ).toHaveLength(0);
  });

  it("coalesces 3,000 marks into a single latest snapshot", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { useImportedUnseenStore } =
      await import("@/stores/session-import/imported-unseen-store");

    act(() => {
      for (let index = 0; index < 3_000; index += 1) {
        useImportedUnseenStore
          .getState()
          .markImported(`epic-${index}`, "claude");
      }
    });

    await vi.advanceTimersByTimeAsync(1_001);
    const writes = setItem.mock.calls.filter(([key]) => key === storageKey);
    expect(writes.length).toBeLessThanOrEqual(3);
    expect(writes.length).toBeGreaterThan(0);
    const latest = JSON.parse(writes.at(-1)?.[1] ?? "null") as {
      state: { unseen: Record<string, string | null> };
    };
    expect(readPersistedUnseen()).toEqual(latest.state.unseen);
    expect(Object.keys(latest.state.unseen)).toHaveLength(3_000);
    expect(latest.state.unseen["epic-0"]).toBe("claude");
    expect(latest.state.unseen["epic-2999"]).toBe("claude");
  });

  it("persists seen changes on pagehide and when visibility becomes hidden", async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    try {
      const firstStore =
        await import("@/stores/session-import/imported-unseen-store");
      act(() => {
        const store = firstStore.useImportedUnseenStore.getState();
        store.markImported("pagehide-a", "claude");
        store.markImported("pagehide-b", "codex");
        store.markImported("pagehide-c", "opencode");
      });
      await vi.advanceTimersByTimeAsync(1_001);

      act(() => {
        firstStore.useImportedUnseenStore.getState().markSeen("pagehide-a");
      });
      window.dispatchEvent(new Event("pagehide"));

      vi.resetModules();
      const reloadedPagehideStore =
        await import("@/stores/session-import/imported-unseen-store");
      const { ImportedUnseenDot: PagehideDot } =
        await import("@/components/session-import/imported-unseen-dot");
      expect(
        reloadedPagehideStore.useImportedUnseenStore.getState().unseen[
          "pagehide-a"
        ],
      ).toBeUndefined();
      render(
        <>
          <PagehideDot epicId="pagehide-a" />
          <PagehideDot epicId="pagehide-b" />
          <PagehideDot epicId="pagehide-c" />
        </>,
      );
      expect(screen.queryAllByTestId("imported-unseen-dot")).toHaveLength(2);
      expect(
        screen.getByRole("img", {
          name: "Imported from Codex, not opened yet",
        }),
      ).toBeTruthy();
      expect(
        screen.getByRole("img", {
          name: "Imported from OpenCode, not opened yet",
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("img", {
          name: "Imported from Claude Code, not opened yet",
        }),
      ).toBeNull();

      cleanup();
      act(() => {
        reloadedPagehideStore.useImportedUnseenStore
          .getState()
          .markImported("visibility-a", "claude");
        reloadedPagehideStore.useImportedUnseenStore
          .getState()
          .markImported("visibility-b", "codex");
      });
      await vi.advanceTimersByTimeAsync(1_001);
      act(() => {
        reloadedPagehideStore.useImportedUnseenStore
          .getState()
          .markSeen("visibility-a");
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));

      vi.resetModules();
      const reloadedVisibilityStore =
        await import("@/stores/session-import/imported-unseen-store");
      const { ImportedUnseenDot: VisibilityDot } =
        await import("@/components/session-import/imported-unseen-dot");
      expect(
        reloadedVisibilityStore.useImportedUnseenStore.getState().unseen[
          "visibility-a"
        ],
      ).toBeUndefined();
      render(
        <>
          <VisibilityDot epicId="visibility-a" />
          <VisibilityDot epicId="visibility-b" />
        </>,
      );
      expect(
        screen.getByRole("img", {
          name: "Imported from Codex, not opened yet",
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("img", {
          name: "Imported from Claude Code, not opened yet",
        }),
      ).toBeNull();
    } finally {
      if (visibilityDescriptor === undefined) {
        Reflect.deleteProperty(document, "visibilityState");
      } else {
        Object.defineProperty(
          document,
          "visibilityState",
          visibilityDescriptor,
        );
      }
    }
  });

  it("shows and clears the dot in the same frame as each store update", async () => {
    const { useImportedUnseenStore } =
      await import("@/stores/session-import/imported-unseen-store");
    const { ImportedUnseenDot } =
      await import("@/components/session-import/imported-unseen-dot");
    render(<ImportedUnseenDot epicId="same-frame" />);

    act(() => {
      useImportedUnseenStore.getState().markImported("same-frame", "claude");
    });
    expect(screen.getByTestId("imported-unseen-dot")).toBeTruthy();

    act(() => {
      useImportedUnseenStore.getState().markSeen("same-frame");
    });
    expect(screen.queryByTestId("imported-unseen-dot")).toBeNull();
  });
});
