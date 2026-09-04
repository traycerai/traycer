import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmAndLaunchExternalScheme,
  launchExternalFromGuest,
  resetConfirmedGuestExternalSchemesForTest,
} from "../security";

const electronState = vi.hoisted(() => ({
  openExternalCalls: [] as string[],
  openExternalResult: true as boolean,
  messageBoxCalls: 0,
  messageBoxResponse: 1,
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: (url: string): Promise<void> => {
      electronState.openExternalCalls.push(url);
      return electronState.openExternalResult
        ? Promise.resolve()
        : Promise.reject(new Error("no handler"));
    },
  },
  dialog: {
    showMessageBox: (): Promise<{ readonly response: number }> => {
      electronState.messageBoxCalls += 1;
      return Promise.resolve({ response: electronState.messageBoxResponse });
    },
  },
  session: {},
}));

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("launchExternalFromGuest", () => {
  beforeEach(() => {
    electronState.openExternalCalls = [];
    electronState.openExternalResult = true;
  });

  it("opens a safe scheme straight through with no dialog", async () => {
    electronState.messageBoxCalls = 0;
    expect(await launchExternalFromGuest("mailto:a@b.example")).toBe(true);
    expect(electronState.openExternalCalls).toEqual(["mailto:a@b.example"]);
    expect(electronState.messageBoxCalls).toBe(0);
  });

  it("reports failure when the OS has no handler", async () => {
    electronState.openExternalResult = false;
    expect(await launchExternalFromGuest("tel:+1")).toBe(false);
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "about:settings",
    "chrome://settings",
  ])(
    "self-guards a dangerous scheme (%s) - never openExternal",
    async (url) => {
      expect(await launchExternalFromGuest(url)).toBe(false);
      expect(electronState.openExternalCalls).toEqual([]);
    },
  );
});

describe("confirmAndLaunchExternalScheme (arbitrary app deep link)", () => {
  beforeEach(() => {
    electronState.openExternalCalls = [];
    electronState.openExternalResult = true;
    electronState.messageBoxCalls = 0;
    electronState.messageBoxResponse = 1;
    resetConfirmedGuestExternalSchemesForTest();
  });

  it("prompts, then opens on Open", async () => {
    expect(await confirmAndLaunchExternalScheme("zoommtg://join?x=1")).toBe(
      true,
    );
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.openExternalCalls).toEqual(["zoommtg://join?x=1"]);
  });

  it("does NOT re-prompt for the same scheme a second time this session", async () => {
    await confirmAndLaunchExternalScheme("slack://open?team=1");
    expect(electronState.messageBoxCalls).toBe(1);

    expect(await confirmAndLaunchExternalScheme("slack://open?team=2")).toBe(
      true,
    );
    // Still one dialog; the second open goes straight through.
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.openExternalCalls).toEqual([
      "slack://open?team=1",
      "slack://open?team=2",
    ]);
  });

  it("tracks the grant per scheme, not globally - a different scheme re-prompts", async () => {
    await confirmAndLaunchExternalScheme("zoommtg://join");
    expect(electronState.messageBoxCalls).toBe(1);
    // A DIFFERENT scheme is not covered by the first grant: it prompts again.
    expect(await confirmAndLaunchExternalScheme("slack://open")).toBe(true);
    expect(electronState.messageBoxCalls).toBe(2);
    expect(electronState.openExternalCalls).toEqual([
      "zoommtg://join",
      "slack://open",
    ]);
  });

  it("opens nothing on Cancel", async () => {
    electronState.messageBoxResponse = 0;
    expect(await confirmAndLaunchExternalScheme("msteams://chat")).toBe(false);
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.openExternalCalls).toEqual([]);
  });

  it("dedupes concurrent same-scheme confirms into ONE dialog", async () => {
    // Both fired before either settles: the second joins the first's dialog.
    const [a, b] = await Promise.all([
      confirmAndLaunchExternalScheme("zoommtg://a"),
      confirmAndLaunchExternalScheme("zoommtg://b"),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.openExternalCalls).toEqual([
      "zoommtg://a",
      "zoommtg://b",
    ]);
  });

  it("self-guards a dangerous scheme - no dialog, no open", async () => {
    expect(await confirmAndLaunchExternalScheme("file:///etc/passwd")).toBe(
      false,
    );
    expect(electronState.messageBoxCalls).toBe(0);
    expect(electronState.openExternalCalls).toEqual([]);
  });
});
