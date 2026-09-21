import { afterEach, describe, expect, it } from "vitest";
import {
  consumeHistoryScopeForPromotion,
  prepareHistoryScopeForPromotion,
  registerHistoryModalScope,
} from "@/lib/history-scope-handoff";

describe("history scope promotion handoff", () => {
  afterEach(() => {
    // Drain any capture a failed case left behind.
    prepareHistoryScopeForPromotion();
    consumeHistoryScopeForPromotion();
  });

  it("is all when no modal ever registered", () => {
    prepareHistoryScopeForPromotion();
    expect(consumeHistoryScopeForPromotion()).toBe("all");
  });

  it("captures the registered scope at prepare time", () => {
    const unregister = registerHistoryModalScope("messages");
    prepareHistoryScopeForPromotion();
    unregister();
    // The body unmounting after prepare must not lose the captured value.
    expect(consumeHistoryScopeForPromotion()).toBe("messages");
  });

  it("follows the latest registration", () => {
    const first = registerHistoryModalScope("tasks");
    const second = registerHistoryModalScope("messages");
    prepareHistoryScopeForPromotion();
    expect(consumeHistoryScopeForPromotion()).toBe("messages");
    second();
    first();
  });

  it("is one-shot: a second consume without a new prepare is all", () => {
    const unregister = registerHistoryModalScope("tasks");
    prepareHistoryScopeForPromotion();
    expect(consumeHistoryScopeForPromotion()).toBe("tasks");
    expect(consumeHistoryScopeForPromotion()).toBe("all");
    unregister();
  });

  it("does not leak a consumed scope into the next promotion", () => {
    const unregister = registerHistoryModalScope("tasks");
    prepareHistoryScopeForPromotion();
    consumeHistoryScopeForPromotion();
    unregister();

    prepareHistoryScopeForPromotion();
    expect(consumeHistoryScopeForPromotion()).toBe("all");
  });

  it("unregistering resets the live scope so a closed modal is not captured", () => {
    const unregister = registerHistoryModalScope("messages");
    unregister();
    prepareHistoryScopeForPromotion();
    expect(consumeHistoryScopeForPromotion()).toBe("all");
  });
});
