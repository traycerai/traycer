import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Where a composer surface's initial `ChatRunSettings` came from, replacing
 * the six-positional-params + `seedIsAuthoritative` boolean every
 * `useComposerToolbarStore` caller used to thread separately (S11):
 *
 * - `none`: no seed at all (a brand-new node with nothing to carry forward).
 * - `fallback`: a picker default - a persisted fallback store
 *   (composer-run-settings-store's epic/global last-run, a landing draft's
 *   frozen snapshot, a settings-store default, ...) that is NEITHER
 *   host-scoped NOR kept in sync with live profile removals. Its `profileId`
 *   is validated against `client`'s live `providers.list` and corrected to
 *   ambient if the profile no longer exists - nobody is relying on it.
 * - `authoritative`: a real commitment - the surface's OWN settings (e.g. a
 *   chat's `chat.settings`). Its `profileId` is passed through unvalidated so
 *   `useProviderReauthGate` can detect and block a dead pin with a banner,
 *   never silently swap it to ambient behind the user's back.
 */
export type ComposerSeedSourceKind = "none" | "fallback" | "authoritative";

export type ComposerSeedSource =
  | { readonly kind: "none" }
  | {
      readonly kind: "fallback";
      readonly settings: ChatRunSettings;
      /** Scopes the fallback `profileId`'s liveness check to the SAME host
       *  the composer will actually run turns on. `null` while that host's
       *  client is still resolving (or when the settings seed is `null`, see
       *  `fallbackSeedSource`) - the validation stays inert until it's ready. */
      readonly client: HostClient<HostRpcRegistry> | null;
    }
  | { readonly kind: "authoritative"; readonly settings: ChatRunSettings };

/**
 * Builds a `fallback`/`none` seed source from a nullable settings value - the
 * shape every "never authoritative" composer surface needs (fork dialogs,
 * the landing composer, add-node/new-conversation, ...): `settings === null`
 * collapses to `none` regardless of `client`, since there is nothing to
 * validate against it.
 */
export function fallbackSeedSource(
  settings: ChatRunSettings | null,
  client: HostClient<HostRpcRegistry> | null,
): ComposerSeedSource {
  return settings === null
    ? { kind: "none" }
    : { kind: "fallback", settings, client };
}

/**
 * Builds the seed source for a surface that CAN carry its own authoritative
 * settings (a chat composer's `chat.settings`) but seeds from a fallback
 * before those hydrate: `authoritativeSettings` wins outright when present,
 * else `fallbackSettings` (see `fallbackSeedSource`).
 */
export function authoritativeOrFallbackSeedSource(
  authoritativeSettings: ChatRunSettings | null,
  fallbackSettings: ChatRunSettings | null,
  client: HostClient<HostRpcRegistry> | null,
): ComposerSeedSource {
  return authoritativeSettings !== null
    ? { kind: "authoritative", settings: authoritativeSettings }
    : fallbackSeedSource(fallbackSettings, client);
}
