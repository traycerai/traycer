export const traycerInfo = {
  mainWebsiteFeatures: "https://traycer.ai/#features",
  mainWebsiteEnterprise: "https://traycer.ai/enterprise",
  mainWebsiteContactUs: "https://traycer.ai/contact-us",
  /**
   * Where a user is sent to get a newer Traycer by hand - the FALLBACK remedy
   * when a host says this client is too old but the in-app updater cannot
   * reach a build that fixes it (no update bridge, an idle or errored
   * updater, a channel this installation does not follow, or an install
   * location that cannot be written).
   *
   * GitHub Releases for BOTH channels, not a marketing download page. It is
   * the only destination this repository can actually vouch for: it is what
   * `docs/install.mdx` sends people to, it is where the release workflows
   * publish, and it lists prereleases alongside stable so one link serves an
   * `rc` remedy and a `stable` one. A `traycer.ai/download` page appears
   * nowhere else in either repository, and this link is the ONLY affordance
   * on a blocking modal - an unverified URL there is a dead end at exactly
   * the moment the user has no other route.
   *
   * A FIRST-PARTY CONSTANT, never a host-supplied URL. The client identity a
   * host reads is unauthenticated and so is anything it might say back, so a
   * rejection must not be able to point a user at an address of the host's
   * choosing - "your app is too old, download it from here" is the exact
   * shape that attack would take.
   */
  releasesPage: "https://github.com/traycerai/traycer/releases",
} as const;
