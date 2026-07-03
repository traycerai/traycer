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

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: CUSTOM_FONT_SIZE_TOKENS }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface FormatSingleLineOptions {
  maxLength: number;
  ellipsis: string;
}

/**
 * Trim, collapse whitespace, and truncate with an ellipsis. Returns the
 * empty string when the input has no non-whitespace characters.
 */
export function formatSingleLine(
  input: string,
  options: FormatSingleLineOptions,
): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  const singleLine = trimmed.replace(/\s+/g, " ");
  const { maxLength, ellipsis } = options;
  if (singleLine.length <= maxLength) return singleLine;
  const cutoff = Math.max(0, maxLength - ellipsis.length);
  return `${singleLine.slice(0, cutoff)}${ellipsis}`;
}
