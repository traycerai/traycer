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

  it("opens nothing on Cancel", async () => {
    electronState.messageBoxResponse = 0;
    expect(await confirmAndLaunchExternalScheme("msteams://chat")).toBe(false);
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.openExternalCalls).toEqual([]);
  });
});
