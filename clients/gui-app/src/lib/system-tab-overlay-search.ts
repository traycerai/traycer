import { z } from "zod";

/**
 * Root-level search-param schema that drives the system-tab modal (Settings / History).
 * Reflected in the URL so refresh and back/forward restore *which* overlay is open.
 */
export const systemTabOverlaySearchSchema = z
  .object({
    settingsOverlay: z.literal(true).optional(),
    historyOverlay: z.literal(true).optional(),
  })
  .catch(() => ({}));

export type SystemTabOverlaySearch = z.infer<
  typeof systemTabOverlaySearchSchema
>;

type SystemOverlayParamKey = "settingsOverlay" | "historyOverlay";

/**
 * Root search keys that mark an overlay open.
 * Presence of a key in a stored href's search ⟺ that overlay is active (the schema only ever sets a key to `true`, and `withOverlayCleared` removes it).
 */
export const SYSTEM_OVERLAY_PARAM_KEYS: ReadonlyArray<SystemOverlayParamKey> = [
  "settingsOverlay",
  "historyOverlay",
];

type OverlayCleared<TPrev> = Omit<TPrev, SystemOverlayParamKey>;

/** Snapshot view used inside the React tree - defaults applied. */
export interface SystemTabOverlayView {
  readonly settingsOverlay: boolean;
  readonly historyOverlay: boolean;
}

const overlayViewSchema = systemTabOverlaySearchSchema.transform(
  (parsed): SystemTabOverlayView => ({
    settingsOverlay: parsed.settingsOverlay === true,
    historyOverlay: parsed.historyOverlay === true,
  }),
);
export function parseSystemTabOverlayView(raw: unknown): SystemTabOverlayView {
  return overlayViewSchema.parse(raw);
}

/**
 * Search-merge helper.
 * Returns prev with overlay keys removed - keeps unrelated params intact while clearing the modal state.
 */
export function withOverlayCleared<TPrev extends SystemTabOverlaySearch>(
  prev: TPrev,
): OverlayCleared<TPrev> {
  const {
    settingsOverlay: _settingsOverlay,
    historyOverlay: _historyOverlay,
    ...rest
  } = prev;
  return rest;
}
