import { toBlob } from "html-to-image";
import {
  canvasWindowCaptureBridge,
  nextPresentedFrame,
} from "@/components/canvas-artifact/canvas-annotation-attach";

/**
 * Whether this app can screenshot its own window: the desktop app only. The
 * share nudge is offered only where this is true, which keeps it off the
 * phone app and the browser.
 */
export function canCaptureAppWindow(): boolean {
  return canvasWindowCaptureBridge() !== null;
}

/**
 * Screenshot the whole app window, after two frames so whatever the caller
 * just dismissed (the nudge toast) is no longer painted. `null` when the
 * window cannot be captured.
 */
export async function captureAppWindow(): Promise<Blob | null> {
  const bridge = canvasWindowCaptureBridge();
  if (bridge === null) return null;
  await nextPresentedFrame();
  const bytes = await bridge.captureRegion({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  if (bytes === null) return null;
  return new Blob([bytes], { type: "image/png" });
}

/** A share image as the dialog holds it: the PNG, and the same bytes as a URL to show. */
export interface ShareImage {
  readonly blob: Blob;
  readonly src: string;
}

/**
 * Read a PNG into a {@link ShareImage}. A data URL rather than an object URL:
 * nothing has to be revoked when the dialog goes away.
 */
export function toShareImage(blob: Blob): Promise<ShareImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve({ blob, src: reader.result });
      } else {
        reject(new Error("share image could not be read"));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("share image could not be read"));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Rasterise a rendered share image (one of the dialog's offscreen image
 * components) into a PNG at twice its CSS size.
 */
export async function renderShareImage(node: HTMLElement): Promise<Blob> {
  const blob = await toBlob(node, {
    pixelRatio: 2,
    // The node parks offscreen while it lays out; html-to-image copies
    // computed styles, so without this the clone keeps the offset and the
    // image comes out blank (same reason as the usage export).
    style: { position: "static", left: "0", top: "0" },
  });
  if (blob === null) throw new Error("share image capture produced no image");
  return blob;
}

/**
 * Resolve once `node`'s subtree has stopped changing for `quietMs`, or after
 * `maxMs` at most. A chart animates its first draw by rewriting its SVG every
 * frame, so a capture taken before it settles shows half-drawn bars; the
 * mutations themselves say when the drawing is done.
 */
export function waitForDomToSettle(
  node: HTMLElement,
  quietMs: number,
  maxMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: number | null = null;
    const finish = (): void => {
      observer.disconnect();
      if (quietTimer !== null) window.clearTimeout(quietTimer);
      window.clearTimeout(maxTimer);
      resolve();
    };
    const armQuiet = (): void => {
      if (quietTimer !== null) window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finish, quietMs);
    };
    const observer = new MutationObserver(armQuiet);
    observer.observe(node, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const maxTimer = window.setTimeout(finish, maxMs);
    armQuiet();
  });
}
