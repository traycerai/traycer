import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The app's custom `--text-*` typography tokens (src/index.css). Without
// this, tailwind-merge cannot classify `text-ui-sm` & friends, falls back
// to treating them as text COLORS, and silently drops them whenever a real
// color like `text-accent-foreground` joins the same cn(...) merge - the
// element then falls back to the inherited font size.
const CUSTOM_FONT_SIZE_TOKENS = [
  "badge",
  "code",
  "code-sm",
  "code-xs",
  "display",
  "micro",
  "overline",
  "title-lg",
  "title-md",
  "title-sm",
  "title-xs",
  "ui",
  "ui-base",
  "ui-lg",
  "ui-md",
  "ui-sm",
  "ui-xs",
];

// The app's safe-area spacing tokens (src/index.css). tailwind-merge's stock
// scales accept numbers, keywords and arbitrary values, so a bare token like
// `safe-bottom` matches nothing and the class falls through UNCLASSIFIED.
// Unclassified is safe - the class is never dropped - but it also never
// conflicts, so `h-safe-dvh` does not displace an `h-full` from earlier in the
// same merge and both reach the stylesheet, where source order decides. That
// failure is invisible on desktop, because every safe-area token collapses to
// zero there. Registering them is what makes the tokens ordinary overrides.
const SAFE_AREA_SPACING_TOKENS = [
  "safe-top",
  "safe-right",
  "safe-bottom",
  "safe-left",
  "safe-top-gutter",
  "safe-right-gutter",
  "safe-bottom-gutter",
  "safe-left-gutter",
];

// Viewport heights measured below the reserved status-bar strip. Sizing-only:
// they are replacements for `h-dvh` / `min-h-svh`, never for a padding.
const SAFE_AREA_HEIGHT_TOKENS = ["safe-dvh", "safe-svh"];

// The width counterpart, for a `fixed` surface that spans the screen.
const SAFE_AREA_WIDTH_TOKENS = ["safe-dvw"];

// The centre lines are positions, not lengths - each resolves to a percentage
// of the containing block - so they join the inset scales and nothing else.
const SAFE_AREA_INSET_TOKENS = [
  ...SAFE_AREA_SPACING_TOKENS,
  "safe-center-x",
  "safe-center-y",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: CUSTOM_FONT_SIZE_TOKENS }],
      p: [{ p: SAFE_AREA_SPACING_TOKENS }],
      px: [{ px: SAFE_AREA_SPACING_TOKENS }],
      py: [{ py: SAFE_AREA_SPACING_TOKENS }],
      pt: [{ pt: SAFE_AREA_SPACING_TOKENS }],
      pr: [{ pr: SAFE_AREA_SPACING_TOKENS }],
      pb: [{ pb: SAFE_AREA_SPACING_TOKENS }],
      pl: [{ pl: SAFE_AREA_SPACING_TOKENS }],
      m: [{ m: SAFE_AREA_SPACING_TOKENS }],
      mx: [{ mx: SAFE_AREA_SPACING_TOKENS }],
      my: [{ my: SAFE_AREA_SPACING_TOKENS }],
      mt: [{ mt: SAFE_AREA_SPACING_TOKENS }],
      mr: [{ mr: SAFE_AREA_SPACING_TOKENS }],
      mb: [{ mb: SAFE_AREA_SPACING_TOKENS }],
      ml: [{ ml: SAFE_AREA_SPACING_TOKENS }],
      h: [{ h: SAFE_AREA_HEIGHT_TOKENS }],
      "min-h": [{ "min-h": SAFE_AREA_HEIGHT_TOKENS }],
      "max-h": [{ "max-h": SAFE_AREA_HEIGHT_TOKENS }],
      w: [{ w: SAFE_AREA_WIDTH_TOKENS }],
      "min-w": [{ "min-w": SAFE_AREA_WIDTH_TOKENS }],
      "max-w": [{ "max-w": SAFE_AREA_WIDTH_TOKENS }],
      inset: [{ inset: SAFE_AREA_INSET_TOKENS }],
      "inset-x": [{ "inset-x": SAFE_AREA_INSET_TOKENS }],
      "inset-y": [{ "inset-y": SAFE_AREA_INSET_TOKENS }],
      top: [{ top: SAFE_AREA_INSET_TOKENS }],
      right: [{ right: SAFE_AREA_INSET_TOKENS }],
      bottom: [{ bottom: SAFE_AREA_INSET_TOKENS }],
      left: [{ left: SAFE_AREA_INSET_TOKENS }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Re-exported, not defined here. The implementation moved to
 * `lib/text/format-single-line.ts` so that a caller needing only the string
 * helper does not pull in `clsx` + `tailwind-merge` through this module - see
 * that file for why the chat find projection made that matter. Callers may
 * import from either place; there is one implementation.
 */
export {
  formatSingleLine,
  type FormatSingleLineOptions,
} from "@/lib/text/format-single-line";
