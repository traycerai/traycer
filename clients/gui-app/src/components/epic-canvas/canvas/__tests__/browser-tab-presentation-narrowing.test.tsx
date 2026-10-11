/**
 * Pins `useBrowserTabPresentation`'s narrowed selector/equality (only
 * `isolated`/`tabId`/`title`/`url`/`status` are compared, not `viewports` or
 * other tab fields) and the settle-gate fix (`browserTabDisplayEqual` instead
 * of reference equality, which previously infinite-looped on a real change).
 */
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const harness = await vi.hoisted(async () => {
  const { createStore } = await import("zustand/vanilla");
  const store = createStore<BrowserSessionsState>(() => ({
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items: [],
    viewports: {},
    setViewport: () => Promise.reject(new Error("not used")),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used")),
    prepareOpenTab: () => {
      throw new Error("not used");
    },
    closeTab: () => Promise.resolve(),
    attachTab: () => Promise.reject(new Error("not used")),
    moveTab: () => Promise.reject(new Error("not used")),
  }));
  return { store };
});

vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  useBrowserSessionsSelectorForHost: <T,>(
    _args: unknown,
    selector: (state: BrowserSessionsState) => T,
    equality: (a: T, b: T) => boolean,
  ): T =>
    useStoreWithEqualityFn(harness.store, (state) => selector(state), equality),
}));

import { useBrowserTabPresentation } from "@/components/epic-canvas/canvas/browser-tab-presentation";

const TAB: EpicCanvasTileRef = {
  id: "browser-session:sess-1:tab-1",
  instanceId: "inst-1",
  type: "browser-session",
  name: "Browser",
  hostId: "host-1",
  sessionId: "sess-1",
  tabId: "tab-1",
  viewportPreset: "responsive",
};

const renders = { count: 0 };
const onRenderProbe: ProfilerOnRenderCallback = () => {
  renders.count += 1;
};

function Probe(): ReactNode {
  const presentation = useBrowserTabPresentation(TAB, "epic-1");
  return (
    <span data-testid="presentation">
      {presentation === null
        ? "none"
        : `${presentation.title}|${presentation.url}|${String(presentation.isolated)}`}
    </span>
  );
}

function setItems(input: {
  readonly tab: Partial<BrowserTabInfo> & Pick<BrowserTabInfo, "tabId" | "url">;
  readonly profile?: "primary" | "isolated";
}): void {
  act(() => {
    harness.store.setState({
      items: [
        sessionInfo({
          sessionId: "sess-1",
          hostId: "host-1",
          profile: input.profile ?? "primary",
          tabs: [tabInfo(input.tab)],
        }),
      ],
    });
  });
}

function presentationText(): string {
  return screen.getByTestId("presentation").textContent;
}

afterEach(() => {
  cleanup();
  renders.count = 0;
  harness.store.setState({ items: [], viewports: {} });
});

describe("useBrowserTabPresentation render isolation", () => {
  it("ignores viewport and unrelated tab-field noise, and re-renders only on a compared field", () => {
    setItems({
      tab: {
        tabId: "tab-1",
        url: "https://shop.example/cart",
        title: "Cart",
        status: "ready",
        viewed: true,
      },
    });
    render(
      <Profiler id="probe" onRender={onRenderProbe}>
        <Probe />
      </Profiler>,
    );
    expect(presentationText()).toBe("Cart|https://shop.example/cart|false");
    const afterMount = renders.count;

    // Viewport noise: never touches `items`, must stay quiet.
    act(() => {
      harness.store.setState({
        viewports: {
          "tab-1": {
            sessionId: "sess-1",
            tabId: "tab-1",
            intent: { mode: "fit" },
            applied: null,
            revision: 1,
            source: "user",
            fitOwnerId: null,
          },
        },
      });
    });
    expect(renders.count).toBe(afterMount);

    // Uncompared tab fields (viewed, drivenBy) changing must also stay quiet.
    setItems({
      tab: {
        tabId: "tab-1",
        url: "https://shop.example/cart",
        title: "Cart",
        status: "ready",
        viewed: false,
        drivenBy: [
          { chatId: "chat-1", agentRunId: "run-1", requestId: "req-1" },
        ],
      },
    });
    expect(renders.count).toBe(afterMount);
    expect(presentationText()).toBe("Cart|https://shop.example/cart|false");

    // `isolated` is a compared field and must re-render.
    setItems({
      tab: {
        tabId: "tab-1",
        url: "https://shop.example/cart",
        title: "Cart",
        status: "ready",
      },
      profile: "isolated",
    });
    expect(renders.count).toBeGreaterThan(afterMount);
    expect(presentationText()).toBe("Cart|https://shop.example/cart|true");
    const afterIsolatedFlip = renders.count;

    // A real navigation re-renders, but the settled title carries over
    // through the transient status (pre-existing settle contract).
    setItems({
      tab: {
        tabId: "tab-1",
        url: "https://shop.example/cart/checkout",
        title: "Loading",
        status: "navigating",
      },
      profile: "isolated",
    });
    expect(renders.count).toBeGreaterThan(afterIsolatedFlip);
    expect(presentationText()).toBe("Cart|https://shop.example/cart|true");
  });
});
