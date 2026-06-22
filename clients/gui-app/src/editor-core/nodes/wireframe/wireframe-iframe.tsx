import { useEffect, useRef, type Ref } from "react";
import { cn } from "@/lib/utils";

export interface WireframeIframeProps {
  readonly htmlContent: string;
  readonly title: string;
  readonly className: string;
  /**
   * When `fill`, the iframe stretches to the container - used for the
   * fullscreen dialog. When `auto`, the iframe grows to the measured
   * document height (clamped) - used for inline preview.
   */
  readonly mode: "auto" | "fill";
  readonly ref?: Ref<HTMLIFrameElement>;
}

const MIN_HEIGHT_PX = 240;
// Conservative ceiling - pathological HTML (infinite scroll demos, giant
// backgrounds) otherwise pushes the tile past viewport and hijacks scroll.
const MAX_HEIGHT_MULTIPLIER = 3;

/**
 * Sandboxed preview iframe. We pick `sandbox=""` (the strictest value) so
 * the embedded HTML cannot execute scripts, open top-level navigations,
 * post forms, or read parent storage. Styles + static markup still render,
 * which is enough for the wireframe use case.
 *
 * Because scripts are forbidden inside the iframe, the usual
 * `postMessage`-based auto-sizing approach is off the table. Instead the
 * parent reads `contentDocument.body.scrollHeight` directly - this works
 * because `srcdoc` is treated as same-origin with the embedder. A
 * `ResizeObserver` attached to the body re-measures whenever the layout
 * shifts (images loading, @media query changing on window resize, etc).
 */
export function WireframeIframe(props: WireframeIframeProps) {
  const { htmlContent, title, className, mode, ref: forwardedRef } = props;
  const innerRef = useRef<HTMLIFrameElement | null>(null);

  const setRef = (node: HTMLIFrameElement | null): void => {
    innerRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef !== null && forwardedRef !== undefined) {
      forwardedRef.current = node;
    }
  };

  useEffect(() => {
    if (mode !== "auto") return;
    const iframe = innerRef.current;
    if (iframe === null) return;
    let observer: ResizeObserver | null = null;

    const measure = (): void => {
      const win = iframe.ownerDocument.defaultView;
      const doc = iframe.contentDocument;
      if (win === null) return;
      if (doc === null) return;
      const maxHeight = win.innerHeight * MAX_HEIGHT_MULTIPLIER;
      const measured = Math.max(
        doc.body.scrollHeight,
        doc.documentElement.scrollHeight,
      );
      const clamped = Math.max(MIN_HEIGHT_PX, Math.min(maxHeight, measured));
      iframe.style.height = `${clamped}px`;
    };

    const onLoad = (): void => {
      const doc = iframe.contentDocument;
      if (doc === null) return;
      measure();
      // Re-measure on layout shifts inside the iframe.
      if (observer !== null) observer.disconnect();
      observer = new ResizeObserver(() => measure());
      observer.observe(doc.body);
    };

    iframe.addEventListener("load", onLoad);
    // If the iframe already loaded synchronously (cached srcdoc), run once.
    if (iframe.contentDocument?.readyState === "complete") onLoad();

    return () => {
      iframe.removeEventListener("load", onLoad);
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
    };
  }, [htmlContent, mode]);

  return (
    <iframe
      ref={setRef}
      title={title}
      // The value of `sandbox` being the empty string is deliberate and
      // is the strictest possible configuration. Do not add
      // `allow-scripts` / `allow-same-origin` - see component docstring.
      sandbox=""
      srcDoc={htmlContent}
      className={cn("tc-node-wireframe__iframe", className)}
      style={
        mode === "auto"
          ? { height: `${MIN_HEIGHT_PX}px`, width: "100%" }
          : { height: "100%", width: "100%" }
      }
    />
  );
}
