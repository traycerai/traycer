import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

const PERSIST_NAME = "traycer-gui-app:host-access-prompts";

function resetStore(): void {
  window.localStorage.clear();
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
}

function persistedState(): Record<string, unknown> {
  const raw = window.localStorage.getItem(PERSIST_NAME);
  if (raw === null) throw new Error("nothing was persisted");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("state" in parsed) ||
    typeof parsed.state !== "object" ||
    parsed.state === null
  ) {
    throw new Error("the persisted record has no state");
  }
  return { ...parsed.state };
}

describe("useHostAccessPromptsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("persists under the catalog name", () => {
    expect(persistKey(STORE_KEYS.hostAccessPrompts)).toBe(PERSIST_NAME);
    expect(useHostAccessPromptsStore.persist.getOptions().name).toBe(
      PERSIST_NAME,
    );
  });

  it("starts with nothing answered and nothing dismissed", () => {
    const state = useHostAccessPromptsStore.getState();
    expect(state.remoteAccessAnswered).toEqual({});
    expect(state.movedNoticeDismissed).toEqual({});
  });

  it("records a remote-access answer for that host id only", () => {
    useHostAccessPromptsStore.getState().answerRemoteAccess("host-a");

    const state = useHostAccessPromptsStore.getState();
    expect(state.remoteAccessAnswered).toEqual({ "host-a": true });
    expect(state.remoteAccessAnswered["host-b"]).toBeUndefined();
    expect(state.movedNoticeDismissed).toEqual({});
  });

  it("records a dismissed moved notice for that host id only", () => {
    useHostAccessPromptsStore.getState().dismissMovedNotice("host-a");

    const state = useHostAccessPromptsStore.getState();
    expect(state.movedNoticeDismissed).toEqual({ "host-a": true });
    expect(state.movedNoticeDismissed["host-b"]).toBeUndefined();
    expect(state.remoteAccessAnswered).toEqual({});
  });

  it("keeps the two prompts independent for one host", () => {
    useHostAccessPromptsStore.getState().answerRemoteAccess("host-a");
    useHostAccessPromptsStore.getState().dismissMovedNotice("host-b");

    const state = useHostAccessPromptsStore.getState();
    expect(state.remoteAccessAnswered).toEqual({ "host-a": true });
    expect(state.movedNoticeDismissed).toEqual({ "host-b": true });
  });

  it("accumulates hosts and answering twice changes nothing", () => {
    const { answerRemoteAccess } = useHostAccessPromptsStore.getState();
    answerRemoteAccess("host-a");
    answerRemoteAccess("host-b");
    answerRemoteAccess("host-a");

    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      "host-a": true,
      "host-b": true,
    });
  });

  it("persists only the two maps, never the actions", () => {
    useHostAccessPromptsStore.getState().answerRemoteAccess("host-a");
    useHostAccessPromptsStore.getState().dismissMovedNotice("host-b");

    expect(persistedState()).toEqual({
      remoteAccessAnswered: { "host-a": true },
      movedNoticeDismissed: { "host-b": true },
    });
  });

  it("restores the answers on rehydration", async () => {
    useHostAccessPromptsStore.getState().answerRemoteAccess("host-a");
    useHostAccessPromptsStore.getState().dismissMovedNotice("host-b");
    const persisted = window.localStorage.getItem(PERSIST_NAME);
    if (persisted === null) throw new Error("nothing was persisted");

    useHostAccessPromptsStore.setState({
      remoteAccessAnswered: {},
      movedNoticeDismissed: {},
    });
    window.localStorage.setItem(PERSIST_NAME, persisted);
    await useHostAccessPromptsStore.persist.rehydrate();

    const state = useHostAccessPromptsStore.getState();
    expect(state.remoteAccessAnswered).toEqual({ "host-a": true });
    expect(state.movedNoticeDismissed).toEqual({ "host-b": true });
    // The actions survive rehydration.
    state.answerRemoteAccess("host-c");
    expect(
      useHostAccessPromptsStore.getState().remoteAccessAnswered["host-c"],
    ).toBe(true);
  });
});
