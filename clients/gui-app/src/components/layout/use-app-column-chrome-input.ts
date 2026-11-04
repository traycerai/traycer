import type { AppColumnChromeInput } from "@/components/layout/header/app-title-band-kind";
import { isFramelessDesktop } from "@/components/layout/header/title-bar-drag";
import { useTabStripPlacement } from "@/components/layout/tabs/use-tab-strip-placement";
import { resolveDesktopPlatform } from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * What decides the app column's chrome in this window: the effective tab strip
 * placement, the desktop platform, and whether the window is frameless. The
 * phone shell's strip takes `PHONE_SHELL_STRIP_CHROME` instead of this answer.
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
