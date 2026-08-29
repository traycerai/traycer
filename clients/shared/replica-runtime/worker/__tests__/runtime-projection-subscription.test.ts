/**
 * The projection channel's ordering guard, over the real endpoints.
 *
 * Whole-value publication is what makes this necessary. A stale delivery does
 * not corrupt anything - it installs an older slice that is perfectly
 * self-consistent - so nothing downstream can tell it apart from a real
 * update, and the UI simply goes backwards.
 */
import { describe, expect, it } from "vitest";
import {
  createMainBridgeEndpoint,
  createWorkerBridgeEndpoint,
  type RuntimeWorkerCallHandlers,
} from "../bridge-endpoint";
import { NO_TRANSFER } from "../transferable-bytes";
import { subscribeRuntimeProjection } from "../runtime-projection-subscription";
import { createFakeBridgePair } from "../test-support/fake-bridge-pair";

interface Slice {
  readonly title: string;
}

const HANDLERS: RuntimeWorkerCallHandlers = {
  "bearer/probe": () =>
    Promise.resolve({ value: { state: "absent" }, transfer: NO_TRANSFER }),
  "attachment/read": () =>
    Promise.resolve({ value: { bytes: null }, transfer: NO_TRANSFER }),
  "body/materialize": () =>
    Promise.resolve({
      value: {
        docKey: null,
        update: null,
        seedMode: "full",
        hostStateVector: null,
      },
      transfer: NO_TRANSFER,
    }),
  "body/demote": () =>
    Promise.resolve({
      value: { accepted: false, settledBytes: 0 },
      transfer: NO_TRANSFER,
    }),
};

function setup() {
  const pair = createFakeBridgePair("sync");
  const worker = createWorkerBridgeEndpoint(pair.worker, HANDLERS);
  const main = createMainBridgeEndpoint(pair.main);
  const applied: Array<{ readonly value: Slice; readonly revision: number }> =
    [];
  const rejected: Array<{
    readonly reason: string;
    readonly revision: number;
  }> = [];
  const unsubscribe = subscribeRuntimeProjection<Slice>(main, {
    accept: (value) =>
      typeof value === "object" &&
      value !== null &&
      "title" in value &&
      typeof value.title === "string"
        ? { title: value.title }
        : null,
    apply: (value, revision) => applied.push({ value, revision }),
    reject: (reason, revision) => rejected.push({ reason, revision }),
  });
  return { worker, main, applied, rejected, unsubscribe };
}

describe("subscribeRuntimeProjection", () => {
  it("applies publications in order", () => {
    const { worker, applied } = setup();

    worker.emit({ kind: "projection", revision: 1, value: { title: "a" } }, []);
    worker.emit({ kind: "projection", revision: 2, value: { title: "b" } }, []);

    expect(applied).toEqual([
      { value: { title: "a" }, revision: 1 },
      { value: { title: "b" }, revision: 2 },
    ]);
  });

  it("drops a revision it has already applied instead of rolling the slice back", () => {
    const { worker, applied, rejected } = setup();

    worker.emit({ kind: "projection", revision: 2, value: { title: "b" } }, []);
    // A re-delivery of an older publication. Whole values, so this would look
    // exactly like a legitimate update to every consumer downstream.
    worker.emit({ kind: "projection", revision: 1, value: { title: "a" } }, []);
    worker.emit(
      { kind: "projection", revision: 2, value: { title: "b2" } },
      [],
    );

    expect(applied).toEqual([{ value: { title: "b" }, revision: 2 }]);
    expect(rejected).toEqual([
      { reason: "stale", revision: 1 },
      { reason: "stale", revision: 2 },
    ]);
  });

  it("does not advance the watermark on a slice it could not narrow", () => {
    const { worker, applied, rejected } = setup();

    worker.emit({ kind: "projection", revision: 1, value: { nope: 1 } }, []);
    // The same revision, now recognisable. Advancing on the rejection would
    // have frozen the projection permanently from one skewed frame.
    worker.emit({ kind: "projection", revision: 1, value: { title: "a" } }, []);

    expect(rejected).toEqual([{ reason: "unrecognised", revision: 1 }]);
    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);
  });

  it("stops on unsubscribe", () => {
    const { worker, applied, unsubscribe } = setup();

    unsubscribe();
    worker.emit({ kind: "projection", revision: 1, value: { title: "a" } }, []);

    expect(applied).toEqual([]);
  });
});
