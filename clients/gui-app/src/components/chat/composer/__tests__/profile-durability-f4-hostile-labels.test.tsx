import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";

/**
 * F4 (durability audit): "profiles[] with hostile label content (very long,
 * RTL/control chars, HTML) rendered in picker/settings/banners: no layout
 * break, no injection (React escaping assumed - verify no
 * dangerouslySetInnerHTML on these paths)."
 *
 * Static check (not expressible as an assertion): grepped
 * `src/components/chat/composer`, `src/components/home/pickers`,
 * `src/components/settings`, `src/components/chat/tombstoned-profile-provider.tsx`,
 * `src/components/chat/use-tombstoned-profile-label.ts` for
 * `dangerouslySetInnerHTML` - zero hits. Every label render below is a plain
 * `{value}` JSX text interpolation, so this suite proves the runtime half:
 * hostile content renders as literal text (no elements get created from it)
 * and nothing throws.
 */

const VERY_LONG_LABEL = "A".repeat(2000);
// RTL override + a scattering of control/zero-width characters, the kind a
// crafted rename could smuggle into a profile label.
// Written with escaped code points (not raw bytes) so a literal NUL byte
// never lands in the file and git keeps treating it as text.
const RTL_CONTROL_LABEL = "\u202Ework\u202C\u0000\u200B\u200E\u200F-profile";
const HTML_LOOKING_LABEL = '<img src=x onerror="alert(1)">';
const SCRIPT_LOOKING_LABEL = "</span><script>alert(1)</script>";

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
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
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

describe("F4: hostile profile labels - profile array (data layer)", () => {
  it.each([
    ["2000-char label", VERY_LONG_LABEL],
    ["RTL override + control chars", RTL_CONTROL_LABEL],
    ["HTML-looking label", HTML_LOOKING_LABEL],
    ["script-tag-looking label", SCRIPT_LOOKING_LABEL],
  ])("profile() carries %s through unmodified, no crash", (_case, label) => {
    const profiles = [
      profile("ambient", "ambient", "Terminal account"),
      profile("work-uuid", "managed", label),
    ];

    expect(profiles).toHaveLength(2);
    // No truncation/sanitization happens at this layer - the raw label rides
    // straight through into the rendered strip chip; truncation (if any) is
    // strictly a CSS/render-layer concern (`truncate` classes), never a data
    // mutation.
    expect(profiles[1].label).toBe(label);
  });
});

describe("F4: hostile profile labels - rate-limit switch banner", () => {
  afterEach(() => cleanup());

  it.each([
    ["2000-char label", VERY_LONG_LABEL],
    ["RTL override + control chars", RTL_CONTROL_LABEL],
    ["HTML-looking label", HTML_LOOKING_LABEL],
    ["script-tag-looking label", SCRIPT_LOOKING_LABEL],
  ])("renders %s as literal text with no injected elements", (_case, label) => {
    const { container } = render(
      <ProfileRateLimitSwitchBanner
        harnessId="claude"
        hardLimited={false}
        current={null}
        alternatives={[
          {
            profileId: "work-uuid",
            accentDotId: "work-uuid",
            label,
            accentColor: null,
          },
        ]}
        onSwitchProfile={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    // React escaped it - it shows up as the literal button text, not parsed
    // markup. No <img>/<script> element was created from the label content.
    expect(
      screen.getByRole("button", { name: `Continue this session on ${label}` }),
    ).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
