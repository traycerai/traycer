/**
 * Docs: see ../SETTINGS.md (General ▸ Agents).
 * Update that file whenever this settings surface changes.
 */
import { useId, useState, type ReactNode } from "react";
import type {
  ChatAutoArchiveBounds,
  ChatAutoArchiveSetRequest,
} from "@traycer/protocol/host/chat-auto-archive/contracts";
import { SettingsRow } from "@/components/settings/settings-row";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useChatAutoArchivePolicyQuery } from "@/hooks/chat-auto-archive/use-chat-auto-archive-policy-query";
import { useChatAutoArchiveSetMutation } from "@/hooks/chat-auto-archive/use-chat-auto-archive-set-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import {
  CHAT_AUTO_ARCHIVE_DEFAULT_IDLE_SECONDS,
  CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS,
  chatAutoArchiveStatusLine,
  idleSecondsError,
} from "@/components/settings/panels/chat-auto-archive-copy";

/**
 * General ▸ Agents ▸ "Archive idle agents automatically".
 *
 * Rendered only when the app-wide host advertises BOTH `chatAutoArchive.get`
 * and `chatAutoArchive.set`: they negotiate independently, and a host that
 * could read but not write would draw a control whose every change fails.
 * Two hook calls, not one `&&`, because short-circuiting a hook breaks the
 * rules of hooks. `null` (no handshake yet) hides the row like `false`; it
 * appears on its own once the host advertises the methods.
 *
 * The setting is ACCOUNT-wide, applied by the host's sweep on every host the
 * user runs. Nothing here schedules or simulates archiving.
 */
export function ChatAutoArchiveSettingsRow(): ReactNode {
  const hostId = useAddressableHostId();
  const getSupported = useHostMethodSupport(hostId, "chatAutoArchive.get");
  const setSupported = useHostMethodSupport(hostId, "chatAutoArchive.set");
  if (getSupported !== true || setSupported !== true) return null;
  return <ChatAutoArchiveSettingsRowBody />;
}

function ChatAutoArchiveSettingsRowBody(): ReactNode {
  const query = useChatAutoArchivePolicyQuery();
  const setPolicy = useChatAutoArchiveSetMutation();
  const viewerUserId = useCloudChatViewerId();
  const includeUserCreatedId = useId();

  // `undefined` until the read lands, which covers the unresolved viewer (the
  // read is disabled there), a read in flight and a failed read: every
  // control waits for a policy it can write over.
  const data = query.data;
  const policy = data?.policy ?? null;
  const current: ChatAutoArchiveSetRequest = {
    enabled: policy?.enabled ?? false,
    includeUserCreated: policy?.includeUserCreated ?? false,
    idleSeconds: policy?.idleSeconds ?? CHAT_AUTO_ARCHIVE_DEFAULT_IDLE_SECONDS,
  };
  const disabled = data === undefined || setPolicy.isPending;

  // `onRejected` runs after the hook's own error toast, for the one write
  // whose control holds local state: the threshold field.
  const save = (
    next: ChatAutoArchiveSetRequest,
    onRejected: (() => void) | null,
  ): void => {
    trackSettingChanged("general", "chatAutoArchive");
    setPolicy.mutate(
      next,
      onRejected === null ? undefined : { onError: onRejected },
    );
  };

  return (
    <SettingsRow
      row={GENERAL.definitions.chatAutoArchive}
      status={
        <div className="flex flex-col gap-2">
          <p>{GENERAL.definitions.chatAutoArchive.description}</p>
          {/* Nothing until the read lands: before then the row knows no
              policy, and the defaults' "Off" would be a claim, not a fact. */}
          {query.isError ? <p>{CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS}</p> : null}
          {data !== undefined ? (
            <p>{chatAutoArchiveStatusLine(current)}</p>
          ) : null}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Switch
                id={includeUserCreatedId}
                checked={current.includeUserCreated}
                disabled={disabled}
                onCheckedChange={(includeUserCreated) => {
                  save({ ...current, includeUserCreated }, null);
                }}
              />
              <Label htmlFor={includeUserCreatedId}>
                Also archive chats I created
              </Label>
            </div>
            <p>
              Off: only chats agents created. Terminal agents count as yours.
            </p>
          </div>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          {setPolicy.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="chat-auto-archive-spinner"
              variant={undefined}
            />
          ) : null}
          {/* Keyed by the viewer: the draft and its error belong to the
              person typing, and an account switch with Settings open must
              neither show nor commit the outgoing account's edit. The query
              partition cannot reach component state. While the viewer is
              unresolved the read is disabled, so there is no draft to keep. */}
          {viewerUserId.length > 0 ? (
            <IdleSecondsInput
              key={viewerUserId}
              idleSeconds={current.idleSeconds}
              bounds={data?.bounds ?? null}
              disabled={disabled}
              onCommit={(idleSeconds, onRejected) => {
                save({ ...current, idleSeconds }, onRejected);
              }}
            />
          ) : (
            <IdleSecondsField
              value={String(current.idleSeconds)}
              error={null}
              errorId={undefined}
              disabled
              onChange={null}
              onCommit={null}
            />
          )}
          <Switch
            checked={current.enabled}
            disabled={disabled}
            aria-label="Archive idle agents automatically"
            onCheckedChange={(enabled) => {
              save({ ...current, enabled }, null);
            }}
          />
        </div>
      }
    />
  );
}

/**
 * The threshold field. Editable while the main switch is off, so the value is
 * kept for the next enable. Commits on blur or Enter when the value changed
 * and is a whole number inside the HOST's bounds; anything else shows an
 * inline error and sends nothing.
 */
function IdleSecondsInput(props: {
  readonly idleSeconds: number;
  readonly bounds: ChatAutoArchiveBounds | null;
  readonly disabled: boolean;
  /** `onRejected` restores the field when the save fails. */
  readonly onCommit: (idleSeconds: number, onRejected: () => void) => void;
}): ReactNode {
  const { idleSeconds, bounds, disabled, onCommit } = props;
  const errorId = useId();
  const [draft, setDraft] = useState(String(idleSeconds));
  const [error, setError] = useState<string | null>(null);
  // Adjusted during render, keyed on the SAVED value changing rather than on
  // the draft differing from it: a committed draft stays on screen while its
  // save is in flight instead of snapping back to the old value, and a value
  // saved elsewhere still reaches the field when it lands.
  const [syncedIdleSeconds, setSyncedIdleSeconds] = useState(idleSeconds);
  if (syncedIdleSeconds !== idleSeconds) {
    setSyncedIdleSeconds(idleSeconds);
    setDraft(String(idleSeconds));
    setError(null);
  }

  const commitDraft = (value: string): void => {
    if (bounds === null) return;
    const validationError = idleSecondsError(value, bounds);
    setError(validationError);
    if (validationError !== null) return;
    const next = Number(value.trim());
    if (next === idleSeconds) return;
    // A rejected save restores the SAVED threshold rather than leaving the
    // refused draft on screen: the switches write the saved value, so a kept
    // draft would show one threshold while the host applies another. The
    // toast says why; the field says what is in force.
    onCommit(next, () => {
      setDraft(String(idleSeconds));
      setError(null);
    });
  };

  return (
    <IdleSecondsField
      value={draft}
      error={error}
      errorId={errorId}
      disabled={disabled}
      onChange={(value) => {
        setDraft(value);
        setError(null);
      }}
      onCommit={commitDraft}
    />
  );
}

/** The threshold field's markup, shared by the live field and the placeholder. */
function IdleSecondsField(props: {
  readonly value: string;
  readonly error: string | null;
  readonly errorId: string | undefined;
  readonly disabled: boolean;
  readonly onChange: ((value: string) => void) | null;
  readonly onCommit: ((value: string) => void) | null;
}): ReactNode {
  const { value, error, errorId, disabled, onChange, onCommit } = props;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          value={value}
          readOnly={onChange === null}
          inputMode="numeric"
          aria-label="Idle seconds before archiving"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          disabled={disabled}
          className="w-[min(30vw,6rem)] text-right"
          size="sm"
          onChange={(event) => onChange?.(event.target.value)}
          onBlur={(event) => onCommit?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="text-ui-sm text-muted-foreground">seconds</span>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-ui-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
