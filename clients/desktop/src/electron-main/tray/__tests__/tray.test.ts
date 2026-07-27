import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { DesktopTrayEpic } from "../../../ipc-contracts/host-types";
import type { TrayManagedWindow } from "../tray";

const { mockAppState, mockMenuState, trayInstances } = vi.hoisted(() => ({
  mockAppState: { appPath: "/unused-in-pure-helper-tests" },
  mockMenuState: {
    lastBuiltMenu: null as { template: CapturedMenuItemLike[] } | null,
  },
  trayInstances: [] as MockTrayInstanceLike[],
}));

interface MockTrayInstanceLike {
  readonly toolTips: string[];
  readonly eventHandlers: Record<string, Array<() => void>>;
  contextMenu: unknown;
  destroyed: boolean;
  setToolTip(text: string): void;
  on(event: string, handler: () => void): void;
  setContextMenu(menu: unknown): void;
  destroy(): void;
}

interface CapturedMenuItemLike {
  label?: string;
  sublabel?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
  submenu?: CapturedMenuItemLike[];
  accelerator?: string;
  registerAccelerator?: boolean;
}

/**
 * The tray asset resolver is the load-bearing piece for the visibility
 * fix: a regression here re-introduces the invisible-tray failure mode that
 * shipped while `new Tray(nativeImage.createEmpty())` was in place. We test
 * the pure helper directly (no Electron runtime) and assert that the
 * dev-mode resolved path actually exists on disk so a missing or renamed
 * asset trips the test instead of slipping into a packaged build.
 */

// `electron` and `electron-log` have no Node-side implementation. The tray
// module reads `process.platform` / `process.resourcesPath` at call-time
// only, but the import itself still needs both modules to resolve.
vi.mock("electron", () => {
  class MockTrayClass implements MockTrayInstanceLike {
    readonly toolTips: string[] = [];
    readonly eventHandlers: Record<string, Array<() => void>> = {};
    contextMenu: unknown = null;
    destroyed = false;

    constructor(_image: unknown) {
      trayInstances.push(this);
    }
    setToolTip(text: string): void {
      this.toolTips.push(text);
    }
    on(event: string, handler: () => void): void {
      const bucket = this.eventHandlers[event] ?? [];
      bucket.push(handler);
      this.eventHandlers[event] = bucket;
    }
    setContextMenu(menu: unknown): void {
      this.contextMenu = menu;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }

  return {
    app: {
      getAppPath: (): string => mockAppState.appPath,
      getPath: (): string => "/tmp",
      quit: vi.fn(),
    },
    BrowserWindow: class {
      isDestroyed(): boolean {
        return false;
      }
      isVisible(): boolean {
        return false;
      }
      show(): void {}
      focus(): void {}
    },
    Menu: {
      buildFromTemplate: (template: CapturedMenuItemLike[]): unknown => {
        mockMenuState.lastBuiltMenu = { template };
        return { template };
      },
    },
    Tray: MockTrayClass,
    nativeImage: {
      createFromPath: (): unknown => ({
        isEmpty: (): boolean => false,
        setTemplateImage: (): void => {},
      }),
      createFromNamedImage: (): unknown => ({
        isEmpty: (): boolean => true,
      }),
      createEmpty: (): unknown => ({ isEmpty: (): boolean => true }),
    },
  };
});

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// `resolveTrayDir` keys off the deploy slot (`config.isDevBuild`), not
// `app.isPackaged`. These tests point `process.resourcesPath` at the
// workspace `resources/`, so pin the dev predicate false to take the
// shipped `<resources>/tray` branch.
vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return { ...actual, isDevBuild: false };
});

import { nativeImage } from "electron";
import { DesktopTrayController, resolveTrayIconPath } from "../tray";

// The controller now receives a pre-loaded image (icon loading moved to the
// async `loadTrayIconImage`), so menu-structure tests pass a stub from the
// mocked `nativeImage`.
function trayImage(): Electron.NativeImage {
  return nativeImage.createFromPath("/tray.png");
}

const REPO_DESKTOP_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("resolveTrayIconPath", () => {
  it("returns <trayDir>/trayTemplate.png on macOS", () => {
    const asset = resolveTrayIconPath({
      platform: "darwin",
      trayDir: "/packaged/Resources/tray",
    });
    expect(asset.path).toBe(
      join("/packaged/Resources/tray", "trayTemplate.png"),
    );
    expect(asset.isTemplate).toBe(true);
  });

  it("returns <trayDir>/tray.png on Windows / Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const asset = resolveTrayIconPath({
        platform,
        trayDir: "/packaged/Resources/tray",
      });
      expect(asset.path).toBe(join("/packaged/Resources/tray", "tray.png"));
      expect(asset.isTemplate).toBe(false);
    }
  });

  it("uses the supplied tray directory verbatim regardless of platform", () => {
    const macAsset = resolveTrayIconPath({
      platform: "darwin",
      trayDir: "/fake/app/path/resources/tray",
    });
    expect(macAsset.path).toBe(
      join("/fake/app/path/resources/tray", "trayTemplate.png"),
    );
    expect(macAsset.isTemplate).toBe(true);

    const linuxAsset = resolveTrayIconPath({
      platform: "linux",
      trayDir: "/fake/app/path/resources/tray",
    });
    expect(linuxAsset.path).toBe(
      join("/fake/app/path/resources/tray", "tray.png"),
    );
    expect(linuxAsset.isTemplate).toBe(false);
  });

  it("resolves to a real PNG on disk for every supported platform when pointed at the workspace tray dir", () => {
    // The dev orchestrator sets `TRAYCER_DESKTOP_TRAY_DIR` to the
    // workspace's `resources/tray/`. Assert that the staged PNGs exist
    // alongside this source tree - exactly what the helper resolves at
    // runtime when the override is set.
    const trayDir = join(REPO_DESKTOP_ROOT, "resources", "tray");
    const platforms: NodeJS.Platform[] = ["darwin", "win32", "linux"];
    for (const platform of platforms) {
      const asset = resolveTrayIconPath({ platform, trayDir });
      expect(existsSync(asset.path), `expected ${asset.path} to exist`).toBe(
        true,
      );
      // Read once and assert against the buffer — reading a directory would
      // throw, so this also covers the "is a regular file" expectation without
      // a separate stat() that could race the read.
      const contents = readFileSync(asset.path);
      expect(
        contents.length,
        `expected ${asset.path} to be non-empty`,
      ).toBeGreaterThan(0);
      const head = contents.subarray(0, 8);
      expect(
        head.equals(PNG_SIGNATURE),
        `expected ${asset.path} to start with the PNG signature`,
      ).toBe(true);
    }
  });

  it("ships a retina @2x companion next to every base asset", () => {
    const trayDir = join(REPO_DESKTOP_ROOT, "resources", "tray");
    for (const base of ["trayTemplate.png", "tray.png"]) {
      const retina = base.replace(".png", "@2x.png");
      expect(existsSync(join(trayDir, retina))).toBe(true);
    }
  });
});

function mostRecentTray(): MockTrayInstanceLike {
  const tray = trayInstances[trayInstances.length - 1];
  if (tray === undefined) {
    throw new Error("expected a tray instance to have been constructed");
  }
  return tray;
}

function latestMenuTemplate(): CapturedMenuItemLike[] {
  const built = mockMenuState.lastBuiltMenu;
  if (built === null) {
    throw new Error("expected a menu template to have been built");
  }
  return built.template;
}

interface WindowCallCounter {
  show: number;
  focus: number;
}

function makeWindow(): TrayManagedWindow & { calls: WindowCallCounter } {
  const calls: WindowCallCounter = { show: 0, focus: 0 };
  return {
    calls,
    isDestroyed: () => false,
    isVisible: () => false,
    show: () => {
      calls.show += 1;
    },
    focus: () => {
      calls.focus += 1;
    },
  };
}

function makeMruWindowProxy(
  getCurrentWindow: () => TrayManagedWindow,
): TrayManagedWindow {
  return {
    isDestroyed: () => getCurrentWindow().isDestroyed(),
    isVisible: () => getCurrentWindow().isVisible(),
    show: () => {
      getCurrentWindow().show();
    },
    focus: () => {
      getCurrentWindow().focus();
    },
  };
}

describe("DesktopTrayController menu structure", () => {
  beforeEach(() => {
    mockAppState.appPath = REPO_DESKTOP_ROOT;
    mockMenuState.lastBuiltMenu = null;
    trayInstances.length = 0;
    // The controller resolves the tray directory from `<resources>/tray`
    // (the config mock pins `isDevBuild` false → shipped branch). Point
    // `process.resourcesPath` at the workspace `resources/` so the icon-load
    // preflight in `loadTrayIconImage` finds the real PNG on disk.
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: join(REPO_DESKTOP_ROOT, "resources"),
    });
  });

  it("renders a disabled 'No recent epics' item when the epic list is empty", () => {
    new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });

    const template = latestMenuTemplate();
    const labels = template.map((entry) => entry.label);
    expect(labels).toContain("No recent epics");
    expect(labels).toContain("Open Traycer");
    expect(labels).toContain("Quit Traycer");

    const placeholder = template.find(
      (entry) => entry.label === "No recent epics",
    );
    expect(placeholder?.enabled).toBe(false);
  });

  it("does not render a 'Status:' row (status drives the tooltip instead)", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });
    controller.setIndicator("attention");

    const template = latestMenuTemplate();
    const statusRow = template.find(
      (entry) =>
        typeof entry.label === "string" && entry.label.startsWith("Status:"),
    );
    expect(statusRow).toBeUndefined();

    const tray = mostRecentTray();
    expect(tray.toolTips[tray.toolTips.length - 1]).toBe("Traycer (attention)");
  });

  it("renders epic rows under separators alongside Open Traycer and Quit Traycer", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });
    const epics: readonly DesktopTrayEpic[] = [
      { epicId: "e1", title: "First Epic", subtitle: "2 hours ago" },
      { epicId: "e2", title: "Second Epic", subtitle: "yesterday" },
    ];
    controller.setEpics(epics);

    const template = latestMenuTemplate();
    const labels = template.map((entry) => entry.label ?? `<${entry.type}>`);

    expect(labels[0]).toBe("Open Traycer");
    expect(labels).toContain("First Epic");
    expect(labels).toContain("Second Epic");
    expect(labels[labels.length - 1]).toBe("Quit Traycer");

    // Recency reads as native `sublabel` metadata beneath the epic title.
    expect(
      template.find((entry) => entry.label === "First Epic")?.sublabel,
    ).toBe("2 hours ago");
    expect(
      template.find((entry) => entry.label === "Second Epic")?.sublabel,
    ).toBe("yesterday");

    // No "No recent epics" placeholder when epics are present.
    expect(labels).not.toContain("No recent epics");
  });

  it("opens the clicked epic and brings the window forward", () => {
    const selectedIds: string[] = [];
    const window = makeWindow();
    const controller = new DesktopTrayController(window, trayImage(), {
      onEpicSelected: (epicId) => {
        selectedIds.push(epicId);
      },
      onCommand: null,
    });
    const epics: readonly DesktopTrayEpic[] = [
      { epicId: "e1", title: "First", subtitle: "just now" },
      { epicId: "e2", title: "Second", subtitle: "1 day ago" },
    ];
    controller.setEpics(epics);

    const template = latestMenuTemplate();
    const firstEpicRow = template.find((entry) => entry.label === "First");
    if (firstEpicRow?.click === undefined) {
      throw new Error("expected first epic row to have a click handler");
    }
    firstEpicRow.click();

    expect(selectedIds).toEqual(["e1"]);
    // A tray epic click forwards the id AND brings the window forward.
    expect(window.calls.show).toBe(1);
    expect(window.calls.focus).toBe(1);

    const secondEpicRow = template.find((entry) => entry.label === "Second");
    secondEpicRow?.click?.();
    expect(selectedIds).toEqual(["e1", "e2"]);
    expect(window.calls.show).toBe(2);
    expect(window.calls.focus).toBe(2);
  });

  it("opens epics on the current MRU window through the managed-window seam", () => {
    const selectedIds: string[] = [];
    const windowA = makeWindow();
    const windowB = makeWindow();
    let currentWindow: TrayManagedWindow = windowA;
    const controller = new DesktopTrayController(
      makeMruWindowProxy(() => currentWindow),
      trayImage(),
      {
        onEpicSelected: (epicId) => {
          selectedIds.push(epicId);
        },
        onCommand: null,
      },
    );

    const firstTemplate = latestMenuTemplate();
    const openRow = firstTemplate.find(
      (entry) => entry.label === "Open Traycer",
    );
    if (openRow?.click === undefined) {
      throw new Error("expected Open Traycer row to have a click handler");
    }

    openRow.click();
    currentWindow = windowB;
    openRow.click();

    controller.setEpics([
      { epicId: "mru-epic", title: "MRU", subtitle: "moments ago" },
    ]);
    const epicRow = latestMenuTemplate().find((entry) => entry.label === "MRU");
    if (epicRow?.click === undefined) {
      throw new Error("expected epic row to have a click handler");
    }
    epicRow.click();

    // Two Open Traycer clicks (one per MRU window) plus the epic click landing
    // on the current MRU window (windowB), which also forwards the epicId.
    expect(windowA.calls).toEqual({ show: 1, focus: 1 });
    expect(windowB.calls).toEqual({ show: 2, focus: 2 });
    expect(selectedIds).toEqual(["mru-epic"]);
  });

  it("supports swapping the epic-selected handler after construction", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });
    const received: string[] = [];
    controller.setEpicSelectedHandler((epicId) => {
      received.push(epicId);
    });
    controller.setEpics([
      { epicId: "late-bind", title: "Late", subtitle: "earlier" },
    ]);
    const template = latestMenuTemplate();
    const row = template.find((entry) => entry.label === "Late");
    row?.click?.();
    expect(received).toEqual(["late-bind"]);

    controller.setEpicSelectedHandler(null);
    row?.click?.();
    expect(received).toEqual(["late-bind"]);
  });

  it("renders the signed-in identity beside Sign Out and the quick actions", () => {
    const commands: string[] = [];
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: (command) => {
        commands.push(command);
      },
    });
    controller.setPresentation({
      authStatus: "signed-in",
      account: { name: "Ada Lovelace", email: "ada@example.com" },
      canCheckForUpdates: true,
      hostUpdateAvailableVersion: null,
    });

    const template = latestMenuTemplate();
    const labels = template.map((entry) => entry.label ?? `<${entry.type}>`);
    expect(labels[0]).toBe("Open Traycer");
    // Identity shows as `Name (email)` and sits directly above Sign Out.
    expect(labels).toContain("Ada Lovelace (ada@example.com)");
    const identityIndex = labels.indexOf("Ada Lovelace (ada@example.com)");
    expect(labels[identityIndex + 1]).toBe("Sign Out");
    // The host version row is gone.
    expect(labels.some((l) => l.startsWith("Host"))).toBe(false);
    expect(labels).toContain("Open Logs");
    expect(labels).toContain("No recent epics");
    expect(labels[labels.length - 1]).toBe("Quit Traycer");

    template.find((entry) => entry.label === "Open Logs")?.click?.();
    template.find((entry) => entry.label === "Check for Updates")?.click?.();
    expect(commands).toEqual(["app.openLogs", "app.checkForUpdates"]);
  });

  it("falls back to the email when no display name is known", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });
    controller.setPresentation({
      authStatus: "signed-in",
      account: { name: null, email: "solo@example.com" },
      canCheckForUpdates: false,
      hostUpdateAvailableVersion: null,
    });
    const labels = latestMenuTemplate().map((entry) => entry.label);
    expect(labels).toContain("solo@example.com");
    expect(labels).toContain("Sign Out");
  });

  it("shows Sign In and no identity row when signed out", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });
    controller.setPresentation({
      authStatus: "signed-out",
      account: null,
      canCheckForUpdates: false,
      hostUpdateAvailableVersion: null,
    });
    const labels = latestMenuTemplate().map((entry) => entry.label);
    expect(labels).toContain("Sign In");
    expect(labels).not.toContain("Sign Out");
  });

  it("collapses epics beyond the inline limit into a 'More' submenu", () => {
    const selectedIds: string[] = [];
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: (epicId) => {
        selectedIds.push(epicId);
      },
      onCommand: null,
    });
    const epics: DesktopTrayEpic[] = Array.from(
      { length: 7 },
      (_unused, i) => ({
        epicId: `e${i}`,
        title: `Epic ${i}`,
        subtitle: "recent",
      }),
    );
    controller.setEpics(epics);

    const template = latestMenuTemplate();
    const labels = template.map((entry) => entry.label ?? `<${entry.type}>`);
    // First five epics render inline.
    expect(labels).toContain("Epic 0");
    expect(labels).toContain("Epic 4");
    // The sixth and seventh do not - they live under "More".
    expect(labels).not.toContain("Epic 5");
    expect(labels).toContain("More");

    const moreRow = template.find((entry) => entry.label === "More");
    const overflow = moreRow?.submenu ?? [];
    expect(overflow.map((entry) => entry.label)).toEqual(["Epic 5", "Epic 6"]);

    // Submenu clicks open the epic just like inline rows.
    overflow.find((entry) => entry.label === "Epic 6")?.click?.();
    expect(selectedIds).toEqual(["e6"]);
  });

  it("inserts an 'Update to <version>' row that dispatches host.installUpdate with the captured version", () => {
    const commands: Array<{
      command: string;
      hostUpdateVersion: string | null;
    }> = [];
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: (command, hostUpdateVersion) => {
        commands.push({ command, hostUpdateVersion });
      },
    });
    controller.setPresentation({
      authStatus: "signed-in",
      account: { name: null, email: "user@example.com" },
      canCheckForUpdates: true,
      hostUpdateAvailableVersion: "1.4.2",
    });

    const template = latestMenuTemplate();
    const updateRow = template.find(
      (entry) =>
        typeof entry.label === "string" &&
        entry.label.includes("Update to 1.4.2"),
    );
    expect(updateRow).toBeDefined();
    updateRow?.click?.();
    expect(commands).toEqual([
      { command: "host.installUpdate", hostUpdateVersion: "1.4.2" },
    ]);
  });

  // Cold-review #3: an already-open native tray menu can fire the click for a
  // row labelled with version A after presentation has rebuilt to B. The
  // item's closure must keep A so main refuses a mismatched current target.
  it("dispatches the labelled version A when a stale open-menu click fires after presentation moves to B", () => {
    const commands: Array<{
      command: string;
      hostUpdateVersion: string | null;
    }> = [];
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: (command, hostUpdateVersion) => {
        commands.push({ command, hostUpdateVersion });
      },
    });
    controller.setPresentation({
      authStatus: "signed-in",
      account: { name: null, email: "user@example.com" },
      canCheckForUpdates: true,
      hostUpdateAvailableVersion: "1.4.2",
    });

    const versionATemplate = latestMenuTemplate();
    const staleUpdateRow = versionATemplate.find(
      (entry) =>
        typeof entry.label === "string" &&
        entry.label.includes("Update to 1.4.2"),
    );
    if (staleUpdateRow?.click === undefined) {
      throw new Error("expected Update to 1.4.2 row with a click handler");
    }
    const staleClick = staleUpdateRow.click;

    // Presentation rebuilds to B (and a new menu template). The open menu's
    // old item callback must still pin A.
    controller.setPresentation({
      authStatus: "signed-in",
      account: { name: null, email: "user@example.com" },
      canCheckForUpdates: true,
      hostUpdateAvailableVersion: "1.6.0-rc.1",
    });
    const versionBTemplate = latestMenuTemplate();
    expect(
      versionBTemplate.some(
        (entry) =>
          typeof entry.label === "string" &&
          entry.label.includes("Update to 1.6.0-rc.1"),
      ),
    ).toBe(true);

    staleClick();
    expect(commands).toEqual([
      { command: "host.installUpdate", hostUpdateVersion: "1.4.2" },
    ]);
    expect(commands[0]?.hostUpdateVersion).not.toBe("1.6.0-rc.1");
  });

  // Decision 9: the "Open Traycer" item is display-only for the summon
  // chord - `registerAccelerator: false` means the OS never binds it from
  // the menu, only the global-shortcuts registry does. Deleting either the
  // `accelerator` assignment or the `registerAccelerator: false` line from
  // `rebuildMenu()` must fail this test, not just checking the method exists.
  it("shows the live summon accelerator on Open Traycer as display-only, and none when disabled", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });

    const beforeSet = latestMenuTemplate().find(
      (entry) => entry.label === "Open Traycer",
    );
    expect(beforeSet?.accelerator).toBeUndefined();
    expect(beforeSet?.registerAccelerator).toBe(false);

    controller.setSummonAccelerator("CommandOrControl+Shift+Space");
    const withAccelerator = latestMenuTemplate().find(
      (entry) => entry.label === "Open Traycer",
    );
    expect(withAccelerator?.accelerator).toBe("CommandOrControl+Shift+Space");
    expect(withAccelerator?.registerAccelerator).toBe(false);

    controller.setSummonAccelerator(null);
    const afterDisable = latestMenuTemplate().find(
      (entry) => entry.label === "Open Traycer",
    );
    expect(afterDisable?.accelerator).toBeUndefined();
    expect(afterDisable?.registerAccelerator).toBe(false);
  });

  it("rebuilds the menu when the summon accelerator changes, but not when it is set to the same value", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });

    controller.setSummonAccelerator("CommandOrControl+Shift+Space");
    const templateAfterFirstSet = latestMenuTemplate();
    mockMenuState.lastBuiltMenu = null;

    controller.setSummonAccelerator("CommandOrControl+Shift+Space");
    expect(mockMenuState.lastBuiltMenu).toBeNull();

    controller.setSummonAccelerator("CommandOrControl+Alt+X");
    expect(mockMenuState.lastBuiltMenu).not.toBeNull();
    const templateAfterChange = latestMenuTemplate();
    expect(
      templateAfterChange.find((entry) => entry.label === "Open Traycer")
        ?.accelerator,
    ).toBe("CommandOrControl+Alt+X");
    expect(templateAfterFirstSet).not.toBe(templateAfterChange);
  });

  it("does not render an update row when no host update is queued", () => {
    const controller = new DesktopTrayController(makeWindow(), trayImage(), {
      onEpicSelected: null,
      onCommand: null,
    });
    controller.setPresentation({
      authStatus: "signed-in",
      account: { name: null, email: "user@example.com" },
      canCheckForUpdates: true,
      hostUpdateAvailableVersion: null,
    });
    const template = latestMenuTemplate();
    const labels = template.map((entry) => entry.label ?? "");
    expect(labels.some((l) => l.toString().startsWith("Update to"))).toBe(
      false,
    );
  });
});
