import { useEffect, useState, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
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
        className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground"
        role="status"
      >
        <ImageOff className="size-8" aria-hidden />
        <span className="text-ui-sm">SVG could not be displayed safely</span>
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
