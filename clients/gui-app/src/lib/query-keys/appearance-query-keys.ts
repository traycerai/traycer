export const appearanceQueryKeys = {
  /**
   * The curated wallpaper catalog. No arguments: one manifest URL per build,
   * held for the session (`staleTime: Infinity`) and refetched only by the
   * gallery's own refresh button.
   */
  curatedWallpapers: () => ["appearance", "curated-wallpapers"] as const,
};
