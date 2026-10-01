import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedControlKeys,
  isControlValueChanged,
  revertControlValue,
  revertControlValues,
  writeControlValue,
} from "@/components/layout-editor/inspector/region-control-io";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The dynamic half of the region grammar, which is the seam a reviewer is
 * right to distrust: a control names its key as a string, so nothing in the
 * type system stops a registry typo from reaching the store. What this suite
 * pins is that the seam is sound anyway - the revert path only touches keys
 * the region really has, and a multi-key revert is one undo step rather than
 * five. That the write path parses is the store's own contract
 * (`layout-store.test.ts`, "the write path parses like a rehydrate").
 */

function reset(): void {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  window.localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

describe("writing and reverting", () => {
  it("writes through the gesture path and reports the key as changed", () => {
    writeControlValue("model", "style", "bars");

    expect(getLayoutSnapshot().overrides).toEqual({ model: { style: "bars" } });
    expect(isControlValueChanged("model", "style")).toBe(true);
    expect(isControlValueChanged("model", "shown")).toBe(false);
  });

  it("drops the region once its last changed key goes back to the base", () => {
    writeControlValue("model", "style", "bars");

    revertControlValue("model", "style");

    expect(getLayoutSnapshot().overrides).toEqual({});
  });

  it("reverts several keys at once and leaves the rest of the region alone", () => {
    writeControlValue("usageLimits", "bar", false);
    writeControlValue("usageLimits", "word", false);

    expect(changedControlKeys("usageLimits", ["bar", "word", "shown"])).toEqual(
      ["bar", "word"],
    );

    revertControlValues("usageLimits", ["bar"]);

    expect(getLayoutSnapshot().overrides).toEqual({
      usageLimits: { word: false },
    });
  });

  it("makes a multi-key revert ONE write, so it is one undo step", () => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    writeControlValue("usageLimits", "bar", false);
    writeControlValue("usageLimits", "word", false);
    const depth = useLayoutEditorStore.getState().history.past.length;

    revertControlValues("usageLimits", ["bar", "word"]);

    expect(getLayoutSnapshot().overrides).toEqual({});
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(
      depth + 1,
    );

    useLayoutEditorStore.getState().undo();

    expect(getLayoutSnapshot().overrides).toEqual({
      usageLimits: { bar: false, word: false },
    });
  });

  it("reverts nothing for a key the region does not have", () => {
    // Against a region that HAS a change, so the answer comes from the
    // per-key membership test rather than from there being nothing to revert:
    // a registry typo touches nothing (G1-08).
    writeControlValue("model", "style", "bars");

    revertControlValues("model", ["stlye"]);

    expect(getLayoutSnapshot().overrides).toEqual({ model: { style: "bars" } });
  });
});
