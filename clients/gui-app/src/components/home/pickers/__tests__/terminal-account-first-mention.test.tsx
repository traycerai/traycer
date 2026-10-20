import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalAccountFirstMention } from "@/components/home/pickers/terminal-account-first-mention";
import { useTerminalAccountMentionStore } from "@/stores/onboarding/terminal-account-mention-store";

const SENTENCE =
  "This computer's own sign-in, which stays on this computer. Link a plan to use one everywhere.";
const PERSIST_NAME = "traycer-gui-app:terminal-account-mention";

function resetStore(): void {
  window.localStorage.clear();
  useTerminalAccountMentionStore.setState({ explained: false });
}

function explained(): boolean {
  return useTerminalAccountMentionStore.getState().explained;
}

describe("<TerminalAccountFirstMention />", () => {
  beforeEach(resetStore);
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("says what the Terminal account is when the picker names one and it has not been said", () => {
    render(<TerminalAccountFirstMention named />);

    expect(
      screen.getByTestId("terminal-account-first-mention").textContent,
    ).toBe(SENTENCE);
    // Shown is not said: it stays until the picker goes away.
    expect(explained()).toBe(false);
  });

  it("shows nothing when the picker does not name a Terminal account", () => {
    render(<TerminalAccountFirstMention named={false} />);

    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });

  it("shows nothing once it has been said on this desktop", () => {
    useTerminalAccountMentionStore.setState({ explained: true });
    render(<TerminalAccountFirstMention named />);

    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });

  it("counts it as said when the picker that showed it goes away, and a remount shows nothing", () => {
    const first = render(<TerminalAccountFirstMention named />);
    expect(screen.getByTestId("terminal-account-first-mention")).toBeTruthy();
    expect(explained()).toBe(false);

    first.unmount();

    expect(explained()).toBe(true);
    render(<TerminalAccountFirstMention named />);
    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });

  it("remembers it was said across a reload", async () => {
    render(<TerminalAccountFirstMention named />).unmount();
    const persisted = window.localStorage.getItem(PERSIST_NAME);
    if (persisted === null) throw new Error("nothing was persisted");

    useTerminalAccountMentionStore.setState({ explained: false });
    window.localStorage.setItem(PERSIST_NAME, persisted);
    await useTerminalAccountMentionStore.persist.rehydrate();

    expect(explained()).toBe(true);
    expect(JSON.parse(persisted)).toMatchObject({ state: { explained: true } });
  });

  it("does not mark it when it was never shown", () => {
    const unnamed = render(<TerminalAccountFirstMention named={false} />);
    unnamed.unmount();
    expect(explained()).toBe(false);

    // Nothing said was written either: a later picker that does name it
    // still has the sentence to say.
    expect(window.localStorage.getItem(PERSIST_NAME)).not.toContain(
      '"explained":true',
    );
    render(<TerminalAccountFirstMention named />);
    expect(screen.getByTestId("terminal-account-first-mention")).toBeTruthy();
  });
});
