import { afterEach, describe, expect, it } from "vitest";
import { useBrowserFocusStore } from "@/stores/settings/browser-focus-store";

function resetBrowserFocusStore(): void {
  useBrowserFocusStore.setState({ openImportLogins: false });
}

describe("useBrowserFocusStore", () => {
  afterEach(resetBrowserFocusStore);

  it("starts with no armed intent", () => {
    expect(useBrowserFocusStore.getState().openImportLogins).toBe(false);
  });

  it("requestImportLogins arms the intent", () => {
    useBrowserFocusStore.getState().requestImportLogins();

    expect(useBrowserFocusStore.getState().openImportLogins).toBe(true);
  });

  it("consumeImportLogins clears an armed intent", () => {
    useBrowserFocusStore.getState().requestImportLogins();

    useBrowserFocusStore.getState().consumeImportLogins();

    expect(useBrowserFocusStore.getState().openImportLogins).toBe(false);
  });

  it("consumeImportLogins is a no-op when nothing is armed", () => {
    useBrowserFocusStore.getState().consumeImportLogins();

    expect(useBrowserFocusStore.getState().openImportLogins).toBe(false);
  });

  it("round-trips request then consume", () => {
    const store = useBrowserFocusStore.getState();
    expect(store.openImportLogins).toBe(false);

    store.requestImportLogins();
    expect(useBrowserFocusStore.getState().openImportLogins).toBe(true);

    useBrowserFocusStore.getState().consumeImportLogins();
    expect(useBrowserFocusStore.getState().openImportLogins).toBe(false);
  });
});
