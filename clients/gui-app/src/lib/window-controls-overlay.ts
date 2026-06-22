/**
 * W3C Window Controls Overlay → `.wco` class on `<html>`.
 *
 * Imperative module-load installer (mirrors `theme-applier.ts`).
 * Subscribes to `navigator.windowControlsOverlay.geometrychange` at
 * module load - outside React - so the DOM cascade flips before any
 * render reads `env(titlebar-area-*)` values.
 *
 * Why a class toggle is required: CSS `env(name, fallback)` resolves
 * to `fallback` when the var is **unset** (browser shell) BUT also
 * when the OS hides the controls (mac fullscreen autohide → WCO
 * reports `visible: false` and clears the env vars). Without this
 * bridge, a frameless-desktop renderer keeps drawing the leading
 * inset in fullscreen because the fallback fires. The `.wco` class
 * lets components scope inset styles to `visible === true` cases.
 *
 * Tailwind variant: `@custom-variant wco (&:is(.wco, .wco *));` in
 * `index.css`. Use `wco:pl-[env(titlebar-area-x,82px)]` to apply the
 * inset only while controls are visible.
 */

const WCO_CLASS_NAME = "wco";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") return null;
  return (
    (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ??
    null
  );
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  if (typeof document === "undefined") return;
  const overlay = getWindowControlsOverlay();
  const update = (): void => {
    document.documentElement.classList.toggle(
      WCO_CLASS_NAME,
      overlay !== null && overlay.visible,
    );
  };
  update();
  if (overlay === null) return;
  overlay.addEventListener("geometrychange", update);
}

install();
