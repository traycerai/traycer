import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { SlashCommand } from "@/lib/composer/types";
import {
  ROOT_MENTION_STEP,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";

import {
  createComposerPickerStore,
  type ComposerPickerItem,
  type ComposerPickerStore,
  type ComposerSlashScope,
  type ComposerSlashTrigger,
} from "../../picker/composer-picker-store";
import { ComposerMenu } from "../composer-menu";

afterEach(() => {
  cleanup();
});

const LEADING_ONLY = "This command is only allowed at the start of the message";

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

function mentionEntry(
  label: string,
  disabledReason: string | null,
): MentionMenuEntry {
  return {
    id: label,
    labelPrefix: null,
    label,
    detail: "",
    description: "",
    searchText: null,
    disabledReason,
    icon: <span />,
    action: { kind: "back" },
    updatedAt: null,
    archived: false,
    dormant: false,
    preview: null,
  };
}

function mentionItem(
  label: string,
  disabledReason: string | null,
): ComposerPickerItem {
  return {
    id: label,
    kind: "mention",
    entry: mentionEntry(label, disabledReason),
  };
}

function openWith(
  store: ComposerPickerStore,
  items: ReadonlyArray<ComposerPickerItem>,
): void {
  openTriggered(store, items, "/", "skills");
}

// Mirrors `openTriggered`, but for a MENTION-kind picker session - the shape
// `renderPickerItem` actually sees for a mention row (a slash-kind session
// never carries one).
function openMentionWith(
  store: ComposerPickerStore,
  items: ReadonlyArray<ComposerPickerItem>,
): void {
  store.getState().openPicker({
    sessionId: 1,
    kind: "mention",
    slashScope: null,
    slashTrigger: null,
    range: { from: 1, to: 2 },
    query: "",
    commit: () => undefined,
    dismiss: null,
    focusEditor: null,
    clientRect: null,
  });
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
}

function openTriggered(
  store: ComposerPickerStore,
  items: ReadonlyArray<ComposerPickerItem>,
  slashTrigger: ComposerSlashTrigger,
  slashScope: ComposerSlashScope,
): void {
  store.getState().openPicker({
    sessionId: 1,
    kind: "slash",
    slashScope,
    slashTrigger,
    range: { from: 1, to: 2 },
    query: "",
    commit: () => undefined,
    dismiss: null,
    focusEditor: null,
    clientRect: null,
  });
  store.getState().setItems({
    sessionId: 1,
    kind: "slash",
    query: "",
    slashScope,
    step: store.getState().step,
    items,
    loading: false,
    loadFailed: false,
    retryLoad: null,
  });
}

// The reason a row is unavailable lives in the side preview panel, which is
// `aria-hidden` and disappears when it cannot fit. `aria-disabled` alone says
// a row is unavailable but never why, so the row itself has to carry the
// explanation or assistive tech never receives it.
describe("<ComposerMenu /> disabled rows", () => {
  it("puts the disabled reason in the row's accessible name", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openWith(store, [slashItem("plan", LEADING_ONLY)]);
    });

    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(`Disabled. ${LEADING_ONLY}`);
  });

  it("leaves an enabled row's accessible name free of policy text", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openWith(store, [slashItem("plan", null)]);
    });

    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("false");
    expect(option.textContent).not.toContain("Disabled.");
  });

  // `renderPickerItem` used to hardcode `disabledReason: null` for mention
  // rows, so a held mention entry (e.g. a GitHub row shown during a filter
  // swap) rendered as actionable even though the store's own commit gate
  // reads `entry.disabledReason` and would have refused it.
  it("puts the disabled reason in a mention row's accessible name", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openMentionWith(store, [mentionItem("Stop the busy-loop", LEADING_ONLY)]);
    });

    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(`Disabled. ${LEADING_ONLY}`);
  });

  it("leaves an enabled mention row's accessible name free of policy text", () => {
    // The control. Without it, a fix that disabled every mention row
    // unconditionally would pass the case above too.
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openMentionWith(store, [mentionItem("Stop the busy-loop", null)]);
    });

    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("false");
    expect(option.textContent).not.toContain("Disabled.");
  });
});

// The menu has to echo the character the user actually typed. Rendering a `$`
// list as `/name` contradicts both the composer and the chip the row inserts,
// which reads back as `$name`.
describe("<ComposerMenu /> trigger echo", () => {
  it("prefixes rows with $ when the picker was opened with $", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openTriggered(store, [slashItem("frontend-design", null)], "$", "all");
    });

    expect(screen.getByRole("option").textContent).toContain(
      "$frontend-design",
    );
    expect(screen.getByRole("option").textContent).not.toContain(
      "/frontend-design",
    );
  });

  it("keeps the / prefix for a slash-opened picker", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openTriggered(store, [slashItem("plan", null)], "/", "all");
    });

    expect(screen.getByRole("option").textContent).toContain("/plan");
  });

  // The trigger changes the row prefixes and nothing else: both open the same
  // catalog, so a `$` list is not a skills list and must not claim to be one.
  it("keeps the same header whichever trigger opened the picker", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openTriggered(store, [slashItem("frontend-design", null)], "$", "all");
    });

    expect(document.body.textContent).toContain("Slash commands");
  });
});
