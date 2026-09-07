import {
  BrowserWindow,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import { log } from "./logger";

export function getAccentColor(): string | null {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }
  try {
    return systemPreferences.getAccentColor();
  } catch (err) {
    log.warn("[system-prefs] getAccentColor failed", { err });
    return null;
  }
}

export function getEffectiveAppearance(): "dark" | "light" | null {
  if (process.platform !== "darwin") return null;
  const value = systemPreferences.getEffectiveAppearance();
  return value === "dark" || value === "light" ? value : null;
}

export function canPromptTouchID(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return systemPreferences.canPromptTouchID();
  } catch {
    return false;
  }
}

export async function promptTouchID(reason: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await systemPreferences.promptTouchID(reason);
    return true;
  } catch (err) {
    log.info("[system-prefs] touchID prompt declined or failed", { err });
    return false;
  }
}

const VIBRANCY_VALUES = [
  "titlebar",
  "selection",
  "menu",
  "popover",
  "sidebar",
  "header",
  "sheet",
  "window",
  "hud",
  "fullscreen-ui",
  "tooltip",
  "content",
  "under-window",
  "under-page",
] as const;
type Vibrancy = (typeof VIBRANCY_VALUES)[number];
const ALLOWED_VIBRANCY: ReadonlySet<Vibrancy> = new Set(VIBRANCY_VALUES);

function isVibrancy(value: unknown): value is Vibrancy {
  return typeof value === "string" && ALLOWED_VIBRANCY.has(value as Vibrancy);
}

/** Renderer must use transparent backgrounds in the areas it wants the vibrancy to show through. */
export function handleSetVibrancy(
  event: IpcMainInvokeEvent,
  vibrancy: unknown,
): void {
  if (process.platform !== "darwin") return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return;
  if (vibrancy === null) {
    window.setVibrancy(null);
    return;
  }
  if (!isVibrancy(vibrancy)) {
    log.warn("[system-prefs] invalid vibrancy", { vibrancy });
    return;
  }
  window.setVibrancy(vibrancy);
}

const BACKGROUND_MATERIAL_VALUES = [
  "auto",
  "none",
  "mica",
  "acrylic",
  "tabbed",
] as const;
type BackgroundMaterial = (typeof BACKGROUND_MATERIAL_VALUES)[number];
const ALLOWED_MATERIAL: ReadonlySet<BackgroundMaterial> = new Set(
  BACKGROUND_MATERIAL_VALUES,
);

function isBackgroundMaterial(value: unknown): value is BackgroundMaterial {
  return (
    typeof value === "string" &&
    ALLOWED_MATERIAL.has(value as BackgroundMaterial)
  );
}

export function handleSetBackgroundMaterial(
  event: IpcMainInvokeEvent,
  material: unknown,
): void {
  if (process.platform !== "win32") return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return;
  if (!isBackgroundMaterial(material)) {
    log.warn("[system-prefs] invalid background material", { material });
    return;
  }
  window.setBackgroundMaterial(material);
}

/** macOS-only: keeps a window pinned across all Spaces / full-screen desktops. */
export function handleSetVisibleOnAllWorkspaces(
  event: IpcMainInvokeEvent,
  visible: unknown,
): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return;
  window.setVisibleOnAllWorkspaces(visible === true, {
    visibleOnFullScreen: visible === true,
  });
}
