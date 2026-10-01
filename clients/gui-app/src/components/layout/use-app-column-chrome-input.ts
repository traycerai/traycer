import type { AppColumnChromeInput } from "@/components/layout/header/app-title-band-kind";
import { isFramelessDesktop } from "@/components/layout/header/title-bar-drag";
import { useTabStripPlacement } from "@/components/layout/tabs/use-tab-strip-placement";
import { resolveDesktopPlatform } from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * What decides the app column's chrome in this window: the effective tab strip
 * placement (`"top"` wherever the mobile header stands in for the desktop
 * chrome, so the header and the strip never both render), the desktop
 * platform, and whether the window is frameless.
 */
export function useAppColumnChromeInput(): AppColumnChromeInput {
  const placement = useTabStripPlacement();
  const runnerHost = useRunnerHostOrNull();
  return {
    placement,
    platform: runnerHost === null ? null : resolveDesktopPlatform(runnerHost),
    frameless: isFramelessDesktop(),
  };
}
