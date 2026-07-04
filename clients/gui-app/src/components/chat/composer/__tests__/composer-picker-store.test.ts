import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ROOT_MENTION_STEP,
  type MentionFlowStep,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";
import type { SlashCommand } from "@/lib/composer/types";

import {
  createComposerPickerStore,
  type ComposerPickerCommit,
  type ComposerPickerItem,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

const NOOP_COMMIT: ComposerPickerCommit = () => undefined;

const FAKE_ICON: ReactElement = { type: "span", props: {}, key: null };

const FILES_PROVIDER_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "files",
  stepId: "files",
  workspacePath: null,
};

function fakeMentionEntry(id: string, label: string): MentionMenuEntry {
  return {
    id,
    label,
    detail: "",
    description: "",
    icon: FAKE_ICON,
    action: { kind: "back" },
    preview: null,
  };
}

function mentionItem(id: string): ComposerPickerItem {
  return { id, kind: "mention", entry: fakeMentionEntry(id, id) };
}

function slashCommand(name: string): SlashCommand {
  return {
    harnessId: "claude",
    name,
    description: "",
    argumentHint: null,
    kind: "slash-command",
    metadata: {},
    source: "provider",
    preview: { kind: "text", primary: "", secondary: null, mono: false },
  };
}

function slashItem(name: string): ComposerPickerItem {
  return { id: name, kind: "slash", command: slashCommand(name) };
}

function open(
  store: ComposerPickerStore,
  query: string,
  commit: ComposerPickerCommit,
): void {
  store.getState().openPicker({
    kind: "mention",
    range: { from: 1, to: 1 + query.length + 1 },
    query,
    commit,
    clientRect: null,
  });
}

describe("composer picker store", () => {
  it("starts in fully reset state", () => {
    const store = createComposerPickerStore();
    expect(store.getState().open).toBe(false);
    expect(store.getState().items).toEqual([]);
    expect(store.getState().query).toBe("");
    expect(store.getState().step).toEqual(ROOT_MENTION_STEP);
    expect(store.getState().activeIndex).toBe(0);
  });

  it("openPicker sets kind, range, query, and resets items", () => {
    const store = createComposerPickerStore();
    store.getState().setItems({
      kind: "mention",
      query: "stale",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
    });
    open(store, "src", NOOP_COMMIT);

    const state = store.getState();
    expect(state.open).toBe(true);
    expect(state.kind).toBe("mention");
    expect(state.query).toBe("src");
    expect(state.range).toEqual({ from: 1, to: 5 });
    expect(state.items).toEqual([]);
    expect(state.itemsForQuery).toBeNull();
  });

  it("setItems guards against stale resolution by query mismatch", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      kind: "mention",
      query: "old",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
    });
    expect(store.getState().items).toEqual([]);
  });

  it("setItems writes when kind, query, and step all match", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      kind: "mention",
      query: "src",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a"), mentionItem("b")],
      loading: false,
    });
    expect(store.getState().items.length).toBe(2);
    expect(store.getState().itemsForQuery).toBe("src");
  });

  it("setItems guards against stale resolution by step mismatch", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setStep(FILES_PROVIDER_STEP);
    store.getState().setItems({
      kind: "mention",
      query: "src",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
    });
    expect(store.getState().items).toEqual([]);
  });

  it("setStep clears items and resets loading", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      kind: "mention",
      query: "src",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
    });
    store.getState().setStep(FILES_PROVIDER_STEP);
    expect(store.getState().items).toEqual([]);
    expect(store.getState().itemsForStepId).toBeNull();
  });

  it("moveActive wraps modulo items length", () => {
    const store = createComposerPickerStore();
    open(store, "", NOOP_COMMIT);
    store.getState().setItems({
      kind: "mention",
      query: "",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a"), mentionItem("b"), mentionItem("c")],
      loading: false,
    });
    expect(store.getState().activeIndex).toBe(0);
    store.getState().moveActive(-1);
    expect(store.getState().activeIndex).toBe(2);
    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(0);
    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(1);
  });

  it("commitActiveItem invokes commit with active item and returns true", () => {
    const store = createComposerPickerStore();
    const commit = vi.fn<ComposerPickerCommit>();
    open(store, "", commit);
    const items = [mentionItem("a"), mentionItem("b")];
    store.getState().setItems({
      kind: "mention",
      query: "",
      step: ROOT_MENTION_STEP,
      items,
      loading: false,
    });
    store.getState().setActiveIndex(1);
    expect(store.getState().commitActiveItem()).toBe(true);
    expect(commit).toHaveBeenCalledWith(items[1]);
  });

  it("commitActiveItem returns false when items empty", () => {
    const store = createComposerPickerStore();
    open(store, "", NOOP_COMMIT);
    expect(store.getState().commitActiveItem()).toBe(false);
  });

  it("close fully resets store state", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      kind: "mention",
      query: "src",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: true,
    });
    store.getState().close();
    const state = store.getState();
    expect(state.open).toBe(false);
    expect(state.items).toEqual([]);
    expect(state.query).toBe("");
    expect(state.range).toBeNull();
    expect(state.step).toEqual(ROOT_MENTION_STEP);
    expect(state.commit).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("supports slash kind items", () => {
    const store = createComposerPickerStore();
    store.getState().openPicker({
      kind: "slash",
      range: { from: 1, to: 2 },
      query: "",
      commit: NOOP_COMMIT,
      clientRect: null,
    });
    store.getState().setItems({
      kind: "slash",
      query: "",
      step: ROOT_MENTION_STEP,
      items: [slashItem("plan"), slashItem("commit")],
      loading: false,
    });
    expect(store.getState().items.length).toBe(2);
    expect(store.getState().kind).toBe("slash");
  });

  it("setKnownSlashCommands stores the catalog and survives close", () => {
    const store = createComposerPickerStore();
    expect(store.getState().knownSlashCommands).toBeNull();
    const commands = new Map([
      ["plan", "plan"],
      ["commit", "commit"],
    ]);
    store.getState().setKnownSlashCommands(commands);
    expect(store.getState().knownSlashCommands).toBe(commands);
    open(store, "src", NOOP_COMMIT);
    store.getState().close();
    expect(store.getState().knownSlashCommands).toBe(commands);
  });

  it("updateRange ignores no-op updates", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    const before = store.getState();
    if (before.range === null) throw new Error("range missing");
    store.getState().updateRange({
      range: before.range,
      query: "src",
      clientRect: null,
    });
    expect(store.getState()).toBe(before);
  });
});
