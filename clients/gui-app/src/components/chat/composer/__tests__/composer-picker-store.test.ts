import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ROOT_MENTION_STEP,
  type MentionFlowStep,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";
import type { SlashCommand } from "@/lib/composer/types";

import {
  activePickerItemDisabledReason,
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

const LEADING_ONLY = "Commands can only be used at the start of a message";

function slashItem(
  name: string,
  disabledReason: string | null,
): ComposerPickerItem {
  return {
    id: name,
    kind: "slash",
    command: slashCommand(name),
    disabledReason,
  };
}

function open(
  store: ComposerPickerStore,
  query: string,
  commit: ComposerPickerCommit,
): void {
  store.getState().openPicker({
    sessionId: 1,
    kind: "mention",
    slashScope: null,
    slashTrigger: null,
    range: { from: 1, to: 1 + query.length + 1 },
    query,
    commit,
    clientRect: null,
  });
}

function openSlash(
  store: ComposerPickerStore,
  commit: ComposerPickerCommit,
): void {
  store.getState().openPicker({
    sessionId: 1,
    kind: "slash",
    slashScope: "skills",
    slashTrigger: "/",
    range: { from: 1, to: 2 },
    query: "",
    commit,
    clientRect: null,
  });
}

// Several suggestion plugins (`/`, `$`, `@`) drive one store, and replacing one
// trigger with another over a selection stops the old session and starts the
// new one in a single transaction - new `onStart` first, old `onExit` after.
// Without ownership the departing session's teardown shuts the picker that just
// opened, and the menu stays invisible while its plugin is still active.
describe("composer picker store session ownership", () => {
  it("ignores a close from a session that no longer owns the store", () => {
    const store = createComposerPickerStore();
    store.getState().openPicker({
      sessionId: 1,
      kind: "slash",
      slashScope: "skills",
      slashTrigger: "$",
      range: { from: 1, to: 2 },
      query: "",
      commit: NOOP_COMMIT,
      clientRect: null,
    });
    store.getState().openPicker({
      sessionId: 2,
      kind: "slash",
      slashScope: "all",
      slashTrigger: "/",
      range: { from: 1, to: 2 },
      query: "",
      commit: NOOP_COMMIT,
      clientRect: null,
    });

    store.getState().closeSession(1);

    expect(store.getState().open).toBe(true);
    expect(store.getState().sessionId).toBe(2);
    expect(store.getState().slashScope).toBe("all");
  });

  it("closes when the owning session exits", () => {
    const store = createComposerPickerStore();
    openSlash(store, NOOP_COMMIT);

    store.getState().closeSession(1);

    expect(store.getState().open).toBe(false);
    expect(store.getState().sessionId).toBeNull();
  });

  it("drops a range update from a session that no longer owns the store", () => {
    const store = createComposerPickerStore();
    openSlash(store, NOOP_COMMIT);
    store.getState().openPicker({
      sessionId: 2,
      kind: "slash",
      slashScope: "all",
      slashTrigger: "/",
      range: { from: 4, to: 5 },
      query: "",
      commit: NOOP_COMMIT,
      clientRect: null,
    });

    store.getState().updateRange({
      sessionId: 1,
      range: { from: 90, to: 99 },
      query: "stale",
      slashScope: "skills",
      clientRect: null,
    });

    expect(store.getState().range).toEqual({ from: 4, to: 5 });
    expect(store.getState().query).toBe("");
    expect(store.getState().slashScope).toBe("all");
  });

  it("still lets an unscoped close shut whatever is open", () => {
    const store = createComposerPickerStore();
    openSlash(store, NOOP_COMMIT);

    store.getState().close();

    expect(store.getState().open).toBe(false);
  });
});

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
      sessionId: 1,
      kind: "mention",
      query: "stale",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
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
      sessionId: 1,
      kind: "mention",
      query: "old",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items).toEqual([]);
  });

  // Kind, query, scope and step can all match across a session swap, so they
  // cannot tell the owner from its predecessor. Only the id can.
  it("setItems rejects a publication from a superseded same-identity session", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().openPicker({
      sessionId: 2,
      kind: "mention",
      slashScope: null,
      slashTrigger: null,
      range: { from: 1, to: 5 },
      query: "src",
      commit: NOOP_COMMIT,
      clientRect: null,
    });
    store.getState().setItems({
      sessionId: 1,
      kind: "mention",
      query: "src",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("stale")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items).toEqual([]);
    expect(store.getState().itemsForQuery).toBeNull();
  });

  it("setItems writes when kind, query, and step all match", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      sessionId: 1,
      kind: "mention",
      query: "src",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a"), mentionItem("b")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items.length).toBe(2);
    expect(store.getState().itemsForQuery).toBe("src");
  });

  it("setItems guards against stale resolution by step mismatch", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setStep(FILES_PROVIDER_STEP);
    store.getState().setItems({
      sessionId: 1,
      kind: "mention",
      query: "src",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items).toEqual([]);
  });

  it("setStep clears items and resets loading", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      sessionId: 1,
      kind: "mention",
      query: "src",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    store.getState().setStep(FILES_PROVIDER_STEP);
    expect(store.getState().items).toEqual([]);
    expect(store.getState().itemsForStepId).toBeNull();
  });

  it("moveActive wraps modulo items length", () => {
    const store = createComposerPickerStore();
    open(store, "", NOOP_COMMIT);
    store.getState().setItems({
      sessionId: 1,
      kind: "mention",
      query: "",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a"), mentionItem("b"), mentionItem("c")],
      loading: false,
      loadFailed: false,
      retryLoad: null,
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
      sessionId: 1,
      kind: "mention",
      query: "",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items,
      loading: false,
      loadFailed: false,
      retryLoad: null,
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

  it("opens on the first selectable row but navigates through disabled ones", () => {
    const store = createComposerPickerStore();
    const commit = vi.fn<ComposerPickerCommit>();
    openSlash(store, commit);
    const items = [
      slashItem("compact", LEADING_ONLY),
      slashItem("review", null),
      slashItem("clear", LEADING_ONLY),
      slashItem("simplify", null),
    ];
    store.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "",
      slashScope: "skills",
      step: ROOT_MENTION_STEP,
      items,
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    // Default selection lands past the leading disabled row so Enter works
    // without the user moving first.
    expect(store.getState().activeIndex).toBe(1);

    // Navigation is continuous - the highlight must not appear to teleport
    // over rows the user can still see.
    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(2);
    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(3);
    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(0);
    store.getState().moveActive(-1);
    expect(store.getState().activeIndex).toBe(3);

    // Hover may also land on a disabled row.
    store.getState().setActiveIndex(2);
    expect(store.getState().activeIndex).toBe(2);
  });

  // A scope flip rewrites every row's enabled/disabled policy, so rows built
  // under the old scope must not survive it - otherwise a native command
  // published while the caret was leading stays committable after the caret
  // makes the position skills-scoped.
  it("drops published items when the slash scope flips", () => {
    const store = createComposerPickerStore();
    store.getState().openPicker({
      sessionId: 1,
      kind: "slash",
      slashScope: "all",
      slashTrigger: null,
      range: { from: 1, to: 2 },
      query: "",
      commit: NOOP_COMMIT,
      clientRect: null,
    });
    store.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "",
      slashScope: "all",
      step: ROOT_MENTION_STEP,
      items: [slashItem("compact", null)],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items.length).toBe(1);
    expect(store.getState().itemsForSlashScope).toBe("all");

    store.getState().updateRange({
      sessionId: 1,
      range: { from: 8, to: 9 },
      query: "",
      slashScope: "skills",
      clientRect: null,
    });

    expect(store.getState().items).toEqual([]);
    expect(store.getState().itemsForSlashScope).toBeNull();
  });

  it("rejects items published under a scope the caret has already left", () => {
    const store = createComposerPickerStore();
    openSlash(store, NOOP_COMMIT);

    // The item hook resolved under "all" but the caret has since moved to a
    // skills-scoped position, so this list must not land.
    store.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "",
      slashScope: "all",
      step: ROOT_MENTION_STEP,
      items: [slashItem("compact", null)],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items).toEqual([]);

    // Republished under the live scope, it lands.
    store.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "",
      slashScope: "skills",
      step: ROOT_MENTION_STEP,
      items: [slashItem("compact", LEADING_ONLY)],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    expect(store.getState().items.length).toBe(1);
    expect(store.getState().itemsForSlashScope).toBe("skills");
    expect(store.getState().commitActiveItem()).toBe(false);
  });

  it("refuses to commit a disabled row while keeping it selectable", () => {
    const store = createComposerPickerStore();
    const commit = vi.fn<ComposerPickerCommit>();
    openSlash(store, commit);
    const items = [
      slashItem("review", null),
      slashItem("compact", LEADING_ONLY),
    ];
    store.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "",
      slashScope: "skills",
      step: ROOT_MENTION_STEP,
      items,
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });

    store.getState().setActiveIndex(1);
    expect(store.getState().activeIndex).toBe(1);
    expect(activePickerItemDisabledReason(store.getState())).toBe(LEADING_ONLY);
    expect(store.getState().commitActiveItem()).toBe(false);
    expect(commit).not.toHaveBeenCalled();

    store.getState().setActiveIndex(0);
    expect(activePickerItemDisabledReason(store.getState())).toBeNull();
    expect(store.getState().commitActiveItem()).toBe(true);
    expect(commit).toHaveBeenCalledWith(items[0]);
  });

  it("close fully resets store state", () => {
    const store = createComposerPickerStore();
    open(store, "src", NOOP_COMMIT);
    store.getState().setItems({
      sessionId: 1,
      kind: "mention",
      query: "src",
      slashScope: null,
      step: ROOT_MENTION_STEP,
      items: [mentionItem("a")],
      loading: true,
      loadFailed: false,
      retryLoad: null,
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
      sessionId: 1,
      kind: "slash",
      slashScope: "all",
      slashTrigger: null,
      range: { from: 1, to: 2 },
      query: "",
      commit: NOOP_COMMIT,
      clientRect: null,
    });
    store.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "",
      slashScope: "all",
      step: ROOT_MENTION_STEP,
      items: [slashItem("plan", null), slashItem("commit", null)],
      loading: false,
      loadFailed: false,
      retryLoad: null,
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
      sessionId: 1,
      range: before.range,
      query: "src",
      slashScope: null,
      clientRect: null,
    });
    expect(store.getState()).toBe(before);
  });
});
