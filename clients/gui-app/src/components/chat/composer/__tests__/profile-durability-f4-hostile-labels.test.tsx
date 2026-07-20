import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => ({
    isHostReady: true,
    entries: new Map(),
  }),
}));

const VERY_LONG_LABEL = "A".repeat(2000);
const RTL_CONTROL_LABEL = "\u202Ework\u202C\u0000\u200B\u200E\u200F-profile";
const HTML_LOOKING_LABEL = '<img src=x onerror="alert(1)">';
const SCRIPT_LOOKING_LABEL = "</span><script>alert(1)</script>";

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  rateLimitStatus: "ok" | "hard_limit",
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

describe("F4: hostile profile labels in the rate-limit banner", () => {
  afterEach(cleanup);

  it.each([
    ["2000-char label", VERY_LONG_LABEL],
    ["RTL override + control chars", RTL_CONTROL_LABEL],
    ["HTML-looking label", HTML_LOOKING_LABEL],
    ["script-tag-looking label", SCRIPT_LOOKING_LABEL],
  ])(
    "renders %s as escaped text with a complete accessible name",
    (_name, label) => {
      const current = profile("current", "managed", "Current", "hard_limit");
      const target = profile("target", "managed", label, "ok");
      const destination = {
        profile: target,
        profileId: target.profileId,
        selectable: true,
      } as const;
      const { container } = render(
        <TooltipProvider delayDuration={0}>
          <ProfileRateLimitSwitchBanner
            harnessId="claude"
            providerId="claude-code"
            severity="hard_limit"
            limitedFamilies={[]}
            current={current}
            profiles={[current, target]}
            destinations={[destination]}
            primaryTarget={destination}
            runTargetHostId={null}
            onSwitchProfile={() => undefined}
            affectedChatCount={1}
            onSwitchProfileForTask={() => undefined}
            onDismiss={() => undefined}
          />
        </TooltipProvider>,
      );

      expect(
        screen.getByRole("button", { name: `Switch to ${label}` }),
      ).toBeDefined();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain(label);
    },
  );
});
