import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * vaul installs an iOS scroll lock (`preventScrollMobileSafari`) while an open
 * drawer is modal. It records `getScrollParent(e.target)` on touchstart and,
 * whenever that resolves to the document, cancels every following `touchmove`
 * from a non-passive capture-phase listener on `document`.
 *
 * A touch inside a shadow root RETARGETS to the host, and `getScrollParent`
 * climbs `parentElement`, which does not cross the boundary. The Pierre trees
 * this sheet embeds keep their scroller shadow-internal, so that walk finds
 * nothing scrollable and takes the cancel-everything branch - which is why the
 * trees were unscrollable in every direction while the sheet's flat lists,
 * whose scrollers are ordinary light DOM, were fine.
 *
 * `repositionInputs={false}` is the only lever vaul exposes for it. Nothing in
 * jsdom reflects the prop's effect - the lock is an iOS-only listener - so the
 * hand-off itself is what this pins. It is a narrow assertion on purpose: it
 * cannot prove the trees scroll (that is touch arbitration on a device), only
 * that the switch the fix depends on has not been silently dropped.
 */
const rootProps = vi.hoisted((): { value: Record<string, unknown> | null } => ({
  value: null,
}));

vi.mock("vaul", () => ({
  Drawer: {
    Root: (props: { readonly children: ReactNode }) => {
      rootProps.value = { ...props };
      return <div>{props.children}</div>;
    },
    Trigger: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    Portal: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    Close: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    Overlay: () => <div />,
    Content: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    Title: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    Description: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
  },
}));

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => true,
  isMobileViewport: () => true,
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
vi.mock("@/components/epic-canvas/mobile/switcher-agents-list", () => ({
  SwitcherAgentsList: () => <div />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-terminals-list", () => ({
  SwitcherTerminalsList: () => <div />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-artifacts-list", () => ({
  SwitcherArtifactsList: () => <div />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-comments-list", () => ({
  SwitcherCommentsList: () => <div />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-panel-embed", () => ({
  SwitcherPanelEmbed: () => <div />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-pr-presence-probe", () => ({
  SwitcherPrPresenceProbe: () => null,
}));
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-1",
}));

import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";

afterEach(() => {
  cleanup();
  rootProps.value = null;
});

describe("mobile sheet scroll lock", () => {
  it("opts the tab switcher sheet out of vaul's iOS scroll lock", () => {
    // The sheet is the surface that embeds the shadow-rooted Pierre trees, so
    // this is the mount the fix has to reach - asserting the wrapper forwards
    // the prop would pass with the sheet never setting it.
    render(
      <TabSwitcherSheet
        epicId="epic-1"
        tabId="tab-1"
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(rootProps.value).not.toBeNull();
    expect(rootProps.value?.repositionInputs).toBe(false);
  });

  it("leaves the lock in place for a drawer that does not opt out", () => {
    // The control: vaul's default is the lock ON, and it stays on for every
    // other sheet in the app. Without this arm the assertion above would pass
    // against a wrapper that hardcoded the opt-out for all drawers.
    render(
      <Drawer direction="bottom" open>
        <DrawerContent>body</DrawerContent>
      </Drawer>,
    );

    expect(rootProps.value).not.toBeNull();
    expect(rootProps.value?.repositionInputs).toBeUndefined();
  });
});
