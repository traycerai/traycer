import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useChatTreeRowModel } from "@/components/epic-canvas/sidebar/use-chat-tree-row-model";
import {
  pendingCreateRowKey,
  type ChatTreeRowModel,
  type FlattenChatTreeRowsInput,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";
import { DEFAULT_SORT_MODE, makeNodeComparator } from "@/lib/epic-sort";
import {
  chatNode,
  cloudEntry,
  cloudSummary,
  flattenInput,
  localEntry,
  treeOf,
} from "./chat-tree-row-fixtures";

/**
 * The panel's row model: the revision moves only when the sequence of row
 * keys changes, and a row whose facts did not change stays the same object so
 * the memoised row component does not re-render.
 */

const TREE = treeOf([
  chatNode("root", null, 100),
  chatNode("child", "root", 90),
  chatNode("other", null, 50),
]);

function renderModel(initial: FlattenChatTreeRowsInput) {
  return renderHook(
    (input: FlattenChatTreeRowsInput) => useChatTreeRowModel(input),
    { initialProps: initial },
  );
}

const BASE = flattenInput({
  listEntries: [localEntry("root"), localEntry("other")],
  tree: TREE,
  expandedIds: new Set<string>(),
});

function rowKeys(model: ChatTreeRowModel): string[] {
  return model.rows.map((row) => row.key);
}

describe("useChatTreeRowModel revision", () => {
  it("holds the model itself when the inputs are rebuilt with the same content", () => {
    const view = renderModel(BASE);
    const first = view.result.current;

    view.rerender({
      ...BASE,
      listEntries: [localEntry("root"), localEntry("other")],
      expandedIds: new Set<string>(),
    });

    expect(view.result.current).toBe(first);
    expect(first.revision).toBe(0);
  });

  it("moves the revision when a branch expands and shows its rows", () => {
    const view = renderModel(BASE);

    view.rerender({ ...BASE, expandedIds: new Set(["root"]) });

    expect(view.result.current.revision).toBe(1);
    expect(view.result.current.rows).toHaveLength(3);
    expect(view.result.current.indexByKey.size).toBe(3);
  });

  it("moves the revision when a row arrives, leaves or the rows reorder", () => {
    const view = renderModel(BASE);

    view.rerender({
      ...BASE,
      listEntries: [localEntry("other"), localEntry("root")],
    });
    expect(view.result.current.revision).toBe(1);
    expect(rowKeys(view.result.current)).toEqual(
      [localEntry("other"), localEntry("root")].map((entry) => entry.key),
    );

    view.rerender({ ...BASE, listEntries: [localEntry("other")] });
    expect(view.result.current.revision).toBe(2);

    view.rerender(BASE);
    expect(view.result.current.revision).toBe(3);
  });

  it("leaves the revision and the other rows alone when one row's own facts change", () => {
    const withPending = (name: string): FlattenChatTreeRowsInput => ({
      ...BASE,
      pendingRoots: [{ key: pendingCreateRowKey("c1"), name }],
    });
    const view = renderModel(withPending("first"));
    const before = view.result.current;

    view.rerender(withPending("second"));

    const after = view.result.current;
    expect(after.revision).toBe(before.revision);
    expect(after.indexByKey).toBe(before.indexByKey);
    expect(after.rows[0]).toBe(before.rows[0]);
    expect(after.rows[1]).toBe(before.rows[1]);
    expect(after.rows[2]).not.toBe(before.rows[2]);
    expect(after.rows[2]).toMatchObject({ name: "second" });
  });
});

describe("useChatTreeRowModel over inputs rebuilt on every render", () => {
  const COMPARATOR = makeNodeComparator(DEFAULT_SORT_MODE);

  function freshCloudInput(title: string): FlattenChatTreeRowsInput {
    const parent = cloudSummary("orchestrator", null, "Orchestrator");
    return flattenInput({
      listEntries: [
        cloudEntry(parent, [
          cloudEntry(cloudSummary("sub", "orchestrator", title), []),
        ]),
        localEntry("other"),
      ],
      tree: TREE,
      comparator: COMPARATOR,
      expandedIds: new Set([cloudEntry(parent, []).key]),
    });
  }

  it("does not loop, and keeps every row's identity, when equal cloud summaries are rebuilt each render", () => {
    const view = renderHook(
      ({ title }: { readonly title: string }) =>
        useChatTreeRowModel(freshCloudInput(title)),
      { initialProps: { title: "Sub" } },
    );
    const before = view.result.current;

    view.rerender({ title: "Sub" });

    expect(view.result.current).toBe(before);
    expect(before.rows).toHaveLength(3);
  });

  it("replaces only the row whose cloud summary changed, leaving the revision alone", () => {
    const view = renderHook(
      ({ title }: { readonly title: string }) =>
        useChatTreeRowModel(freshCloudInput(title)),
      { initialProps: { title: "Sub" } },
    );
    const before = view.result.current;

    view.rerender({ title: "Renamed" });

    const after = view.result.current;
    expect(after.revision).toBe(before.revision);
    expect(after.rows[0]).toBe(before.rows[0]);
    expect(after.rows[2]).toBe(before.rows[2]);
    expect(after.rows[1]).not.toBe(before.rows[1]);
    expect(after.rows[1]).toMatchObject({
      kind: "cloud",
      chat: { title: "Renamed" },
    });
  });
});
