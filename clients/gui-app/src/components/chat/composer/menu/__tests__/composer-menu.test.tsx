import "../../../../../../__tests__/test-browser-apis";
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
