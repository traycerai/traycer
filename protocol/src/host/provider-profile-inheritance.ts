import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";
import { spendScopeKeySchema } from "./provider-credential-home-schemas";
import type { SpendScopeKey } from "./provider-credential-home-schemas";

/** Compare provider-stated spend scope, never display identity. */
export function spendScopeKeysEqual(
  left: SpendScopeKey,
  right: SpendScopeKey,
): boolean {
  if (left.providerId !== right.providerId) return false;
  if ("accountId" in left && "accountId" in right) {
    return (
      left.accountId === right.accountId &&
      left.organizationId === right.organizationId
    );
  }
  return "email" in left && "email" in right && left.email === right.email;
}

export type InheritedProfileResolution =
  | { readonly kind: "match"; readonly profileId: string | null }
  | { readonly kind: "not-on-destination" }
  | { readonly kind: "source-unidentified" };

/** A host-local row id is never evidence that two hosts spend the same account. */
export function resolveInheritedProfile(
  sourceKey: SpendScopeKey | null,
  destinationProfiles: readonly {
    readonly profileId: string | null;
    readonly spendScopeKey: SpendScopeKey | null;
  }[],
): InheritedProfileResolution {
  if (sourceKey === null) return { kind: "source-unidentified" };
  const match = destinationProfiles.find(
    (profile) =>
      profile.spendScopeKey !== null &&
      spendScopeKeysEqual(sourceKey, profile.spendScopeKey),
  );
  return match === undefined
    ? { kind: "not-on-destination" }
    : { kind: "match", profileId: match.profileId };
}

/** A known selection carries its key; an unresolved cross-host source is explicit. */
export const profileBindingSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("key"), key: spendScopeKeySchema }),
    z.strictObject({ kind: z.literal("source-unidentified") }),
  ]),
);
export type ProfileBinding = z.infer<typeof profileBindingSchema>;

export function profileBindingsEqual(
  left: ProfileBinding | undefined,
  right: ProfileBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (
    left.kind === "source-unidentified" ||
    right.kind === "source-unidentified"
  )
    return left.kind === right.kind;
  return spendScopeKeysEqual(left.key, right.key);
}

const managedProfileProviderIds = [
  "claude-code",
  "codex",
  "grok",
  "antigravity",
] as const;
export type ManagedProfileProviderId =
  (typeof managedProfileProviderIds)[number];

/** Providers whose execution is bound to a selectable credential home. */
export function providerSupportsManagedProfiles(
  providerId: string,
): providerId is ManagedProfileProviderId {
  return managedProfileProviderIds.some(
    (candidate) => candidate === providerId,
  );
}
