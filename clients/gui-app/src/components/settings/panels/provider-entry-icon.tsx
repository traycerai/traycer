import type { ReactNode } from "react";

/** `iconUrl` is a `data:` URI produced by the host, never a filesystem path: desktop CSP allows `data:` in
 * `img-src` but not `file:`, and a path would resolve to nothing against a remote host. */
export function ProviderEntryIcon(props: {
  /** Provider-supplied artwork, or null when this plugin ships none. */
  readonly iconUrl: string | null;
  readonly reserveSpace: boolean;
}): ReactNode {
  if (props.iconUrl === null) {
    return props.reserveSpace ? (
      <span aria-hidden className="size-8 shrink-0" />
    ) : null;
  }
  return (
    <img
      src={props.iconUrl}
      alt=""
      aria-hidden
      // `object-contain` over `cover`: these are logos with their own padding and aspect ratios (a 32x32 PNG next to
      // a 1024x1024 one), and cropping to fill would cut the mark.
      className="size-8 shrink-0 rounded-lg object-contain"
    />
  );
}
