import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  declareTracyPlaceLanding,
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
  it("counts the Tracy entry the history starts on as a landing, taken once", () => {
    const history = observed("/bot/bot-a?view=activity");
    const started = identityOf(history);

    expect(takeTracyPlaceStep(started)).toBe(true);
    expect(takeTracyPlaceStep(started)).toBe(false);
  });

  it("does not count a start entry that is not Tracy's", () => {
    const history = observed("/settings/general");

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });

  it("drops the untaken start entry when an app write replaces it, whatever the href", () => {
    const history = observed("/bot/bot-a?view=activity");
    const started = identityOf(history);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });
    const replaced = identityOf(history);

    expect(replaced).not.toBe(started);
    expect(takeTracyPlaceStep(started)).toBe(false);
    expect(takeTracyPlaceStep(replaced)).toBe(false);
  });

  it("does not revive a step once it was taken, when the entry is replaced later", () => {
    const history = observed("/bot/bot-a");
    expect(takeTracyPlaceStep(identityOf(history))).toBe(true);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });

  it("makes no step of an app write replacing an entry stepped back onto", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });

  it("counts back and forward onto a Tracy entry as landings", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    const tracyEntry = identityOf(history);
    history.push("/settings/general");

    history.back();
    expect(identityOf(history)).toBe(tracyEntry);
    expect(takeTracyPlaceStep(tracyEntry)).toBe(true);

    history.forward();
    history.back();
    expect(takeTracyPlaceStep(tracyEntry)).toBe(true);
  });

  it("does not count a clamped step that does not move the entry", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    const tracyEntry = identityOf(history);
    expect(takeTracyPlaceStep(tracyEntry)).toBe(false);

    history.forward();

    expect(identityOf(history)).toBe(tracyEntry);
    expect(takeTracyPlaceStep(tracyEntry)).toBe(false);
  });

  it("does not count a traversal onto an entry that is not Tracy's", () => {
    const history = observed("/settings/general");
    history.push("/bot/bot-a");

    history.back();

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });
});

describe("declareTracyPlaceLanding", () => {
  it("makes the declared Tracy entry's identity a step, taken once", () => {
    const history = observed("/");
    history.replace("/bot/bot-a?view=memory", undefined, {
      ignoreBlocker: true,
    });

    declareTracyPlaceLanding(history.location);

    const identity = identityOf(history);
    expect(takeTracyPlaceStep(identity)).toBe(true);
    expect(takeTracyPlaceStep(identity)).toBe(false);
  });

  it("declares nothing for a location that is not Tracy's", () => {
    const history = observed("/bot/bot-a");
    history.replace("/settings/general", undefined, { ignoreBlocker: true });

    declareTracyPlaceLanding(history.location);

    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });

  it("is dropped by a later app write", () => {
    const history = observed("/");
    history.replace("/bot/bot-a?view=memory", undefined, {
      ignoreBlocker: true,
    });
    declareTracyPlaceLanding(history.location);
    const declared = identityOf(history);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(declared)).toBe(false);
    expect(takeTracyPlaceStep(identityOf(history))).toBe(false);
  });
});
