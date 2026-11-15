// Register the host and navigation mocks before the header imports them.
import "./bot-search-surface-support";
import { vi } from "vitest";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { MobileBotHeaderSlotProvider } from "@/components/layout/header/mobile-bot-header-slot";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import type { ReactNode } from "react";
import { Surface as UnthemedSurface } from "./bot-search-surface-view";

// The header's own host-backed chrome. These sit in this module so they are
// registered before the real header it imports is evaluated.
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => null,
}));

/** The real header and the real surface, under the theme the app's provider supplies. */
export function UnderHeader(): ReactNode {
  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "dark", themePreset: "neutral" }}
    >
      <MobileBotHeaderSlotProvider>
        <MobileAppHeader />
        <UnthemedSurface />
      </MobileBotHeaderSlotProvider>
    </ResolvedThemeContext.Provider>
  );
}
