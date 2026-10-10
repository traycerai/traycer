/**
 * Docs: see ../SETTINGS.md (General ▸ Agents).
 * Update that file whenever this settings surface changes.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import type {
  ChatAutoArchiveBounds,
  ChatAutoArchiveSetRequest,
} from "@traycer/protocol/host/chat-auto-archive/contracts";
import { SettingsRow } from "@/components/settings/settings-row";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useChatAutoArchivePolicyQuery } from "@/hooks/chat-auto-archive/use-chat-auto-archive-policy-query";
import { useChatAutoArchiveSetMutation } from "@/hooks/chat-auto-archive/use-chat-auto-archive-set-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import {
  chatAutoArchiveShownPolicy,
  CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS,
  CHAT_AUTO_ARCHIVE_ON_FOOTNOTE,
  formatIdleSeconds,
  IDLE_UNIT_LABELS,
  IDLE_UNIT_SECONDS,
  idleDurationError,
  idlePresetsWithin,
  idleUnitFor,
  idleUnitsFor,
  isIdleUnit,
  type IdleUnit,
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
  const viewerUserId = useCloudChatViewerId();
  if (getSupported !== true || setSupported !== true) return null;
  // Keyed by the viewer: the custom draft, the row's unsettled write and the
  // mutation observer all belong to the person using the row. The mutation
  // key and scope are not per-viewer, so without a remount an account switch
  // with Settings open would keep following the outgoing account's in-flight
  // save, show its policy and build the next write on it. The scope still
  // queues the new account's writes behind the old one's.
  return <ChatAutoArchiveSettingsRowBody key={viewerUserId} />;
}

function ChatAutoArchiveSettingsRowBody(): ReactNode {
  const query = useChatAutoArchivePolicyQuery();
  const setPolicy = useChatAutoArchiveSetMutation();

  // `undefined` until the read lands, which covers the unresolved viewer (the
  // read is disabled there), a read in flight and a failed read: every
  // control waits for a policy it can write over.
  const data = query.data;
  // What the row shows: the newest save's policy while one is in flight,
  // else the saved one. Saves queue in order (`chatAutoArchiveWriteScope`),
  // so the controls stay live while one is pending instead of following the
  // usual disabled-while-pending rule: a click then is the user's newest
  // choice, and a disabled switch would swallow the click that lands right
  // after the threshold field saved on its way out. When the newest save is
  // rejected the row drops back to the saved policy.
  const current = setPolicy.isPending
    ? setPolicy.variables
    : chatAutoArchiveShownPolicy(data);
  const disabled = data === undefined;

  // The newest write this row sent that has not settled. Writes are BUILT on
  // it, at event time, not on `current`: the mutation reaches React a timer
  // tick after `mutate`, and a touch tap delivers the threshold field's
  // leave-blur and the switch's click in one task, so a click built on the
  // rendered `current` would carry the old threshold and, queued last, put
  // it back. Read only in handlers, never during render.
  const unsettled = useRef<ChatAutoArchiveSetRequest | null>(null);

  // `build` gets the policy to write over and returns the write, or `null`
  // when there is nothing to send. `onRejected` runs after the hook's own
  // error toast, for the one write whose control holds local state: the
  // custom threshold field.
  const save = (
    build: (
      base: ChatAutoArchiveSetRequest,
    ) => ChatAutoArchiveSetRequest | null,
    onRejected: (() => void) | null,
  ): void => {
    const next = build(unsettled.current ?? current);
    if (next === null) return;
    unsettled.current = next;
    trackSettingChanged("general", "chatAutoArchive");
    setPolicy.mutate(next, {
      onError: onRejected ?? undefined,
      // Per-call callbacks run only for the observer's newest `mutate`, the
      // only one `unsettled` can still name.
      onSettled: () => {
        if (unsettled.current === next) unsettled.current = null;
      },
    });
  };

  return (
    <SettingsRow
      row={GENERAL.definitions.chatAutoArchive}
      status={
        query.isError ? (
          <div className="flex flex-col gap-1">
            <p>{GENERAL.definitions.chatAutoArchive.description}</p>
            <p>{CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS}</p>
          </div>
        ) : undefined
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
          <Switch
            checked={current.enabled}
            disabled={disabled}
            aria-label="Archive idle agents automatically"
            onCheckedChange={(enabled) => {
              save((base) => ({ ...base, enabled }), null);
            }}
          />
        </div>
      }
      // The options configure what the switch turns on, so they are drawn
      // only while it is on. Closing them writes nothing: the threshold and
      // include choice are where they were when the switch comes back.
      details={
        data !== undefined && current.enabled ? (
          <div className="flex flex-col gap-2.5">
            {/* An alpha of the foreground rather than `bg-muted`: every
                preset theme's dark variant collapses `--muted` onto the card
                this group sits on. */}
            <div className="overflow-hidden rounded-lg border border-border/60 bg-foreground/3">
              <ChatAutoArchiveOptionLine
                label="Archive after"
                hint="Time since the chat's last activity"
                renderControl={(controlId, hintId) => (
                  <IdleThresholdControl
                    controlId={controlId}
                    hintId={hintId}
                    idleSeconds={current.idleSeconds}
                    bounds={data.bounds}
                    disabled={disabled}
                    onCommit={(idleSeconds, onRejected) => {
                      save(
                        (base) =>
                          base.idleSeconds === idleSeconds
                            ? null
                            : { ...base, idleSeconds },
                        onRejected,
                      );
                    }}
                  />
                )}
              />
              <ChatAutoArchiveOptionLine
                label="Include chats I started"
                hint="Terminal agent chats count as yours"
                renderControl={(controlId, hintId) => (
                  <Switch
                    id={controlId}
                    checked={current.includeUserCreated}
                    disabled={disabled}
                    aria-describedby={hintId}
                    onCheckedChange={(includeUserCreated) => {
                      save((base) => ({ ...base, includeUserCreated }), null);
                    }}
                  />
                )}
              />
            </div>
            <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-success"
              />
              {CHAT_AUTO_ARCHIVE_ON_FOOTNOTE}
            </p>
          </div>
        ) : null
      }
    />
  );
}

/** One option inside the group: label and hint on the left, control on the right. */
function ChatAutoArchiveOptionLine(props: {
  readonly label: string;
  readonly hint: string;
  readonly renderControl: (controlId: string, hintId: string) => ReactNode;
}): ReactNode {
  const controlId = useId();
  const hintId = useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border/40 px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={controlId}>{props.label}</Label>
        <p id={hintId} className="text-ui-xs text-muted-foreground">
          {props.hint}
        </p>
      </div>
      <div className="ml-auto max-w-full">
        {props.renderControl(controlId, hintId)}
      </div>
    </div>
  );
}

/**
 * The threshold: a named preset, or "Custom…", which opens a number-and-unit
 * field in the largest unit that states the shown seconds exactly.
 * `idleSeconds` is the threshold the row shows: the newest save's while one
 * is in flight, else the saved one. A shown value that is not a preset shows
 * as Custom with its field open.
 *
 * The preset picker and the custom field are ONE value, so one action is one
 * write. A preset commits on pick; the custom value commits on a unit pick, on
 * Enter, and when focus leaves the whole control - not when it moves inside it
 * (number, unit picker, preset picker, or either portalled list). Committing
 * on the number's own blur would save it the moment a picker opened, and the
 * pick would save a second time. A value outside the HOST's bounds shows an
 * inline error and sends nothing.
 */
function IdleThresholdControl(props: {
  readonly controlId: string;
  readonly hintId: string;
  readonly idleSeconds: number;
  readonly bounds: ChatAutoArchiveBounds;
  readonly disabled: boolean;
  readonly onCommit: (
    idleSeconds: number,
    onRejected: (() => void) | null,
  ) => void;
}): ReactNode {
  const { controlId, hintId, idleSeconds, bounds, disabled, onCommit } = props;
  const errorId = useId();
  const controlRef = useRef<HTMLDivElement>(null);
  // Both lists are portalled, so neither is inside `controlRef` in the DOM;
  // React still delivers their focus events to `controlRef`'s handler.
  const presetListRef = useRef<HTMLDivElement>(null);
  const unitListRef = useRef<HTMLDivElement>(null);
  const presets = idlePresetsWithin(bounds);
  // "Custom…" picked by hand keeps the field open even once its value lands on
  // a preset, so the field does not vanish under the cursor.
  const [pickedCustom, setPickedCustom] = useState(false);
  const custom = pickedCustom || !presets.includes(idleSeconds);

  const shownUnit = idleUnitFor(idleSeconds);
  const shownAmount = String(idleSeconds / IDLE_UNIT_SECONDS[shownUnit]);
  const [draft, setDraft] = useState(shownAmount);
  const [unit, setUnit] = useState<IdleUnit>(shownUnit);
  const [error, setError] = useState<string | null>(null);
  const resetDraft = (): void => {
    setDraft(shownAmount);
    setUnit(shownUnit);
    setError(null);
  };
  // Adjusted during render, keyed on the SHOWN value changing rather than on
  // the draft differing from it: a commit re-states its own value in the
  // largest exact unit as soon as it is sent ("120 minutes" reads "2 hours"),
  // a rejected newest save puts the saved value back, and a value saved
  // elsewhere reaches the field when it lands.
  const [syncedIdleSeconds, setSyncedIdleSeconds] = useState(idleSeconds);
  if (syncedIdleSeconds !== idleSeconds) {
    setSyncedIdleSeconds(idleSeconds);
    resetDraft();
  }

  const commitCustom = (value: string, nextUnit: IdleUnit): void => {
    const validationError = idleDurationError(value, nextUnit, bounds);
    setError(validationError);
    if (validationError !== null) return;
    const next = Number(value.trim()) * IDLE_UNIT_SECONDS[nextUnit];
    // `idleSeconds` is the newest save's threshold while one is in flight, so
    // focus leaving right after a unit pick does not send that pick twice.
    if (next === idleSeconds) return;
    // A rejected save restores the threshold shown before it rather than
    // leaving the refused draft on screen: the switches write the shown
    // threshold, so a kept draft would show one value while another is in
    // force. The toast says why; the field says what is in force.
    onCommit(next, resetDraft);
  };

  return (
    <div
      ref={controlRef}
      className="flex flex-col items-end gap-2"
      onBlur={(event) => {
        if (!custom) return;
        const next = event.relatedTarget;
        if (
          next instanceof Node &&
          [controlRef, presetListRef, unitListRef].some(
            (ref) => ref.current?.contains(next) === true,
          )
        ) {
          return;
        }
        commitCustom(draft, unit);
      }}
    >
      <Select
        value={custom ? "custom" : String(idleSeconds)}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "custom") {
            setPickedCustom(true);
            return;
          }
          // A preset replaces whatever the custom field held, so its draft
          // is dropped rather than kept for the next "Custom…".
          setPickedCustom(false);
          resetDraft();
          const seconds = Number(value);
          if (seconds !== idleSeconds) onCommit(seconds, null);
        }}
      >
        <SelectTrigger
          id={controlId}
          aria-describedby={hintId}
          className="w-[min(40vw,9rem)]"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent ref={presetListRef}>
          {presets.map((seconds) => (
            <SelectItem key={seconds} value={String(seconds)}>
              {formatIdleSeconds(seconds)}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom…</SelectItem>
        </SelectContent>
      </Select>
      {custom ? (
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              inputMode="numeric"
              aria-label="Custom idle time"
              aria-invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
              disabled={disabled}
              className="w-[min(20vw,4.5rem)] text-right"
              size="sm"
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                // An Enter that confirms an IME composition is the IME's, not
                // a commit (the drafts dialog's guard, copied).
                if (
                  event.key !== "Enter" ||
                  event.nativeEvent.isComposing ||
                  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Safari reports the IME-confirming Enter with isComposing already false; only keyCode 229 marks it, and there is no non-deprecated spelling
                  event.keyCode === 229
                ) {
                  return;
                }
                event.currentTarget.blur();
              }}
            />
            <Select
              value={unit}
              disabled={disabled}
              onValueChange={(value) => {
                if (!isIdleUnit(value)) return;
                setUnit(value);
                commitCustom(draft, value);
              }}
            >
              <SelectTrigger
                aria-label="Idle time unit"
                className="w-[min(30vw,7rem)]"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent ref={unitListRef}>
                {/* From the SHOWN value's unit, not the draft's: a value in
                    seconds keeps "seconds" listed after the draft moves to
                    another unit, so the exact value stays reachable. */}
                {idleUnitsFor(shownUnit).map((option) => (
                  <SelectItem key={option} value={option}>
                    {IDLE_UNIT_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error !== null ? (
            <p
              id={errorId}
              role="alert"
              className="text-ui-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
