import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Switch } from "@/components/ui/switch";
import {
  OnboardingHostPickerBar,
  OnboardingHostUnavailableNotice,
} from "@/components/onboarding/onboarding-host-picker";
import type { OnboardingHostPicker } from "@/components/onboarding/onboarding-host-picker-model";
import {
  joinProviderNames,
  type OnboardingMemoryRow,
} from "@/components/onboarding/onboarding-agent-memories-model";
import type { OnboardingAgentMemories } from "@/components/onboarding/use-onboarding-agent-memories";
import { cn } from "@/lib/utils";
import "./onboarding-memory.css";

/**
 * The memory act: whether regular agents use Traycer memories, and, when they
 * do, whether each provider picked on the act before keeps its own.
 *
 * Renders the tour's draft and nothing else - the choices, the save and its
 * outcomes live in `useOnboardingAgentMemories`, held by the tour, so this
 * can unmount on Back and Next without losing any of them.
 */
export function OnboardingMemoryStage(props: {
  readonly memory: OnboardingAgentMemories;
  readonly hostPicker: OnboardingHostPicker;
  /** "Not now": on to the next act, writing nothing. */
  readonly onNotNow: () => void;
}): ReactNode {
  const { memory, hostPicker } = props;
  return (
    <div
      data-testid="onboarding-memory-stage"
      className="onboarding-memory-stage flex h-full min-h-0 w-full min-w-0 flex-col gap-4 text-foreground"
    >
      <OnboardingHostPickerBar
        picker={hostPicker}
        className="onboarding-memory-host"
      />
      <MemoryStageBody
        memory={memory}
        hostPicker={hostPicker}
        onNotNow={props.onNotNow}
      />
    </div>
  );
}

function MemoryStageBody(props: {
  readonly memory: OnboardingAgentMemories;
  readonly hostPicker: OnboardingHostPicker;
  readonly onNotNow: () => void;
}): ReactNode {
  const { memory, hostPicker } = props;
  switch (memory.availability) {
    case "host-unavailable":
      return (
        <OnboardingHostUnavailableNotice picker={hostPicker} refusal={null} />
      );
    case "unsupported":
      return (
        <OnboardingHostUnavailableNotice
          picker={hostPicker}
          refusal={`${hostPicker.scope.hostLabel} can't turn on Traycer memories`}
        />
      );
    case "checking":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <MutedAgentSpinner />
        </div>
      );
    case "ready":
      return memory.chosen === null ? (
        <MemoryChoiceCards memory={memory} onNotNow={props.onNotNow} />
      ) : (
        <MemoryChoices memory={memory} />
      );
  }
}

/** The two cards the act opens on. Nothing is written by either. */
function MemoryChoiceCards(props: {
  readonly memory: OnboardingAgentMemories;
  readonly onNotNow: () => void;
}): ReactNode {
  const { memory } = props;
  return (
    <div className="onboarding-memory-body grid w-full gap-3 md:grid-cols-2">
      <section
        aria-labelledby="onboarding-memory-use-title"
        className="onboarding-memory-card flex flex-col gap-3"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="onboarding-memory-use-title"
            className="text-ui-lg font-medium"
          >
            Use Traycer memories
          </h2>
          <p className="text-ui-sm text-muted-foreground">
            Your agents can use and update shared memories in Traycer.
          </p>
        </div>
        <Button
          type="button"
          data-testid="onboarding-memory-use"
          className="mt-auto self-start"
          onClick={memory.choose}
        >
          {/* Already on, there is nothing to turn on: what this card still
              offers is the provider switches, which start off. */}
          {memory.alreadyOn
            ? "Set up provider memories"
            : "Use Traycer memories"}
        </Button>
      </section>
      <section
        aria-labelledby="onboarding-memory-later-title"
        className="onboarding-memory-card flex flex-col gap-3"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="onboarding-memory-later-title"
            className="text-ui-lg font-medium"
          >
            Not now
          </h2>
          <p className="text-ui-sm text-muted-foreground">
            {/* A "Not now" that turned memories off would be a write, and this
                card makes none - so with the setting already on, the line has
                to say it stays on. */}
            {memory.alreadyOn
              ? "Traycer memories stay on, and your provider memory settings stay as they are."
              : "You can enable this later in Settings. Your provider memory settings stay as they are."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          data-testid="onboarding-memory-not-now"
          className="mt-auto self-start"
          onClick={props.onNotNow}
        >
          Not now
        </Button>
      </section>
    </div>
  );
}

/** Traycer memories chosen: its switch, then the providers' own. */
function MemoryChoices(props: {
  readonly memory: OnboardingAgentMemories;
}): ReactNode {
  const { memory } = props;
  return (
    <div className="onboarding-memory-body flex w-full flex-col gap-4">
      {/* First, so a save that stopped short is read before anything else on
          the act - it is what the footer's two ways on are about. */}
      <MemorySaveReport memory={memory} />
      <div className="onboarding-memory-list">
        <MemorySwitchRow
          testId="onboarding-memory-traycer"
          title="Use Traycer memories"
          description={traycerDescription(memory)}
          checked={memory.chosen === true}
          disabled={memory.traycerLocked || memory.saving}
          ariaLabel="Use Traycer memories"
          problem={null}
          onCheckedChange={memory.setTraycer}
        />
      </div>
      {memory.chosen === true ? <ProviderMemories memory={memory} /> : null}
      <p className="text-ui-xs text-muted-foreground">
        Applies to agents you run through Traycer. Saved memories are kept.
        Change these later in Settings → Agent memories and Providers.
      </p>
    </div>
  );
}

function traycerDescription(memory: OnboardingAgentMemories): string {
  if (!memory.traycerLocked)
    return "Agents can read, add, update and remove shared memories.";
  return memory.draft.traycerOutcome?.kind === "queued"
    ? "Waiting for your configuration. Change this later in Settings → Agent memories."
    : "On. Turn it off later in Settings → Agent memories.";
}

function ProviderMemories(props: {
  readonly memory: OnboardingAgentMemories;
}): ReactNode {
  const { memory } = props;
  const keepSettings =
    memory.withoutSwitch.length === 0 ? null : (
      <p
        data-testid="onboarding-memory-without-switch"
        className="text-ui-sm text-muted-foreground"
      >
        Memory settings for {joinProviderNames(memory.withoutSwitch)} stay as
        they are.
      </p>
    );
  if (memory.providerControls === "loading")
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        Checking your providers
      </div>
    );
  if (memory.providerControls === "failed")
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-muted-foreground"
      >
        Couldn&apos;t read your providers, so their memories won&apos;t change.
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={memory.reloadProviders}
        >
          Try again
        </Button>
      </div>
    );
  if (memory.rows.length === 0) return keepSettings;
  return (
    <section
      aria-labelledby="onboarding-memory-providers-title"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="onboarding-memory-providers-title"
          className="text-ui-base font-medium"
        >
          Your providers&apos; memories
        </h2>
        <p className="text-ui-sm text-muted-foreground">
          Start with these off to keep memories together in Traycer. You can
          keep a provider&apos;s memories on.
        </p>
      </div>
      <div className="onboarding-memory-list">
        {memory.rows.map((row) => (
          <MemorySwitchRow
            key={row.providerId}
            testId={`onboarding-memory-provider-${row.providerId}`}
            title={`${row.name} memories`}
            description={`Use and save ${row.name}'s own memories.`}
            checked={row.value}
            disabled={memory.saving}
            ariaLabel={`${row.name} memories`}
            problem={
              row.outcome?.kind === "failed" ? "Not changed. Try again." : null
            }
            onCheckedChange={(value) =>
              memory.setProvider(row.providerId, value)
            }
          />
        ))}
      </div>
      {keepSettings}
    </section>
  );
}

function MemorySwitchRow(props: {
  readonly testId: string;
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  /** Why this row's last write did not land, beside the row it is about. */
  readonly problem: string | null;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="onboarding-memory-row flex items-center justify-between gap-4"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui-sm font-medium">{props.title}</span>
        <span className="text-ui-xs text-muted-foreground">
          {props.description}
        </span>
        {props.problem === null ? null : (
          <span className="text-ui-xs text-destructive">{props.problem}</span>
        )}
      </div>
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}

/**
 * What a save that stopped short did and did not change, in one place, so
 * "Skip for now" in the footer is a choice made knowing both.
 */
function MemorySaveReport(props: {
  readonly memory: OnboardingAgentMemories;
}): ReactNode {
  const lines = saveReportLines(props.memory);
  if (lines === null) return null;
  return (
    <div
      role="alert"
      data-testid="onboarding-memory-save-report"
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-3 py-2 text-ui-sm",
        "border-warning/30 bg-warning/10 text-warning-foreground",
      )}
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

const PROVIDERS_UNCHANGED = "Your providers' memories weren't changed.";

function saveReportLines(
  memory: OnboardingAgentMemories,
): ReadonlyArray<string> | null {
  if (!memory.interrupted || memory.saving) return null;
  const traycer = memory.draft.traycerOutcome;
  if (traycer?.kind === "queued")
    return [
      "Traycer memories are waiting to reach your configuration and aren't on yet. This computer sends the change when it's online.",
      PROVIDERS_UNCHANGED,
    ];
  if (traycer?.kind === "failed")
    return [
      traycer.refused
        ? "Your configuration turned this change away, so Traycer memories aren't on."
        : "Couldn't turn on Traycer memories.",
      PROVIDERS_UNCHANGED,
    ];
  return ["Traycer memories are on.", ...providerReportLines(memory.rows)];
}

function providerReportLines(
  rows: ReadonlyArray<OnboardingMemoryRow>,
): ReadonlyArray<string> {
  const failed = rows.filter((row) => row.outcome?.kind === "failed");
  const off = rows.filter((row) => row.outcome?.kind === "saved" && !row.value);
  const on = rows.filter((row) => row.outcome?.kind === "saved" && row.value);
  return [
    off.length === 0
      ? null
      : `${joinProviderNames(off.map((row) => row.name))} memories are now off.`,
    // A switch turned back on removes Traycer's override; the provider's own
    // setting decides from there, and it may well be off.
    on.length === 0
      ? null
      : `Traycer no longer turns off ${joinProviderNames(on.map((row) => row.name))} memories.`,
    `Couldn't change ${joinProviderNames(failed.map((row) => row.name))} memories.`,
  ].filter((line) => line !== null);
}
