import "../../../../../__tests__/test-browser-apis";
import type { SyntheticEvent } from "react";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import {
  PRIMARY_TILE_CHROME_CAPABILITIES,
  type TileChromeCapabilities,
  type TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { TooltipProvider } from "@/components/ui/tooltip";

const openLink = vi.hoisted(() => vi.fn());

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLink,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({}),
}));

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
  devtools: false,
  find: false,
  siteInfo: false,
  annotate: false,
  screenshot: false,
  recording: false,
  previewWindow: false,
  hardReload: false,
  appearance: false,
  clearCache: false,
  audio: false,
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
    viewport: null,
    capabilities,
    profile: "primary",
    url: "https://example.com",
    addressValue: "https://example.com",
    selectAddressOnFocus: false,
    setAddressInput: () => undefined,
    focusAddress: () => undefined,
    canGoBack: true,
    canGoForward: true,
    zoomPercent: 100,
    faviconUrl: null,
    colorSchemePreference: "system",
    muted: false,
    isRecording: false,
    disabled: false,
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
    onOpenDevTools: () => undefined,
    devtoolsUnavailableReason: null,
    onHardReload: () => undefined,
    onColorSchemePreferenceChange: () => undefined,
    onClearCache: () => undefined,
    onToggleMuted: () => undefined,
    onSaveScreenshot: null,
    onToggleRecording: null,
    onTogglePreviewWindow: () => undefined,
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
        loading={false}
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
    openLink.mockClear();
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

  it("shows a private-session shield with no action for an isolated session", () => {
    const controller: TileController = {
      ...makeController(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION),
      profile: "isolated",
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
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

    expect(openLink).toHaveBeenCalledExactlyOnceWith(
      "https://example.com",
      "app",
      null,
    );
  });

  it("renders the explicit picture-in-picture conversion action", () => {
    const convert = vi.fn();
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={makeController(DISABLED_CAPABILITIES, null)}
          pictureInPicture={{ disabled: false, convert }}
          loading={false}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Convert to picture-in-picture" }),
    );
    expect(convert).toHaveBeenCalledOnce();
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
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
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

describe("<BrowserTileToolbar /> address first-focus", () => {
  afterEach(cleanup);

  it("prevents the first mousedown default so a full-URL selection survives mouseup", () => {
    const controller: TileController = {
      ...makeController(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION),
      selectAddressOnFocus: true,
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );

    const input = screen.getByRole("textbox", { name: "Browser address" });
    expect(document.activeElement).not.toBe(input);

    const first = createEvent.mouseDown(input, { button: 0 });
    fireEvent(input, first);
    expect(first.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    const second = createEvent.mouseDown(input, { button: 0 });
    fireEvent(input, second);
    expect(second.defaultPrevented).toBe(false);
  });

  it("does not prevent the first mousedown when selectAddressOnFocus is false", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    expect(document.activeElement).not.toBe(input);

    const first = createEvent.mouseDown(input, { button: 0 });
    fireEvent(input, first);
    expect(first.defaultPrevented).toBe(false);
  });
});

describe("<BrowserTileToolbar /> reload loading", () => {
  afterEach(cleanup);

  it("moves the spinner into Reload while loading and restores it when idle", () => {
    const onReload = vi.fn();
    const controller: TileController = {
      ...makeController(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION),
      onReload,
    };
    const { rerender } = render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );

    const reload = (): HTMLElement =>
      screen.getByRole("button", { name: "Reload" });

    expect(reload()).toHaveProperty("disabled", false);
    expect(reload().getAttribute("aria-busy")).not.toBe("true");
    expect(screen.queryByTestId("browser-reload-loading")).toBeNull();

    rerender(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading
        />
      </TooltipProvider>,
    );

    expect(reload()).toHaveProperty("disabled", false);
    expect(reload().getAttribute("aria-busy")).toBe("true");
    const spinner = screen.getByTestId("browser-reload-loading");
    expect(reload().contains(spinner)).toBe(true);

    fireEvent.click(reload());
    expect(onReload).toHaveBeenCalledOnce();

    rerender(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(reload()).toHaveProperty("disabled", false);
    expect(reload().getAttribute("aria-busy")).not.toBe("true");
    expect(screen.queryByTestId("browser-reload-loading")).toBeNull();
  });
});

describe("<BrowserTileToolbar /> page controls", () => {
  afterEach(cleanup);

  function renderWith(controller: TileController): void {
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );
  }

  const ALL_CAPABILITIES: TileChromeCapabilities = {
    ...DISABLED_CAPABILITIES,
    devtools: true,
    hardReload: true,
    appearance: true,
    clearCache: true,
    audio: true,
  };

  it("offers a hard reload beside DevTools, under Developer", () => {
    const onHardReload = vi.fn();
    renderWith({ ...makeController(ALL_CAPABILITIES, null), onHardReload });

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Reload ignoring cached files" }),
    );
    expect(onHardReload).toHaveBeenCalledTimes(1);
  });

  it("clears cached files through its own action, not the cookie one", () => {
    const onClearCache = vi.fn();
    const onClearSite = vi.fn();
    renderWith({
      ...makeController(ALL_CAPABILITIES, null),
      onClearCache,
      onClearSite,
    });

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Clear cached files for this page" }),
    );
    expect(onClearCache).toHaveBeenCalledTimes(1);
    // A cache clear is not a sign-out and must never reach the jar's path.
    expect(onClearSite).not.toHaveBeenCalled();
  });

  it("reports the emulated scheme on the Appearance row and switches it", () => {
    const onColorSchemePreferenceChange = vi.fn();
    renderWith({
      ...makeController(ALL_CAPABILITIES, null),
      colorSchemePreference: "dark",
      onColorSchemePreferenceChange,
    });

    openMoreMenu();
    const trigger = screen.getByRole("menuitem", { name: /Appearance/ });
    expect(trigger.textContent).toContain("Dark");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(onColorSchemePreferenceChange).toHaveBeenCalledWith("light");
  });

  it("labels the audio row by what pressing it will do", () => {
    const onToggleMuted = vi.fn();
    renderWith({
      ...makeController(ALL_CAPABILITIES, null),
      muted: true,
      onToggleMuted,
    });

    openMoreMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unmute this page" }));
    expect(onToggleMuted).toHaveBeenCalledTimes(1);
  });

  it("renders none of these where the tile has no local guest behind them", () => {
    // `siteInfo` alone keeps the overflow menu on screen, so this asserts the
    // rows are absent rather than that the menu is.
    renderWith({
      ...makeController({ ...DISABLED_CAPABILITIES, siteInfo: true }, null),
    });

    openMoreMenu();
    expect(
      screen.queryByRole("menuitem", { name: "Reload ignoring cached files" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", {
        name: "Clear cached files for this page",
      }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Appearance/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /mute this page/i })).toBeNull();
    // The Developer heading exists only for the rows under it.
    expect(screen.queryByText("Developer")).toBeNull();
  });
});

describe("<BrowserTileToolbar /> page favicon", () => {
  afterEach(cleanup);

  function renderWith(controller: TileController): void {
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );
  }

  const NAV_CAPABILITIES: TileChromeCapabilities = {
    ...DISABLED_CAPABILITIES,
    navigate: true,
  };

  it("shows the page's own icon beside its address", () => {
    renderWith({
      ...makeController(NAV_CAPABILITIES, null),
      faviconUrl: "https://example.com/favicon.ico",
    });

    const icon = document.querySelector("img[aria-hidden]");
    expect(icon?.getAttribute("src")).toBe("https://example.com/favicon.ico");
    // Fetching an icon must not announce which page the user is on.
    expect(icon?.getAttribute("referrerPolicy")).toBe("no-referrer");
    // Decorative: the address beside it already names the page.
    expect(icon?.getAttribute("alt")).toBe("");
  });

  it("renders no icon slot when the page declares none", () => {
    renderWith({ ...makeController(NAV_CAPABILITIES, null), faviconUrl: null });

    expect(document.querySelector("img[aria-hidden]")).toBeNull();
  });

  it("drops the element when the icon fails to load, not a broken glyph", () => {
    renderWith({
      ...makeController(NAV_CAPABILITIES, null),
      faviconUrl: "https://example.com/missing.png",
    });

    const icon = document.querySelector("img[aria-hidden]");
    expect(icon).not.toBeNull();
    if (icon !== null) fireEvent.error(icon);
    expect(document.querySelector("img[aria-hidden]")).toBeNull();
  });
});

describe("<BrowserTileToolbar /> screenshot", () => {
  afterEach(cleanup);

  function renderWith(controller: TileController): void {
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );
  }

  const SHOT_CAPABILITIES: TileChromeCapabilities = {
    ...DISABLED_CAPABILITIES,
    screenshot: true,
    previewWindow: true,
    recording: true,
  };

  it("saves a screenshot when pressed", () => {
    const onSaveScreenshot = vi.fn();
    renderWith({
      ...makeController(SHOT_CAPABILITIES, null),
      onSaveScreenshot,
    });

    fireEvent.click(screen.getByRole("button", { name: "Save a screenshot" }));
    expect(onSaveScreenshot).toHaveBeenCalledTimes(1);
  });

  it("hides the button where there is no local guest to capture", () => {
    // A screencast tile's pixels live on another machine.
    renderWith({
      ...makeController(SHOT_CAPABILITIES, null),
      onSaveScreenshot: null,
      onTogglePreviewWindow: () => undefined,
      isRecording: false,
      onToggleRecording: null,
    });

    expect(
      screen.queryByRole("button", { name: "Save a screenshot" }),
    ).toBeNull();
  });

  it("hides the button when the capability is off", () => {
    renderWith({
      ...makeController(DISABLED_CAPABILITIES, null),
      onSaveScreenshot: () => undefined,
      onTogglePreviewWindow: () => undefined,
      isRecording: false,
      onToggleRecording: null,
    });

    expect(
      screen.queryByRole("button", { name: "Save a screenshot" }),
    ).toBeNull();
  });
});

describe("<BrowserTileToolbar /> floating window", () => {
  afterEach(cleanup);

  it("toggles the floating window from the overflow menu", () => {
    const onTogglePreviewWindow = vi.fn();
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={{
            ...makeController(
              { ...DISABLED_CAPABILITIES, previewWindow: true },
              null,
            ),
            onTogglePreviewWindow,
          }}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Open a floating window on this page",
      }),
    );
    // Main owns the toggle, so one row covers open and close and the label does
    // not have to track which state the window is in.
    expect(onTogglePreviewWindow).toHaveBeenCalledTimes(1);
  });
});

describe("<BrowserTileToolbar /> recording", () => {
  afterEach(cleanup);

  function renderWith(controller: TileController): void {
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );
  }

  const REC_CAPABILITIES: TileChromeCapabilities = {
    ...DISABLED_CAPABILITIES,
    recording: true,
  };

  it("offers to record, and says stop while recording", () => {
    const onToggleRecording = vi.fn();
    renderWith({
      ...makeController(REC_CAPABILITIES, null),
      onToggleRecording,
    });

    fireEvent.click(screen.getByRole("button", { name: "Record this page" }));
    expect(onToggleRecording).toHaveBeenCalledTimes(1);

    cleanup();
    renderWith({
      ...makeController(REC_CAPABILITIES, null),
      isRecording: true,
      onToggleRecording,
    });
    const stop = screen.getByRole("button", { name: "Stop recording" });
    // Pressed state as well as the label, so the control reads correctly to a
    // screen reader mid-recording.
    expect(stop.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the button where there is no local guest to record", () => {
    renderWith({
      ...makeController(REC_CAPABILITIES, null),
      onToggleRecording: null,
    });

    expect(
      screen.queryByRole("button", { name: /Record this page|Stop recording/ }),
    ).toBeNull();
  });
});

describe("<BrowserTileToolbar /> DevTools availability", () => {
  afterEach(cleanup);

  function renderWith(controller: TileController): void {
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={controller}
          pictureInPicture={null}
          loading={false}
        />
      </TooltipProvider>,
    );
  }

  const DEVTOOLS_CAPABILITIES: TileChromeCapabilities = {
    ...DISABLED_CAPABILITIES,
    devtools: true,
  };

  it("opens DevTools where the page is local", () => {
    const onOpenDevTools = vi.fn();
    renderWith({
      ...makeController(DEVTOOLS_CAPABILITIES, null),
      onOpenDevTools,
    });

    openMoreMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open browser DevTools" }),
    );
    expect(onOpenDevTools).toHaveBeenCalledTimes(1);
  });

  it("refuses with a reason rather than hiding the row", () => {
    const onOpenDevTools = vi.fn();
    renderWith({
      ...makeController(DEVTOOLS_CAPABILITIES, null),
      devtoolsUnavailableReason: "DevTools needs the tab on this machine",
      onOpenDevTools,
    });

    openMoreMenu();
    // Both halves: a screen reader that hears only the reason never learns the
    // row is the DevTools action.
    const item = screen.getByRole("menuitem", {
      name: "Open browser DevTools - DevTools needs the tab on this machine",
    });
    // A row that simply vanished would read as a bug in the app.
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("DevTools needs the tab on this machine");
    fireEvent.click(item);
    expect(onOpenDevTools).not.toHaveBeenCalled();
  });
});
