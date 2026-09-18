import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTurnMinimapView } from "@/components/chat/chat-turn-minimap";
import { shouldRunChatTurnMinimapRail } from "@/components/chat/chat-turn-minimap-logic";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { SampleWorkspaceBody } from "@/components/sample-workspace/sample-workspace-body";
import {
  SAMPLE_MINIMAP_ITEMS,
  SAMPLE_TILE_ID,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

const MINIMAP_KEY = `chat.minimapSide@shell:${SAMPLE_TILE_ID}`;
const COARSE_REASON = "Minimap is unavailable with a coarse pointer";

/** A switchable `(pointer: coarse)`; every other query is "no match". */
const pointer = {
  coarse: false,
  listeners: new Set<() => void>(),
};
const realMatchMedia = window.matchMedia;

function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      ...realMatchMedia(query),
      get matches() {
        return query.includes("pointer: coarse") ? pointer.coarse : false;
      },
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === "function")
          pointer.listeners.add(() => listener(new Event("change")));
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
}

function setCoarse(next: boolean): void {
  pointer.coarse = next;
  act(() => {
    for (const notify of pointer.listeners) notify();
  });
}

function instance() {
  return useCustomizeStore.getState().instances.get(MINIMAP_KEY) ?? null;
}

function proxy(): Element | null {
  return document.querySelector(`[data-customize-proxy="${MINIMAP_KEY}"]`);
}

function renderBody() {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={new QueryClient()}>
        <LazyMotion features={domAnimation}>
          <TooltipProvider>
            <SampleSceneProvider>
              <SampleWorkspaceBody />
            </SampleSceneProvider>
            <CustomizeOverlay />
          </TooltipProvider>
        </LazyMotion>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

beforeEach(() => {
  pointer.coarse = false;
  pointer.listeners.clear();
  installMatchMedia();
  localStorage.clear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(20, 20, 40, 24),
  );
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => {
    const measured = new DOMRect(20, 20, 40, 24);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  });
  useThemeLibraryStore.setState({ panelAnimations: false });
  useSettingsStore.setState({
    chatTurnMinimapSide: "right",
    visualLayoutEditorEnabled: true,
  });
  useCustomizeStore.setState({
    session: {
      scene: "sample",
      opener: { kind: "none" },
      startedAt: Date.now(),
      pointerEntry: false,
    },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    preferredTileId: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
});

afterEach(() => {
  act(() => {
    useCustomizeStore.setState({ session: null, instances: new Map() });
  });
  cleanup();
  document.body.innerHTML = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: realMatchMedia,
  });
  vi.restoreAllMocks();
});

describe("S4 - fine pointer (control: ordinary behaviour unchanged)", () => {
  it("draws the minimap and registers it as a real, non-ghost hotspot", async () => {
    renderBody();

    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
    expect(instance()).toMatchObject({ ghost: false, condition: null });
    await waitFor(() => expect(proxy()).not.toBeNull());
  });
});

describe("S4 - coarse pointer at desktop width", () => {
  beforeEach(() => {
    pointer.coarse = true;
  });

  it("draws no minimap, and registers a ghost anchor with the coarse-pointer reason", async () => {
    renderBody();

    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    expect(instance()).toMatchObject({ ghost: true, condition: COARSE_REASON });
    // The anchor has content the editor can point at and users can read.
    expect(instance()?.node.textContent).toContain(COARSE_REASON);
    expect(instance()?.node.isConnected).toBe(true);
    await waitFor(() => expect(proxy()).not.toBeNull());
  });

  it.each(["left", "right"] as const)(
    "selecting %s keeps the target (it does NOT vanish again)",
    async (side) => {
      renderBody();

      act(() => {
        useSettingsStore.setState({ chatTurnMinimapSide: side });
      });

      expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
      expect(instance()).toMatchObject({
        ghost: true,
        condition: COARSE_REASON,
      });
      await waitFor(() => expect(proxy()).not.toBeNull());
    },
  );

  it("hide still reads as Hidden and stays a ghost", () => {
    useSettingsStore.setState({ chatTurnMinimapSide: "hide" });
    renderBody();

    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    expect(instance()).toMatchObject({ ghost: true, condition: "Hidden" });
  });

  it("follows a live pointer change both ways", async () => {
    renderBody();
    expect(instance()).toMatchObject({ ghost: true, condition: COARSE_REASON });

    setCoarse(false);
    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
    expect(instance()).toMatchObject({ ghost: false, condition: null });
    await waitFor(() => expect(proxy()).not.toBeNull());

    setCoarse(true);
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    expect(instance()).toMatchObject({ ghost: true, condition: COARSE_REASON });
  });
});

describe("S4 - the live chat's minimap is unchanged", () => {
  it("the drawing leaf itself never gates on pointer type (its container CSS does)", () => {
    pointer.coarse = true;
    render(
      <ChatTurnMinimapView
        items={SAMPLE_MINIMAP_ITEMS}
        currentIndex={0}
        cursorIndex={0}
        maxVisibleItems={5}
        bottomInset={0}
        hitStripWidth={24}
        side="right"
        open={false}
        ref={null}
        hitStripRef={null}
        onOpen={() => undefined}
        onFocus={() => undefined}
        onKeyDown={() => undefined}
        onCursorIndexChange={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-turn-minimap")).not.toBeNull();
  });

  it.each([
    {
      side: "right",
      coarsePointer: false,
      mobileViewport: false,
      expected: true,
    },
    {
      side: "left",
      coarsePointer: false,
      mobileViewport: false,
      expected: true,
    },
    {
      side: "hide",
      coarsePointer: false,
      mobileViewport: false,
      expected: false,
    },
    {
      side: "right",
      coarsePointer: true,
      mobileViewport: false,
      expected: false,
    },
    {
      side: "right",
      coarsePointer: false,
      mobileViewport: true,
      expected: false,
    },
    {
      side: "left",
      coarsePointer: true,
      mobileViewport: true,
      expected: false,
    },
  ] as const)(
    "shouldRunChatTurnMinimapRail($side, coarse=$coarsePointer, mobile=$mobileViewport) is $expected",
    ({ side, coarsePointer, mobileViewport, expected }) => {
      expect(
        shouldRunChatTurnMinimapRail({ side, coarsePointer, mobileViewport }),
      ).toBe(expected);
    },
  );
});
