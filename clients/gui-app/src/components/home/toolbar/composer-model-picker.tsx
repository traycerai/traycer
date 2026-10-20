import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { chatMaxModeContextForToolbar } from "@/components/home/data/model-max-mode";
import type { ComposerToolbarItemsProps } from "@/components/home/toolbar/composer-toolbar-item";

export function ComposerModelPicker(
  props: ComposerToolbarItemsProps,
): ReactNode {
  const reasoning = useStore(props.store, (state) => state.reasoning);
  const serviceTier = useStore(props.store, (state) => state.serviceTier);
  const maxModeContext = useMemo(
    () => chatMaxModeContextForToolbar(reasoning, serviceTier),
    [reasoning, serviceTier],
  );
  return (
    <HarnessModelPicker
      labelDisplay="responsive"
      store={props.store}
      maxModeContext={maxModeContext}
      withServiceTier
      withReasoning
      tuiOnly={false}
      lockedHarnessId={null}
      disabled={props.settingsLocked}
      registerActivation={!props.presentation}
      presentation={props.presentation}
      createProfileHostId={props.createProfileHostId}
      runTargetHostId={props.runTargetHostId}
      terminalLoginSurface={props.terminalLoginSurface}
      profileAdmission={null}
      embedding={null}
    />
  );
}
