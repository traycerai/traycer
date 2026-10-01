import type { ReactNode } from "react";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import { ComposerMicSlot } from "@/components/home/toolbar/composer-mic-button";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import type { PermissionMode } from "@/components/home/data/landing-options";
import type { AutoJudgeBilling } from "@/lib/auto-mode/auto-judge-billing";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";
import type { ToolbarRegionId } from "@/lib/layout/region-id";

/**
 * Every prop any of the four toolbar items could need, in one shape: since an
 * item may sit in either cluster after a reorder, both `ComposerToolbarLeft`
 * and `ComposerToolbarRight` render through the same `renderToolbarItem`
 * and so both need the full set, not just the half each drew before D13's
 * clusters existed.
 */
export interface ComposerToolbarItemsProps {
  readonly presentation?: boolean;
  readonly onAttachImages: (files: ReadonlyArray<File>) => void;
  readonly permission: PermissionMode;
  readonly onPermissionChange: (next: PermissionMode) => void;
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  readonly harnessLabel: string | null;
  readonly catalogSupportedModes: ReadonlyArray<PermissionMode> | null;
  readonly hostKnowsAutoMode: boolean | null;
  readonly turnActive: boolean;
  readonly judgeBilling: AutoJudgeBilling | null;
  readonly onOpenPermissionSettings: (() => void) | null;
  readonly settingsLocked: boolean;
  readonly store: ComposerToolbarStore;
  readonly createProfileHostId: string | null;
  readonly runTargetHostId: string | null;
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  readonly dictation: ComposerDictationControl | null;
  readonly dictationPreparing: DictationPreparingStatus | null;
}

/**
 * One toolbar item: the one place that pairs a `ToolbarRegionId` with the
 * control that draws it, which is what lets the cluster components walk an
 * order without knowing what is in it.
 *
 * The right-click menu is NOT here. It hangs once per cluster
 * (`LayoutClusterContextMenu`) and resolves the region from the element the
 * pointer was over, because a Radix root per item cost twenty-eight mounted
 * roots on a four-tile canvas for a gesture used a handful of times a session
 * (L-19, G3-10).
 */
export function renderToolbarItem(
  id: ToolbarRegionId,
  props: ComposerToolbarItemsProps,
): ReactNode {
  switch (id) {
    case "attachImage":
      return (
        <ComposerAttachImageButton onAttachImages={props.onAttachImages} />
      );
    case "access":
      return (
        <PermissionsPicker
          value={props.permission}
          disabled={props.settingsLocked}
          onChange={props.onPermissionChange}
          supportedPermissionModes={props.supportedPermissionModes}
          harnessLabel={props.harnessLabel}
          catalogSupportedModes={props.catalogSupportedModes}
          hostKnowsAutoMode={props.hostKnowsAutoMode}
          turnActive={props.turnActive}
          judgeBilling={props.judgeBilling}
          closeFocus="composer"
          onOpenPermissionSettings={props.onOpenPermissionSettings}
          interactive
        />
      );
    case "model":
      return (
        <HarnessModelPicker
          labelDisplay="responsive"
          store={props.store}
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
    case "mic":
      return (
        <ComposerMicSlot
          dictation={props.dictation}
          dictationPreparing={props.dictationPreparing}
        />
      );
  }
}
