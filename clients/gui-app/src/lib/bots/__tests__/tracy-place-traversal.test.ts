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

afterEach(() => {
  stop?.();
  stop = null;
});

describe("observeTracyPlaceTraversals", () => {
  it("counts the Tracy entry the history starts on as a landing, taken once", () => {
    const history = observed("/bot/bot-a?view=activity");
    const started = historyEntryIdentity(history.location);

    expect(takeTracyPlaceStep(started)).toBe(true);
    expect(takeTracyPlaceStep(started)).toBe(false);
  });

  it("does not count a start entry that is not Tracy's", () => {
    const history = observed("/settings/general");

    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      false,
    );
  });

  it("drops the untaken start entry when an app write replaces it, whatever the href", () => {
    const history = observed("/bot/bot-a?view=activity");
    const started = historyEntryIdentity(history.location);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });
    const replaced = historyEntryIdentity(history.location);

    expect(replaced).not.toBe(started);
    expect(takeTracyPlaceStep(started)).toBe(false);
    expect(takeTracyPlaceStep(replaced)).toBe(false);
  });

  it("does not revive a step once it was taken, when the entry is replaced later", () => {
    const history = observed("/bot/bot-a");
    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      true,
    );

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      false,
    );
  });

  it("makes no step of an app write replacing an entry stepped back onto", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    const stepped = historyEntryIdentity(history.location);
    history.push("/settings/general");
    history.back();
    expect(historyEntryIdentity(history.location)).toBe(stepped);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(stepped)).toBe(false);
    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      false,
    );
  });

  it("counts back and forward onto a Tracy entry as landings", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    const tracyEntry = historyEntryIdentity(history.location);
    history.push("/settings/general");

    history.back();
    expect(historyEntryIdentity(history.location)).toBe(tracyEntry);
    expect(takeTracyPlaceStep(tracyEntry)).toBe(true);

    history.forward();
    history.back();
    expect(takeTracyPlaceStep(tracyEntry)).toBe(true);
  });

  it("does not count a clamped step that does not move the entry", () => {
    const history = observed("/");
    history.push("/bot/bot-a");
    const tracyEntry = historyEntryIdentity(history.location);
    expect(takeTracyPlaceStep(tracyEntry)).toBe(false);

    history.forward();

    expect(historyEntryIdentity(history.location)).toBe(tracyEntry);
    expect(takeTracyPlaceStep(tracyEntry)).toBe(false);
  });

  it("does not count a traversal onto an entry that is not Tracy's", () => {
    const history = observed("/settings/general");
    history.push("/bot/bot-a");

    history.back();

    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      false,
    );
  });
});

describe("declareTracyPlaceLanding", () => {
  it("makes the declared Tracy entry's identity a step, taken once", () => {
    const history = observed("/");
    history.replace("/bot/bot-a?view=memory", undefined, {
      ignoreBlocker: true,
    });

    declareTracyPlaceLanding(history.location);

    const identity = historyEntryIdentity(history.location);
    expect(takeTracyPlaceStep(identity)).toBe(true);
    expect(takeTracyPlaceStep(identity)).toBe(false);
  });

  it("declares nothing for a location that is not Tracy's", () => {
    const history = observed("/bot/bot-a");
    history.replace("/settings/general", undefined, { ignoreBlocker: true });

    declareTracyPlaceLanding(history.location);

    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      false,
    );
  });

  it("is dropped by a later app write", () => {
    const history = observed("/");
    history.replace("/bot/bot-a?view=memory", undefined, {
      ignoreBlocker: true,
    });
    declareTracyPlaceLanding(history.location);
    const declared = historyEntryIdentity(history.location);

    history.replace("/bot/bot-a?view=activity", undefined, {
      ignoreBlocker: true,
    });

    expect(takeTracyPlaceStep(declared)).toBe(false);
    expect(takeTracyPlaceStep(historyEntryIdentity(history.location))).toBe(
      false,
    );
  });
});
