import { useInstalledAppLevel2Form } from "@/hooks/ui/use-installed-app-level2-form";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";

/**
 * The form a task's tile list draws in. Off the installed app it is the sheet
 * behind the header's trigger, as it has always been.
 */
export function useMobileTileLevel2Form(): MobileLevel2Form {
  return useInstalledAppLevel2Form(1) ?? "bar";
}
