import { beforeEach, describe, expect, it } from "vitest";
import {
  ACK_TIMEOUT_MS,
  CHUNK_MAX_CHARS,
  CONFIRM_WINDOW_MS,
  INPUT_ACTIVE_WINDOW_MS,
  MAX_DELIVERY_ATTEMPTS,
  OUTPUT_HANGOVER_MS,
  OUTPUT_HANGOVER_WITHOUT_LEVEL_MS,
  chunkText,
  estimateSpeechMs,
  confirmationWords,
  createSpeechScheduler,
  type SpeechItem,
  type SpeechPriority,
  type SpeechScheduler,
} from "../scheduler";

interface Timer {
  readonly handle: number;
  readonly at: number;
  readonly fn: () => void;
}

/** A manual clock: timers fire only when the test advances time. */
interface Clock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: unknown) => void;
  advance: (ms: number) => void;
}

function createClock(): Clock {
  let nowMs = 1_000;
  let nextHandle = 1;
  let timers: Timer[] = [];
  return {
    now: () => nowMs,
    setTimer: (fn: () => void, ms: number): number => {
      const handle = nextHandle++;
      timers.push({ handle, at: nowMs + ms, fn });
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      timers = timers.filter((timer) => timer.handle !== handle);
    },
    advance(ms: number): void {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (due === undefined) break;
        timers = timers.filter((timer) => timer !== due);
        nowMs = due.at;
        due.fn();
      }
      nowMs = target;
    },
  };
}

interface Appended {
  readonly text: string;
  readonly delegationId: string | null;
}

let clock: Clock;
let appended: Appended[];
let scheduler: SpeechScheduler;

beforeEach(() => {
  clock = createClock();
  appended = [];
  scheduler = createSpeechScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    append: (text, delegationId) => appended.push({ text, delegationId }),
  });
  scheduler.setLevelDetection(true);
  scheduler.setReady(true);
});

function item(
  id: string,
  overrides: Partial<SpeechItem> & { priority?: SpeechPriority },
): SpeechItem {
  return {
    id,
    priority: "focused",
    text: `reply ${id}`,
    delegationId: `d-${id}`,
    confirmWords: ["tracy"],
    onDelivered: null,
    onGivenUp: null,
    ...overrides,
  };
}

describe("when an item is appended", () => {
  it("appends a focused item once when nothing holds it back", () => {
    scheduler.enqueue(item("a", {}));
    expect(appended).toEqual([{ text: "reply a", delegationId: "d-a" }]);
  });

  it("holds it while the person is speaking, until the window passes", () => {
    scheduler.noteInputTranscript();
    scheduler.enqueue(item("a", {}));
    expect(appended).toHaveLength(0);

    clock.advance(INPUT_ACTIVE_WINDOW_MS);
    expect(appended).toHaveLength(1);
  });

  it("holds it while the voice is playing, until playback stops", () => {
    scheduler.noteOutputLevel(true);
    scheduler.enqueue(item("a", {}));
    expect(appended).toHaveLength(0);

    scheduler.noteOutputLevel(false);
    expect(appended).toHaveLength(1);
  });

  it("holds it behind a pending acknowledgement until it is spoken through", () => {
    scheduler.noteDelegationCreated();
    scheduler.enqueue(item("a", {}));
    expect(appended).toHaveLength(0);

    scheduler.noteOutputLevel(true);
    scheduler.noteOutputLevel(false);
    expect(appended).toHaveLength(1);
  });

  it("stops waiting for an acknowledgement that never comes", () => {
    scheduler.noteDelegationCreated();
    scheduler.enqueue(item("a", {}));

    clock.advance(ACK_TIMEOUT_MS);
    expect(appended).toHaveLength(1);
  });
});

describe("delivery confirmation", () => {
  it("confirms a short numeric answer by its spoken form, once, instead of repeating it", () => {
    let delivered = 0;
    const words = confirmationWords({
      botTitle: null,
      threadTitle: null,
      text: "42",
    });
    expect(words).toEqual(
      expect.arrayContaining(["42", "forty-two", "forty", "two"]),
    );
    scheduler.enqueue(
      item("a", {
        text: "42",
        confirmWords: words,
        onDelivered: () => delivered++,
      }),
    );
    expect(appended).toHaveLength(1);

    scheduler.noteOutputTranscript("Forty-two.");
    clock.advance(CONFIRM_WINDOW_MS * MAX_DELIVERY_ATTEMPTS);

    expect(delivered).toBe(1);
    expect(appended).toHaveLength(1);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("runs onDelivered once when the transcript holds a confirm word", () => {
    let delivered = 0;
    scheduler.enqueue(item("a", { onDelivered: () => delivered++ }));

    scheduler.noteOutputTranscript("Tracy says");
    scheduler.noteOutputTranscript(" tracy again");

    expect(delivered).toBe(1);
  });

  it("does not count a bare backchannel, and re-appends after the window", () => {
    let delivered = 0;
    scheduler.enqueue(item("a", { onDelivered: () => delivered++ }));

    scheduler.noteOutputTranscript("Mm-hmm");
    clock.advance(CONFIRM_WINDOW_MS);

    expect(delivered).toBe(0);
    expect(appended).toHaveLength(2);
  });

  it("drops the item after MAX_DELIVERY_ATTEMPTS unconfirmed appends", () => {
    scheduler.enqueue(item("a", {}));
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
      clock.advance(CONFIRM_WINDOW_MS + 1_000);
    }

    expect(appended).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("giving up", () => {
  it("runs onGivenUp once after the last unconfirmed append, and never onDelivered", () => {
    let givenUp = 0;
    let delivered = 0;
    scheduler.enqueue(
      item("a", { onGivenUp: () => givenUp++, onDelivered: () => delivered++ }),
    );

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
      clock.advance(CONFIRM_WINDOW_MS);
    }
    expect(givenUp).toBe(0);
    clock.advance(CONFIRM_WINDOW_MS);
    clock.advance(CONFIRM_WINDOW_MS);

    expect(appended).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(givenUp).toBe(1);
    expect(delivered).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("relabel", () => {
  it("changes the delegation of a queued item before it is appended", () => {
    scheduler.noteOutputLevel(true);
    scheduler.enqueue(item("a", {}));
    scheduler.relabel("a", "d-new");
    scheduler.noteOutputLevel(false);

    expect(appended).toEqual([{ text: "reply a", delegationId: "d-new" }]);
  });

  it("is a no-op for the item already in flight", () => {
    scheduler.enqueue(item("a", {}));
    scheduler.relabel("a", "d-new");
    clock.advance(CONFIRM_WINDOW_MS);

    expect(appended).toEqual([
      { text: "reply a", delegationId: "d-a" },
      { text: "reply a", delegationId: "d-a" },
    ]);
  });
});

describe("a bare backchannel", () => {
  it("never confirms an item that itself opens with a backchannel word", () => {
    const text = "Mm-hmm, the deployment completed successfully.";
    const words = confirmationWords({
      botTitle: null,
      threadTitle: null,
      text,
    });
    expect(words).not.toContain("mm-hmm");

    let delivered = 0;
    scheduler.enqueue(
      item("a", {
        text,
        confirmWords: ["mm-hmm", ...words],
        onDelivered: () => delivered++,
      }),
    );

    scheduler.noteOutputTranscript("Mm-hmm.");
    expect(delivered).toBe(0);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.noteOutputTranscript(" The deployment completed");
    expect(delivered).toBe(1);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("handoff", () => {
  it("retires old engine facts, requeues the in-flight item unlabelled and waits for ready", () => {
    scheduler.enqueue(item("a", {}));
    scheduler.noteOutputLevel(true);
    expect(appended).toHaveLength(1);
    expect(scheduler.activity().outputPlaying).toBe(true);

    scheduler.handoff();

    expect(scheduler.activity().outputPlaying).toBe(false);
    expect(scheduler.pendingCount()).toBe(1);
    clock.advance(CONFIRM_WINDOW_MS * 2);
    expect(appended).toHaveLength(1);

    scheduler.setReady(true);
    expect(appended).toEqual([
      { text: "reply a", delegationId: "d-a" },
      { text: "reply a", delegationId: null },
    ]);
  });

  it("relabels queued items too and does not dispatch them before ready", () => {
    scheduler.noteOutputLevel(true);
    scheduler.enqueue(item("a", {}));
    scheduler.handoff();
    scheduler.setLevelDetection(true);
    scheduler.noteOutputLevel(false);
    expect(appended).toEqual([]);

    scheduler.setReady(true);
    expect(appended).toEqual([{ text: "reply a", delegationId: null }]);
  });
});

describe("a handoff spends delivery attempts", () => {
  it("appends one item at most MAX_DELIVERY_ATTEMPTS times across repeated replacements, then drops it", () => {
    scheduler.enqueue(item("a", {}));
    for (let cycle = 0; cycle < 5; cycle++) {
      scheduler.handoff();
      scheduler.setReady(true);
    }

    expect(appended).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("without a trusted level detector", () => {
  it("holds the next item for the estimated duration of the one in flight", () => {
    scheduler.setLevelDetection(false);
    const longText = "word ".repeat(33).trim();
    scheduler.enqueue(item("a", { priority: "briefing", text: longText }));
    scheduler.enqueue(item("b", {}));
    expect(appended).toHaveLength(1);

    clock.advance(4_000);
    expect(appended).toHaveLength(1);

    clock.advance(estimateSpeechMs(longText) - 4_001);
    expect(appended).toHaveLength(1);

    clock.advance(1);
    expect(appended.map((entry) => entry.text)).toEqual([longText, "reply b"]);
  });

  it("keeps the playback floor after a matching transcript confirms the long item early", () => {
    scheduler.setLevelDetection(false);
    const longText = "word ".repeat(33).trim();
    let delivered = 0;
    scheduler.enqueue(
      item("a", { text: longText, onDelivered: () => delivered++ }),
    );
    scheduler.enqueue(item("b", {}));

    clock.advance(640);
    scheduler.noteOutputTranscript("Tracy says");
    expect(delivered).toBe(1);

    clock.advance(4_000);
    expect(appended).toHaveLength(1);

    clock.advance(estimateSpeechMs(longText) - 4_640 - 1);
    expect(appended).toHaveLength(1);

    clock.advance(1);
    expect(appended.map((entry) => entry.text)).toEqual([longText, "reply b"]);
  });
});

describe("the output hangover", () => {
  function afterFirstTranscript(): void {
    scheduler.enqueue(item("a", {}));
    scheduler.noteOutputTranscript("Tracy says hello");
    scheduler.enqueue(item("b", {}));
    expect(appended).toHaveLength(1);
  }

  it("without a level detector holds the next item well past 700 ms", () => {
    scheduler.setLevelDetection(false);
    afterFirstTranscript();

    clock.advance(OUTPUT_HANGOVER_MS);
    expect(appended).toHaveLength(1);

    clock.advance(OUTPUT_HANGOVER_WITHOUT_LEVEL_MS - OUTPUT_HANGOVER_MS);
    expect(appended).toHaveLength(2);
  });

  it("with a detector reporting quiet, 700 ms suffices", () => {
    scheduler.setLevelDetection(true);
    afterFirstTranscript();

    clock.advance(OUTPUT_HANGOVER_MS);
    expect(appended).toHaveLength(2);
  });
});

describe("reset", () => {
  it("forgets queued items and every fact, and stays usable", () => {
    scheduler.noteDelegationCreated();
    scheduler.enqueue(item("a", {}));
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.reset();

    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.activity()).toEqual({
      inputActiveUntil: null,
      outputPlaying: false,
      ackPending: false,
    });
    scheduler.setReady(true);
    scheduler.enqueue(item("b", {}));
    expect(appended).toEqual([{ text: "reply b", delegationId: "d-b" }]);
  });
});

describe("ordering and chunking", () => {
  it("appends ask, then focused, then elsewhere, then briefing", () => {
    scheduler.noteOutputLevel(true);
    for (const priority of [
      "briefing",
      "elsewhere",
      "focused",
      "ask",
    ] as const) {
      scheduler.enqueue(item(priority, { priority, confirmWords: [priority] }));
    }
    const order: string[] = [];
    scheduler.noteOutputLevel(false);
    for (let i = 0; i < 4; i++) {
      order.push(appended[appended.length - 1]?.text ?? "");
      scheduler.noteOutputTranscript(order[i]?.replace("reply ", "") ?? "");
      clock.advance(1_000);
    }

    expect(order).toEqual([
      "reply ask",
      "reply focused",
      "reply elsewhere",
      "reply briefing",
    ]);
  });

  it("appends several chunks for an item longer than CHUNK_MAX_CHARS", () => {
    const sentence = `${"word ".repeat(100).trim()}.`;
    const text = Array.from({ length: 10 }, () => sentence).join(" ");
    scheduler.enqueue(item("a", { text }));

    expect(appended.length).toBeGreaterThan(1);
    for (const chunk of appended) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });
});

describe("chunkText", () => {
  it("splits a sentence longer than the limit at word boundaries", () => {
    const chunks = chunkText("alpha beta gamma delta", 11);
    expect(chunks).toEqual(["alpha beta", "gamma delta"]);
  });
});

describe("confirmationWords", () => {
  it("keeps the bot and thread names and content words, not filler", () => {
    const words = confirmationWords({
      botTitle: "Tracy",
      threadTitle: "Billing fix",
      text: "The invoice migration is ready, please check",
    });
    expect(words).toEqual(
      expect.arrayContaining(["tracy", "billing", "fix", "invoice"]),
    );
    expect(words).not.toContain("please");
  });
});
