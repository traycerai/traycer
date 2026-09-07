import { tabRequestClose } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";

/** The returned function is module-stable, so callers can pass it to effect/callback dep arrays without churn. */
export function useTabCloseCommand(): (tab: HeaderTab) => void {
  return tabRequestClose;
}
