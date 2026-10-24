import { DATA_HANDLING_NOTICE } from "@traycer/protocol/host/environment/data-handling-notice";

/**
 * The protocol notice as one string for `HowTraycerHandlesThis`. The
 * constant is imported, never copied.
 */
export function dataHandlingNoticeText(): string {
  return [
    ...DATA_HANDLING_NOTICE.recipients,
    DATA_HANDLING_NOTICE.destinations,
    DATA_HANDLING_NOTICE.authority,
    DATA_HANDLING_NOTICE.deletionLimits,
    DATA_HANDLING_NOTICE.processingLocations,
    DATA_HANDLING_NOTICE.backupHorizons,
  ].join(" ");
}
