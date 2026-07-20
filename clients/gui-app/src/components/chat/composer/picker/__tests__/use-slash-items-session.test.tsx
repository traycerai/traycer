import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SlashCommand } from "@/lib/composer/types";

import {
  createComposerPickerStore,
  type ComposerPickerStore,
  type ComposerSlashScope,
} from "../composer-picker-store";
import { useSlashItems } from "../use-slash-items";

// Hoisted alongside the `vi.mock` that closes over it. Only the returned hook
// reads `CATALOG`, and it is not called until a test renders, so a plain
// top-level const would also work - but reading it in the factory body itself
// would throw, and keeping the fixture hoisted removes that edge entirely.
const { CATALOG } = vi.hoisted(
  (): { CATALOG: ReadonlyArray<SlashCommand> } => ({
    CATALOG: [
      {
        harnessId: "claude",
        name: "plan",
        description: "",
        argumentHint: null,
        kind: "slash-command",
        metadata: {},
        source: "provider",
        preview: { kind: "text", primary: "", secondary: null, mono: false },
      },
    ],
  }),
);

// The catalog is deliberately constant across renders: the bug under test is
// about the hook not re-running, so any per-render identity change would mask
// it by re-triggering the effect for the wrong reason.
vi.mock("@/hooks/composer/use-slash-commands", () => ({
  useSlashCommands: () => ({
    data: CATALOG,
    isLoading: false,
    isFetching: false,
  }),
}));

function openSession(
  store: ComposerPickerStore,
  sessionId: number,
  query: string,
  slashScope: ComposerSlashScope,
): void {
  store.getState().openPicker({
    sessionId,
    kind: "slash",
    slashScope,
    slashTrigger: "/",
    range: { from: 1, to: 2 },
    query,
    commit: () => undefined,
    clientRect: null,
  });
}

function renderItems(store: ComposerPickerStore) {
  return renderHook(() =>
    useSlashItems({
      pickerStore: store,
      hostClient: null,
      harnessId: "claude",
      workingDirectories: [],
    }),
  );
}

/**
 * Tiptap swaps suggestion sessions without ever closing the picker - typing `/`
 * over a selection ends one session and starts another in the same transaction.
 * `openPicker` clears the published rows for the incoming session, so something
 * has to republish them. Every input the item effect watches (`query`,
 * `slashScope`, the catalog) can be identical across that swap, which leaves the
 * session id as the only evidence that a republish is owed.
 */
describe("useSlashItems across a session swap", () => {
  it("republishes rows when a new session reopens on the same query", () => {
    const store = createComposerPickerStore();
    const view = renderItems(store);

    act(() => {
      openSession(store, 1, "", "all");
    });
    view.rerender();
    expect(store.getState().items).toHaveLength(1);

    // Same query, same scope, same catalog - only the session differs.
    act(() => {
      openSession(store, 2, "", "all");
    });
    view.rerender();

    expect(store.getState().items).toHaveLength(1);
  });

  it("publishes under the incoming session so the rows are not disowned", () => {
    const store = createComposerPickerStore();
    const view = renderItems(store);

    act(() => {
      openSession(store, 1, "", "all");
    });
    view.rerender();
    act(() => {
      openSession(store, 2, "", "all");
    });
    view.rerender();

    expect(store.getState().sessionId).toBe(2);
    expect(store.getState().itemsForQuery).toBe("");
  });
});
