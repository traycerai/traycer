import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  BOT_SWATCH_COUNT,
  type BotAppearance,
  type BotAppearanceMark,
  type BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BotCreaturePreview } from "@/components/bots/bot-avatars";
import { BotSettingsRefusal } from "@/components/bots/bot-settings-group";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotLook } from "@/hooks/bots/use-bot-appearance";
import { useBotUpdateAppearanceMutation } from "@/hooks/bots/use-bot-mutations";
import {
  type CreatureChoice,
  creatureSheet,
  nextCreatureSheet,
  ownCreature,
} from "@/lib/bots/creature-mark";
import {
  botSwatchAt,
  derivedBotSwatchIndex,
} from "@/lib/providers/profile-accent-color";

/** The twelve hues' names, in the swatches' order; the deep tones follow. */
const HUE_NAMES: readonly string[] = [
  "Red",
  "Orange",
  "Amber",
  "Lime",
  "Emerald",
  "Teal",
  "Cyan",
  "Blue",
  "Violet",
  "Purple",
  "Fuchsia",
  "Pink",
];

function swatchName(index: number): string {
  const hue = HUE_NAMES[index % HUE_NAMES.length] ?? "Colour";
  return index < HUE_NAMES.length ? hue : `Deep ${hue.toLowerCase()}`;
}

const SWATCHES: readonly number[] = Array.from(
  { length: BOT_SWATCH_COUNT },
  (_, index) => index,
);

/** Which of the three a write changes, read off its request. */
type AppearanceField = "mark" | "swatch" | "background";

function fieldOf(request: BotUpdateAppearanceRequest): AppearanceField | null {
  if (request.mark !== undefined) return "mark";
  if (request.swatch !== undefined) return "swatch";
  if (request.background !== undefined) return "background";
  return null;
}

function sameCreature(a: CreatureChoice, b: CreatureChoice): boolean {
  return a.family === b.family && a.seed === b.seed;
}

/**
 * A bot's look, in its channel settings: its icon (a creature grown from its
 * id), the colour its icon sits on, and the background of its channel. Each starts on the look the bot's id gives it,
 * and "Use the default" brings that back. Drawn where the tab's host can
 * change it; the rename authority decides who may.
 */
export function BotAppearanceSettings(props: {
  readonly botId: string;
}): ReactNode {
  const { botId } = props;
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const supported =
    useHostMethodSupport(hostId, "bot.updateAppearance") === true;
  const update = useBotUpdateAppearanceMutation(client);
  const look = useBotLook(botId);
  if (!supported) return null;
  const appearance: BotAppearance = look ?? {
    mark: null,
    swatch: null,
    background: null,
  };
  const pending = update.isPending ? fieldOf(update.variables) : null;
  const failed = update.isError ? fieldOf(update.variables) : null;
  const refusal = (field: AppearanceField): string | null =>
    failed === field && update.error !== null ? update.error.message : null;
  const change = (request: Omit<BotUpdateAppearanceRequest, "botId">): void =>
    update.mutate({ botId, ...request });
  return (
    <>
      <BotIconSection
        botId={botId}
        mark={appearance.mark}
        swatch={appearance.swatch ?? derivedBotSwatchIndex(botId)}
        pending={pending === "mark"}
        disabled={update.isPending}
        refusal={refusal("mark")}
        onChange={(mark) => change({ mark })}
      />
      <SwatchSection
        label="Colour"
        testId="bot-settings-colour"
        chosen={appearance.swatch}
        pending={pending === "swatch"}
        disabled={update.isPending}
        refusal={refusal("swatch")}
        onChange={(swatch) => change({ swatch })}
      />
      <SwatchSection
        label="Background"
        testId="bot-settings-background"
        chosen={appearance.background}
        pending={pending === "background"}
        disabled={update.isPending}
        refusal={refusal("background")}
        onChange={(background) => change({ background })}
      />
    </>
  );
}

/** A section's label, with the write's dots while it is under way. */
function SectionLabel(props: {
  readonly id: string;
  readonly label: string;
  readonly pending: boolean;
}): ReactNode {
  return (
    <span
      id={props.id}
      className="flex items-center gap-1 text-ui-sm font-medium text-foreground"
    >
      {props.label}
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </span>
  );
}

function UseDefaultButton(props: {
  readonly testId: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      Use the default
    </Button>
  );
}

/** A choice's frame: pressed when it is the current one. */
const CHOICE_CLASS =
  "rounded-md p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-pressed:ring-2 aria-pressed:ring-foreground";

/**
 * The icon: the creature the bot shows now, a sheet of others to choose
 * from, and "Regenerate patterns" for the next sheet. Regenerating changes
 * only what is offered; choosing a creature is what writes.
 */
function BotIconSection(props: {
  readonly botId: string;
  readonly mark: BotAppearanceMark | null;
  /** The swatch the icon draws on now, chosen or the bot's own. */
  readonly swatch: number;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly refusal: string | null;
  readonly onChange: (mark: BotAppearanceMark | null) => void;
}): ReactNode {
  const { botId, mark, onChange } = props;
  const labelId = useId();
  const firstSheet = useMemo(() => creatureSheet(botId), [botId]);
  // The last regenerated sheet, kept for the bot it was drawn for.
  const [regenerated, setRegenerated] = useState<{
    readonly botId: string;
    readonly sheet: readonly CreatureChoice[];
  } | null>(null);
  const sheet = regenerated?.botId === botId ? regenerated.sheet : firstSheet;
  const current: CreatureChoice =
    mark === null
      ? ownCreature(botId)
      : { family: mark.family, seed: mark.seed };
  const swatch = botSwatchAt(props.swatch);
  return (
    <section
      aria-labelledby={labelId}
      data-testid="bot-settings-icon"
      className="flex flex-col gap-2"
    >
      <SectionLabel id={labelId} label="Icon" pending={props.pending} />
      <div
        data-testid="bot-settings-icon-current"
        className="flex items-center gap-2"
      >
        <BotCreaturePreview
          botId={botId}
          choice={current}
          swatch={swatch}
          size="lg"
        />
        <span className="text-ui-xs text-muted-foreground">
          Current creature
        </span>
      </div>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1.5"
      >
        {sheet.map((choice, index) => (
          <button
            key={choice.seed}
            type="button"
            aria-label={`Creature ${String(index + 1)}`}
            aria-pressed={sameCreature(choice, current)}
            className={CHOICE_CLASS}
            data-testid={`bot-settings-icon-creature-${String(index)}`}
            disabled={props.disabled}
            onClick={() =>
              onChange({
                kind: "creature",
                family: choice.family,
                seed: choice.seed,
              })
            }
          >
            <BotCreaturePreview
              botId={botId}
              choice={choice}
              swatch={swatch}
              size="default"
            />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="bot-settings-icon-regenerate"
          disabled={props.disabled}
          onClick={() =>
            setRegenerated({
              botId,
              sheet: nextCreatureSheet(botId, sheet, current),
            })
          }
        >
          Regenerate patterns
        </Button>
        <UseDefaultButton
          testId="bot-settings-icon-default"
          disabled={props.disabled || mark === null}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}

/** A row of the swatches, the chosen one pressed, and "Use the default". */
function SwatchSection(props: {
  readonly label: string;
  readonly testId: string;
  readonly chosen: number | null;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly refusal: string | null;
  readonly onChange: (swatch: number | null) => void;
}): ReactNode {
  const { chosen, onChange, testId } = props;
  const labelId = useId();
  return (
    <section
      aria-labelledby={labelId}
      data-testid={testId}
      className="flex flex-col gap-2"
    >
      <SectionLabel id={labelId} label={props.label} pending={props.pending} />
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1.5"
      >
        {SWATCHES.map((index) => (
          <button
            key={index}
            type="button"
            aria-label={swatchName(index)}
            aria-pressed={chosen === index}
            className={CHOICE_CLASS}
            data-testid={`${testId}-${String(index)}`}
            disabled={props.disabled}
            onClick={() => onChange(index)}
          >
            <span
              aria-hidden="true"
              className="block size-6 rounded-sm bg-(--swatch)"
              style={{ "--swatch": botSwatchAt(index).color } as CSSProperties}
            />
          </button>
        ))}
      </div>
      <div>
        <UseDefaultButton
          testId={`${testId}-default`}
          disabled={props.disabled || chosen === null}
          onClick={() => onChange(null)}
        />
      </div>
      <BotSettingsRefusal message={props.refusal} />
    </section>
  );
}
