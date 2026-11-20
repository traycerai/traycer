import type { OwnershipReceipt } from "@/components/settings/panels/host-overview-settings-card";

/** A receipt that holds nothing: for suites that never draw the line. */
export const NO_RECEIPT: OwnershipReceipt = {
  line: null,
  show: () => undefined,
  giveStarted: () => undefined,
};
