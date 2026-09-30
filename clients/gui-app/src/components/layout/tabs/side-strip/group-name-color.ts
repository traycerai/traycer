import { useLayoutEffect, type RefObject } from "react";
import { formatHex, interpolate, parse, wcagContrast } from "culori";
import { useThemeRevision } from "@/providers/use-theme-revision";

/** WCAG AA for normal text. */
const MIN_CONTRAST = 4.5;
const STEPS = 20;

/** The custom property a block's header name reads; see `SIDE_TAB_GROUP_NAME_CLASS`. */
const GROUP_NAME_PROPERTY = "--side-tab-group-name";

/**
 * The group's colour moved toward `foreground` in the smallest of twenty steps
 * that reads at 4.5:1 on `block`, as the hex the header paints. Contrast is
 * measured on the clamped hex, the colour that is painted, and `foreground`
 * itself is the last step. `null` when a colour does not parse.
 */
function readableGroupName(
  groupColor: string,
  block: string,
  foreground: string,
): string | null {
  const group = parse(groupColor);
  const ink = parse(foreground);
  if (group === undefined || ink === undefined || parse(block) === undefined) {
    return null;
  }
  const towardForeground = interpolate([group, ink], "oklab");
  for (let step = 0; step <= STEPS; step += 1) {
    const candidate = formatHex(towardForeground(step / STEPS));
    if (wcagContrast(candidate, block) >= MIN_CONTRAST) return candidate;
  }
  return formatHex(ink);
}

/**
 * Sets the block's header-name colour from what the block paints now: its
 * resolved tinted fill and its text colour. The fill depends on the theme and
 * on the strip's ground (`md` swaps the canvas for the shell ground), so it is
 * read again when the theme changes and when the block resizes. Until it is
 * set, and where the fill does not resolve, the name keeps the group's colour.
 */
export function useGroupNameColor(
  blockRef: RefObject<HTMLElement | null>,
  groupColor: string,
): void {
  const themeRevision = useThemeRevision();
  useLayoutEffect(() => {
    const block = blockRef.current;
    if (block === null) return undefined;
    const apply = (): void => {
      const painted = getComputedStyle(block);
      const name = readableGroupName(
        groupColor,
        painted.backgroundColor,
        painted.color,
      );
      if (name === null) block.style.removeProperty(GROUP_NAME_PROPERTY);
      else block.style.setProperty(GROUP_NAME_PROPERTY, name);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(block);
    return () => {
      observer.disconnect();
    };
  }, [blockRef, groupColor, themeRevision]);
}
