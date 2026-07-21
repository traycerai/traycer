import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ChordCaptureInput } from "@/components/settings/controls/chord-capture-input";
import { ChordCaptureCore } from "@/components/settings/controls/chord-capture-core";
import {
  ACTION_IDS,
  ACTION_META,
  type ActionId,
} from "@/lib/keybindings/actions";
import { formatModifierChordForDisplay } from "@/lib/keybindings/chord";
import { findConflict } from "@/lib/keybindings/conflicts";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { Kbd } from "@/components/ui/kbd";
import { useSummonHotkey } from "@/hooks/runner/use-summon-hotkey";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { trackSettingChanged } from "@/lib/analytics";
import type {
  DesktopGlobalShortcutsBridge,
  GlobalShortcutIntent,
  GlobalShortcutStatus,
} from "@/lib/windows/types";

const SUB_LEADER_ACTION_IDS: ReadonlyArray<ActionId> = [
  "epic.switch.byDigit",
  "app.settings.section.byDigit",
];

const SUB_LEADER_ACTION_SET = new Set<ActionId>(SUB_LEADER_ACTION_IDS);

export function KeybindingsSettingsPanel() {
  const bindings = useKeybindingStore((s) => s.bindings);
  const setBinding = useKeybindingStore((s) => s.setBinding);
  const clearBinding = useKeybindingStore((s) => s.clearBinding);
  const resetAll = useKeybindingStore((s) => s.resetAll);

  const primaryActionIds = ACTION_IDS.filter(
    (id) => !SUB_LEADER_ACTION_SET.has(id),
  );

  return (
    <section className="mx-auto w-full max-w-5xl px-8 py-10">
      <header className="sticky top-0 z-10 -mx-8 mb-8 bg-background/95 px-8 py-2 backdrop-blur">
        <h1 className="text-title-lg font-semibold text-foreground">
          Keybindings
        </h1>
      </header>
      <KeybindingList
        actionIds={primaryActionIds}
        bindings={bindings}
        setBinding={setBinding}
        clearBinding={clearBinding}
      />
      <SubLeaderSection
        actionIds={SUB_LEADER_ACTION_IDS}
        bindings={bindings}
        setBinding={setBinding}
        clearBinding={clearBinding}
      />
      <GlobalShortcutsSection />
      <div className="mt-6 flex items-center justify-end">
        <Button type="button" variant="outline" size="sm" onClick={resetAll}>
          Reset all to defaults
        </Button>
      </div>
    </section>
  );
}

interface KeybindingListProps {
  readonly actionIds: ReadonlyArray<ActionId>;
  readonly bindings: Readonly<Record<ActionId, string | null>>;
  readonly setBinding: (id: ActionId, chord: string) => void;
  readonly clearBinding: (id: ActionId) => void;
}

function KeybindingList(props: KeybindingListProps) {
  const { actionIds, bindings, setBinding, clearBinding } = props;
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <ul className="divide-y divide-border/40">
        {actionIds.map((id) => {
          const meta = ACTION_META[id];
          const chord = bindings[id];
          return (
            <li
              key={id}
              className="flex items-center justify-between gap-6 px-5 py-3"
            >
              <span className="truncate text-ui-sm text-foreground">
                {meta.label}
              </span>
              {meta.kind === "digit" ? (
                <DigitBindingDisplay actionId={id} chord={chord} />
              ) : (
                <ChordCaptureInput
                  actionId={id}
                  value={chord}
                  onChange={(next) => setBinding(id, next)}
                  onClear={() => clearBinding(id)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface SubLeaderSectionProps {
  readonly actionIds: ReadonlyArray<ActionId>;
  readonly bindings: Readonly<Record<ActionId, string | null>>;
  readonly setBinding: (id: ActionId, chord: string) => void;
  readonly clearBinding: (id: ActionId) => void;
}

function SubLeaderSection(props: SubLeaderSectionProps) {
  return (
    <div className="mt-8">
      <header className="mb-3">
        <h2 className="text-title-sm font-semibold text-foreground">
          Sub-leader
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          The primary leader (default <Kbd>⌘</Kbd>) drives the active Epic
          group. The sub-leader (default <Kbd>⌥</Kbd>) drives the header tab
          strip, and settings sections while Settings is frontmost.
        </p>
      </header>
      <KeybindingList
        actionIds={props.actionIds}
        bindings={props.bindings}
        setBinding={props.setBinding}
        clearBinding={props.clearBinding}
      />
    </div>
  );
}

interface DigitBindingDisplayProps {
  actionId: ActionId;
  chord: string | null;
}

function DigitBindingDisplay(props: DigitBindingDisplayProps) {
  const { actionId, chord } = props;
  if (chord === null) {
    return <span className="text-ui-xs text-muted-foreground">Unbound</span>;
  }
  const first = formatModifierChordForDisplay(chord, "1");
  const last = formatModifierChordForDisplay(chord, "9");
  if (actionId === "tab.switch.byDigit") {
    return (
      <span className="inline-flex items-center gap-1 text-ui-xs">
        <Kbd className="font-mono tabular-nums">{first}</Kbd>
        <span className="text-muted-foreground">–</span>
        <Kbd className="font-mono tabular-nums">{last}</Kbd>
      </span>
    );
  }
  const overflow = formatModifierChordForDisplay(
    chord,
    actionId === "epic.switch.byDigit" ? "10+" : "0",
  );
  return (
    <span className="inline-flex items-center gap-1 text-ui-xs">
      <Kbd className="font-mono tabular-nums">{first}</Kbd>
      <span className="text-muted-foreground">–</span>
      <Kbd className="font-mono tabular-nums">{last}</Kbd>
      <span className="text-muted-foreground">·</span>
      <Kbd className="font-mono tabular-nums">{overflow}</Kbd>
    </span>
  );
}

/**
 * Desktop-only: global (OS-level) shortcuts, backed by the main process
 * rather than `useKeybindingStore`/localStorage. Hidden entirely on shells
 * without the desktop bridge (browser tab, pre-registry builds).
 */
function GlobalShortcutsSection() {
  const { bridge, status } = useSummonHotkey();
  if (bridge === null) return null;

  return (
    <div className="mt-8">
      <header className="mb-3">
        <h2 className="text-title-sm font-semibold text-foreground">
          Global shortcuts
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          Registered system-wide - fires from anywhere, even when Traycer isn't
          focused.
        </p>
      </header>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
        <ul className="divide-y divide-border/40">
          <SummonHotkeyRow bridge={bridge} status={status} />
        </ul>
      </div>
    </div>
  );
}

interface SummonHotkeyRowProps {
  readonly bridge: DesktopGlobalShortcutsBridge;
  readonly status: GlobalShortcutStatus | null;
}

function SummonHotkeyRow(props: SummonHotkeyRowProps) {
  const { bridge, status } = props;
  const bindings = useKeybindingStore((s) => s.bindings);
  const mutation = useMutation({
    mutationKey: runnerMutationKeys.globalShortcutsSet("summon"),
    mutationFn: (intent: GlobalShortcutIntent) => bridge.set("summon", intent),
    onSuccess: () => {
      trackSettingChanged("keybindings", "summonHotkeyChord");
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't update the summon shortcut."),
  });

  if (status === null) {
    return (
      <li className="flex items-center justify-between gap-6 px-5 py-3">
        <span className="truncate text-ui-sm text-foreground">
          Summon Traycer
        </span>
      </li>
    );
  }

  // The OS refused registration, either just now (this row's own rebind
  // attempt) or already at launch (`mutation.data` is only set by an attempt
  // from this row) - either way it's not actually live, so show it rather
  // than let the failure live only in logs.
  const rejected =
    mutation.data?.status === "rejected" || status.status === "rejected";

  return (
    <li className="flex items-center justify-between gap-6 px-5 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="truncate text-ui-sm text-foreground">
          Summon Traycer
        </span>
        <span className="text-ui-xs text-muted-foreground">
          Shows and focuses Traycer from anywhere.
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-3">
          {mutation.isPending ? (
            <AgentSpinningDots
              className="size-3"
              testId="summon-hotkey-pending-indicator"
              variant={undefined}
            />
          ) : null}
          <Switch
            checked={status.intent.enabled}
            disabled={mutation.isPending}
            onCheckedChange={(checked) => {
              trackSettingChanged("keybindings", "summonHotkeyEnabled");
              mutation.mutate({ enabled: checked, chord: status.intent.chord });
            }}
            aria-label="Enable summon shortcut"
          />
          <ChordCaptureCore
            value={status.effectiveChord}
            controlAware={false}
            label="the summon shortcut"
            onCapture={(chord) =>
              mutation.mutate({ enabled: status.intent.enabled, chord })
            }
            onClear={() =>
              mutation.mutate({ enabled: status.intent.enabled, chord: null })
            }
            checkConflict={(candidate) => {
              const result = findConflict(bindings, null, candidate, []);
              if (result === null) return null;
              return {
                blocksCommit: result.severity === "duplicate",
                conflict: result,
              };
            }}
          />
        </div>
        {rejected ? (
          <p className="text-ui-xs text-destructive">
            In use by another application.
          </p>
        ) : null}
      </div>
    </li>
  );
}
