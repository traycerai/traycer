import { useEffect, useState } from "react";
import { sanitizeUntrustedSvg } from "@/lib/images/untrusted-svg";

type SvgSanitizationState = {
  readonly source: string;
  readonly status: "ready" | "error";
  readonly src: string | null;
};

export function useSanitizedSvg(
  src: string,
  enabled: boolean,
): {
  readonly status: "loading" | "ready" | "error";
  readonly src: string | null;
} {
  const [state, setState] = useState<SvgSanitizationState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    void fetch(src, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`SVG fetch failed (${response.status})`);
        }
        return response.text();
      })
      .then((source) => {
        if (active) {
          setState({
            source: src,
            status: "ready",
            src: svgDataUrl(sanitizeUntrustedSvg(source)),
          });
        }
      })
      .catch((error: unknown) => {
        if (
          active &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setState({ source: src, status: "error", src: null });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [src, enabled]);

  if (!enabled) return { status: "ready", src: null };
  const current = state?.source === src ? state : null;
  return current ?? { status: "loading", src: null };
}

function svgDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
