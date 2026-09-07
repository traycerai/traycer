/** W3C Window Controls Overlay → `.wco` class on `<html>`. */

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
