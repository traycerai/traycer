import { useEffect, useRef } from "react";
import type { ProviderId } from "@/components/home/data/landing-options";
import type { RailEntry } from "@/components/home/pickers/harness-rail-providers";
import {
  LEADER_SCOPE_MODEL_PICKER,
  notifyLeaderScopesChanged,
  registerLeaderScope,
} from "@/lib/keybindings/leader-scope";
import type { ReasoningFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";

interface PickerLeaderScopeInput {
  /** While true, the picker owns ⌘ (rail) and—when actionable—⌥ (reasoning). */
  readonly open: boolean;
  /** Ordered visible rail entries, mirroring what the rail renders. */
  readonly railEntries: ReadonlyArray<RailEntry>;
  readonly onEntryChange: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
  readonly reasoning: ReasoningFooterConfig | null;
  readonly reasoningActionable: boolean;
}

/**
 * Registers the model picker's leader-key scope while it's open: ⌘+digit
 * switches the browsed provider rail and ⌥+digit sets the thinking level. Both
 * dispatches are pure state writes through the supplied callbacks (no DOM focus
 * move), so the search box keeps focus. A latest-value ref lets the scope's
 * dispatch closures—registered once per open—read fresh state every keypress.
 */
export function usePickerLeaderScope(input: PickerLeaderScopeInput): void {
  const { open, railEntries, onEntryChange, reasoning, reasoningActionable } =
    input;
  const stateRef = useRef({
    railEntries,
    onEntryChange,
    reasoning,
    reasoningActionable,
  });
  useEffect(() => {
    stateRef.current = {
      railEntries,
      onEntryChange,
      reasoning,
      reasoningActionable,
    };
  }, [railEntries, onEntryChange, reasoning, reasoningActionable]);

  useEffect(() => {
    if (!open) return;
    notifyLeaderScopesChanged();
  }, [open, reasoningActionable]);

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
            stateRef.current.onEntryChange(target.harness.id, target.profileId);
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
      ],
    });
  }, [open]);
}
