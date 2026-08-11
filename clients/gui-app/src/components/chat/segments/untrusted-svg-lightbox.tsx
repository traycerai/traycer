import { useEffect, useState, type ReactNode } from "react";
import { PanZoomSvgViewer } from "@/editor-core/nodes/mermaid/pan-zoom-svg-viewer";
import { sanitizeUntrustedSvg } from "@/lib/images/untrusted-svg";

interface UntrustedSvgLightboxProps {
  readonly src: string;
  readonly alt: string;
}

type SvgState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly svg: string }
  | { readonly status: "error" };

export function UntrustedSvgLightbox(
  props: UntrustedSvgLightboxProps,
): ReactNode {
  const [state, setState] = useState<SvgState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch(props.src, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`SVG fetch failed (${response.status})`);
        }
        return response.text();
      })
      .then((source) => {
        setState({ status: "ready", svg: sanitizeUntrustedSvg(source) });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setState({ status: "error" });
      });
    return () => controller.abort();
  }, [props.src]);

  if (state.status === "loading") {
    return (
      <div
        className="size-full animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none"
        role="status"
        aria-label="Loading SVG"
      />
    );
  }
  if (state.status === "error") {
    return (
      <div
        className="flex size-full items-center justify-center rounded-lg bg-muted/60 px-4 text-center text-ui-sm text-muted-foreground"
        role="status"
        aria-label={
          props.alt.length > 0
            ? `${props.alt}: Couldn't display this SVG.`
            : "Couldn't display this SVG."
        }
      >
        Couldn&apos;t display this SVG.
      </div>
    );
  }
  return (
    <PanZoomSvgViewer
      svg={state.svg}
      source="sanitized"
      ariaLabel={props.alt.length > 0 ? props.alt : "SVG image"}
      className="rounded-lg"
    />
  );
}
