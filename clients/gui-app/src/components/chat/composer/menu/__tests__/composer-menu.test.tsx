import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isWithinTextEntryPopup } from "@/components/layout/shell/shell-gestures";
import type { MentionFlowStep } from "@/lib/composer/mentions";
import { setNativeKeyboardState } from "@/lib/native-keyboard";

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

describe("ComposerMenu as its editor's popup", () => {
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  // The other half lives with the keyboard-dismiss recognizer: a tap inside a
  // text entry's popup keeps the keyboard up. This half pins that the menu -
  // rendered in a portal, outside the editor's DOM - is recognised as one, so
  // tapping a row or the header chrome never blurs the editor.
  it("declares its rows and header as part of the editor's popup", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    const store = createComposerPickerStore();
    openSlashPickerWithItems(store, [describedSlashItem("take")]);

    render(<ComposerMenu pickerStore={store} />);
    await flush();

    expect(isWithinTextEntryPopup(screen.getByRole("option"))).toBe(true);
    expect(isWithinTextEntryPopup(screen.getByText("Slash commands"))).toBe(
      true,
    );
  });

  it("declares the preview panel beside the menu as part of the editor's popup", async () => {
    const store = createComposerPickerStore();
    openSlashPickerWithItems(store, [describedSlashItem("take")]);

    render(<ComposerMenu pickerStore={store} />);
    await flush();

    const panel = document.querySelector('[data-slot="mention-preview-panel"]');
    expect(panel).not.toBeNull();
    expect(isWithinTextEntryPopup(panel)).toBe(true);
  });
});

const PULL_REQUESTS_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "pull-requests",
  stepId: "pull-requests",
  workspacePath: null,
};

/**
 * The three shapes the menu opens in: the slash list, the mention root, and a
 * mention provider step with its chrome bar, still loading. All of them must
 * follow the keyboard.
 */
const MENU_SHAPES = [
  {
    name: "the slash menu",
    open: (store: ComposerPickerStore, clientRect: () => DOMRect): void => {
      openSlashPickerWithItems(store, [describedSlashItem("take")]);
      store.getState().updateRange({
        sessionId: SESSION_ID,
        range: { from: 1, to: 2 },
        query: "",
        slashScope: "all",
        clientRect,
      });
    },
  },
  {
    name: "the mention root",
    open: (store: ComposerPickerStore, clientRect: () => DOMRect): void => {
      openMentionPicker(store, clientRect);
    },
  },
  {
    name: "a mention provider step with its chrome bar",
    open: (store: ComposerPickerStore, clientRect: () => DOMRect): void => {
      openMentionPicker(store, clientRect);
      store.getState().setStep(PULL_REQUESTS_STEP);
      store.getState().setItems({
        sessionId: SESSION_ID,
        kind: "mention",
        query: "",
        slashScope: null,
        step: PULL_REQUESTS_STEP,
        items: [],
        loading: true,
        loadFailed: false,
        retryLoad: null,
      });
      store.getState().setStepChrome({
        sessionId: SESSION_ID,
        step: PULL_REQUESTS_STEP,
        chrome: {
          refresh: {
            onRefresh: () => Promise.resolve(),
            refreshing: false,
            label: "Refresh pull requests",
            timeoutMs: 20_000,
            targetKey: "pull-requests",
          },
          freshness: null,
          notice: null,
          filter: null,
          banner: null,
          appendedStatus: null,
          emptyLabel: null,
        },
      });
    },
  },
] as const;

function openMentionPicker(
  store: ComposerPickerStore,
  clientRect: () => DOMRect,
): void {
  store.getState().openPicker({
    sessionId: SESSION_ID,
    kind: "mention",
    slashScope: null,
    slashTrigger: null,
    range: { from: 1, to: 2 },
    query: "",
    commit: () => {},
    dismiss: null,
    focusEditor: null,
    clientRect,
  });
}

describe("ComposerMenu and the software keyboard", () => {
  afterEach(() => {
    setNativeKeyboardState({ open: false, transitioning: false });
    document.documentElement.style.removeProperty("--keyboard-inset");
  });

  // A keyboard opening or closing changes the room the menu may use without
  // moving anything floating-ui observes, so the menu has to be told. Every
  // positioning pass reads the caret rect, which makes its reads the count of
  // passes.
  it.each(MENU_SHAPES)(
    "repositions $name when the keyboard opens and again when it closes",
    async (shape) => {
      const store = createComposerPickerStore();
      const clientRect = vi.fn(() => new DOMRect(20, 300, 0, 20));
      shape.open(store, clientRect);

      render(<ComposerMenu pickerStore={store} />);
      await flush();
      const passesBeforeOpen = clientRect.mock.calls.length;
      expect(passesBeforeOpen).toBeGreaterThan(0);

      document.documentElement.style.setProperty("--keyboard-inset", "336px");
      act(() => {
        setNativeKeyboardState({ open: true, transitioning: true });
      });
      await flush();
      const passesAfterOpen = clientRect.mock.calls.length;
      expect(passesAfterOpen).toBeGreaterThan(passesBeforeOpen);

      document.documentElement.style.setProperty("--keyboard-inset", "0px");
      act(() => {
        setNativeKeyboardState({ open: false, transitioning: false });
      });
      await flush();
      expect(clientRect.mock.calls.length).toBeGreaterThan(passesAfterOpen);
    },
  );
});
