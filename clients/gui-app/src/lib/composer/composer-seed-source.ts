import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Where a composer surface's initial `ChatRunSettings` came from, replacing the six-positional-params + `seedIsAuthoritative` boolean every `useComposerToolbarStore` caller used to thread separately (S11):
 */
export type ComposerSeedSourceKind = "none" | "fallback" | "authoritative";

export type ComposerSeedSource =
  | { readonly kind: "none" }
  | {
      readonly kind: "fallback";
      readonly settings: ChatRunSettings;
      /**
       * Scopes the fallback `profileId`'s liveness check to the SAME host the composer will actually run turns on.
       * `null` while that host's client is still resolving (or when the settings seed is `null`, see `fallbackSeedSource`) - the validation stays inert until it's ready.
       */
      readonly client: HostClient<HostRpcRegistry> | null;
    }
  | { readonly kind: "authoritative"; readonly settings: ChatRunSettings };

/**
 * Builds a `fallback`/`none` seed source from a nullable settings value - the shape every "never authoritative" composer surface needs (fork dialogs, the landing composer, add-node/new-conversation, ...): `settings === null` collapses to `none` regardless of.
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
 * Builds the seed source for a surface that CAN carry its own authoritative settings (a chat composer's `chat.settings`) but seeds from a fallback before those hydrate: `authoritativeSettings` wins outright when present, else `fallbackSettings` (see.
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
