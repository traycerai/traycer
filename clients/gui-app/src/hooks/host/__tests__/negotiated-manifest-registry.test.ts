import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * Direct unit tests for the per-host negotiated-method registry that backs
 * optional-capability gates (including `epic.setChatArchived` / B4).
 *
 * Unknown hosts must fail closed; a recorded manifest must answer; re-recording
 * an identical set must not churn listeners (referential stability).
 */
describe("negotiated-manifest-registry", () => {
  afterEach(() => {
    resetNegotiatedManifests();
  });

  it("reads an unknown host as not-yet-known (null), not false", () => {
    expect(getNegotiatedHostMethods("host-unknown")).toBeNull();
  });

  it("answers from a recorded manifest", () => {
    recordNegotiatedHostMethods("host-1", [
      "epic.listChats",
      "epic.setChatArchived",
    ]);

    const methods = getNegotiatedHostMethods("host-1");
    expect(methods).not.toBeNull();
    if (methods === null) throw new Error("expected recorded methods");
    expect(methods.has("epic.setChatArchived")).toBe(true);
    expect(methods.has("epic.listChats")).toBe(true);
    expect(methods.has("epic.missingMethod")).toBe(false);
  });

  it("does not notify listeners or churn the set when re-recording an identical method set", () => {
    recordNegotiatedHostMethods("host-1", ["a", "b"]);
    const first = getNegotiatedHostMethods("host-1");
    expect(first).not.toBeNull();

    const listener = vi.fn();
    const unsubscribe = subscribeNegotiatedManifests(listener);

    recordNegotiatedHostMethods("host-1", ["b", "a"]);
    expect(listener).not.toHaveBeenCalled();
    // Same Set instance - useSyncExternalStore getSnapshot can stay stable.
    expect(getNegotiatedHostMethods("host-1")).toBe(first);

    unsubscribe();
  });

  it("notifies listeners and replaces the set when the negotiated methods change", () => {
    recordNegotiatedHostMethods("host-1", ["a"]);
    const first = getNegotiatedHostMethods("host-1");

    const listener = vi.fn();
    const unsubscribe = subscribeNegotiatedManifests(listener);

    recordNegotiatedHostMethods("host-1", ["a", "epic.setChatArchived"]);
    expect(listener).toHaveBeenCalledTimes(1);
    const second = getNegotiatedHostMethods("host-1");
    expect(second).not.toBe(first);
    expect(second?.has("epic.setChatArchived")).toBe(true);

    unsubscribe();
  });
  it("reads an unknown host's method version as not-yet-known (null)", () => {
    expect(
      getNegotiatedHostMethodVersion("host-unknown", "epic.listChats"),
    ).toBeNull();
  });

  it("records the exact per-method negotiated version from a manifest", () => {
    recordNegotiatedHostManifest("host-1", {
      "epic.listChats": { major: 2, minor: 3 },
      "epic.setChatArchived": { major: 1, minor: 0 },
    });

    expect(getNegotiatedHostMethodVersion("host-1", "epic.listChats")).toEqual({
      major: 2,
      minor: 3,
    });
    expect(
      getNegotiatedHostMethodVersion("host-1", "epic.setChatArchived"),
    ).toEqual({ major: 1, minor: 0 });
    // Still unknown for a method absent from the manifest.
    expect(
      getNegotiatedHostMethodVersion("host-1", "epic.missingMethod"),
    ).toBeNull();
  });

  it("notifies but keeps the method set stable when only a VERSION changes", () => {
    // The branch the fork dialog's capability healing rides on: a host upgraded
    // in place answers the same methods at a higher minor, so `methodsChanged`
    // is false and `versionsChanged` is true. `recordNegotiatedHostManifest`
    // handles the two independently - it must still notify (or the gate never
    // re-reads and the row keeps its stale "needs update" word), while leaving
    // the method Set's REFERENCE alone (or every presence consumer's
    // `getSnapshot` churns for a change that did not touch presence).
    recordNegotiatedHostManifest("host-1", {
      "epic.createChat": { major: 1, minor: 1 },
    });
    const first = getNegotiatedHostMethods("host-1");
    expect(first).not.toBeNull();

    const listener = vi.fn();
    const unsubscribe = subscribeNegotiatedManifests(listener);

    recordNegotiatedHostManifest("host-1", {
      "epic.createChat": { major: 1, minor: 2 },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getNegotiatedHostMethods("host-1")).toBe(first);
    expect(getNegotiatedHostMethodVersion("host-1", "epic.createChat")).toEqual(
      {
        major: 1,
        minor: 2,
      },
    );

    unsubscribe();
  });

  it("also records method presence so existing presence consumers keep working", () => {
    recordNegotiatedHostManifest("host-1", {
      "epic.listChats": { major: 1, minor: 0 },
    });

    const methods = getNegotiatedHostMethods("host-1");
    expect(methods).not.toBeNull();
    expect(methods?.has("epic.listChats")).toBe(true);
  });
});
