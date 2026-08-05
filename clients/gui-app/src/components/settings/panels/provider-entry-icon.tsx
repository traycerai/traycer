import type { ReactNode } from "react";

/**
 * A plugin row's artwork tile - the provider's OWN icon, or nothing.
 *
 * There is deliberately no fallback glyph. An earlier version drew a monogram
 * (initials over a hashed tone) for plugins with no artwork, which asserted a
 * visual identity the plugin never declared; sitting beside real vendor logos
 * it read as a rendering fault rather than as "this one has no icon". Most
 * providers ship no plugin artwork at all, so that fallback was the common
 * case, not the rare one.
 *
 * `reserveSpace` keeps the text column aligned in a MIXED list - some rows
 * with artwork, some without - by holding the same footprint empty. Rendering
 * nothing at all in that case would ragged-edge the names. The caller decides,
 * because it is a property of the whole list, not of one row.
 *
 * `iconUrl` is a `data:` URI produced by the host, never a filesystem path:
 * desktop CSP allows `data:` in `img-src` but not `file:`, and a path would
 * resolve to nothing against a remote host.
 */
export function ProviderEntryIcon(props: {
  /** Provider-supplied artwork, or null when this plugin ships none. */
  readonly iconUrl: string | null;
  /** True when some other row in the same list does have artwork. */
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
      // `object-contain` over `cover`: these are logos with their own padding
      // and aspect ratios (a 32x32 PNG next to a 1024x1024 one), and cropping
      // to fill would cut the mark. No background tone either - most ship
      // their own, and tinting behind a transparent logo reads as a bug.
      className="size-8 shrink-0 rounded-lg object-contain"
    />
  );
}
