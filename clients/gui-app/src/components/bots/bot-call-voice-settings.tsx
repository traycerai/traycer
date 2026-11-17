import { useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup } from "@/components/bots/bot-settings-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  callVoiceLabel,
  resolveCallVoice,
  type CallVoiceCatalogue,
  type CallVoiceCatalogueState,
  type CallVoiceResolution,
} from "@/lib/voice/call-voice";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * The Voice group of a bot's channel settings: which voice calls speak in on
 * this device. One choice for every bot, kept in this device's settings, so
 * nothing here writes the bot. A pick applies from the next call; a call in
 * progress keeps the voice it started with.
 *
 * The list is the deployment's offered voices, searchable, after a choice
 * to follow the deployment's default (saved as `null`, so calls follow it if
 * it changes); a named voice, the current default included, stays that voice.
 * A saved voice the deployment no longer offers stays saved, and the group
 * says which voice speaks instead. There is no way to hear a voice from here.
 */
export function BotCallVoiceSettings(props: {
  readonly catalogue: CallVoiceCatalogueState;
}): ReactNode {
  const { catalogue } = props;
  const { callVoice, setCallVoice } = useSettingsStore(
    useShallow((s) => ({
      callVoice: s.callVoice,
      setCallVoice: s.setCallVoice,
    })),
  );
  // Only a call whose voice the server confirmed keeps it; a call on a
  // connection that offers no choice promises nothing about its voice.
  const callKeepsVoice = useVoiceSessionStore(
    (s) =>
      (s.phase === "connecting" || s.phase === "live") &&
      s.attestedVoice !== null,
  );
  return (
    <SettingsGroup title="Voice" testId="bot-settings-voice">
      {catalogue.kind === "ready" ? (
        <CallVoicePicker
          catalogue={catalogue.catalogue}
          saved={callVoice}
          onPick={setCallVoice}
        />
      ) : (
        <CallVoiceWithoutChoices kind={catalogue.kind} saved={callVoice} />
      )}
      {callKeepsVoice ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="bot-settings-voice-in-call"
        >
          This call keeps its current voice.
        </p>
      ) : null}
    </SettingsGroup>
  );
}

function CallVoicePicker(props: {
  readonly catalogue: CallVoiceCatalogue;
  readonly saved: string | null;
  readonly onPick: (voice: string | null) => void;
}): ReactNode {
  const { catalogue, saved, onPick } = props;
  const [query, setQuery] = useState("");
  const resolution = resolveCallVoice(saved, catalogue);
  const needle = query.trim().toLowerCase();
  const matches = (label: string): boolean =>
    needle.length === 0 || label.toLowerCase().includes(needle);
  const defaultLabel = `Deployment default (${callVoiceLabel(catalogue.defaultVoice)})`;
  const showDefault = matches(defaultLabel);
  const matching = catalogue.voices.filter((voice) =>
    matches(callVoiceLabel(voice)),
  );
  // What speaks follows the deployment's default unless a named voice that
  // is offered was chosen.
  const followsDefault = resolution.kind !== "selected";
  return (
    <div className="flex flex-col gap-2">
      <span className="text-ui-sm font-medium text-foreground">
        Voice for calls
      </span>
      <div className="rounded-md border border-border">
        <Command
          variant="embedded"
          selection="flat"
          shouldFilter={false}
          label="Search voices"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search voices"
            spellCheck={false}
          />
          <CommandList label="Voice for calls" className="max-h-60 p-1">
            {matching.length === 0 && !showDefault ? (
              <CommandEmpty>No matching voices.</CommandEmpty>
            ) : (
              <CommandGroup>
                {showDefault ? (
                  <CommandItem
                    value={DEPLOYMENT_DEFAULT_VALUE}
                    data-checked={followsDefault ? "true" : "false"}
                    onSelect={() => onPick(null)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {defaultLabel}
                    </span>
                  </CommandItem>
                ) : null}
                {matching.map((voice) => (
                  <CommandItem
                    key={voice}
                    value={voice}
                    data-checked={
                      !followsDefault && voice === resolution.voice
                        ? "true"
                        : "false"
                    }
                    onSelect={() => onPick(voice)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {callVoiceLabel(voice)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </div>
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="bot-settings-voice-current"
      >
        {currentVoiceLine(resolution)}
      </p>
      <p className="text-ui-xs text-muted-foreground">
        Used on this device. Changes apply to the next call.
      </p>
      {resolution.kind === "unavailable" ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="bot-settings-voice-unavailable"
        >
          {`${callVoiceLabel(resolution.saved)} isn't available now, so calls use ${callVoiceLabel(resolution.voice)}.`}
        </p>
      ) : null}
    </div>
  );
}

/** The list's value for following the deployment's default; no voice name can be it. */
const DEPLOYMENT_DEFAULT_VALUE = "deployment-default:";

/**
 * "Selected: Marin (default)" while following the deployment's default,
 * "Selected: Cedar" for a named voice, or the saved voice that is not
 * offered now.
 */
function currentVoiceLine(resolution: CallVoiceResolution): string {
  switch (resolution.kind) {
    case "unavailable":
      return `Saved: ${callVoiceLabel(resolution.saved)} (unavailable)`;
    case "default":
      return `Selected: ${callVoiceLabel(resolution.voice)} (default)`;
    case "selected":
      return `Selected: ${callVoiceLabel(resolution.voice)}`;
  }
}

/**
 * The group while the offered voices are not known: loading, not offered by
 * this connection, or unreadable. The saved choice is kept and named.
 */
function CallVoiceWithoutChoices(props: {
  readonly kind: Exclude<CallVoiceCatalogueState["kind"], "ready">;
  readonly saved: string | null;
}): ReactNode {
  const { kind, saved } = props;
  return (
    <div className="flex flex-col gap-2" data-testid="bot-settings-voice-none">
      {kind === "loading" ? (
        <div aria-busy="true" aria-label="Loading voices">
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        </div>
      ) : (
        <p className="text-ui-xs text-muted-foreground">
          {kind === "unsupported"
            ? "Voice choices aren't available on this connection. Calls use the default voice."
            : "Couldn't load voice choices."}
        </p>
      )}
      {saved === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          {`Saved: ${callVoiceLabel(saved)}`}
        </p>
      )}
    </div>
  );
}
