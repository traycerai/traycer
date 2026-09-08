import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProviderId } from "@/components/home/data/landing-options";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  useComposerHarnessMemoryStore,
  type ResolvedHarnessSwitch,
} from "@/stores/composer/composer-harness-memory-store";
import { profileCommitId } from "@/components/providers/provider-profile-model";

/**
 * D09's per-profile `defaultModel` seed: the profile's own `endpoint.model`
 * from its `providers.list` row (also carried by the ambient/default-account
 * row when it has an endpoint configured), or `null` when that profile has
 * none or isn't in `profiles`. Wire knowledge belongs here, in the reader the
 * toolbar calls, never in the memory store (`resolveHarnessSwitch` stays a
 * pure persisted-map lookup with no `ProviderProfile` import).
 */
export function defaultModelForProfile(
  profiles: ReadonlyArray<ProviderProfile>,
  profileId: string | null,
): string | null {
  const profile = profiles.find(
    (candidate) => profileCommitId(candidate) === profileId,
  );
  return profile?.endpoint?.model ?? null;
}

/**
 * Applies D09's default-model seeding around a harness-switch resolution:
 * when the memory store found no remembered model for the (harness, profile)
 * pair (the `""` unresolved sentinel `resolveHarnessSwitch` returns), the
 * profile's own `defaultModel` seeds the composer instead of leaving it
 * empty. A no-op once any model has ever been committed for that pair, or
 * when the profile carries no `defaultModel` - `resolved` then passes through
 * unchanged, same as before D09.
 */
export function seedResolvedHarnessSwitch(
  resolved: ResolvedHarnessSwitch,
  defaultModel: string | null,
): ResolvedHarnessSwitch {
  if (resolved.modelSlug.length > 0 || defaultModel === null) return resolved;
  return { ...resolved, modelSlug: defaultModel };
}

/**
 * The single memory-aware commit funnel behind every `(harness, model)` change.
 * Reads the per-provider / per-(provider, model) memory, then drives the toolbar
 * store's combined `applyComposerSelection` so the switch restores what was last
 * used for that harness - model, thinking effort, and service tier - falling
 * back to the model's own defaults (the `""` no-carry lever) when there is no
 * history.
 *
 * - `modelSlug === null` is a provider SWITCH: resolve the (harness, profile)
 *   pair's last model and effort/tier (`resolveHarnessSwitch`), seeded by
 *   `defaultModel` (D09) when that pair has never been used. `defaultModel`
 *   is ignored on the explicit-pick branch below - pass `null` there.
 * - a concrete `modelSlug` is an explicit model PICK: keep the slug, restore
 *   only that pair's effort/tier (`resolveModelSelection`).
 *
 * Shared by the picker (rail click / ⌘-digit / model row) and the registered
 * command-palette controls so every surface funnels through identical logic.
 * Reads the memory store imperatively (`getState()`); it is not a hook.
 */
export interface CommitSelectionInput {
  readonly store: ComposerToolbarStore;
  readonly harnessId: ProviderId;
  readonly modelSlug: string | null;
  readonly profileId: string | null;
  readonly defaultModel: string | null;
}

export function commitSelection(input: CommitSelectionInput): void {
  const { store, harnessId, modelSlug, profileId, defaultModel } = input;
  // The composer's target host keys every memory read/write below - the
  // toolbar store carries it in its catalog scope, so the picker and the
  // palette funnel through the identical host without threading it.
  const hostId = store.getState().catalog.hostId;
  const memory = useComposerHarnessMemoryStore.getState();
  // Profile memory is independent of model memory. Record the explicit choice
  // immediately so header usage previews can follow it even while the target
  // harness's model catalog is still resolving (and before a settings emit).
  memory.recordProfileSelection(hostId, harnessId, profileId);
  const resolved =
    modelSlug === null
      ? seedResolvedHarnessSwitch(
          memory.resolveHarnessSwitch(hostId, harnessId, profileId),
          defaultModel,
        )
      : {
          modelSlug,
          ...memory.resolveModelSelection(hostId, harnessId, modelSlug),
        };
  store.getState().applyComposerSelection({
    selection: { harnessId, profileId, modelSlug: resolved.modelSlug },
    reasoning: resolved.reasoningEffort ?? "",
    serviceTier: resolved.serviceTier ?? "",
  });
}

/**
 * Commits a profile-only change for the currently selected harness.
 *
 * D09 reverses what this path used to do. Model memory is keyed per
 * `(harness, profile)`, so switching profile INSIDE one harness switches the
 * model with it: an API-key profile can point at a different endpoint with a
 * different catalog, and carrying the previous profile's slug across names a
 * model the destination may not serve. The destination pair's remembered
 * model wins, and a pair that has never been used is seeded by that
 * profile's own `defaultModel`. Effort and tier stay keyed by `(harness,
 * model)` and are restored for whichever model that resolves to.
 *
 * Delegating to `commitSelection`'s switch branch rather than re-spelling it
 * is deliberate (rule 11): the two profile-switch paths - the picker's
 * dropdown and the rate-limit banner - cannot drift into describing
 * different destinations.
 */
export function commitProfileSelection(
  store: ComposerToolbarStore,
  profileId: string | null,
  defaultModel: string | null,
): void {
  commitSelection({
    store,
    harnessId: store.getState().selection.harnessId,
    modelSlug: null,
    profileId,
    defaultModel,
  });
}
