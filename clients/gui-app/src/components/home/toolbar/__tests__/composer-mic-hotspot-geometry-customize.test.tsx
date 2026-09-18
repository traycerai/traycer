import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerMicSlot } from "@/components/home/toolbar/composer-mic-button";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { undo } from "@/lib/customize/history";
import { registerComposerToolbarCustomizeOptions } from "@/lib/customize/options/composer-toolbar-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

/**
 * Wave-3 fixup regression (review w3): B1 ("ghosts register but never get
 * proxies" - `use-hotspot-rects.ts` rejected a ghost via its own
 * `aria-hidden` self-mark), B2 ("most real anchors have no measurable box" -
 * `ComposerMicSlot`'s live wrapper was `className="contents"`, which has no
 * principal box), and B3 ("every successful form/move/drop nests gesture
 * recording and duplicates undo entries" - the option factory's `change`
 * recorded a history entry on top of the popover's own).
 *
 * This suite mounts the REAL `ComposerMicSlot` (ghost and live) plus the REAL
 * `CustomizeOverlay` (real `useHotspotRects`, real proxies, real
 * `CustomizePopover`), so a regression in any of those three files shows up
 * here instead of only in a factory-level unit test.
 */

vi.mock("@/components/settings/panels/layout/track-layout-setting", () => ({
  trackLayoutSetting: vi.fn(),
}));

import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";

registerComposerToolbarCustomizeOptions();

// jsdom does no layout, so a plain node measures as an all-zero rect and the
// REAL `useHotspotRects` would (correctly) call it unreachable. Stub the two
// DOM reads the hook uses - same technique as `customize-overlay.test.tsx` -
// instead of faking layout or mocking the hook itself.
function stubRect(
  node: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  node.getBoundingClientRect = () =>
    new DOMRect(rect.x, rect.y, rect.width, rect.height);
  node.getClientRects = () => {
    const measured = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  };
}

function proxyFor(key: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-customize-proxy="${key}"]`,
  );
}

function resetStores(): void {
  useThemeLibraryStore.setState({ panelAnimations: false });
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useCustomizeStore.setState({
    session: {
      scene: "in-place",
      opener: { kind: "none" },
      startedAt: Date.now(),
    },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
}

beforeEach(resetStores);
afterEach(() => {
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("composer.mic real hotspot geometry (B1/B2)", () => {
  it("a ghost mic is not self-rejected by the measurement hook's aria-hidden check, and becomes a reachable proxy", async () => {
    render(
      <>
        <ComposerMicSlot dictation={null} dictationPreparing={null} />
        <CustomizeOverlay />
      </>,
    );
    const ghost = screen.getByTestId("composer-mic-ghost");
    // The registered node must not mark itself aria-hidden - that was exactly
    // what made `closest('[hidden], [aria-hidden="true"]')` match the ghost
    // itself and call it unreachable regardless of its geometry.
    expect(ghost.getAttribute("aria-hidden")).not.toBe("true");
    expect(ghost.hasAttribute("hidden")).toBe(false);

    stubRect(ghost, { x: 0, y: 0, width: 32, height: 32 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const key = [...useCustomizeStore.getState().instances.keys()].find((k) =>
      k.startsWith("composer.mic@"),
    );
    expect(key).toBeDefined();
    await waitFor(() => expect(proxyFor(key ?? "")).not.toBeNull());
  });

  it("the live mic's wrapper is a measurable box (inline-flex), not display:contents, and becomes a reachable proxy", async () => {
    render(
      <>
        <ComposerMicSlot
          dictation={{
            state: "idle",
            onToggle: () => undefined,
            onStop: () => undefined,
            onCancel: () => undefined,
            getStream: () => null,
          }}
          dictationPreparing={null}
        />
        <CustomizeOverlay />
      </>,
    );
    const key = [...useCustomizeStore.getState().instances.keys()].find((k) =>
      k.startsWith("composer.mic@"),
    );
    expect(key).toBeDefined();
    const instance = useCustomizeStore.getState().instances.get(key ?? "");
    const wrapper = instance?.node;
    expect(wrapper).toBeDefined();
    if (!wrapper) throw new Error("composer.mic did not register a node");
    // `display: contents` has no principal box - the real anchor was that
    // class name before this fixup. A measurable wrapper is `inline-flex`.
    expect(wrapper.className).not.toMatch(/\bcontents\b/);
    expect(wrapper.className).toMatch(/\binline-flex\b/);

    stubRect(wrapper, { x: 0, y: 0, width: 32, height: 32 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => expect(proxyFor(key ?? "")).not.toBeNull());
  });
});

describe("composer.mic single-owner recording through the real proxy + popover (B3)", () => {
  it("hiding the mic through the real proxy/popover writes exactly one history entry and one analytics call", async () => {
    render(
      <>
        <ComposerMicSlot
          dictation={{
            state: "idle",
            onToggle: () => undefined,
            onStop: () => undefined,
            onCancel: () => undefined,
            getStream: () => null,
          }}
          dictationPreparing={null}
        />
        <CustomizeOverlay />
      </>,
    );
    const key = [...useCustomizeStore.getState().instances.keys()].find((k) =>
      k.startsWith("composer.mic@"),
    );
    expect(key).toBeDefined();
    const instance = useCustomizeStore.getState().instances.get(key ?? "");
    const wrapper = instance?.node;
    if (!wrapper) throw new Error("composer.mic did not register a node");
    stubRect(wrapper, { x: 0, y: 0, width: 32, height: 32 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(proxyFor(key ?? "")).not.toBeNull());
    const proxy = proxyFor(key ?? "");
    if (!proxy) throw new Error("composer.mic proxy did not render");

    fireEvent.click(proxy);
    expect(useCustomizeStore.getState().popoverKey).toBe(key);

    fireEvent.click(screen.getByRole("radio", { name: "Hidden" }));

    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    // The old bug: the option factory's `change` recorded a history entry
    // AND the popover's own `mutate` recorded a second one for the same
    // gesture, so one click produced two entries (and a redundant one left
    // behind after a single Undo). Exactly one owner now.
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(useCustomizeStore.getState().history.past[0]?.label).toBe(
      "Microphone",
    );
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.composer.mic",
    );

    // One Undo should fully restore the setting with nothing redundant left
    // in `past` - the symptom the review reproduced with an in-memory probe
    // (`["Hide microphone", "Microphone"]`, a redundant entry surviving one
    // Undo).
    act(() => undo());
    expect(useLayoutStore.getState().composer.mic).toBe("visible");
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });
});

describe("composer.mic option pictures render passively (review w3, should-fix 2)", () => {
  // Should-fix 2 is now implemented centrally: `getCustomizeOptions` runs
  // every control through `withOptionPictures`
  // (`lib/customize/options/with-option-pictures.ts`), which fills in any
  // option with no explicit `picture` using `CustomizeOptionPicture` -> for
  // `composer.mic` specifically, `option-pictures.tsx`'s `ComposerPicture`
  // renders the REAL `ComposerMicButton` for the "Visible" option. So this
  // suite drives the actual `composer.mic` factory through the actual popover
  // pipeline - no fixture registration - and the picture under test is
  // exactly what a real Customize session renders.
  //
  // A picture is a passive preview leaf under `LayoutOverrideProvider`,
  // `inert` and `aria-hidden` (`Picture` in `customize-popover.tsx`). It must
  // not register its own Customize hotspot (it renders inside the same
  // popover as the real `composer.mic` instance, not as a new anchor on the
  // page) and must not activate anything real - no settings write, no
  // history entry, no analytics call - just from being shown.
  it("opening the real popover renders the mic's real picture without registering a new hotspot or touching settings/history/analytics", async () => {
    render(
      <>
        <ComposerMicSlot
          dictation={{
            state: "idle",
            onToggle: () => undefined,
            onStop: () => undefined,
            onCancel: () => undefined,
            getStream: () => null,
          }}
          dictationPreparing={null}
        />
        <CustomizeOverlay />
      </>,
    );
    const key = [...useCustomizeStore.getState().instances.keys()].find((k) =>
      k.startsWith("composer.mic@"),
    );
    expect(key).toBeDefined();
    const instance = useCustomizeStore.getState().instances.get(key ?? "");
    const wrapper = instance?.node;
    if (!wrapper) throw new Error("composer.mic did not register a node");
    stubRect(wrapper, { x: 0, y: 0, width: 32, height: 32 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(proxyFor(key ?? "")).not.toBeNull());
    const proxy = proxyFor(key ?? "");
    if (!proxy) throw new Error("composer.mic proxy did not render");

    const registryKeysBefore = [
      ...useCustomizeStore.getState().instances.keys(),
    ].sort();
    const composerBefore = useLayoutStore.getState().composer;

    fireEvent.click(proxy);

    // The real picture actually rendered - not just "nothing broke". The
    // "Visible" option's label wraps an inert, aria-hidden leaf carrying the
    // real mic icon; scoped to that label so it can't accidentally match the
    // LIVE mic button still mounted outside the popover.
    const visibleLabel = screen
      .getByRole("radio", { name: "Visible" })
      .closest("label");
    if (!visibleLabel) throw new Error("Visible option label not found");
    const pictureWrapper = visibleLabel.querySelector("[inert]");
    expect(pictureWrapper).not.toBeNull();
    expect(pictureWrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(pictureWrapper?.querySelector("svg.lucide-mic")).not.toBeNull();

    // No new hotspot from the picture, and no side effect from merely
    // showing it.
    expect([...useCustomizeStore.getState().instances.keys()].sort()).toEqual(
      registryKeysBefore,
    );
    expect(useLayoutStore.getState().composer).toEqual(composerBefore);
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
    expect(vi.mocked(trackLayoutSetting)).not.toHaveBeenCalled();
  });
});
