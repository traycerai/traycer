import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutFormContext } from "@/components/layout-editor/regions/row-availability";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  DEFAULT_ARRANGEMENT,
  USAGE_PROVIDER_IDS,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * The usage-providers group's own filter and reorder, read at
 * `OrderGroupList` - the actual owner of both (`order-group-list.tsx`'s
 * `OrderGroupRows`/`reorderVisibleProviders`), not `useLayoutUsage()` or
 * `providerOrderItems` in isolation, which would prove the pieces agree with
 * themselves rather than that the list wires them together correctly.
 *
 * `useLayoutUsage` is mocked because this suite is about what `OrderGroupList`
 * does with a given `providerIds` set, not about resolving one - that
 * resolution is `provider-limit-windows.test.tsx` /
 * `provider-limit-windows-scoped-cache.test.tsx`'s own proof.
 */
const usage = vi.hoisted(() => ({
  providerIds: [] as ReadonlyArray<RateLimitProviderId>,
}));
vi.mock("@/components/layout-editor/inspector/use-layout-usage", () => ({
  useLayoutUsage: () => ({
    providerIds: usage.providerIds,
    cluster: { kind: "no-providers" as const },
    hostName: "the watched host",
  }),
}));
vi.mock("@/components/layout-editor/inspector/provider-limit-windows", () => ({
  NoLayoutUsageProviders: () => <p>stub: no providers</p>,
}));

import { OrderGroupList } from "@/components/layout-editor/inspector/rows/order-group-list";

// The real catalog, in its own canonical order (codex, claude-code,
// openrouter, kilocode, grok, huggingface, opencode, cursor, antigravity) -
// not a hand picked subset. `writeArrangement` runs every write through
// `normalizeArrangement`, which merges in any canonical id the stored order
// is missing (`mergeOrder`, arrangement-persist.ts); starting from the full
// catalog makes that merge a no-op instead of a second, unrelated seam this
// suite would otherwise have to hand-trace.
const CATALOG_ORDER: ReadonlyArray<RateLimitProviderId> = USAGE_PROVIDER_IDS;

function arrangement(overrides: Partial<LayoutArrangement>): LayoutArrangement {
  return {
    ...DEFAULT_ARRANGEMENT,
    usageProviders: CATALOG_ORDER,
    ...overrides,
  };
}

function values() {
  return effectiveLayoutValues(
    DEFAULT_LAYOUT_SNAPSHOT.basePreset,
    DEFAULT_LAYOUT_SNAPSHOT.overrides,
  );
}

/**
 * The one form context a row's rules read (P1), built by hand so the list is
 * given the arrangement the test names rather than the stored one. A desktop
 * browser tab, with Voice input on, unless the case says otherwise.
 */
function formContext(
  arrangementValue: LayoutArrangement,
  shell: Pick<SettingsAvailabilityContext, "mobileApp" | "phoneLayout">,
): LayoutFormContext {
  return {
    values: values(),
    arrangement: arrangementValue,
    shell: { runnerHost: null, featureSettings: null, ...shell },
    facts: { voiceInputEnabled: true },
  };
}

const DESKTOP_SHELL = { mobileApp: false, phoneLayout: false };
const NARROW_BROWSER_SHELL = { mobileApp: false, phoneLayout: true };
const INSTALLED_APP_SHELL = { mobileApp: true, phoneLayout: true };

function renderList(arrangementValue: LayoutArrangement): ReactNode {
  return (
    <OrderGroupList
      group="usageProviders"
      selectedId={null}
      values={values()}
      arrangement={arrangementValue}
      decorate={null}
      context={formContext(arrangementValue, DESKTOP_SHELL)}
    />
  );
}

function renderToolbar(
  group: "toolbarLeft" | "toolbarRight",
  arrangementValue: LayoutArrangement,
  shell: Pick<SettingsAvailabilityContext, "mobileApp" | "phoneLayout">,
): ReactNode {
  return (
    <OrderGroupList
      group={group}
      selectedId={null}
      values={values()}
      arrangement={arrangementValue}
      decorate={null}
      context={formContext(arrangementValue, shell)}
    />
  );
}

function row(id: string): HTMLElement {
  const node = document.querySelector(`[data-sortable-id="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

function rowOrder(): ReadonlyArray<string> {
  return [...document.querySelectorAll("[data-sortable-id]")].map(
    (node) => node.getAttribute("data-sortable-id") ?? "",
  );
}

beforeEach(() => {
  usage.providerIds = [];
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({
    instances: new Map(),
    dockMode: "right",
    lockedBy: "none",
  });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

/** Watched providers that leave the list with nothing to draw. */
const EMPTY_CASES: ReadonlyArray<{
  readonly providerIds: ReadonlyArray<RateLimitProviderId>;
  readonly usageProviders: ReadonlyArray<RateLimitProviderId>;
}> = [
  { providerIds: [], usageProviders: CATALOG_ORDER },
  { providerIds: ["kilocode"], usageProviders: ["codex", "claude-code"] },
];

describe("the usage-providers list is filtered to the watched host's own providers", () => {
  it("draws only the watched providerIds, in the catalog's own order", () => {
    usage.providerIds = ["claude-code", "openrouter"];
    render(renderList(arrangement({})));

    // Neither the credit-only provider (kilocode) nor everything else the
    // watched host has not reported gets a row - the list reflects
    // `useLayoutUsage().providerIds`, not the full catalog. The two watched
    // ids are drawn in the CATALOG's order (claude-code before openrouter),
    // not the order they were named in.
    expect(rowOrder()).toEqual(["claude-code", "openrouter"]);
  });

  // The second row names providers outside `arrangement.usageProviders`
  // entirely - a defensive case `Array.includes` already covers, but the one
  // place a hand-rolled filter could plausibly invert the check. It needs its
  // own restricted `usageProviders` (unlike the full canonical catalog the
  // other cases share), since every real provider id is by definition inside
  // the full catalog.
  it.each(EMPTY_CASES)(
    "falls back to the empty-state line when nothing is visible (watched $providerIds)",
    ({ providerIds, usageProviders }) => {
      usage.providerIds = providerIds;
      render(renderList(arrangement({ usageProviders })));

      expect(screen.getByText("stub: no providers")).not.toBeNull();
      expect(rowOrder()).toEqual([]);
    },
  );
});

describe("reordering the visible providers preserves the omitted ones' own slots", () => {
  it("moves a visible provider past another visible one, leaving hidden slots untouched", () => {
    // claude-code and kilocode are the only ones the watched host reports;
    // everything else - including openrouter, which sits BETWEEN them in the
    // catalog's own order - must keep its exact index across the move.
    usage.providerIds = ["claude-code", "kilocode"];
    render(renderList(arrangement({})));
    expect(rowOrder()).toEqual(["claude-code", "kilocode"]);
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });

    fireEvent.keyDown(row("claude-code"), { key: "ArrowDown", altKey: true });

    const stored = useLayoutStore.getState().arrangement.usageProviders;
    expect(stored).toEqual([
      "codex",
      "kilocode",
      "openrouter",
      "claude-code",
      "grok",
      "huggingface",
      "opencode",
      "cursor",
      "antigravity",
    ]);
    // openrouter's INDEX, specifically - not merely "still present" - is
    // what "preserve omitted slots" actually claims: it sat between the two
    // moved providers before and still does, at the same index, after.
    expect(stored[2]).toBe("openrouter");
    expect(stored.slice(4)).toEqual([
      "grok",
      "huggingface",
      "opencode",
      "cursor",
      "antigravity",
    ]);

    // One undoable gesture, same as every other arrangement write.
    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.usageProviders).toEqual(
      CATALOG_ORDER,
    );
  });
});

describe("narrow (mobile-viewport-width) toolbar clusters draw fixed, non-reorderable rows", () => {
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    window.innerWidth = 500;
  });

  afterEach(() => {
    window.innerWidth = originalInnerWidth;
  });

  it("draws only Attach image on the left, in place of the desktop's Attach image/Access pair", () => {
    render(renderToolbar("toolbarLeft", arrangement({}), NARROW_BROWSER_SHELL));
    expect(rowOrder()).toEqual(["attachImage"]);
  });

  it("draws Model then Microphone on the right: the phone's chip is the same picker, without its label", () => {
    render(
      renderToolbar("toolbarRight", arrangement({}), NARROW_BROWSER_SHELL),
    );
    expect(rowOrder()).toEqual(["model", "mic"]);
  });

  it("leaves Microphone out of the installed app, which refuses dictation", () => {
    render(renderToolbar("toolbarRight", arrangement({}), INSTALLED_APP_SHELL));
    expect(rowOrder()).toEqual(["model"]);
  });

  it("has no reorder gesture at all, not merely nothing left to reorder into", () => {
    // A single visible row already has nowhere to move to
    // (`stepPastFixed`/`handleArrow` return before ever calling `onMove`), so
    // simulating a drag and checking the stored order afterwards cannot tell
    // "onMove is null" apart from "onMove exists but this list of one has no
    // legal destination" - both leave the array untouched. `onMove={null}`
    // has its own real signal instead: `SortableList` renders no grab
    // instructions for an unordered list (`ordered = onMove !== null`,
    // sortable-list.tsx), so their absence is what a narrow list without a
    // reorder gesture actually looks like.
    render(renderToolbar("toolbarLeft", arrangement({}), NARROW_BROWSER_SHELL));
    expect(
      screen.queryByText(
        "Press space to pick up, arrow keys to move, space to drop, escape to cancel.",
      ),
    ).toBeNull();
  });

  it("keeps the reorder gesture on the desktop's own (wider) toolbar list", () => {
    // Sanity check that the instructions text really is the ordered-list
    // signal the test above relies on: widen past the narrow gate this
    // describe block sets in `beforeEach`, and it comes back.
    window.innerWidth = 1024;
    render(renderToolbar("toolbarLeft", arrangement({}), DESKTOP_SHELL));
    expect(
      screen.queryByText(
        "Press space to pick up, arrow keys to move, space to drop, escape to cancel.",
      ),
    ).not.toBeNull();
  });
});
