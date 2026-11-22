/**
 * The team's track set as main answers it: the set's manifest with a signed
 * link in place of every sample path. `manifest` crosses unread and the
 * renderer validates it. A failure has one answer whatever its reason, and the
 * reason stays in main's log.
 */
export type SoundtrackSetReadResult =
  | { readonly kind: "ok"; readonly manifest: unknown }
  | { readonly kind: "unavailable" };
