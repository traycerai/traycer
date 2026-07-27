import { useEffect, useRef, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { customNameFromDraft } from "@/components/settings/panels/host-settings-panel-model";
import type { HostNameSettings } from "@traycer-clients/shared/platform/runner-host";

interface HostNameEditFormProps {
  readonly settings: HostNameSettings | undefined;
  readonly pending: boolean;
  readonly draftName: string;
  readonly savePending: boolean;
  readonly onDraftNameChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
  readonly onCancel: () => void;
}

/**
 * The focused inline edit state Flow 5 keeps from the prior always-visible
 * Display Name row - same Input plus explicit Save/Reset (plus a new
 * Cancel), now revealed only while editing (toggled by "Edit name" in the
 * summary actions) instead of sitting open by default.
 */
export function HostNameEditForm(props: HostNameEditFormProps): ReactNode {
  const { settings, pending, draftName, savePending, onCancel } = props;
  const disabled = pending || savePending || settings === undefined;
  const dirty =
    settings === undefined
      ? false
      : customNameFromDraft(draftName, settings) !== settings.customName;
  const systemName = settings === undefined ? "" : settings.systemName;
  const resetDisabled =
    settings === undefined ||
    pending ||
    savePending ||
    settings.customName === null;
  // Cancel must not be clickable while a Save/Reset is in flight - closing
  // then would discard the draft and the only retry surface before knowing
  // whether the request actually failed.
  const cancelDisabled = pending || savePending;

  // Imperative focus (not the `autoFocus` JSX prop, which jsx-a11y forbids).
  // Depends on `disabled` (not `[]`) so opening the form before the name
  // query resolves - or while a save is pending - retries the focus once
  // the input actually becomes interactive, instead of firing once against
  // a disabled input and never again.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (disabled) return;
    inputRef.current?.focus();
  }, [disabled]);

  return (
    <div
      className="flex flex-col gap-2 border-t border-border/40 pt-3"
      data-testid="settings-host-name-edit"
    >
      <Input
        ref={inputRef}
        aria-label="Display Name"
        value={draftName}
        maxLength={80}
        placeholder={systemName.length === 0 ? "Display Name" : systemName}
        disabled={disabled}
        onChange={(event) => {
          props.onDraftNameChange(event.currentTarget.value);
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resetDisabled}
          onClick={props.onReset}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || !dirty}
          onClick={props.onSave}
        >
          {savePending ? (
            <AgentSpinningDots
              testId={undefined}
              variant="orbit"
              className="text-current"
            />
          ) : null}
          Save
        </Button>
      </div>
    </div>
  );
}
