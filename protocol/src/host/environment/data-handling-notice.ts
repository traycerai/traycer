/**
 * The data-handling notice: the one text every custody sentence links to with
 * `How Traycer handles this`. One home, here, so the desktop, the web client
 * and the dashboard (through the common package's re-export) show the same
 * words. Processing locations and backup horizons are stated only once they
 * are verified; until then the notice says so rather than guessing.
 */
export const DATA_HANDLING_NOTICE = {
  title: "How Traycer handles this",
  recipients: [
    "Traycer's cloud broker stores the value encrypted.",
    "The computers running this configuration receive the value, and their tools and agents can read it.",
    "The sandboxes running this configuration use the value through the broker.",
  ],
  destinations:
    "A Personal value reaches only the computers and sandboxes that run your Personal configuration. A team value reaches every computer and sandbox that runs the team's configuration.",
  authority:
    "Share a work credential only if you have the authority to share it.",
  deletionLimits:
    "Removing a value stops access from then on. It cannot take back copies a computer already made, task data already published, or exports already shared.",
  processingLocations: "Where Traycer processes this data is not yet stated.",
  backupHorizons: "How long backups keep this data is not yet stated.",
} as const;
