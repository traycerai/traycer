import { useEffect, useRef } from "react";
import type { ProviderId } from "@/components/home/data/landing-options";
import type { RailEntry } from "@/components/home/pickers/harness-rail-providers";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import {
  LEADER_SCOPE_MODEL_PICKER,
  notifyLeaderScopesChanged,
  registerLeaderScope,
} from "@/lib/keybindings/leader-scope";
import type { ReasoningFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

interface PickerLeaderScopeInput {
  /** While true, the picker owns ⌘ (rail), ⌥ (reasoning, when actionable), and
   *  ⌘⇧ (profile dropdown, when the active provider has 2+ profiles). */
  readonly open: boolean;
  /** Ordered visible rail entries, mirroring what the rail renders. */
  readonly railEntries: ReadonlyArray<RailEntry>;
  readonly onEntryChange: (providerId: ProviderId) => void;
  readonly reasoning: ReasoningFooterConfig | null;
  readonly reasoningActionable: boolean;
  /** The provider the profile dropdown is scoped to - always the locked
   *  provider while a fork lock is active (the rail can't browse away from it). */
  readonly activeProviderId: ProviderId;
  /** Ordered profiles the dropdown renders, mirroring what it displays - empty
   *  (or under 2) means no dropdown, hence no ⌘⇧-digit action. */
  readonly activeProviderProfiles: ReadonlyArray<ProviderProfile>;
  /** Same commit path the dropdown's row clicks use - `handleProfileChange` -
   *  so the lock rule and memory-aware funnel apply identically here. */
  readonly onProfileChange: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
}

/**
 * Registers the model picker's leader-key scope while it's open: ⌘+digit
 * switches the browsed provider rail, ⌥+digit sets the thinking level, and
 * ⌘⇧+digit switches the active provider's profile dropdown. All three
 * dispatches are pure state writes through the supplied callbacks (no DOM
 * focus move), so the search box keeps focus. A latest-value ref lets the
 * scope's dispatch closures—registered once per open—read fresh state every
 * keypress.
 */
export function usePickerLeaderScope(input: PickerLeaderScopeInput): void {
  const {
    open,
    railEntries,
    onEntryChange,
    reasoning,
    reasoningActionable,
    activeProviderId,
    activeProviderProfiles,
    onProfileChange,
  } = input;
  const stateRef = useRef({
    railEntries,
    onEntryChange,
    reasoning,
    reasoningActionable,
    activeProviderId,
    activeProviderProfiles,
    onProfileChange,
  });
  useEffect(() => {
    stateRef.current = {
      railEntries,
      onEntryChange,
      reasoning,
      reasoningActionable,
      activeProviderId,
      activeProviderProfiles,
      onProfileChange,
    };
  }, [
    railEntries,
    onEntryChange,
    reasoning,
    reasoningActionable,
    activeProviderId,
    activeProviderProfiles,
    onProfileChange,
  ]);

  useEffect(() => {
    if (!open) return;
    notifyLeaderScopesChanged();
  }, [open, reasoningActionable, activeProviderProfiles.length]);

  useEffect(() => {
    if (!open) return;
    return registerLeaderScope({
      id: LEADER_SCOPE_MODEL_PICKER,
      actions: [
        {
          actionId: "model.provider.byDigit",
          isActive: () => true,
          dispatch: (digit) => {
            const list = stateRef.current.railEntries;
            const index = digit === 0 ? 9 : digit - 1;
            if (index < 0 || index >= list.length) return false;
            const target = list[index];
            // Mirror the rail button's disabled state: a still-probing (pending)
            // provider can't be selected by click, so the ⌘-digit shortcut must
            // not select it either. Its digit badge is hidden while pending, so
            // dispatching here would be a silent no-op the picker resolves away.
            if (target.harness.availabilityPending) return false;
            stateRef.current.onEntryChange(target.harness.id);
            return true;
          },
          dispatchSequence: null,
          sequenceState: null,
        },
        {
          actionId: "model.reasoning.byDigit",
          isActive: () => stateRef.current.reasoningActionable,
          dispatch: (digit) => {
            const reasoningConfig = stateRef.current.reasoning;
            if (reasoningConfig === null || reasoningConfig.disabled) {
              return false;
            }
            const index = digit === 0 ? 9 : digit - 1;
            if (index < 0 || index >= reasoningConfig.options.length) {
              return false;
            }
            reasoningConfig.onChange(reasoningConfig.options[index].id);
            return true;
          },
          dispatchSequence: null,
          sequenceState: null,
        },
        {
          actionId: "model.profile.byDigit",
          // Progressive disclosure: active only when the dropdown itself is
          // rendered (2+ profiles) - otherwise there is nothing to hint or
          // dispatch to, matching the rail/reasoning gates above.
          isActive: () => stateRef.current.activeProviderProfiles.length >= 2,
          dispatch: (digit) => {
            const profiles = stateRef.current.activeProviderProfiles;
            // Beyond digit 9, profiles stay click-only - mirrors the provider
            // rail's own overflow behavior above.
            const index = digit === 0 ? 9 : digit - 1;
            if (index < 0 || index >= profiles.length) return false;
            const profile = profiles[index];
            // Routes through the SAME commit path the dropdown's row clicks
            // use (`handleProfileChange`), which already carries the
            // locked-fork guard - no second commit path to keep in sync.
            stateRef.current.onProfileChange(
              stateRef.current.activeProviderId,
              profileCommitId(profile),
            );
            return true;
          },
          dispatchSequence: null,
          sequenceState: null,
        },
      ],
    });
  }, [open]);
}
