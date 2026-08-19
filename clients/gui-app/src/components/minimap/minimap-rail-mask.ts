export function resolveMinimapRailMaskClassName(
  hasBefore: boolean,
  hasAfter: boolean,
): string | undefined {
  if (hasBefore && hasAfter) {
    return "[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1.25rem,black_calc(100%_-_1.25rem),transparent)] [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem,black_calc(100%_-_1.25rem),transparent)]";
  }
  if (hasBefore) {
    return "[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)] [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]";
  }
  if (hasAfter) {
    return "[-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%_-_1.25rem),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%_-_1.25rem),transparent)]";
  }
  return undefined;
}
