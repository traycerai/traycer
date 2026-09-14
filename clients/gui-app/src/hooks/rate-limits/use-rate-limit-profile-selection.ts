import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { useShallow } from "zustand/react/shallow";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  selectLastProfileByHarness,
  useComposerHarnessMemoryStore,
} from "@/stores/composer/composer-harness-memory-store";
import {
  useLayoutStore,
  type StatusBarHostShownProfiles,
} from "@/stores/settings/layout-store";

/**
 * Everything the usage surfaces need to decide WHICH ACCOUNTS a provider's
 * readings describe, resolved once for one host.
 *
 * Both halves are keyed by the host the surface is showing, and that is the
 * point of resolving them together: a profile id names a credential on one
 * machine, so the checked list and the last-used memory for host A say
 * nothing about host B, and a surface that read either for the wrong host
 * would draw one machine's account under another's name.
 */
export interface RateLimitProfileSelection {
  /**
   * The accounts checked `Show in status bar` on this host, per provider. A
   * provider with no entry has nothing checked and falls through to
   * `lastProfileByHarness`.
   */
  readonly shownProfiles: StatusBarHostShownProfiles;
  /**
   * The profile last picked in a composer on this host, per harness - the
   * strip's answer for a provider with nothing checked.
   */
  readonly lastProfileByHarness: Readonly<
    Partial<Record<ChatRunSettings["harnessId"], string | null>>
  >;
}

/**
 * One reactive snapshot shared by every usage surface bound to `hostId`: the
 * strip and its panel, the header glyph and its panel, the background refresh
 * targets, and Layout's passive preview.
 *
 * `hostId` is the host the CALLER is showing - the watch scope's for the strip
 * and the header, the app-wide host for the background queue - and is passed
 * rather than read here, because the two are not the same host under an
 * explicit watch pick and only the caller knows which one it is drawing.
 *
 * The focused chat's own composer settings are deliberately NOT an input any
 * more. They used to be, and they were read for a chat on ANY host, so a tile
 * bound to another machine made the strip's segment jump to an account that
 * host does not have and fall to ambient. The strip now describes what was
 * checked for it, or what was last used on its own host; a chat's account is
 * the chat's business.
 */
export function useRateLimitProfileSelection(
  hostId: string | null,
): RateLimitProfileSelection {
  const shownProfiles = useLayoutStore(
    useShallow((state) =>
      hostId === null
        ? NO_HOST_SHOWN_PROFILES
        : (state.statusBar.rateLimits.shownProfiles[hostId] ??
          NO_HOST_SHOWN_PROFILES),
    ),
  );
  const lastProfileByHarness = useComposerHarnessMemoryStore(
    useShallow((state) => selectLastProfileByHarness(state, hostId)),
  );
  return { shownProfiles, lastProfileByHarness };
}

/** Stable identity for a host with nothing checked, or no host at all. */
const NO_HOST_SHOWN_PROFILES: StatusBarHostShownProfiles = {};

/**
 * The accounts one provider's strip segments describe, in the order the strip
 * draws them. Never empty.
 *
 * The checked list wins when any of it still names a profile the provider
 * reports: the result is those profiles in the PROVIDER's order with the
 * ambient login last, not the order they were checked in, so two windows
 * with the same checks draw the same strip. A checked id whose profile has
 * since been removed is skipped, not drawn as ambient.
 *
 * With nothing checked - or nothing checked that still exists - the provider
 * draws ONE account, and the chain is: the profile last picked in a composer
 * on this host, if the provider still has it; else the provider's first
 * profile; else ambient (`null`), which is also the only answer a provider
 * with no profiles at all can give.
 */
export function resolveStatusBarProfileIds(
  selection: RateLimitProfileSelection,
  providerId: RateLimitProviderId,
  profiles: ReadonlyArray<ProviderProfile>,
): ReadonlyArray<string | null> {
  const checked = selection.shownProfiles[providerId] ?? [];
  const shown = profiles
    .filter((profile) => checked.includes(profileCommitId(profile)))
    .map(profileCommitId);
  if (shown.length > 0) {
    // Ambient last, wherever the host lists it.
    return [
      ...shown.filter((profileId) => profileId !== null),
      ...shown.filter((profileId) => profileId === null),
    ];
  }
  return [resolveFallbackProfileId(selection, providerId, profiles)];
}

/**
 * The one account a provider reads when nothing is checked for it - and the
 * account the surfaces with room for exactly one reading per provider (the
 * header glyph, Layout's limits list) always take: the first of what the strip
 * would draw.
 */
export function resolveRateLimitProfileId(
  selection: RateLimitProfileSelection,
  providerId: RateLimitProviderId,
  profiles: ReadonlyArray<ProviderProfile>,
): string | null {
  return resolveStatusBarProfileIds(selection, providerId, profiles)[0];
}

function resolveFallbackProfileId(
  selection: RateLimitProfileSelection,
  providerId: RateLimitProviderId,
  profiles: ReadonlyArray<ProviderProfile>,
): string | null {
  const harnessId = providerIdToGuiHarnessId(providerId);
  const lastUsed = selection.lastProfileByHarness[harnessId] ?? null;
  // A remembered id that no longer addresses a profile here falls through to
  // the next rule rather than short-circuiting to ambient: the memory is
  // about a credential that is gone, and the provider still has others.
  if (
    lastUsed !== null &&
    profiles.some(
      (profile) => profile.kind === "managed" && profile.profileId === lastUsed,
    )
  ) {
    return lastUsed;
  }
  const first = profiles.at(0);
  return first === undefined ? null : profileCommitId(first);
}
