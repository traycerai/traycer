import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordMapStorageKey,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist/keys";

const storagePrefix = persistKey(STORE_KEYS.sessionImportUnseen);
const epicKey = (epicId: string): string =>
  recordMapStorageKey(storagePrefix, epicId);

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetModules();
});

describe("imported unseen per-entry persistence", () => {
  it("writes and removes only the addressed entry with 3,000 other entries present", async () => {
    for (let index = 0; index < 3000; index += 1) {
      localStorage.setItem(
        epicKey(`existing-${index}`),
        '{"harness":"claude"}',
      );
    }
    const storeModule =
      await import("@/stores/session-import/imported-unseen-store");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const epicId = "new-import";

    act(() => {
      storeModule.useImportedUnseenStore
        .getState()
        .markImported(epicId, "codex");
    });

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(
      epicKey(epicId),
      '{"harness":"codex"}',
    );
    expect(localStorage.getItem(epicKey(epicId))).toBe('{"harness":"codex"}');

    setItem.mockClear();
    act(() => {
      storeModule.useImportedUnseenStore.getState().markSeen(epicId);
    });

    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith(epicKey(epicId));
    expect(setItem).not.toHaveBeenCalled();
  });

  it("migrates the legacy blob once without replacing an existing entry", async () => {
    const legacyKey = storagePrefix;
    const existingEpic = "already-current";
    const migratedEpic = "from-legacy";
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        state: {
          unseen: {
            [existingEpic]: "claude",
            [migratedEpic]: null,
          },
        },
        version: 0,
      }),
    );
    localStorage.setItem(epicKey(existingEpic), '{"harness":"codex"}');

    const { ImportedUnseenDot } =
      await import("@/components/session-import/imported-unseen-dot");

    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(localStorage.getItem(epicKey(existingEpic))).toBe(
      '{"harness":"codex"}',
    );
    expect(localStorage.getItem(epicKey(migratedEpic))).toBe(
      '{"harness":null}',
    );

    render(
      <>
        <ImportedUnseenDot epicId={existingEpic} />
        <ImportedUnseenDot epicId={migratedEpic} />
      </>,
    );
    expect(
      screen.getByRole("img", { name: "Imported from Codex, not opened yet" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Imported, not opened yet" }),
    ).toBeTruthy();
  });
});
