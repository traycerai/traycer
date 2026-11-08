import { useEffect, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { rateLimitModelSlugIsAlias } from "@traycer/protocol/host/rate-limit/semantics";
import type { ModelOption } from "@/components/home/data/landing-options";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  useProvidersReadModelRoutesQuery,
  type ProvidersReadModelRoutesRequest,
} from "@/hooks/providers/use-providers-read-model-routes-query";
import type { HostRpcRegistry } from "@/lib/host";

/** The composer's selected model as it would run on `profile`. */
export type ModelForProfile = (profile: ProviderProfile) => ModelOption | null;

function hasFamilyScopedLimit(profile: ProviderProfile): boolean {
  return (
    profile.rateLimitLimitedScopes?.some((scope) => scope.family !== null) ??
    false
  );
}

function routeRequest(input: {
  readonly providerId: ProviderId | null;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly selectedModel: ModelOption | null;
  readonly workingDirectory: string | null;
}): ProvidersReadModelRoutesRequest | null {
  const { selectedModel, workingDirectory } = input;
  if (
    input.providerId !== "claude-code" ||
    selectedModel === null ||
    workingDirectory === null ||
    !rateLimitModelSlugIsAlias(selectedModel.slug)
  ) {
    return null;
  }
  // Only a family-scoped limit can stop gating once the route is known; a
  // shared window gates every model whatever the alias runs on.
  const profileIds = input.profiles
    .filter(hasFamilyScopedLimit)
    .map(profileCommitId)
    .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
  if (profileIds.length === 0) return null;
  return {
    providerId: "claude-code",
    workingDirectory,
    modelSlug: selectedModel.slug,
    profileIds,
  };
}

/**
 * The composer's selected model as it would run on each profile in the folder
 * its next run starts the CLI in.
 *
 * An alias such as `default` names no family, so every family-scoped limit
 * gates it. When the host holds a CLI handshake for exactly that profile and
 * folder, the alias is matched as the model it routes to there, until that
 * evidence expires on the host's clock - asking again does not extend it.
 * Anything else leaves the alias as it is, so the warning errs toward showing:
 * an older host, an unknown folder (a folderless chat, a worktree not created
 * yet), a read still pending or failed, or an answer past its expiry.
 */
export function useProfileRoutedModels(input: {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly providerId: ProviderId | null;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly selectedModel: ModelOption | null;
  readonly workingDirectory: string | null;
  readonly active: boolean;
}): ModelForProfile {
  const { selectedModel } = input;
  const supported = useHostSupportsMethod(
    input.hostId,
    "providers.readModelRoutes",
  );
  const request = input.active && supported ? routeRequest(input) : null;
  const query = useProvidersReadModelRoutesQuery({
    client: input.client,
    request,
  });
  const { refetch } = query;
  const routes = request === null ? [] : (query.data?.routes ?? []);
  // A deadline snapshot stays stable between expiries, but judges a newly
  // selected cache entry immediately. A mount-time clock could revive an
  // already-expired route when the composer returns to that entry.
  const expiredThrough = useSyncExternalStore(
    (onExpiry) => {
      const now = Date.now();
      let nextExpiry: number | null = null;
      for (const route of routes) {
        if (route.resolvedModel === null || route.expiresAt <= now) continue;
        nextExpiry =
          nextExpiry === null
            ? route.expiresAt
            : Math.min(nextExpiry, route.expiresAt);
      }
      if (nextExpiry === null) return () => undefined;
      const timer = setTimeout(onExpiry, Math.max(0, nextExpiry - Date.now()));
      return () => clearTimeout(timer);
    },
    () => {
      const now = Date.now();
      let expired = 0;
      for (const route of routes) {
        if (route.resolvedModel !== null && route.expiresAt <= now) {
          expired = Math.max(expired, route.expiresAt);
        }
      }
      return expired;
    },
    () => Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (expiredThrough > 0) void refetch({ cancelRefetch: false });
  }, [expiredThrough, refetch]);
  const live = new Map<string | null, string>();
  for (const route of routes) {
    if (route.resolvedModel === null || route.expiresAt <= expiredThrough)
      continue;
    live.set(route.profileId, route.resolvedModel);
  }
  return (profile) => {
    if (selectedModel === null) return null;
    const resolvedModel = live.get(profileCommitId(profile));
    return resolvedModel === undefined
      ? selectedModel
      : { ...selectedModel, slug: resolvedModel, label: resolvedModel };
  };
}
