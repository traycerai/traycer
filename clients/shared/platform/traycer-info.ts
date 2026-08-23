export const traycerInfo = {
  mainWebsiteFeatures: "https://traycer.ai/#features",
  mainWebsiteEnterprise: "https://traycer.ai/enterprise",
  mainWebsiteContactUs: "https://traycer.ai/contact-us",
  /**
   * The official download page - the FALLBACK remedy when a host says this
   * client is too old but the in-app updater cannot reach a build that fixes
   * it (no update bridge, or the required build is on a channel this
   * installation does not follow).
   *
   * A FIRST-PARTY CONSTANT, never a host-supplied URL. The client identity a
   * host reads is unauthenticated and so is anything a host might say back, so
   * a rejection must not be able to point a user at an address of the host's
   * choosing - "your app is too old, download it from here" is the exact shape
   * of the attack that would be.
   */
  mainWebsiteDownload: "https://traycer.ai/download",
  /**
   * Where prereleases are published. The download page above carries the
   * stable line; an RC-channel remedy needs the releases list, which is the
   * only first-party place an rc build is downloadable from.
   */
  releasesPage: "https://github.com/traycerai/traycer/releases",
} as const;
