import { act, cleanup, render } from "@testing-library/react";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { CanvasFrameEvents } from "../canvas-frame";
import { CanvasFrameEventsContext } from "../canvas-surface-context";
import { CanvasSelectionProvider } from "../canvas-selection-provider";
import { useCanvasSelectionStore } from "../canvas-selection-store";

// The editing overlay, the clipboard boundary, panels and annotation action are
// other tests' subjects, and the real ones need a query client and the host's
// edit transport. The overlay stand-in keeps the one thing the provider relies
// on: leaving the tree reports the board as retired, which is what the real
// overlay's effect cleanup does.
vi.mock("../canvas-editing-overlay", () => ({
  CanvasEditingOverlay: (props: {
    readonly boardPath: string;
    readonly onRetire: (path: string) => void;
  }) => {
    const { boardPath, onRetire } = props;
    useEffect(() => () => onRetire(boardPath), [boardPath, onRetire]);
    return null;
  },
}));
vi.mock("../canvas-clipboard-controls", () => ({
  CanvasClipboardBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("../canvas-editing-panel", () => ({
  CanvasEditingPanel: (props: { readonly children: ReactNode }) =>
    props.children,
  CanvasElementEditingPanel: () => null,
}));
vi.mock("../canvas-annotation-action", () => ({
  CanvasAnnotationAction: () => null,
  CanvasSelectionAction: () => null,
}));
vi.mock("../canvas-properties-panel", () => ({
  CanvasPropertiesPanel: () => null,
}));
vi.mock("../canvas-board-panel", () => ({ CanvasBoardPanel: () => null }));

const BOARD = "boards/home.html";
const SHA = "sha-1";

function scope(artifactId: string) {
  return {
    epicId: "epic-1",
    artifactId,
    artifactTitle: artifactId,
    hostId: "host-1",
    viewTabId: "tab-1",
  };
}

function element(selector: string): CanvasElement {
  return {
    marker: 1,
    tid: null,
    tagName: "div",
    selector,
    elementId: null,
    classNames: [],
    textPreview: "",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: [],
    generated: false,
  };
}

/** A real bridge; only the page's answer to a hit test is held open by the test. */
function bridge(): SandboxBridgeHost {
  return new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: "n",
      forwardedShortcuts: [],
    },
    hostContext: {
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      platform: "desktop",
    },
    hostVersion: "9.9.9",
    post: () => undefined,
    events: {
      onStatus: () => undefined,
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(true),
      onShortcut: () => undefined,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
    },
    appRequests: null,
  });
}

interface Deferred {
  readonly resolve: (value: CanvasElement | null) => void;
}

/** A provider mounted over a board whose hit test answers only when told to. */
interface MountedProvider {
  readonly events: () => CanvasFrameEvents;
  readonly pick: () => Deferred;
  readonly setOverlayShown: (shown: boolean) => void;
}

function mountProvider(artifactId: string): MountedProvider {
  let captured: CanvasFrameEvents | null = null;
  let showOverlay: (shown: boolean) => void = () => undefined;
  const host = bridge();
  const pending: Deferred[] = [];
  vi.spyOn(host, "hitTest").mockImplementation(
    () =>
      new Promise<CanvasElement | null>((resolve) => {
        pending.push({ resolve });
      }),
  );

  function Probe(): ReactNode {
    const events = useContext(CanvasFrameEventsContext);
    captured = events;
    const [shown, setShown] = useState(true);
    showOverlay = setShown;
    return shown ? (events?.renderOverlay?.(BOARD) ?? null) : null;
  }

  render(
    <CanvasSelectionProvider {...scope(artifactId)}>
      <Probe />
    </CanvasSelectionProvider>,
  );
  const events = (): CanvasFrameEvents => {
    if (captured === null) throw new Error("provider events not captured");
    return captured;
  };
  act(() => {
    events().onBridge(BOARD, host);
    events().onServedSource?.(BOARD, SHA);
  });
  return {
    events,
    pick: () => {
      const before = pending.length;
      act(() => {
        events().onEditPointer(BOARD, { x: 5, y: 5 });
      });
      const next = pending.at(before);
      if (next === undefined) throw new Error("the pick never asked the page");
      return next;
    },
    setOverlayShown: (shown) => act(() => showOverlay(shown)),
  };
}

async function answer(request: Deferred, value: CanvasElement | null) {
  await act(async () => {
    request.resolve(value);
    await Promise.resolve();
  });
}

function selectedSelector(): string | null {
  return useCanvasSelectionStore.getState().selection?.element.selector ?? null;
}

beforeEach(() => {
  useCanvasSelectionStore.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCanvasSelectionStore.getState().clear();
});

describe("CanvasSelectionProvider picks", () => {
  it("selects the element the page answers with", async () => {
    const provider = mountProvider("artifact-a");

    await answer(provider.pick(), element("div.a"));

    expect(selectedSelector()).toBe("div.a");
  });

  it("ignores a page's late answer once the board's overlay has left (switching to Hand or Play)", async () => {
    const provider = mountProvider("artifact-a");
    const request = provider.pick();

    provider.setOverlayShown(false);
    await answer(request, element("div.late"));

    expect(selectedSelector()).toBeNull();
  });

  it("drops the selection the overlay owned when it leaves", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));
    expect(selectedSelector()).toBe("div.a");

    provider.setOverlayShown(false);

    expect(selectedSelector()).toBeNull();
  });

  it("lets only the newest pick win when two providers compete, whichever answers last", async () => {
    const older = mountProvider("artifact-a");
    const newer = mountProvider("artifact-b");
    const olderRequest = older.pick();
    const newerRequest = newer.pick();

    await answer(newerRequest, element("div.newer"));
    await answer(olderRequest, element("div.older"));

    expect(selectedSelector()).toBe("div.newer");
    expect(useCanvasSelectionStore.getState().selection?.artifactId).toBe(
      "artifact-b",
    );
  });

  it("does not let an older provider's answer land before the newer one's either", async () => {
    const older = mountProvider("artifact-a");
    const newer = mountProvider("artifact-b");
    const olderRequest = older.pick();
    const newerRequest = newer.pick();

    await answer(olderRequest, element("div.older"));
    expect(selectedSelector()).toBeNull();
    await answer(newerRequest, element("div.newer"));

    expect(selectedSelector()).toBe("div.newer");
  });
});
