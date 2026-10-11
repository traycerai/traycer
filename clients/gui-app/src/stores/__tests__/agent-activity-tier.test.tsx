import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityStateForTests,
  TEST_LOCAL_ACTIVITY_HOST_ID,
  useAgentActivityTier,
} from "@/stores/agent-activity-store";

/**
 * `useAgentActivityTier` exists so a row can read ONE agent's tier without
 * subscribing to every agent working in the epic - `useEpicAgentActivityTiers`
 * (the map-returning sibling, pinned in `agent-activity-tiers.test.tsx`)
 * re-renders every consumer on any agent's transition because a Map's
 * identity moves whenever any entry does. This file pins the narrower
 * contract: a row reading its own agent's tier must not re-render when a
 * DIFFERENT agent in the same epic changes tier, and must re-render for its
 * own turn/background/idle transitions.
 */

const EPIC_ID = "epic-tier";

function publish(working: Record<string, readonly string[]>): void {
  __setHostAgentActivityStateForTests(
    TEST_LOCAL_ACTIVITY_HOST_ID,
    {
      [EPIC_ID]: {
        working: Object.keys(working),
        turn: Object.entries(working)
          .filter(([, tags]) => tags.includes("turn"))
          .map(([id]) => id),
      },
    },
    "local",
    null,
  );
}

afterEach(() => {
  __resetAgentActivityStoreForTests();
});

describe("useAgentActivityTier", () => {
  it("reads background, turn and absent for their respective agents", () => {
    publish({ a: ["background"], b: ["turn"] });
    const background = renderHook(() => useAgentActivityTier(EPIC_ID, "a"));
    const turn = renderHook(() => useAgentActivityTier(EPIC_ID, "b"));
    const idle = renderHook(() => useAgentActivityTier(EPIC_ID, "c"));
    expect(background.result.current).toBe("background");
    expect(turn.result.current).toBe("turn");
    expect(idle.result.current).toBeUndefined();
  });

  it("does not re-render when a DIFFERENT agent's tier changes", () => {
    publish({ a: ["background"], b: ["background"] });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAgentActivityTier(EPIC_ID, "a");
    });
    expect(result.current).toBe("background");
    const rendersAfterMount = renders;

    act(() => {
      // "b" moves background -> turn; "a" is untouched.
      publish({ a: ["background"], b: ["turn"] });
    });
    expect(result.current).toBe("background");
    expect(renders).toBe(rendersAfterMount);

    act(() => {
      // "b" stops working entirely; "a" is still untouched.
      publish({ a: ["background"] });
    });
    expect(result.current).toBe("background");
    expect(renders).toBe(rendersAfterMount);
  });

  it("re-renders for its own idle -> background -> turn -> idle transitions", () => {
    publish({});
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAgentActivityTier(EPIC_ID, "a");
    });
    expect(result.current).toBeUndefined();
    const rendersAfterMount = renders;

    act(() => {
      publish({ a: ["background"] });
    });
    expect(result.current).toBe("background");
    expect(renders).toBeGreaterThan(rendersAfterMount);
    const rendersAfterBackground = renders;

    act(() => {
      publish({ a: ["turn"] });
    });
    expect(result.current).toBe("turn");
    expect(renders).toBeGreaterThan(rendersAfterBackground);
    const rendersAfterTurn = renders;

    act(() => {
      publish({});
    });
    expect(result.current).toBeUndefined();
    expect(renders).toBeGreaterThan(rendersAfterTurn);
  });
});
