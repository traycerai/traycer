import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { LinkTargetContext } from "@/lib/links/link-target-context";
import { useOpenLink, type LinkClickEvent } from "@/lib/links/open-link";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isBrowserSessionTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";

const EPIC_ID = "epic-links";
const VIEW_TAB_ID = "view-tab-links";
const HOST_ID = "host-links";
const DOCS_URL = "https://example.test/docs";

interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

const toastError = vi.hoisted(() =>
  vi.fn<(message: string, options?: { action?: ToastAction }) => void>(),
);

const harness = vi.hoisted<{
  sessions: BrowserSessionsState | null;
  bridged: string[];
  intents: TileOpenIntent[];
}>(() => ({ sessions: null, bridged: [], intents: [] }));

vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useMaybeBrowserSessionsSnapshot: () => ({ current: harness.sessions }),
}));
vi.mock("@/lib/links/open-external-link", () => ({
  useOpenExternalLink: () => (url: string) => {
    harness.bridged.push(url);
    return Promise.resolve();
  },
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTile: (intent: TileOpenIntent) => {
      harness.intents.push(intent);
      return null;
    },
  }),
}));

function tab(overrides: Partial<BrowserTabInfo>): BrowserTabInfo {
  return {
    tabId: "tab-1",
    url: DOCS_URL,
    originTier: "external",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    ...overrides,
  };
}

function session(tabs: readonly BrowserTabInfo[]): BrowserSessionInfo {
  return {
    sessionId: "session-1",
    epicId: EPIC_ID,
    hostId: HOST_ID,
    profile: "primary",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 1 },
    tabs: [...tabs],
  };
}

const openTab = vi.fn<BrowserSessionsState["openTab"]>(() =>
  Promise.resolve({ sessionId: "session-opened", tabId: "tab-opened" }),
);

function liveSessions(
  items: readonly BrowserSessionInfo[],
): BrowserSessionsState {
  return {
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    items,
    errorMessage: null,
    retry: () => undefined,
    openTab,
    closeTab: () => Promise.resolve(),
  };
}

function click(overrides: Partial<LinkClickEvent>): LinkClickEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    button: 0,
    ...overrides,
  };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <LinkTargetContext value={{ epicId: EPIC_ID, viewTabId: VIEW_TAB_ID }}>
      {props.children}
    </LinkTargetContext>
  );
}

function renderOpenLink() {
  return renderHook(() => useOpenLink(), { wrapper }).result;
}

function openViewTab(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: EPIC_ID, name: "Links" },
    },
    openTabOrder: [VIEW_TAB_ID],
    activeTabId: VIEW_TAB_ID,
    canvasByTabId: {},
  });
}

beforeEach(() => {
  harness.sessions = liveSessions([]);
  harness.bridged = [];
  harness.intents = [];
  openViewTab();
  useSettingsStore.setState({
    linkOpen: {
      default: "in-app",
      markdown: "in-app",
      terminal: "in-app",
      github: "in-app",
      image: "in-app",
    },
    browserDevOrigins: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useOpenLink", () => {
  it("opens a configured in-app link as a browser tile", async () => {
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", null);

    await waitFor(() => expect(harness.intents).toHaveLength(1));
    expect(openTab).toHaveBeenCalledWith(null, DOCS_URL);
    const intent = harness.intents[0];
    expect(isBrowserSessionTileRef(intent.node)).toBe(true);
    expect(intent).toMatchObject({
      target: { tabId: VIEW_TAB_ID },
      gesture: "single",
      dedupe: true,
      placement: null,
    });
    expect(harness.bridged).toEqual([]);
  });

  it.each(["auth", "docs", "account", "app"] as const)(
    "sends a %s link straight out and never touches sessions",
    (kind) => {
      const { current: openLink } = renderOpenLink();

      void openLink(DOCS_URL, kind, null);

      expect(harness.bridged).toEqual([DOCS_URL]);
      expect(openTab).not.toHaveBeenCalled();
      expect(harness.intents).toEqual([]);
    },
  );

  it("sends a non-http(s) link out whatever the kind", () => {
    const { current: openLink } = renderOpenLink();

    void openLink("mailto:someone@example.test", "markdown", null);

    expect(harness.bridged).toEqual(["mailto:someone@example.test"]);
    expect(openTab).not.toHaveBeenCalled();
  });

  it.each([
    ["Command", click({ metaKey: true })],
    ["Control", click({ ctrlKey: true })],
  ])("%s-click forces external", (_name, event) => {
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", event);

    expect(harness.bridged).toEqual([DOCS_URL]);
    expect(openTab).not.toHaveBeenCalled();
  });

  it("inverts the configured mode on alt-click, both ways", async () => {
    useSettingsStore.setState({
      linkOpen: {
        default: "per-kind",
        markdown: "external",
        terminal: "in-app",
        github: "in-app",
        image: "in-app",
      },
    });
    const { current: openLink } = renderOpenLink();

    // Configured external + alt -> in-app.
    void openLink(DOCS_URL, "markdown", click({ altKey: true }));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(null, DOCS_URL));
    expect(harness.bridged).toEqual([]);

    // Configured in-app + alt -> external.
    void openLink(
      "https://example.test/terminal",
      "terminal",
      click({ altKey: true }),
    );
    expect(harness.bridged).toEqual(["https://example.test/terminal"]);
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("consumes alt at the link layer instead of passing it to placement", async () => {
    useSettingsStore.setState({
      linkOpen: {
        default: "per-kind",
        markdown: "external",
        terminal: "in-app",
        github: "in-app",
        image: "in-app",
      },
    });
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", click({ altKey: true }));

    await waitFor(() => expect(harness.intents).toHaveLength(1));
    // `alt` already inverted external -> in-app (A3); leaking it into the
    // intent would ALSO invert tab<->split in the resolver (C4).
    expect(harness.intents[0].modifiers).toEqual({
      shift: false,
      alt: false,
      middle: false,
    });
  });

  it("opens externally on a surface with no link target at all (A5a)", () => {
    const { result } = renderHook(() => useOpenLink());

    void result.current(DOCS_URL, "markdown", null);

    expect(harness.bridged).toEqual([DOCS_URL]);
    expect(openTab).not.toHaveBeenCalled();
    expect(harness.intents).toEqual([]);
    // Nothing was attempted, so nothing failed: this is not the A5 toast.
    expect(toastError).not.toHaveBeenCalled();
  });

  it("focuses a tab already showing the same page instead of opening one", async () => {
    harness.sessions = liveSessions([
      session([tab({ tabId: "tab-open", url: "https://example.test/docs/" })]),
    ]);
    const { current: openLink } = renderOpenLink();

    void openLink("https://example.test/docs#section", "markdown", null);

    await waitFor(() => expect(harness.intents).toHaveLength(1));
    expect(openTab).not.toHaveBeenCalled();
    expect(harness.intents[0].node).toMatchObject({
      type: "browser-session",
      hostId: HOST_ID,
      sessionId: "session-1",
      tabId: "tab-open",
    });
  });

  it("middle-click skips the match and opens a fresh background tab", async () => {
    harness.sessions = liveSessions([session([tab({ tabId: "tab-open" })])]);
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", click({ button: 1 }));

    await waitFor(() => expect(openTab).toHaveBeenCalledWith(null, DOCS_URL));
    expect(harness.intents[0].modifiers).toEqual({
      shift: false,
      alt: false,
      middle: true,
    });
  });

  it("records dev-server origins from terminal links only", () => {
    const { current: openLink } = renderOpenLink();

    void openLink("http://localhost:5173/ready", "terminal", null);
    void openLink("http://localhost:5173/again", "terminal", null);
    void openLink("http://localhost:5174/docs", "markdown", null);

    expect(useSettingsStore.getState().browserDevOrigins).toEqual([
      "http://localhost:5173",
    ]);
  });

  it("falls back to the epic when the view tab closed mid-open (R8)", async () => {
    const settles: Array<(tab: { sessionId: string; tabId: string }) => void> =
      [];
    openTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settles.push(resolve);
        }),
    );
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", null);
    await waitFor(() => expect(settles).toHaveLength(1));
    // The header tab goes away while the host is still opening the tab.
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
    });
    settles[0]({ sessionId: "session-opened", tabId: "tab-opened" });

    await waitFor(() => expect(harness.intents).toHaveLength(1));
    expect(harness.intents[0].target).toEqual({ epicId: EPIC_ID });
  });

  it("offers the OS browser on a refusal instead of taking it", async () => {
    openTab.mockImplementationOnce(() =>
      Promise.reject(new Error("no runtime")),
    );
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", null);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(harness.bridged).toEqual([]);
    const [message, options] = toastError.mock.calls[0];
    expect(message).toBe("no runtime");
    expect(options?.action?.label).toBe("Open in browser");
    // The user's own click is the only thing that may send the link outside.
    options?.action?.onClick();
    expect(harness.bridged).toEqual([DOCS_URL]);
  });

  it("offers the OS browser when no browser session is live", () => {
    harness.sessions = null;
    const { current: openLink } = renderOpenLink();

    void openLink(DOCS_URL, "markdown", null);

    expect(toastError).toHaveBeenCalled();
    expect(harness.bridged).toEqual([]);
    expect(harness.intents).toEqual([]);
  });
});
