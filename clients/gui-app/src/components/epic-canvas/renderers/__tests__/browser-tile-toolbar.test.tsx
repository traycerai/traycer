import "../../../../../__tests__/test-browser-apis";
import type { ReactNode, SyntheticEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import {
  PRIMARY_TILE_CHROME_CAPABILITIES,
  type TileChromeCapabilities,
  type TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BrowserPersistenceController } from "@/lib/browser-view/use-browser-persistence-state";
import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";

const openExternalLink = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => openExternalLink,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({}),
}));

// The `os-backed` shield links to Settings, and a bare <Link> needs a router.
// The link is not what these tests are about; its presence is.
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { readonly children: ReactNode; readonly to: string }) => (
    <a href={props.to}>{props.children}</a>
  ),
}));

const forgetAllBrowserLogins = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  forgetAllBrowserLogins,
}));

const REAL_COOKIE_STATE: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
};

const ENABLED_PERSISTENCE: BrowserPersistenceController = {
  state: {
    decision: { kind: "enabled", decidedAt: 0 },
    cryptoState: REAL_COOKIE_STATE,
    promptsOnEnable: false,
    appName: "Traycer",
    platform: "darwin",
  },
  pending: false,
  enable: () => undefined,
  decline: () => undefined,
  relaunch: () => undefined,
};

const ANNOTATION: BrowserAnnotationSessionController = {
  isActive: false,
  canStart: true,
  zoomLocked: false,
  toggle: () => undefined,
};

const DISABLED_CAPABILITIES: TileChromeCapabilities = {
  navigate: false,
  back: false,
  forward: false,
  reload: false,
  zoom: false,
  viewportPreset: false,
  devtools: false,
  find: false,
  siteInfo: false,
  annotate: false,
};

function preventNavigate(
  event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
): void {
  event.preventDefault();
}

function makeController(
  capabilities: TileChromeCapabilities,
  annotation: BrowserAnnotationSessionController | null,
): TileController {
  return {
    capabilities,
    profile: "primary",
    url: "https://example.com",
    addressValue: "https://example.com",
    canGoBack: true,
    canGoForward: true,
    zoomPercent: 100,
    viewportPreset: "responsive",
    disabled: false,
    persistence: ENABLED_PERSISTENCE,
    zoomLocked: annotation?.zoomLocked === true,
    annotation,
    onNavigate: preventNavigate,
    onAddressChange: () => undefined,
    onAddressFocusChange: () => undefined,
    onBack: () => undefined,
    onForward: () => undefined,
    onReload: () => undefined,
    onZoomOut: () => undefined,
    onZoomIn: () => undefined,
    onResetZoom: () => undefined,
    onViewportPresetChange: () => undefined,
    onOpenDevTools: () => undefined,
    onClearSite: () => undefined,
  };
}

function renderToolbar(
  capabilities: TileChromeCapabilities,
  annotation: BrowserAnnotationSessionController | null,
): void {
  render(
    <TooltipProvider>
      <BrowserTileToolbar
        controller={makeController(capabilities, annotation)}
        pictureInPicture={null}
      />
    </TooltipProvider>,
  );
}

const CHROME_QUERIES: ReadonlyArray<{
  readonly name: string;
  readonly role: "button" | "textbox";
}> = [
  { name: "Back", role: "button" },
  { name: "Forward", role: "button" },
  { name: "Reload", role: "button" },
  { name: "Browser address", role: "textbox" },
  { name: "Open in default browser", role: "button" },
  { name: "Annotate page", role: "button" },
];

const ADVANCED_MENU_ITEMS = [
  /^Site information/,
  /^Zoom out/,
  /^Reset zoom/,
  /^Zoom in/,
  /^Viewport/,
  "Open browser DevTools",
] as const;

function openMoreMenu(): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "More browser controls" }),
    { button: 0 },
  );
}

function queryChrome(query: {
  readonly name: string;
  readonly role: "button" | "textbox";
}): HTMLElement | null {
  return screen.queryByRole(query.role, { name: query.name });
}

describe("<BrowserTileToolbar /> capability gating", () => {
  afterEach(() => {
    cleanup();
    openExternalLink.mutate.mockClear();
    forgetAllBrowserLogins.mockClear();
  });

  it("renders every chrome control when all capabilities are true", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    for (const query of CHROME_QUERIES) {
      expect(queryChrome(query)).not.toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "More browser controls" }),
    ).not.toBeNull();
    for (const name of ADVANCED_MENU_ITEMS) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }

    openMoreMenu();
    expect(
      screen.getByRole("group", {
        name: "Zoom controls, current zoom 100%",
      }),
    ).not.toBeNull();
    for (const name of ADVANCED_MENU_ITEMS) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeNull();
    }
    expect(screen.getByRole("menuitem", { name: "Zoom out" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reset zoom" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Zoom in" })).not.toBeNull();
  });

  it("sends forgetLogins from the shield only after the destructive confirm", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Saved logins: Logins saved securely",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Forget all browser logins…" }),
    );
    // Nothing is shredded by opening the dialog: the frame goes out on confirm
    // and nowhere else.
    expect(forgetAllBrowserLogins).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(forgetAllBrowserLogins).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to forget where this machine saves no logins", () => {
    const controller: TileController = {
      ...makeController(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION),
      persistence: {
        ...ENABLED_PERSISTENCE,
        state: {
          decision: { kind: "undecided" },
          // Exactly what `resolveBrowserCookieCryptoStateFromInputs` yields
          // when nothing was ever asked of the OS keystore.
          cryptoState: {
            mode: "degraded",
            persistence: "ephemeral",
            reason: "not-enabled",
            storageBackend: null,
            encryptionAvailable: false,
          },
          promptsOnEnable: true,
          appName: "Traycer",
          platform: "darwin",
        },
      },
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar controller={controller} pictureInPicture={null} />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Saved logins: Logins aren't saved yet",
      }),
    );

    expect(
      screen.queryByRole("button", { name: "Forget all browser logins…" }),
    ).toBeNull();
  });

  it("shows a private-session shield with no action for an isolated session", () => {
    const controller: TileController = {
      ...makeController(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION),
      profile: "isolated",
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar controller={controller} pictureInPicture={null} />
      </TooltipProvider>,
    );

    const shield = screen.getByRole("button", {
      name: "Saved logins: Private session",
    });
    // The persistence shield must not also be there: an isolated tile has no
    // saved-login state to report.
    expect(
      screen.queryByRole("button", {
        name: "Saved logins: Logins saved securely",
      }),
    ).toBeNull();

    fireEvent.click(shield);

    expect(screen.getByText("Private session")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Enable saved logins" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restart Traycer" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /Settings/ })).toBeNull();
  });

  it("describes the private jar in site information instead of saved logins", () => {
    const controller: TileController = {
      ...makeController({ ...DISABLED_CAPABILITIES, siteInfo: true }, null),
      profile: "isolated",
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar controller={controller} pictureInPicture={null} />
      </TooltipProvider>,
    );

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /^Site information/ }),
    );

    expect(screen.getAllByText("Private session").length).toBeGreaterThan(0);
    expect(screen.queryByText("Logins saved securely")).toBeNull();
  });

  it("renders no chrome when every capability is false", () => {
    renderToolbar(DISABLED_CAPABILITIES, ANNOTATION);

    for (const query of CHROME_QUERIES) {
      expect(queryChrome(query)).toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "More browser controls" }),
    ).toBeNull();
  });

  it("opens the current page in the default browser", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    fireEvent.click(
      screen.getByRole("button", { name: "Open in default browser" }),
    );

    expect(openExternalLink.mutate).toHaveBeenCalledExactlyOnceWith(
      "https://example.com",
    );
  });

  it("renders the explicit picture-in-picture conversion action", () => {
    const convert = vi.fn();
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={makeController(DISABLED_CAPABILITIES, null)}
          pictureInPicture={{ disabled: false, convert }}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Convert to picture-in-picture" }),
    );
    expect(convert).toHaveBeenCalledOnce();
  });

  it("keeps viewport presets open for quick switching", () => {
    const onViewportPresetChange = vi.fn();
    const controller = {
      ...makeController(
        { ...DISABLED_CAPABILITIES, viewportPreset: true },
        null,
      ),
      onViewportPresetChange,
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar controller={controller} pictureInPicture={null} />
      </TooltipProvider>,
    );

    openMoreMenu();
    expect(screen.queryByRole("menuitemradio", { name: /^Mobile/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Viewport/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Mobile/ }));
    expect(onViewportPresetChange).toHaveBeenCalledWith("mobile");
    expect(screen.getByRole("menuitem", { name: /^Viewport/ })).not.toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: /^Mobile/ }),
    ).not.toBeNull();
  });

  it("progressively discloses site information from the More menu", () => {
    renderToolbar({ ...DISABLED_CAPABILITIES, siteInfo: true }, null);

    expect(screen.queryByText("Web page")).toBeNull();
    openMoreMenu();
    expect(
      screen.getByRole("menuitem", {
        name: /Served over the network from this page's origin/,
      }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /^Site information/ }),
    );

    expect(
      screen.getByText("Served over the network from this page's origin."),
    ).not.toBeNull();
  });

  it.each([
    { flag: "back" as const, name: "Back", role: "button" as const },
    { flag: "forward" as const, name: "Forward", role: "button" as const },
    { flag: "reload" as const, name: "Reload", role: "button" as const },
    {
      flag: "navigate" as const,
      name: "Browser address",
      role: "textbox" as const,
    },
    {
      flag: "annotate" as const,
      name: "Annotate page",
      role: "button" as const,
    },
  ])("omits $name when $flag is false", ({ flag, name, role }) => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, [flag]: false },
      ANNOTATION,
    );

    expect(screen.queryByRole(role, { name })).toBeNull();
  });

  it.each([
    { flag: "zoom" as const, names: [/^Zoom/] },
    { flag: "viewportPreset" as const, names: [/^Viewport/] },
    { flag: "devtools" as const, names: ["Open browser DevTools"] },
    { flag: "siteInfo" as const, names: [/^Site information/] },
  ])("hides advanced controls when $flag is false", ({ flag, names }) => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, [flag]: false },
      ANNOTATION,
    );

    openMoreMenu();
    for (const name of names) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
  });
});

describe("<BrowserTileToolbar /> clear cookies for this site", () => {
  afterEach(cleanup);

  function renderWith(controller: TileController): void {
    render(
      <TooltipProvider>
        <BrowserTileToolbar controller={controller} pictureInPicture={null} />
      </TooltipProvider>,
    );
  }

  const MENU_CAPABILITIES: TileChromeCapabilities = {
    ...DISABLED_CAPABILITIES,
    siteInfo: true,
  };

  it("names the tile's registrable domain, not its host", () => {
    renderWith({
      ...makeController(MENU_CAPABILITIES, null),
      url: "https://app.example.com/inbox",
    });

    openMoreMenu();
    const item = screen.getByRole("menuitem", {
      name: "Clear cookies for example.com",
    });
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("hides the action on a private session - its jar dies with the session", () => {
    renderWith({
      ...makeController(MENU_CAPABILITIES, null),
      profile: "isolated",
    });

    openMoreMenu();
    expect(
      screen.queryByRole("menuitem", { name: /^Clear cookies/ }),
    ).toBeNull();
  });

  it("hides the action where there is no local jar to clear", () => {
    renderWith({
      ...makeController(MENU_CAPABILITIES, null),
      onClearSite: null,
    });

    openMoreMenu();
    expect(
      screen.queryByRole("menuitem", { name: /^Clear cookies/ }),
    ).toBeNull();
  });

  it("disables the action on a non-http(s) tile, which names no site", () => {
    renderWith({
      ...makeController(MENU_CAPABILITIES, null),
      url: "about:blank",
    });

    openMoreMenu();
    const item = screen.getByRole("menuitem", {
      name: "Clear cookies for this site",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("confirms before clearing, and only then runs it", () => {
    const onClearSite = vi.fn();
    renderWith({
      ...makeController(MENU_CAPABILITIES, null),
      url: "https://app.example.com/inbox",
      onClearSite,
    });

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Clear cookies for example.com" }),
    );
    expect(onClearSite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(onClearSite).toHaveBeenCalledOnce();
  });

  it("does not clear when the confirm is cancelled", () => {
    const onClearSite = vi.fn();
    renderWith({
      ...makeController(MENU_CAPABILITIES, null),
      url: "https://app.example.com/inbox",
      onClearSite,
    });

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Clear cookies for example.com" }),
    );
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(onClearSite).not.toHaveBeenCalled();
  });
});
