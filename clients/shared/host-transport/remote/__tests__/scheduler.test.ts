import { describe, expect, it } from "vitest";
import {
  QosClass,
  type QosClassValue,
} from "@traycer/protocol/host-transport/mux";
import { InboundCreditTracker, PriorityScheduler } from "../scheduler";
import { INBOUND_CREDIT_GRANT_BATCH } from "../config";

interface Item {
  readonly qos: QosClassValue;
  readonly label: string;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PriorityScheduler", () => {
  it("sends interactive frames without consuming credits", async () => {
    const written: string[] = [];
    const scheduler = new PriorityScheduler<Item>({
      write: async (item) => {
        written.push(item.label);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
    });
    scheduler.enqueue({ qos: QosClass.INTERACTIVE, label: "keystroke" });
    await flush();
    expect(written).toEqual(["keystroke"]);
  });

  it("gates bulk frames on credits and releases them on a grant", async () => {
    const written: string[] = [];
    const scheduler = new PriorityScheduler<Item>({
      write: async (item) => {
        written.push(item.label);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
    });
    scheduler.enqueue({ qos: QosClass.BULK, label: "chunk" });
    await flush();
    expect(written).toEqual([]); // parked: no credits

    scheduler.grantCredits(1);
    await flush();
    expect(written).toEqual(["chunk"]);
  });

  it("drains a ready interactive frame while a bulk frame is credit-starved", async () => {
    const written: string[] = [];
    const scheduler = new PriorityScheduler<Item>({
      write: async (item) => {
        written.push(item.label);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 0,
    });
    scheduler.enqueue({ qos: QosClass.BULK, label: "bulk" });
    scheduler.enqueue({ qos: QosClass.INTERACTIVE, label: "interactive" });
    await flush();
    // Interactive is sent (not gated); bulk stays parked until credits arrive.
    expect(written).toEqual(["interactive"]);
    scheduler.grantCredits(1);
    await flush();
    expect(written).toEqual(["interactive", "bulk"]);
  });

  it("holds queued frames while paused and flushes them on resume", async () => {
    const written: string[] = [];
    const scheduler = new PriorityScheduler<Item>({
      write: async (item) => {
        written.push(item.label);
      },
      onWriteError: () => undefined,
      initialBulkCredits: 10,
    });
    scheduler.pause();
    scheduler.enqueue({ qos: QosClass.INTERACTIVE, label: "held" });
    await flush();
    expect(written).toEqual([]);
    scheduler.resume();
    await flush();
    expect(written).toEqual(["held"]);
  });
});

describe("InboundCreditTracker", () => {
  it("grants a batch of credits back after enough bulk frames are consumed", () => {
    const tracker = new InboundCreditTracker();
    for (let i = 0; i < INBOUND_CREDIT_GRANT_BATCH - 1; i += 1) {
      expect(tracker.onBulkFrameConsumed()).toBe(0);
    }
    expect(tracker.onBulkFrameConsumed()).toBe(INBOUND_CREDIT_GRANT_BATCH);
    expect(tracker.onBulkFrameConsumed()).toBe(0);
  });
});
