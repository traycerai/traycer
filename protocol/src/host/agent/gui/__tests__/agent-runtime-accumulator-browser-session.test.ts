import { describe, it, expect } from "vitest";
import { accumulateEvent } from "../agent-runtime-accumulator";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";
import type { BrowserSessionReference } from "@traycer/protocol/persistence/epic/content-blocks";

type TextBlock = Extract<ContentBlock, { type: "text" }>;

const SESSION: BrowserSessionReference = {
  hostId: "host-1",
  sessionId: "session-1",
  tabId: "tab-1",
  profile: "primary",
};

describe("accumulateEvent text.delta browserSession metadata", () => {
  it("attaches browserSession to a newly created text block", () => {
    const blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Browser · Primary",
      browserSession: SESSION,
    });

    expect((blocks[0] as TextBlock).browserSession).toEqual(SESSION);
  });

  it("carries browserSession forward across a delta that omits it", () => {
    let blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Browser · Primary",
      browserSession: SESSION,
    });
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 2,
      delta: " · Checkout",
    });

    expect((blocks[0] as TextBlock).text).toBe("Browser · Primary · Checkout");
    expect((blocks[0] as TextBlock).browserSession).toEqual(SESSION);
  });

  it("leaves ordinary text blocks with no browserSession key (legacy absence)", () => {
    const blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Just a normal reply",
    });

    expect("browserSession" in blocks[0]).toBe(false);
  });
});
