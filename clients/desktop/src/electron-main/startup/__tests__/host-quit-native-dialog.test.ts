import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { HostQuitPrompt } from "../../ipc/runner-ipc-bridge";
import {
  askHostQuitNatively,
  confirmQuitAndStopHost,
  type ShowMessageBox,
} from "../host-quit-native-dialog";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

const INITIAL: HostQuitPrompt = { mode: "ask", round: "initial" };
const BUSY: HostQuitPrompt = { mode: "stop-if-idle", round: "busy" };
const BUSY_RETRY: HostQuitPrompt = {
  mode: "stop-if-idle",
  round: "busy-retry",
};

function terminalsInUse(count: number): HostQuitPrompt {
  return {
    mode: "stop-if-idle",
    round: "terminals-in-use",
    terminalsInUse: count,
  };
}

function boxReturning(
  response: number,
  checkboxChecked: boolean,
): { readonly show: ShowMessageBox; readonly seen: MessageBoxOptions[] } {
  const seen: MessageBoxOptions[] = [];
  return {
    seen,
    show: (options) => {
      seen.push(options);
      const result: MessageBoxReturnValue = { response, checkboxChecked };
      return Promise.resolve(result);
    },
  };
}

describe("askHostQuitNatively", () => {
  it("maps the button index to the decision: Keep, Stop (force), Cancel", async () => {
    const signal = new AbortController().signal;
    const keep = boxReturning(0, false);
    const stop = boxReturning(1, false);
    const cancel = boxReturning(2, false);
    expect(await askHostQuitNatively(INITIAL, signal, keep.show)).toEqual({
      kind: "keep",
      remember: false,
    });
    expect(await askHostQuitNatively(INITIAL, signal, stop.show)).toEqual({
      kind: "stop",
      force: true,
      remember: false,
    });
    expect(await askHostQuitNatively(INITIAL, signal, cancel.show)).toEqual({
      kind: "cancel",
    });
  });

  it("initial and busy-retry rounds use different copy; Keep is the default, Cancel the escape", async () => {
    const signal = new AbortController().signal;
    const initial = boxReturning(0, false);
    const retry = boxReturning(0, false);
    await askHostQuitNatively(INITIAL, signal, initial.show);
    await askHostQuitNatively(BUSY_RETRY, signal, retry.show);
    const [a] = initial.seen;
    const [b] = retry.seen;
    expect(a.message).toBe("Can't tell what's running on the host");
    expect(b.message).toBe("The host is still working");
    expect(a.detail).not.toBe(b.detail);
    expect(a.buttons).toEqual([
      "Keep Running and Quit",
      "Stop Host Anyway and Quit",
      "Cancel",
    ]);
    expect(b.buttons).toEqual([
      "Keep Running and Quit",
      "Stop Host and Quit",
      "Cancel",
    ]);
    for (const options of [a, b]) {
      expect(options.defaultId).toBe(0);
      expect(options.cancelId).toBe(2);
      expect(options.signal).toBe(signal);
    }
  });

  it("a throwing showMessageBox answers keep (never loses work)", async () => {
    const decision = await askHostQuitNatively(
      INITIAL,
      new AbortController().signal,
      () => Promise.reject(new Error("no display")),
    );
    expect(decision).toEqual({ kind: "keep", remember: false });
  });

  it("the busy round: message, detail (no 'Something started'), Stop label, and Stop answers force:true", async () => {
    const signal = new AbortController().signal;
    const stop = boxReturning(1, false);
    const decision = await askHostQuitNatively(BUSY, signal, stop.show);
    expect(decision).toEqual({ kind: "stop", force: true, remember: false });
    const [seen] = stop.seen;
    expect(seen.message).toBe("The host is still working");
    expect(seen.detail).toBe(
      "Keep it running so that work carries on, or stop it now, which ends it.",
    );
    expect(seen.detail).not.toContain("Something started");
    expect(seen.buttons).toEqual([
      "Keep Running and Quit",
      "Stop Host and Quit",
      "Cancel",
    ]);
  });

  it("the busy-retry round's detail DOES say something started meanwhile", async () => {
    const signal = new AbortController().signal;
    const keep = boxReturning(0, false);
    await askHostQuitNatively(BUSY_RETRY, signal, keep.show);
    const [seen] = keep.seen;
    expect(seen.message).toBe("The host is still working");
    expect(seen.detail).toContain("Something started");
  });
});

describe("askHostQuitNatively: the terminals-in-use round", () => {
  const SINGULAR_DETAIL =
    "Stopping the host ends it. Quitting Traycer can keep the host running so it carries on, or stop it now.";
  const PLURAL_DETAIL =
    "Stopping the host ends them. Quitting Traycer can keep the host running so they carry on, or stop it now.";

  it("says what the host counted: singular for one terminal", async () => {
    const box = boxReturning(0, false);
    await askHostQuitNatively(
      terminalsInUse(1),
      new AbortController().signal,
      box.show,
    );
    const [seen] = box.seen;
    expect(seen.message).toBe("1 terminal is still in use");
    expect(seen.detail).toBe(SINGULAR_DETAIL);
    expect(seen.buttons).toEqual([
      "Keep Running and Quit",
      "Stop Host and Quit",
      "Cancel",
    ]);
  });

  it("says what the host counted: plural for three terminals", async () => {
    const box = boxReturning(0, false);
    await askHostQuitNatively(
      terminalsInUse(3),
      new AbortController().signal,
      box.show,
    );
    const [seen] = box.seen;
    expect(seen.message).toBe("3 terminals are still in use");
    expect(seen.detail).toBe(PLURAL_DETAIL);
    expect(seen.buttons).toEqual([
      "Keep Running and Quit",
      "Stop Host and Quit",
      "Cancel",
    ]);
  });

  it("keeps Keep as the default and Cancel as the escape, like every round", async () => {
    const signal = new AbortController().signal;
    const box = boxReturning(0, false);
    await askHostQuitNatively(terminalsInUse(2), signal, box.show);
    const [seen] = box.seen;
    expect(seen.defaultId).toBe(0);
    expect(seen.cancelId).toBe(2);
    expect(seen.signal).toBe(signal);
  });

  for (const count of [1, 3]) {
    it(`${String(count)} in use: Keep keeps, Cancel cancels, and Stop is an idle-only stop (force:false), not a force`, async () => {
      const signal = new AbortController().signal;
      const prompt = terminalsInUse(count);
      expect(
        await askHostQuitNatively(prompt, signal, boxReturning(0, false).show),
      ).toEqual({ kind: "keep", remember: false });
      expect(
        await askHostQuitNatively(prompt, signal, boxReturning(1, false).show),
      ).toEqual({ kind: "stop", force: false, remember: false });
      expect(
        await askHostQuitNatively(prompt, signal, boxReturning(2, false).show),
      ).toEqual({ kind: "cancel" });
    });
  }

  it("a throwing showMessageBox still answers keep", async () => {
    const decision = await askHostQuitNatively(
      terminalsInUse(2),
      new AbortController().signal,
      () => Promise.reject(new Error("no display")),
    );
    expect(decision).toEqual({ kind: "keep", remember: false });
  });

  it("every other round's Stop is still a force", async () => {
    const signal = new AbortController().signal;
    for (const prompt of [INITIAL, BUSY, BUSY_RETRY]) {
      expect(
        await askHostQuitNatively(prompt, signal, boxReturning(1, false).show),
      ).toEqual({ kind: "stop", force: true, remember: false });
    }
  });
});

describe("confirmQuitAndStopHost", () => {
  it("Stop confirmed with the checkbox: confirmed and remember", async () => {
    const box = boxReturning(1, true);
    expect(await confirmQuitAndStopHost(box.show)).toEqual({
      confirmed: true,
      remember: true,
    });
    expect(box.seen[0].buttons).toEqual(["Cancel", "Stop Host and Quit"]);
    expect(box.seen[0].defaultId).toBe(0);
    expect(box.seen[0].cancelId).toBe(0);
  });

  it("Stop confirmed without the checkbox: no remember", async () => {
    expect(await confirmQuitAndStopHost(boxReturning(1, false).show)).toEqual({
      confirmed: true,
      remember: false,
    });
  });

  it("Cancel with the checkbox ticked: not confirmed, and the tick is not remembered", async () => {
    expect(await confirmQuitAndStopHost(boxReturning(0, true).show)).toEqual({
      confirmed: false,
      remember: false,
    });
  });

  it("a throw is not confirmed", async () => {
    expect(
      await confirmQuitAndStopHost(() => Promise.reject(new Error("boom"))),
    ).toEqual({ confirmed: false, remember: false });
  });
});
