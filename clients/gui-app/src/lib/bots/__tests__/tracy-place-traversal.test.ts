import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  historyEntryIdentity,
  observeTracyPlaceTraversals,
  takeTracyPlaceStep,
} from "@/lib/bots/tracy-place-traversal";

let stop: (() => void) | null = null;

function observed(initialEntry: string): RouterHistory {
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  stop = observeTracyPlaceTraversals(history);
  return history;
}

function identityOf(history: RouterHistory): string {
  return historyEntryIdentity(history.location);
}

afterEach(() => {
  stop?.();
  stop = null;
});

describe("observeTracyPlaceTraversals", () => {
  it("keeps the untaken entry the app started on across a replace of it by another Tracy entry, under its new identity", () => {
    const history = observed("/bot/bot-a?view=activity");
    const started = identityOf(history);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });
    const replaced = identityOf(history);

    expect(replaced).not.toBe(started);
    expect(takeTracyPlaceStep(started)).toBe(false);
    expect(takeTracyPlaceStep(replaced)).toBe(true);
  });

  it("drops the untaken entry when it is replaced by a path that is not Tracy's", () => {
    const history = observed("/bot/bot-a");

    history.replace("/settings/general", undefined, { ignoreBlocker: true });

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });

  it("does not revive a step once it was taken, when the entry is replaced later", () => {
    const history = observed("/bot/bot-a");
    expect(takeTracyPlaceStep(identityOf(history))).toBe(true);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });

  it("makes no step of an entry that was never one: an app write replacing an entry stepped back onto", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });
});
