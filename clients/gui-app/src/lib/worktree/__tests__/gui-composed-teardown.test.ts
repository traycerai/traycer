import { describe, expect, it, vi } from "vitest";
import {
  failuresByHolderKey,
  runGuiComposedTeardown,
  teardownErrorMessage,
} from "../gui-composed-teardown";

describe("runGuiComposedTeardown", () => {
  it("awaits each disclosed shell stop before returning", async () => {
    const order: string[] = [];
    const stopShell = vi.fn((commandId: string) => {
      order.push(`stop:${commandId}`);
      return Promise.resolve();
    });
    const failures = await runGuiComposedTeardown({
      stopTargets: [
        {
          kind: "supervised-shell",
          commandId: "sh-1",
          holderKey: "chat:c1:supervised-shell:npm run dev",
        },
      ],
      stopShell,
      stopTurn: vi.fn(),
      isCancelled: () => false,
    });
    expect(failures).toEqual([]);
    expect(stopShell).toHaveBeenCalledWith("sh-1");
    expect(order).toEqual(["stop:sh-1"]);
  });

  it("names a failed stop and still attempts later targets", async () => {
    const stopShell = vi
      .fn()
      .mockRejectedValueOnce(new Error("shell still running"))
      .mockResolvedValueOnce({});
    const failures = await runGuiComposedTeardown({
      stopTargets: [
        {
          kind: "supervised-shell",
          commandId: "sh-1",
          holderKey: "chat:c1:supervised-shell:npm run dev",
        },
        {
          kind: "supervised-shell",
          commandId: "sh-2",
          holderKey: "chat:c1:supervised-shell:watch",
        },
      ],
      stopShell,
      stopTurn: vi.fn(),
      isCancelled: () => false,
    });
    expect(failures).toEqual([
      {
        holderKey: "chat:c1:supervised-shell:npm run dev",
        message: "shell still running",
      },
    ]);
    expect(stopShell).toHaveBeenCalledTimes(2);
    expect(
      failuresByHolderKey(failures)["chat:c1:supervised-shell:npm run dev"],
    ).toBe("shell still running");
  });

  it("awaits a chat-turn stop", async () => {
    const stopTurn = vi.fn(() => Promise.resolve());
    const failures = await runGuiComposedTeardown({
      stopTargets: [
        { kind: "chat-turn", holderKey: "chat:c1:chat-turn:working" },
      ],
      stopShell: vi.fn(),
      stopTurn,
      isCancelled: () => false,
    });
    expect(failures).toEqual([]);
    expect(stopTurn).toHaveBeenCalledTimes(1);
  });

  it("stops further targets once cancelled", async () => {
    let cancelled = false;
    const stopShell = vi.fn(() => {
      cancelled = true;
      return Promise.resolve();
    });
    const failures = await runGuiComposedTeardown({
      stopTargets: [
        {
          kind: "supervised-shell",
          commandId: "sh-1",
          holderKey: "chat:c1:supervised-shell:npm run dev",
        },
        {
          kind: "supervised-shell",
          commandId: "sh-2",
          holderKey: "chat:c1:supervised-shell:watch",
        },
      ],
      stopShell,
      stopTurn: vi.fn(),
      isCancelled: () => cancelled,
    });
    expect(failures).toEqual([]);
    expect(stopShell).toHaveBeenCalledTimes(1);
  });
});

describe("teardownErrorMessage", () => {
  it("reads an Error message and falls back otherwise", () => {
    expect(teardownErrorMessage(new Error("nope"))).toBe("nope");
    expect(teardownErrorMessage("nope")).toBe("Couldn't stop it.");
  });
});
