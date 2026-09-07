export const traycerInfo = {
  mainWebsiteFeatures: "https://traycer.ai/#features",
  mainWebsiteEnterprise: "https://traycer.ai/enterprise",
  mainWebsiteContactUs: "https://traycer.ai/contact-us",
  /**
   * GitHub Releases for both channels, not a marketing download page.
   * A `traycer.ai/download` page appears nowhere else in either repository, and this link is the only affordance on a blocking modal - an unverified URL there is a dead end at exactly the moment the user has no other route.
   */
  releasesPage: "https://github.com/traycerai/traycer/releases",
} as const;
