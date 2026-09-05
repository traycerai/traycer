import { afterEach, describe, expect, it } from "vitest";
import { isPresentationLossBlur } from "@/components/epic-tabs/pane-visibility-context";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import type {
  BrowserGuestActivate,
  BrowserGuestActivateEvent,
  BrowserGuestTilePlacement,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import {
  browserGuestCssAnchorName,
  clearBrowserGuestTilePlacement,
  setBrowserGuestTilePlacement,
  startPersistentBrowserGuestHost,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type { BrowserViewGuestMountRequested } from "@traycer-clients/shared/platform/browser-view";

/**
 * jsdom can observe wrapper/webview node identity, attributes,
 * subscriptions, and which activate handler fired. It cannot prove
 * Chromium compositing, CSS anchor geometry (`anchor()` / `anchor-size()`
 * values are dropped by the parser), overlay stacking, hidden painting,
 * real Electron `<webview>` identity, `webContentsId`, `inert` subtrees,
 * or Electron focus retention. `position-anchor` and `position: fixed`
 * are asserted because jsdom stores those declarations.
 */
const HOST_TEST_ID = "persistent-browser-guest-host";
const REGISTRATION_A = "reg-a";
const REGISTRATION_B = "reg-b";
const PARTITION_A = "persist:guest-a";
const PARTITION_B = "persist:guest-b";
const INSTANCE_A = "tile-1";
const ANCHOR_A = `--traycer-bv-${REGISTRATION_A}`;

interface RecordedActivation {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly event: BrowserGuestActivateEvent;
}

function mountRequest(
  registrationId: string,
  partition: string,
): BrowserViewGuestMountRequested {
  return {
    registrationId,
    partition,
  };
}

function recordingActivate(): {
  readonly pointerDowns: RecordedActivation[];
  readonly focuses: RecordedActivation[];
  readonly activate: BrowserGuestActivate;
} {
  const pointerDowns: RecordedActivation[] = [];
  const focuses: RecordedActivation[] = [];
  return {
    pointerDowns,
    focuses,
    activate: {
      pointerDown: (viewTabId, paneId, event) => {
        pointerDowns.push({ viewTabId, paneId, event });
      },
      focus: (viewTabId, paneId, event) => {
        focuses.push({ viewTabId, paneId, event });
      },
    },
  };
}

const NOOP_ACTIVATE: BrowserGuestActivate = {
  pointerDown: () => {},
  focus: () => {},
};

let hostDisposers: Array<() => void> = [];

function startHost(
  bridge: FakeBrowserViewBridge,
  activate: BrowserGuestActivate,
): () => void {
  const dispose = startPersistentBrowserGuestHost(bridge, activate);
  hostDisposers.push(dispose);
  return dispose;
}

function queryHost(): HTMLElement | null {
  const host = document.querySelector(`[data-testid="${HOST_TEST_ID}"]`);
  return host instanceof HTMLElement ? host : null;
}

function queryWrapper(registrationId: string): HTMLElement | null {
  const wrapper = document.querySelector(
    `[data-browser-guest-registration="${registrationId}"]`,
  );
  return wrapper instanceof HTMLElement ? wrapper : null;
}

function guestNodes(registrationId: string): {
  readonly host: HTMLElement;
  readonly wrapper: HTMLElement;
  readonly webview: HTMLElement;
} {
  const host = queryHost();
  if (host === null) throw new Error("expected persistent browser guest host");
  const wrapper = queryWrapper(registrationId);
  if (wrapper === null) {
    throw new Error(`expected guest wrapper ${registrationId}`);
  }
  const webview = wrapper.querySelector("webview");
  if (!(webview instanceof HTMLElement)) {
    throw new Error(`expected webview for ${registrationId}`);
  }
  return { host, wrapper, webview };
}

function dispatchPointerDown(target: HTMLElement): void {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

function dispatchFocus(target: HTMLElement): void {
  target.dispatchEvent(new Event("focus"));
}

/**
 * Host stop no longer wipes placements. Track every owner this file
 * publishes so a later test cannot inherit a live record.
 */
const ownedPlacements: Array<{
  readonly owner: symbol;
  readonly registrationId: string;
}> = [];

function setOwnedPlacement(
  owner: symbol,
  placement: BrowserGuestTilePlacement,
): void {
  setBrowserGuestTilePlacement(owner, placement);
  ownedPlacements.push({
    owner,
    registrationId: placement.registrationId,
  });
}

afterEach(() => {
  for (const owned of ownedPlacements) {
    clearBrowserGuestTilePlacement(owned.owner, owned.registrationId);
  }
  ownedPlacements.length = 0;
  hostDisposers.forEach((dispose) => dispose());
  hostDisposers = [];
});

describe("browserGuestCssAnchorName", () => {
  it("prefixes the registration id as a dashed-ident", () => {
    expect(browserGuestCssAnchorName(REGISTRATION_A)).toBe(ANCHOR_A);
    expect(
      browserGuestCssAnchorName("550e8400-e29b-41d4-a716-446655440000"),
    ).toBe("--traycer-bv-550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("persistent browser guest host", () => {
  describe("guest identity", () => {
    it("keeps the same wrapper parent, webview node, and partition across placement and pane changes", () => {
      const bridge = new FakeBrowserViewBridge();
      const first = recordingActivate();
      startHost(bridge, first.activate);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));

      const created = guestNodes(REGISTRATION_A);
      expect(created.wrapper.parentNode).toBe(created.host);
      expect(created.webview.parentNode).toBe(created.wrapper);
      expect(created.webview.tagName).toBe("WEBVIEW");
      expect(created.webview.getAttribute("src")).toBe(
        `about:blank#${REGISTRATION_A}`,
      );
      expect(created.webview.getAttribute("partition")).toBe(PARTITION_A);
      expect(created.webview.style.display).toBe("flex");
      expect(created.wrapper.getAttribute("data-browser-guest-state")).toBe(
        "unbound",
      );

      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });
      const presented = guestNodes(REGISTRATION_A);
      expect(presented.wrapper).toBe(created.wrapper);
      expect(presented.webview).toBe(created.webview);
      expect(presented.wrapper.parentNode).toBe(created.host);
      expect(presented.webview.parentNode).toBe(created.wrapper);
      expect(presented.wrapper.style.getPropertyValue("position-anchor")).toBe(
        ANCHOR_A,
      );

      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-2",
        presented: true,
      });
      const moved = guestNodes(REGISTRATION_A);
      expect(moved.wrapper).toBe(created.wrapper);
      expect(moved.webview).toBe(created.webview);
      expect(moved.wrapper.parentNode).toBe(created.host);
      expect(moved.webview.parentNode).toBe(created.wrapper);
      expect(moved.webview.getAttribute("partition")).toBe(PARTITION_A);
      expect(moved.wrapper.style.getPropertyValue("position-anchor")).toBe(
        ANCHOR_A,
      );
      expect(moved.wrapper.getAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE)).toBe(
        "pane-2",
      );

      dispatchPointerDown(moved.wrapper);
      expect(first.focuses).toEqual([]);
      expect(first.pointerDowns).toHaveLength(1);
      expect(first.pointerDowns[0]?.viewTabId).toBe("view-1");
      expect(first.pointerDowns[0]?.paneId).toBe("pane-2");

      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-2",
        presented: false,
      });
      const retained = guestNodes(REGISTRATION_A);
      expect(retained.wrapper).toBe(created.wrapper);
      expect(retained.webview).toBe(created.webview);
      expect(retained.wrapper.parentNode).toBe(created.host);
    });

    it("applies a placement that arrived before the matching mount without recreating later", () => {
      const bridge = new FakeBrowserViewBridge();
      startHost(bridge, NOOP_ACTIVATE);
      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });
      expect(queryWrapper(REGISTRATION_A)).toBeNull();

      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const first = guestNodes(REGISTRATION_A);
      expect(first.wrapper.getAttribute("data-browser-guest-state")).toBe(
        "presented",
      );

      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });
      const again = guestNodes(REGISTRATION_A);
      expect(again.wrapper).toBe(first.wrapper);
      expect(again.webview).toBe(first.webview);
    });
  });

  describe("mount and release incarnation", () => {
    it("treats a duplicate mount of the same registrationId as a no-op", () => {
      const bridge = new FakeBrowserViewBridge();
      startHost(bridge, NOOP_ACTIVATE);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const first = guestNodes(REGISTRATION_A);

      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_B));
      const again = guestNodes(REGISTRATION_A);
      expect(again.wrapper).toBe(first.wrapper);
      expect(again.webview).toBe(first.webview);
      expect(again.webview.getAttribute("partition")).toBe(PARTITION_A);
      expect(first.host.querySelectorAll("webview")).toHaveLength(1);
    });

    it("releases only the matching registration and ignores a stale unknown id", () => {
      const bridge = new FakeBrowserViewBridge();
      startHost(bridge, NOOP_ACTIVATE);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_B, PARTITION_B));
      const guestA = guestNodes(REGISTRATION_A);
      const guestB = guestNodes(REGISTRATION_B);

      bridge.emitGuestReleaseRequested({ registrationId: "unknown-reg" });
      expect(queryWrapper(REGISTRATION_A)).toBe(guestA.wrapper);
      expect(queryWrapper(REGISTRATION_B)).toBe(guestB.wrapper);
      expect(guestA.webview.parentNode).toBe(guestA.wrapper);
      expect(guestB.webview.parentNode).toBe(guestB.wrapper);

      bridge.emitGuestReleaseRequested({ registrationId: REGISTRATION_A });
      expect(queryWrapper(REGISTRATION_A)).toBeNull();
      const remaining = guestNodes(REGISTRATION_B);
      expect(remaining.wrapper).toBe(guestB.wrapper);
      expect(remaining.webview).toBe(guestB.webview);
      expect(remaining.webview.getAttribute("partition")).toBe(PARTITION_B);

      bridge.emitGuestReleaseRequested({ registrationId: REGISTRATION_A });
      expect(queryWrapper(REGISTRATION_A)).toBeNull();
      expect(queryWrapper(REGISTRATION_B)).toBe(guestB.wrapper);
    });

    it("blurs a focused presented guest through presentation-loss on matching release", () => {
      const bridge = new FakeBrowserViewBridge();
      startHost(bridge, NOOP_ACTIVATE);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const { webview } = guestNodes(REGISTRATION_A);
      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });

      webview.tabIndex = 0;
      webview.focus();
      expect(document.activeElement).toBe(webview);

      let usedPresentationLoss = false;
      webview.addEventListener("blur", () => {
        usedPresentationLoss = isPresentationLossBlur();
      });

      bridge.emitGuestReleaseRequested({ registrationId: REGISTRATION_A });
      expect(queryWrapper(REGISTRATION_A)).toBeNull();
      expect(document.activeElement).not.toBe(webview);
      expect(usedPresentationLoss).toBe(true);
    });

    it("keeps a live placement across stop and start so remount is presented", () => {
      const bridge = new FakeBrowserViewBridge();
      const stop = startHost(bridge, NOOP_ACTIVATE);
      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const first = guestNodes(REGISTRATION_A);
      expect(first.wrapper.getAttribute("data-browser-guest-state")).toBe(
        "presented",
      );

      stop();
      expect(queryHost()).toBeNull();
      expect(queryWrapper(REGISTRATION_A)).toBeNull();

      startHost(bridge, NOOP_ACTIVATE);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const remounted = guestNodes(REGISTRATION_A);
      expect(remounted.wrapper).not.toBe(first.wrapper);
      expect(remounted.wrapper.getAttribute("data-browser-guest-state")).toBe(
        "presented",
      );
    });

    it("ignores a superseded host's disposer", () => {
      const bridge = new FakeBrowserViewBridge();
      const stale = startHost(bridge, NOOP_ACTIVATE);
      // The superseded host element is unreachable once replaced; drop it so
      // `queryHost` names exactly the live one.
      queryHost()?.remove();
      startHost(bridge, NOOP_ACTIVATE);
      const live = queryHost();

      stale();

      expect(queryHost()).toBe(live);
    });
  });

  describe("presentation states", () => {
    it("maps presented, retained, and unbound onto visibility and interactivity", () => {
      const bridge = new FakeBrowserViewBridge();
      startHost(bridge, NOOP_ACTIVATE);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const { wrapper } = guestNodes(REGISTRATION_A);

      expect(wrapper.getAttribute("data-browser-guest-state")).toBe("unbound");
      expect(wrapper.style.position).toBe("fixed");
      expect(wrapper.style.insetInlineStart).toBe("-10000px");
      expect(wrapper.style.width).toBe("1280px");
      expect(wrapper.style.height).toBe("800px");
      expect(wrapper.style.opacity).toBe("0");
      expect(wrapper.style.pointerEvents).toBe("none");
      expect(wrapper.style.display).toBe("block");
      expect(wrapper.inert).toBe(true);
      expect(wrapper.getAttribute("aria-hidden")).toBe("true");
      expect(wrapper.hasAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE)).toBe(
        false,
      );

      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });
      expect(wrapper.getAttribute("data-browser-guest-state")).toBe(
        "presented",
      );
      expect(wrapper.style.position).toBe("fixed");
      expect(wrapper.style.getPropertyValue("position-anchor")).toBe(ANCHOR_A);
      expect(wrapper.style.opacity).toBe("1");
      expect(wrapper.style.pointerEvents).toBe("auto");
      expect(wrapper.style.display).toBe("block");
      expect(wrapper.inert).toBe(false);
      expect(wrapper.hasAttribute("aria-hidden")).toBe(false);
      expect(wrapper.getAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE)).toBe(
        INSTANCE_A,
      );
      expect(wrapper.getAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE)).toBe(
        "pane-1",
      );
      expect(wrapper.getAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE)).toBe(
        "view-1",
      );

      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: false,
      });
      expect(wrapper.getAttribute("data-browser-guest-state")).toBe("retained");
      // Retained keeps the unbound offscreen posture: a `display: none` guest
      // stops compositing, and CDP/PiP frames go blank with it.
      expect(wrapper.style.display).toBe("block");
      expect(wrapper.style.position).toBe("fixed");
      expect(wrapper.style.insetInlineStart).toBe("-10000px");
      expect(wrapper.style.pointerEvents).toBe("none");
      expect(wrapper.style.opacity).toBe("0");
      expect(wrapper.style.getPropertyValue("position-anchor")).toBe("");
      expect(wrapper.inert).toBe(true);
      expect(wrapper.getAttribute("aria-hidden")).toBe("true");
      expect(wrapper.hasAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE)).toBe(
        false,
      );

      clearBrowserGuestTilePlacement(Symbol("other-owner"), REGISTRATION_A);
      expect(wrapper.getAttribute("data-browser-guest-state")).toBe("retained");

      clearBrowserGuestTilePlacement(owner, REGISTRATION_A);
      expect(wrapper.getAttribute("data-browser-guest-state")).toBe("unbound");
      expect(wrapper.style.position).toBe("fixed");
      expect(wrapper.style.insetInlineStart).toBe("-10000px");
      expect(wrapper.style.width).toBe("1280px");
      expect(wrapper.style.height).toBe("800px");
      expect(wrapper.inert).toBe(true);
      expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    });

    it("blurs an active guest through presentation-loss before leaving presented", () => {
      const bridge = new FakeBrowserViewBridge();
      startHost(bridge, NOOP_ACTIVATE);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const { wrapper, webview } = guestNodes(REGISTRATION_A);
      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });

      webview.tabIndex = 0;
      webview.focus();
      expect(document.activeElement).toBe(webview);

      let usedPresentationLoss = false;
      webview.addEventListener("blur", () => {
        usedPresentationLoss = isPresentationLossBlur();
      });

      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: false,
      });
      expect(document.activeElement).not.toBe(webview);
      expect(wrapper.contains(document.activeElement)).toBe(false);
      expect(usedPresentationLoss).toBe(true);
      expect(wrapper.getAttribute("data-browser-guest-state")).toBe("retained");
    });
  });

  describe("pane activation", () => {
    it("routes pointerdown only to pointerDown and capture-phase focus only to focus while presented", () => {
      const bridge = new FakeBrowserViewBridge();
      const recorded = recordingActivate();
      startHost(bridge, recorded.activate);
      bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
      const { wrapper, webview } = guestNodes(REGISTRATION_A);

      dispatchPointerDown(wrapper);
      dispatchFocus(webview);
      expect(recorded.pointerDowns).toEqual([]);
      expect(recorded.focuses).toEqual([]);

      const owner = Symbol("tile");
      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: false,
      });
      dispatchPointerDown(wrapper);
      dispatchFocus(webview);
      expect(recorded.pointerDowns).toEqual([]);
      expect(recorded.focuses).toEqual([]);

      setOwnedPlacement(owner, {
        registrationId: REGISTRATION_A,
        instanceId: INSTANCE_A,
        viewTabId: "view-1",
        paneId: "pane-1",
        presented: true,
      });
      dispatchPointerDown(wrapper);
      expect(recorded.pointerDowns).toHaveLength(1);
      expect(recorded.focuses).toEqual([]);
      expect(recorded.pointerDowns[0]?.viewTabId).toBe("view-1");
      expect(recorded.pointerDowns[0]?.paneId).toBe("pane-1");
      expect(recorded.pointerDowns[0]?.event.scope).toBe(wrapper);
      expect(recorded.pointerDowns[0]?.event.target).toBe(wrapper);

      dispatchFocus(webview);
      expect(recorded.pointerDowns).toHaveLength(1);
      expect(recorded.focuses).toHaveLength(1);
      expect(recorded.focuses[0]?.viewTabId).toBe("view-1");
      expect(recorded.focuses[0]?.paneId).toBe("pane-1");
      expect(recorded.focuses[0]?.event.scope).toBe(wrapper);
      expect(recorded.focuses[0]?.event.target).toBe(webview);
    });
  });
});
