import { Button } from "@/components/ui/button";
import { ChordCaptureInput } from "@/components/settings/controls/chord-capture-input";
import {
  ACTION_IDS,
  ACTION_META,
  type ActionId,
} from "@/lib/keybindings/actions";
import { formatModifierChordForDisplay } from "@/lib/keybindings/chord";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { Kbd } from "@/components/ui/kbd";

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
    <section className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
      <header className="sticky top-0 z-10 -mx-4 mb-8 bg-background/95 px-4 py-2 backdrop-blur sm:-mx-8 sm:px-8">
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
