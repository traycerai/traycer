import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  RefusalNoteCopy,
  RefusalRemainingActions,
} from "../fallback-copy";
import {
  failedTurnSwitchOffered,
  failedTurnSwitchSeed,
  recordFailedTurnRefusal,
  refusalForAttempt,
  refusalLeaves,
  useFailedTurnRefusal,
  useHoldFailedTurnRefusal,
} from "../failed-turn-actions";
import {
  chatRunSettings,
  FAILED_CLAUDE_TUPLE,
  lastFailedAttempt,
  TARGET_CODEX_TUPLE,
} from "./fallback-fixtures";

const CHAT_A = { hostId: "host-a", chatId: "chat-a" };
const CHAT_B = { hostId: "host-a", chatId: "chat-b" };
const CHAT_A_OTHER_HOST = { hostId: "host-b", chatId: "chat-a" };

function copy(
  remaining: RefusalNoteCopy["remaining"],
  text: string | null,
): RefusalNoteCopy {
  return { text, remaining };
}

const REFUSED = copy("none", "refused one");
const REFUSED_2 = copy("switch", "refused two");

function attempt(
  turnId: string,
  eligibleRungs: ReadonlyArray<"retry" | "switch" | "wait_once">,
): LastFailedAttempt {
  return lastFailedAttempt({
    userMessageId: "user-1",
    turnId,
    failure: { reason: "rate_limit" },
    eligibleRungs,
    waitDisposition: "no_verified_reset",
    switchDisposition: "eligible",
    failedTuple: FAILED_CLAUDE_TUPLE,
  });
}

describe("failed-turn refusal registry", () => {
  it("records nothing and returns false when no card holds the turn", () => {
    const reader = renderHook(() => useFailedTurnRefusal(CHAT_A));
    let wrote = true;
    act(() => {
      wrote = recordFailedTurnRefusal(CHAT_A, "T", REFUSED);
    });
    expect(wrote).toBe(false);
    expect(reader.result.current).toBeNull();
    reader.unmount();
  });

  it("records for a held turn and drops the entry when the holder unmounts", () => {
    const reader = renderHook(() => useFailedTurnRefusal(CHAT_A));
    const holder = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T");
    });
    let wrote = false;
    act(() => {
      wrote = recordFailedTurnRefusal(CHAT_A, "T", REFUSED);
    });
    expect(wrote).toBe(true);
    expect(reader.result.current).toEqual({ turnId: "T", copy: REFUSED });
    holder.unmount();
    expect(reader.result.current).toBeNull();
    reader.unmount();
  });

  it("does not record for a turn no card holds even when another turn is held", () => {
    const reader = renderHook(() => useFailedTurnRefusal(CHAT_A));
    const holder = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T");
    });
    let wrote = true;
    act(() => {
      wrote = recordFailedTurnRefusal(CHAT_A, "OTHER", REFUSED);
    });
    expect(wrote).toBe(false);
    expect(reader.result.current).toBeNull();
    holder.unmount();
    reader.unmount();
  });

  it.each([
    { order: "first holder then second", firstToLeave: 0 },
    { order: "second holder then first", firstToLeave: 1 },
  ])(
    "keeps the entry until the last of two holders leaves ($order)",
    ({ firstToLeave }) => {
      const reader = renderHook(() => useFailedTurnRefusal(CHAT_A));
      const holders = [
        renderHook(() => {
          useHoldFailedTurnRefusal(CHAT_A, "T");
        }),
        renderHook(() => {
          useHoldFailedTurnRefusal(CHAT_A, "T");
        }),
      ];
      act(() => {
        recordFailedTurnRefusal(CHAT_A, "T", REFUSED);
      });
      expect(reader.result.current).toEqual({ turnId: "T", copy: REFUSED });

      holders[firstToLeave].unmount();
      expect(reader.result.current).toEqual({ turnId: "T", copy: REFUSED });

      holders[1 - firstToLeave].unmount();
      expect(reader.result.current).toBeNull();
      reader.unmount();
    },
  );

  it("does not clear a newer turn's entry when an older turn's card leaves", () => {
    const reader = renderHook(() => useFailedTurnRefusal(CHAT_A));
    const older = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T");
    });
    const newer = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T2");
    });
    act(() => {
      recordFailedTurnRefusal(CHAT_A, "T2", REFUSED_2);
    });
    older.unmount();
    expect(reader.result.current).toEqual({ turnId: "T2", copy: REFUSED_2 });
    newer.unmount();
    expect(reader.result.current).toBeNull();
    reader.unmount();
  });

  it("clears the entry with null and returns true while the turn is held", () => {
    const reader = renderHook(() => useFailedTurnRefusal(CHAT_A));
    const holder = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T");
    });
    act(() => {
      recordFailedTurnRefusal(CHAT_A, "T", REFUSED);
    });
    expect(reader.result.current).not.toBeNull();
    let wrote = false;
    act(() => {
      wrote = recordFailedTurnRefusal(CHAT_A, "T", null);
    });
    expect(wrote).toBe(true);
    expect(reader.result.current).toBeNull();
    holder.unmount();
    reader.unmount();
  });

  it("keeps two chats independent", () => {
    const readerA = renderHook(() => useFailedTurnRefusal(CHAT_A));
    const readerB = renderHook(() => useFailedTurnRefusal(CHAT_B));
    const holderA = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T");
    });
    const holderB = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_B, "T");
    });
    act(() => {
      recordFailedTurnRefusal(CHAT_A, "T", REFUSED);
    });
    expect(readerA.result.current).toEqual({ turnId: "T", copy: REFUSED });
    expect(readerB.result.current).toBeNull();
    holderB.unmount();
    expect(readerA.result.current).toEqual({ turnId: "T", copy: REFUSED });
    holderA.unmount();
    expect(readerA.result.current).toBeNull();
    readerA.unmount();
    readerB.unmount();
  });

  it("keeps the same chat id on two hosts independent", () => {
    const readerA = renderHook(() => useFailedTurnRefusal(CHAT_A));
    const readerOther = renderHook(() =>
      useFailedTurnRefusal(CHAT_A_OTHER_HOST),
    );
    const holderA = renderHook(() => {
      useHoldFailedTurnRefusal(CHAT_A, "T");
    });
    let wrote = true;
    act(() => {
      wrote = recordFailedTurnRefusal(CHAT_A_OTHER_HOST, "T", REFUSED);
    });
    expect(wrote).toBe(false);
    expect(readerA.result.current).toBeNull();
    expect(readerOther.result.current).toBeNull();
    holderA.unmount();
    readerA.unmount();
    readerOther.unmount();
  });
});

describe("refusalForAttempt", () => {
  it("returns the copy only for the attempt's own turn", () => {
    const refusal = { turnId: "T", copy: REFUSED };
    expect(refusalForAttempt(refusal, attempt("T", ["switch"]))).toBe(REFUSED);
    expect(refusalForAttempt(refusal, attempt("T2", ["switch"]))).toBeNull();
    expect(refusalForAttempt(null, attempt("T", ["switch"]))).toBeNull();
  });
});

describe("refusalLeaves", () => {
  const cases: ReadonlyArray<{
    readonly remaining: RefusalRemainingActions | null;
    readonly retry: boolean;
    readonly switch: boolean;
    readonly wait: boolean;
  }> = [
    { remaining: null, retry: true, switch: true, wait: true },
    { remaining: "all", retry: true, switch: true, wait: true },
    { remaining: "retry_and_switch", retry: true, switch: true, wait: false },
    { remaining: "switch", retry: false, switch: true, wait: false },
    { remaining: "none", retry: false, switch: false, wait: false },
  ];
  it.each(cases)(
    "remaining=$remaining leaves retry=$retry switch=$switch wait=$wait",
    ({ remaining, retry, switch: sw, wait }) => {
      const refusal = remaining === null ? null : copy(remaining, "x");
      expect(refusalLeaves(refusal)).toEqual({ retry, switch: sw, wait });
    },
  );
});

describe("failedTurnSwitchSeed", () => {
  const chatSettings = chatRunSettings({
    harnessId: "codex",
    model: "gpt-5",
    profileId: "chat-profile",
  });
  it("prefers the failed tuple", () => {
    expect(failedTurnSwitchSeed(attempt("T", ["switch"]), chatSettings)).toBe(
      FAILED_CLAUDE_TUPLE,
    );
  });
  it("falls back to the chat settings when the attempt has no tuple", () => {
    const noTuple: LastFailedAttempt = {
      ...attempt("T", ["switch"]),
      failedTuple: null,
    };
    expect(failedTurnSwitchSeed(noTuple, chatSettings)).toBe(chatSettings);
  });
  it("is null when neither exists", () => {
    const noTuple: LastFailedAttempt = {
      ...attempt("T", ["switch"]),
      failedTuple: null,
    };
    expect(failedTurnSwitchSeed(noTuple, null)).toBeNull();
  });
});

describe("failedTurnSwitchOffered", () => {
  const refusals: ReadonlyArray<{
    readonly remaining: RefusalRemainingActions | null;
    readonly leavesSwitch: boolean;
  }> = [
    { remaining: null, leavesSwitch: true },
    { remaining: "all", leavesSwitch: true },
    { remaining: "retry_and_switch", leavesSwitch: true },
    { remaining: "switch", leavesSwitch: true },
    { remaining: "none", leavesSwitch: false },
  ];
  const table = [true, false].flatMap((admitted) =>
    [true, false].flatMap((seeded) =>
      refusals.map((r) => ({
        admitted,
        seeded,
        remaining: r.remaining,
        expected: admitted && seeded && r.leavesSwitch,
      })),
    ),
  );
  it.each(table)(
    "admitted=$admitted seeded=$seeded remaining=$remaining -> $expected",
    ({ admitted, seeded, remaining, expected }) => {
      expect(
        failedTurnSwitchOffered({
          attempt: attempt("T", admitted ? ["retry", "switch"] : ["retry"]),
          refusal: remaining === null ? null : copy(remaining, "x"),
          seedTuple: seeded ? TARGET_CODEX_TUPLE : null,
        }),
      ).toBe(expected);
    },
  );
});
