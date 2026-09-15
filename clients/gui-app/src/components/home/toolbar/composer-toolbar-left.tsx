import { memo } from "react";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import type { PermissionMode } from "@/components/home/data/landing-options";
import type { AutoJudgeBilling } from "@/lib/auto-mode/auto-judge-billing";

interface ComposerToolbarLeftProps {
  onAttachImages: (files: ReadonlyArray<File>) => void;
  permission: PermissionMode;
  onPermissionChange: (next: PermissionMode) => void;
  /**
   * Permission modes the active harness honors. Forwarded straight to
   * `PermissionsPicker`; `null` while the harness catalog is still loading
   * (every option stays enabled until the host reports back).
   */
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  /**
   * Display label of the active harness (e.g. "Cursor"). Threaded into the
   * picker's "Not supported by <name>" copy for disabled options. `null` while
   * the harness catalog is still loading, in which case the picker falls back
   * to "this provider".
   */
  harnessLabel: string | null;
  /** Union across the host's whole harness catalog - see `PermissionsPicker`. */
  readonly catalogSupportedModes: ReadonlyArray<PermissionMode> | null;
  /** Whether a turn is running - see `PermissionsPicker`. */
  readonly turnActive: boolean;
  /** Which pocket the host's judge spends - see `PermissionsPicker`. */
  readonly judgeBilling: AutoJudgeBilling | null;
  showNextTurnPermissionNote: boolean;
  settingsLocked: boolean;
}

function ComposerToolbarLeftImpl(props: ComposerToolbarLeftProps) {
  const {
    onAttachImages,
    permission,
    onPermissionChange,
    supportedPermissionModes,
    harnessLabel,
    catalogSupportedModes,
    turnActive,
    judgeBilling,
    showNextTurnPermissionNote,
    settingsLocked,
  } = props;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ComposerAttachImageButton onAttachImages={onAttachImages} />
      <PermissionsPicker
        value={permission}
        disabled={settingsLocked}
        onChange={onPermissionChange}
        supportedPermissionModes={supportedPermissionModes}
        harnessLabel={harnessLabel}
        catalogSupportedModes={catalogSupportedModes}
        turnActive={turnActive}
        judgeBilling={judgeBilling}
        closeFocus="composer"
      />
      {showNextTurnPermissionNote ? (
        <output
          aria-live="polite"
          aria-atomic="true"
          className="max-w-[min(28vw,14rem)] truncate text-ui-xs text-muted-foreground"
        >
          New mode applies to the next turn
        </output>
      ) : null}
    </div>
  );
}

export const ComposerToolbarLeft = memo(ComposerToolbarLeftImpl);
