/**
 * The data-handling notice: the one text every custody sentence links to with
 * `How Traycer handles this`. One home, here, so the desktop, the web client
 * and the dashboard show the same words. Where a value goes is each screen's
 * own sentence, not this one's. Processing locations and backup horizons are stated only once they
 * are verified; until then the notice says so rather than guessing.
 */
export const DATA_HANDLING_NOTICE = {
  title: "How Traycer handles this",
  recipients: [
    "Traycer's cloud stores the value encrypted.",
    "Sandboxes running Personal or a team use the value without seeing it.",
  ],
  authority:
    "Share a work credential only if you have the authority to share it.",
  deletionLimits:
    "Removing a value stops access from then on. It cannot take back copies a computer already made, task data already published, or exports already shared.",
  processingLocations: "Where Traycer processes this data is not yet stated.",
  backupHorizons: "How long backups keep this data is not yet stated.",
} as const;
