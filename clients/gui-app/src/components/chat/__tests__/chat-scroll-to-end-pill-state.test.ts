import { describe, expect, it } from "vitest";
import {
  resolveScrollToEndPillState,
  type ScrollToEndPillState,
} from "@/components/chat/chat-scroll-to-end-pill-state";

function resolve(input: {
  readonly visible: boolean;
  readonly turnRunning: boolean;
  readonly unseenCompletion: boolean;
}): ScrollToEndPillState {
  return resolveScrollToEndPillState(input);
}

describe("resolveScrollToEndPillState", () => {
  it("returns hidden when not visible, regardless of turn/completion flags", () => {
    expect(
      resolve({
        visible: false,
        turnRunning: true,
        unseenCompletion: true,
      }),
    ).toEqual({ kind: "hidden" });

    expect(
      resolve({
        visible: false,
        turnRunning: false,
        unseenCompletion: false,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("returns streaming when visible and the turn is running", () => {
    expect(
      resolve({
        visible: true,
        turnRunning: true,
        unseenCompletion: false,
      }),
    ).toEqual({ kind: "streaming" });
  });

  it("returns new-reply when visible, not running, and an unseen completion is pending", () => {
    expect(
      resolve({
        visible: true,
        turnRunning: false,
        unseenCompletion: true,
      }),
    ).toEqual({ kind: "new-reply" });
  });

  it("returns plain when visible with neither a running turn nor an unseen completion", () => {
    expect(
      resolve({
        visible: true,
        turnRunning: false,
        unseenCompletion: false,
      }),
    ).toEqual({ kind: "plain" });
  });

  it("prioritizes turnRunning over unseenCompletion (streaming wins)", () => {
    // Source order: hidden -> turnRunning -> unseenCompletion -> plain.
    // A turn still streaming after a prior unseen completion must not
    // collapse to "New reply" - the live stream is the more urgent signal.
    expect(
      resolve({
        visible: true,
        turnRunning: true,
        unseenCompletion: true,
      }),
    ).toEqual({ kind: "streaming" });
  });
});
