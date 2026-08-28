import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createComposerPickerStore,
  type ComposerPickerItem,
  type ComposerPickerStore,
} from "../../picker/composer-picker-store";
import { ComposerMenu } from "../composer-menu";

afterEach(() => {
  cleanup();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const SESSION_ID = 1;

function openSlashPicker(store: ComposerPickerStore): void {
  store.getState().openPicker({
    sessionId: SESSION_ID,
    kind: "slash",
    slashScope: "all",
    slashTrigger: "/",
    range: { from: 1, to: 2 },
    query: "",
    commit: () => {},
    dismiss: null,
    focusEditor: null,
    clientRect: null,
  });
}

function setSlashItems(
  store: ComposerPickerStore,
  input: {
    readonly loadFailed: boolean;
    readonly retryLoad: (() => void) | null;
  },
): void {
  store.getState().setItems({
    sessionId: SESSION_ID,
    kind: "slash",
    query: "",
    slashScope: "all",
    step: { kind: "root" },
    items: [],
    loading: false,
    loadFailed: input.loadFailed,
    retryLoad: input.retryLoad,
  });
}

describe("ComposerMenu slash load failure", () => {
  it("renders a retryable error row instead of the empty label when the catalog failed", async () => {
    const store = createComposerPickerStore();
    const retryLoad = vi.fn();
    openSlashPicker(store);
    setSlashItems(store, { loadFailed: true, retryLoad });

    render(<ComposerMenu pickerStore={store} />);
    await flush();

    expect(screen.getByText("Couldn't load commands")).toBeTruthy();
    expect(screen.queryByText("No matching commands")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryLoad).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty label for a successful catalog with no matches", async () => {
    const store = createComposerPickerStore();
    openSlashPicker(store);
    setSlashItems(store, { loadFailed: false, retryLoad: null });

    render(<ComposerMenu pickerStore={store} />);
    await flush();

    expect(screen.getByText("No matching commands")).toBeTruthy();
    expect(screen.queryByText("Couldn't load commands")).toBeNull();
  });

  it("clears the failure state when the picker reopens", () => {
    const store = createComposerPickerStore();
    openSlashPicker(store);
    setSlashItems(store, { loadFailed: true, retryLoad: () => {} });
    store.getState().close();
    openSlashPicker(store);

    expect(store.getState().loadFailed).toBe(false);
    expect(store.getState().retryLoad).toBeNull();
  });
});

function describedSlashItem(name: string): ComposerPickerItem {
  return {
    id: name,
    kind: "slash",
    command: {
      harnessId: "claude",
      name,
      description: "does a thing",
      argumentHint: null,
      kind: "slash-command",
      metadata: {},
      source: "provider",
      preview: {
        kind: "text",
        primary: "does a thing",
        secondary: null,
        mono: false,
      },
    },
    disabledReason: null,
  };
}

function openSlashPickerWithItems(
  store: ComposerPickerStore,
  items: ReadonlyArray<ComposerPickerItem>,
): void {
  openSlashPicker(store);
  store.getState().setItems({
    sessionId: SESSION_ID,
    kind: "slash",
    query: "",
    slashScope: "all",
    step: store.getState().step,
    items,
    loading: false,
    loadFailed: false,
    retryLoad: null,
  });
}

describe("ComposerMenu preview panel viewport gate", () => {
  // `useIsMobileViewport` reads `window.innerWidth` directly, so overriding
  // it before render is what forces the phone presentation - same pattern as
  // the providers panel's mobile suites.
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  it("renders the preview panel beside the menu on desktop", async () => {
    const store = createComposerPickerStore();
    openSlashPickerWithItems(store, [describedSlashItem("take")]);

    render(<ComposerMenu pickerStore={store} />);
    await flush();

    expect(
      document.querySelector('[data-slot="mention-preview-panel"]'),
    ).not.toBeNull();
  });

  it("does not mount the preview panel on a phone viewport", async () => {
    // The regression this pins: the panel is a SIDE surface, and a phone has
    // no side room - every placement covers the command list, so the row's
    // description painted on top of the menu it described.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    const store = createComposerPickerStore();
    openSlashPickerWithItems(store, [describedSlashItem("take")]);

    render(<ComposerMenu pickerStore={store} />);
    await flush();

    expect(
      document.querySelector('[data-slot="mention-preview-panel"]'),
    ).toBeNull();
    // The menu itself still renders - only the side panel is gone.
    expect(screen.getByText("/take")).toBeTruthy();
  });
});
