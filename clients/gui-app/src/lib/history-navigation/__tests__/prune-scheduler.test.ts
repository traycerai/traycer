import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPruneScheduler } from "@/lib/history-navigation/prune-scheduler";
import { isHistoryEntryDead } from "@/lib/history-navigation/liveness";
import type { PersistentHistoryController } from "@/lib/persistent-history";

type IsDead = (href: string) => boolean;

interface FakeController extends PersistentHistoryController {
  readonly pruneCalls: ReadonlyArray<IsDead>;
}

function fakeController(): FakeController {
  const pruneCalls: IsDead[] = [];
  return {
    pruneCalls,
    getEntries: () => [],
    getIndex: () => 0,
    canGoBack: () => false,
    canGoForward: () => false,
    prune: (isDead) => {
      pruneCalls.push(isDead);
      return true;
    },
    subscribe: () => () => {},
  };
}

// Advance past a couple of animation frames so any scheduled (or rescheduled)
// flush runs under fake timers.
function flushFrames(): void {
  vi.advanceTimersByTime(64);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installPruneScheduler", () => {
  it("coalesces a burst of store changes into a single prune", () => {
    const controller = fakeController();
    let fire: () => void = () => {};
    const uninstall = installPruneScheduler({
      getController: () => controller,
      subscribeStores: (onChange) => {
        fire = onChange;
        return () => {};
      },
      isLoadInFlight: () => false,
    });

    fire();
    fire();
    fire();
    expect(controller.pruneCalls.length).toBe(0); // nothing runs synchronously
    flushFrames();
    expect(controller.pruneCalls.length).toBe(1);

    uninstall();
  });

  it("passes isHistoryEntryDead so liveness is re-read at execution", () => {
    const controller = fakeController();
    let fire: () => void = () => {};
    const uninstall = installPruneScheduler({
      getController: () => controller,
      subscribeStores: (onChange) => {
        fire = onChange;
        return () => {};
      },
      isLoadInFlight: () => false,
    });

    fire();
    flushFrames();
    expect(controller.pruneCalls[0]).toBe(isHistoryEntryDead);

    uninstall();
  });

  it("skips while a load is in flight and runs once it settles", () => {
    const controller = fakeController();
    let fire: () => void = () => {};
    let loadInFlight = true;
    const uninstall = installPruneScheduler({
      getController: () => controller,
      subscribeStores: (onChange) => {
        fire = onChange;
        return () => {};
      },
      isLoadInFlight: () => loadInFlight,
    });

    fire();
    flushFrames();
    expect(controller.pruneCalls.length).toBe(0); // deferred while loading

    loadInFlight = false;
    flushFrames();
    expect(controller.pruneCalls.length).toBe(1); // runs after the load settles

    uninstall();
  });

  it("is a no-op when no controller is available (browser history)", () => {
    let fire: () => void = () => {};
    const uninstall = installPruneScheduler({
      getController: () => null,
      subscribeStores: (onChange) => {
        fire = onChange;
        return () => {};
      },
      isLoadInFlight: () => false,
    });

    expect(() => {
      fire();
      flushFrames();
    }).not.toThrow();

    uninstall();
  });

  it("cancels a pending prune and unsubscribes on uninstall", () => {
    const controller = fakeController();
    let fire: () => void = () => {};
    let unsubscribed = false;
    const uninstall = installPruneScheduler({
      getController: () => controller,
      subscribeStores: (onChange) => {
        fire = onChange;
        return () => {
          unsubscribed = true;
        };
      },
      isLoadInFlight: () => false,
    });

    fire();
    uninstall();
    flushFrames();

    expect(unsubscribed).toBe(true);
    expect(controller.pruneCalls.length).toBe(0); // pending flush was cancelled
  });
});
