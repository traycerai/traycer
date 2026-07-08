import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import {
  navigateNestedFocus,
  type NestedFocusLocation,
} from "@/lib/epic-nested-focus-navigation";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";

interface CapturedNavigateOptions {
  readonly search: (prev: Record<string, unknown>) => unknown;
  readonly replace: boolean;
}

function isCapturedNavigateOptions(
  value: unknown,
): value is CapturedNavigateOptions {
  if (typeof value !== "object" || value === null) return false;
  if (!("search" in value) || !("replace" in value)) return false;
  return (
    typeof value.search === "function" && typeof value.replace === "boolean"
  );
}

function firstNavigateOptions(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): CapturedNavigateOptions {
  const firstCall = calls[0];
  const options = firstCall[0];
  if (!isCapturedNavigateOptions(options)) {
    throw new Error("expected navigate search options");
  }
  return options;
}

describe("navigateNestedFocus", () => {
  it("pushes a nested search patch for persistent desktop history", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-1/tab-1",
      "nested-focus-navigation",
    );
    const navigate = vi.fn();

    navigateNestedFocus(
      {
        history,
        navigate,
        getLocation: (): NestedFocusLocation => ({
          pathname: "/epics/epic-1/tab-1",
          search: {},
        }),
      },
      { epicId: "epic-1", tabId: "tab-1" },
      () => ({ paneId: "pane-1", tileInstanceId: "tile-1" }),
    );

    const options = firstNavigateOptions(navigate.mock.calls);
    expect(options.replace).toBe(false);
    expect(options.search({ focusArtifactId: "artifact-1" })).toMatchObject({
      focusArtifactId: "artifact-1",
      focusPaneId: "pane-1",
      focusTileInstanceId: "tile-1",
    });
  });

  it("does not navigate duplicate focus targets", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-1/tab-1?focusPaneId=pane-1&focusTileInstanceId=tile-1",
      "nested-focus-navigation-duplicate",
    );
    const navigate = vi.fn();

    navigateNestedFocus(
      {
        history,
        navigate,
        getLocation: (): NestedFocusLocation => ({
          pathname: "/epics/epic-1/tab-1",
          search: {
            focusPaneId: "pane-1",
            focusTileInstanceId: "tile-1",
          },
        }),
      },
      { epicId: "epic-1", tabId: "tab-1" },
      () => ({ paneId: "pane-1", tileInstanceId: "tile-1" }),
    );

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not write nested params for memory history", () => {
    const history = createMemoryHistory({
      initialEntries: ["/epics/epic-1/tab-1"],
    });
    const navigate = vi.fn();

    const target = navigateNestedFocus(
      {
        history,
        navigate,
        getLocation: (): NestedFocusLocation => ({
          pathname: "/epics/epic-1/tab-1",
          search: {},
        }),
      },
      { epicId: "epic-1", tabId: "tab-1" },
      () => ({ paneId: "pane-1", tileInstanceId: "tile-1" }),
    );

    expect(target).toEqual({ paneId: "pane-1", tileInstanceId: "tile-1" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate null preparation targets", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-1/tab-1",
      "nested-focus-navigation-null",
    );
    const navigate = vi.fn();

    const target = navigateNestedFocus(
      {
        history,
        navigate,
        getLocation: (): NestedFocusLocation => ({
          pathname: "/epics/epic-1/tab-1",
          search: {},
        }),
      },
      { epicId: "epic-1", tabId: "tab-1" },
      () => null,
    );

    expect(target).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("prepares and returns the target without navigating when the current route does not match the tab", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-1/tab-1",
      "nested-focus-navigation-cross-route",
    );
    const navigate = vi.fn();
    let prepareCalled = false;

    const target = navigateNestedFocus(
      {
        history,
        navigate,
        getLocation: (): NestedFocusLocation => ({
          pathname: "/epics/epic-2/tab-2",
          search: {},
        }),
      },
      { epicId: "epic-1", tabId: "tab-1" },
      () => {
        prepareCalled = true;
        return { paneId: "pane-1", tileInstanceId: "tile-1" };
      },
    );

    expect(prepareCalled).toBe(true);
    expect(target).toEqual({ paneId: "pane-1", tileInstanceId: "tile-1" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
