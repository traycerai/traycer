export const appearanceMutationKeys = {
  /**
   * Applying a curated wallpaper. Keyed, not anonymous, because the gallery
   * reads its pending entry back with `useMutationState` - that is what lets a
   * reopened panel still show the spinner on a download that outlived it.
   */
  applyCuratedWallpaper: () =>
    ["appearance", "apply-curated-wallpaper"] as const,
};
