import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { CustomizePopover } from "@/components/customize/customize-popover";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { registerChatSurfacesCustomizeOptions } from "@/lib/customize/options/chat-surfaces-options";
import { undo } from "@/lib/customize/history";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import {
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

/**
 * Ticket w3-chat-surfaces: the context chip's `chat.context` composite.
 *
 * Wave-3 fixup regression (review w3, should-fix 6 / B3): `movePinnedField`
 * (`chat-surfaces-options.ts`) used to mutate `pinnedContextBreakdownOrder`
 * directly when called; it now returns a `CustomizeMove | null` descriptor
 * that only the popover's own Move button records and runs (the shared
 * single-recording-owner fix). The two tests below that called
 * `fields.moveItem(...)` and asserted a synchronous store mutation no longer
 * match that contract - direct-mutation assertions on a `CustomizeMove`
 * factory call are now silently wrong (the descriptor is built but never
 * run), so this rewrite drives the real popover's "Move up" button instead,
 * and also pins down the previously-untested rendered DOM order (review
 * finding 6: "the test ... checks the store and option factory, not
 * rendered order").
 */

registerChatSurfacesCustomizeOptions();

const RELIABLE_USAGE: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

function chipInstance(): HotspotInstance {
  return {
    key: "chat.context@shell:chat-1",
    settingId: "chat.context",
    sceneId: "shell",
    tileId: "landing",
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

function resetStores(): void {
  useSettingsStore.setState({
    pinContextUsageBreakdown: false,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    pinnedContextBreakdownOrder: DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  });
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    preferredTileId: null,
    history: { past: [], future: [] },
  });
}

/** Finds the real hotspot instance a mounted `<ContextUsageChip>` registered
 *  for `chat.context`, and opens its popover against that instance's real
 *  (fixture) node - the same two-step other w3 suites use to go through the
 *  real proxy/popover boundary rather than a hand-built instance. */
function openRealChipPopover(): HotspotInstance {
  const instance = [...useCustomizeStore.getState().instances.values()].find(
    (candidate) => candidate.settingId === "chat.context",
  );
  if (!instance) throw new Error("chat.context hotspot did not register");
  act(() => {
    useCustomizeStore.setState({ popoverKey: instance.key });
  });
  const rects = new Map([[instance.key, new DOMRect(0, 0, 20, 20)]]);
  render(<CustomizePopover rects={rects} />);
  return instance;
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
  resetStores();
});

describe("chat.context ghost", () => {
  it("ghosts with 'no usage reported yet' while editing and no usage has arrived", () => {
    render(<ContextUsageChip usage={null} onCompact={null} />);
    expect(screen.getByTestId("context-usage-chip-ghost")).not.toBeNull();
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "chat.context",
    );
    expect(instance?.condition).toBe("no usage reported yet");
  });

  it("renders nothing when there is no usage outside a session", () => {
    act(() => {
      useCustomizeStore.setState({ session: null });
    });
    const { container } = render(
      <ContextUsageChip usage={null} onCompact={null} />,
    );
    expect(container.innerHTML).toBe("");
  });

  // Review w3, should-fix 12: a populated surface must not keep announcing a
  // missing-data condition. `noUsage` gates both `ghost` and `condition`
  // together here, so a real usage payload must clear both at once.
  it("carries no missing-usage condition once real usage has arrived", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={null} />);
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "chat.context",
    );
    expect(instance?.ghost).toBe(false);
    expect(instance?.condition).toBeNull();
    expect(screen.queryByTestId("context-usage-chip-ghost")).toBeNull();
  });
});

describe("chat.context option", () => {
  it("the fields 'More' list is in pinnedContextBreakdownOrder", () => {
    const options = getCustomizeOptions(chipInstance());
    const fields =
      options?.control?.kind === "composite"
        ? options.control.more.find(
            (control) => control.id === "chat.context.fields",
          )
        : null;
    expect(
      fields?.kind === "multi" ? fields.options.map((o) => o.value) : null,
    ).toEqual(DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER);
  });

  // Rewritten (see file header): drives the real popover's Move button
  // instead of calling the `multi` control's `moveItem` factory directly -
  // that call now returns a `CustomizeMove` descriptor rather than mutating,
  // and only the popover records + runs it (single-recording-owner, B3).
  // Also asserts the RENDERED pinned strip's DOM order, not just the store -
  // review finding 6's actual gap.
  it("moving Output to the top through the real popover reorders the rendered pinned strip, one history entry per move", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={null} />);
    act(() => useSettingsStore.getState().setPinContextUsageBreakdown(true));

    openRealChipPopover();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const moveGroup = screen.getByRole("group", { name: "Move Output" });
    const moveUp = within(moveGroup).getByRole("button", { name: "Move up" });

    // Four ups over the five-field default order brings "output" to the
    // front; each click is a fresh real gesture (RELIABLE_USAGE has no cache
    // fields, so only "used"/"output" ever render in the strip - the other
    // three moves are still real store writes even though they don't move
    // anything currently visible).
    for (let i = 0; i < 4; i += 1) fireEvent.click(moveUp);

    expect(useSettingsStore.getState().pinnedContextBreakdownOrder[0]).toBe(
      "output",
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(4);

    // Re-mount the real chip fresh so it reads the now-updated store, and
    // check the rendered DOM order - not the factory's option list.
    cleanup();
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={null} />);
    const details = screen.getByTestId("context-usage-pinned-details");
    const outputIndex = details.textContent.indexOf("Output");
    const usedIndex = details.textContent.indexOf("Used");
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(usedIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeLessThan(usedIndex);
  });

  // Rewritten (see file header) for the same `moveItem` contract change; also
  // now asserts the single-history-entry invariant the old direct-mutation
  // version never checked.
  it("undoing a pinned-field reorder (through the real popover) restores the previous order", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={null} />);
    openRealChipPopover();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const moveGroup = screen.getByRole("group", { name: "Move Fresh" });
    fireEvent.click(within(moveGroup).getByRole("button", { name: "Move up" }));

    expect(useSettingsStore.getState().pinnedContextBreakdownOrder).toEqual([
      "fresh",
      "used",
      "cacheRead",
      "cacheWrite",
      "output",
    ]);
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);

    act(() => undo());
    expect(useSettingsStore.getState().pinnedContextBreakdownOrder).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });

  it("unchecking the last pinned field is held: its checkbox is disabled, not removable", () => {
    act(() => {
      useSettingsStore.getState().setPinnedContextBreakdownFields(["used"]);
    });
    const instance = chipInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);

    render(<CustomizePopover rects={rects} />);

    fireEvent.click(screen.getByRole("button", { name: /More/i }));
    const lastCheckbox = screen.getByRole("checkbox", { name: /Used/i });
    expect(lastCheckbox.hasAttribute("disabled")).toBe(true);
  });

  // Rewritten (see file header - the same B3 fix applies here): the choice
  // control's `change` is now a plain write with no `recordGesture` of its
  // own, so calling it directly pushes NOTHING onto `history.past` and a
  // follow-up `undo()` has nothing to pop - the old version of this test
  // only "passed" by coincidence (it happened to assert the post-`change`
  // value before ever exercising `undo`'s real behaviour). Drives the real
  // popover instead, and now actually checks the history entry undo needs.
  it("hiding the compact button through the real popover writes the layout store, and undo restores it", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} onCompact={null} />);
    openRealChipPopover();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("radio", { name: "Hidden" }));

    expect(useLayoutStore.getState().composer.compactButton).toBe("hidden");
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);

    act(() => undo());
    expect(useLayoutStore.getState().composer.compactButton).toBe("visible");
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });
});
