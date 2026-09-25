/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 *
 * The lines at the foot of the Judge tab's two tiles. Each says what is
 * checking right now and who pays or, when something is wrong, one amber
 * sentence with one fix.
 */
import type { ReactNode } from "react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useGuiHarnessModelsQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import { autoJudgeModelLabel } from "@/hooks/auto-mode/use-auto-judge-billing";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import {
  judgeModelsFailedLine,
  judgeNoModelsLine,
  type JudgeProviderBlocker,
  type JudgeWarningCause,
} from "@/components/settings/panels/auto-judge-selection";
import { judgePickAccount } from "@/components/settings/panels/permissions/judge-tile-state";
import type {
  JudgeDroppedSwitch,
  JudgePendingSwitch,
} from "@/components/settings/panels/permissions/use-judge-toolbar-store";
import { COPILOT_PREMIUM_REQUESTS_PER_HOUR } from "@/lib/auto-mode/auto-judge-billing";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

const COPILOT_HARNESS_ID = providerIdToGuiHarnessId("copilot");

type StatusTone = "success" | "info" | "warning";

/** One status sentence, led by a dot in its role's colour. */
function StatusLine(props: {
  readonly tone: StatusTone;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-2 text-pretty",
        props.tone === "warning" && "text-warning-foreground",
      )}
      data-testid={props.testId}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          props.tone === "success" && "bg-success",
          props.tone === "info" && "bg-info",
          props.tone === "warning" && "bg-warning",
        )}
      />
      <span className="min-w-0">{props.children}</span>
    </p>
  );
}

/** The quieter second line under a status sentence, aligned past its dot. */
function StatusSubLine(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      className="pl-3.5 text-pretty text-muted-foreground"
      data-testid={props.testId}
    >
      {props.children}
    </p>
  );
}

/** A save in flight: the spinner alone, since any line would describe the
 *  choice being replaced. */
export function JudgeSavingLine(): ReactNode {
  return (
    <span className="flex items-center gap-2" data-testid="auto-judge-saving">
      <MutedAgentSpinner />
      <span className="sr-only">Saving</span>
    </span>
  );
}

/**
 * What Automatic resolves to right now, from the host's `effective`. Silent
 * for a host too old to report it, and for a verdict that is not current.
 *
 * `effective === null` is the one line for "nothing can run": whatever the
 * blocked reason, Automatic has no judge and Auto mode asks the user.
 */
export function AutomaticStatus(props: {
  /** The CURRENT verdict about Automatic. */
  readonly record: AutoJudgeGetResponse;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly copilotEnabled: boolean;
}): ReactNode {
  const effective = props.record.effective;
  if (effective === undefined) return null;
  if (effective === null) {
    return (
      <StatusLine tone="warning" testId="auto-judge-effective">
        No judge can run here · Auto mode asks you
      </StatusLine>
    );
  }
  const copilotLine = props.copilotEnabled ? (
    <StatusSubLine testId="auto-judge-copilot-fallback">
      Copilot conversations use premium requests when Traycer can&apos;t answer:{" "}
      {COPILOT_PREMIUM_REQUESTS_PER_HOUR} per hour.
    </StatusSubLine>
  ) : null;
  if (effective.source === "fallback") {
    return (
      <>
        <StatusLine tone="info" testId="auto-judge-effective">
          Now:{" "}
          <span className="font-medium text-foreground">
            each conversation&apos;s own model
          </span>{" "}
          · on your account there
        </StatusLine>
        {copilotLine}
      </>
    );
  }
  if (effective.source !== "default") return null;
  const row = props.harnesses?.find(
    (candidate) => candidate.id === effective.harnessId,
  );
  return (
    <>
      <StatusLine tone="success" testId="auto-judge-effective">
        Now:{" "}
        <span className="font-medium text-foreground">
          {row === undefined ? (
            effective.model
          ) : (
            <EffectiveModelLabel row={row} slug={effective.model} />
          )}{" "}
          on Traycer
        </span>{" "}
        · uses Traycer credits
      </StatusLine>
      {copilotLine}
    </>
  );
}

function EffectiveModelLabel(props: {
  readonly row: GuiHarnessOption;
  readonly slug: string;
}): ReactNode {
  const models = useGuiHarnessModelsQuery(props.row.id, null, {
    enabled: true,
    subscribed: true,
  }).data?.models;
  return autoJudgeModelLabel(models, props.slug) ?? props.slug;
}

/**
 * The line under a picked judge that can run: who is billed, naming the
 * account only when its provider has more than one on this machine, as the
 * chip does. Copilot adds its measured rate.
 */
export function PickedStatus(props: {
  readonly selection: AutoJudgeSelection;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
}): ReactNode {
  const { selection } = props;
  const providerLabel =
    props.harnesses?.find((row) => row.id === selection.harnessId)?.label ??
    selection.harnessId;
  const account = judgePickAccount(props.providers, selection);
  return (
    <>
      <StatusLine tone="success" testId="auto-judge-picked-status">
        Billed to your{" "}
        <span className="font-medium text-foreground">{providerLabel}</span>{" "}
        account
        {account === null ? null : ` (${profileDisplayLabel(account)})`}
      </StatusLine>
      {selection.harnessId === COPILOT_HARNESS_ID ? (
        <StatusSubLine testId="auto-judge-copilot-picked">
          Uses premium requests: {COPILOT_PREMIUM_REQUESTS_PER_HOUR} per hour of
          Auto mode.
        </StatusSubLine>
      ) : null}
    </>
  );
}

/**
 * A provider switch waiting for its models, reported on the second tile
 * whichever tile is selected, because the pending pick belongs to it: a
 * spinner while they load, and one amber line once they have answered with
 * nothing or failed. Nothing is saved until a model is known.
 */
export function PendingSwitchLine(props: {
  readonly pending: JudgePendingSwitch;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
}): ReactNode {
  const { pending } = props;
  const label =
    props.harnesses?.find((row) => row.id === pending.harnessId)?.label ??
    pending.harnessId;
  switch (pending.models) {
    case "loading":
      return (
        <span
          className="flex items-center gap-2"
          data-testid="auto-judge-pending-switch"
        >
          <MutedAgentSpinner />
          <span className="sr-only">Waiting for {label}&apos;s models</span>
        </span>
      );
    case "empty":
      return (
        <StatusLine tone="warning" testId="auto-judge-pending-switch">
          {judgeNoModelsLine(label)}
        </StatusLine>
      );
    case "failed":
      return (
        <StatusLine tone="warning" testId="auto-judge-pending-switch">
          {judgeModelsFailedLine(label)}
        </StatusLine>
      );
  }
}

/**
 * The line a provider switch dropped for having no models, or failing to load
 * them, leaves on the second tile: the same sentence the waiting switch
 * showed, kept until the picker next opens or a tile is chosen, so the tile
 * still says why nothing was saved. The switch itself is gone.
 */
export function DroppedSwitchLine(props: {
  readonly dropped: JudgeDroppedSwitch;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
}): ReactNode {
  const { dropped } = props;
  const label =
    props.harnesses?.find((row) => row.id === dropped.harnessId)?.label ??
    dropped.harnessId;
  return (
    <StatusLine tone="warning" testId="auto-judge-switch-dropped">
      {dropped.models === "empty"
        ? judgeNoModelsLine(label)
        : judgeModelsFailedLine(label)}
    </StatusLine>
  );
}

/**
 * The one amber line about the stored pick: the first thing wrong with it, in
 * one sentence with one fix. `judgeWarningCause` decides; this only chooses
 * the sentence. A provider that cannot run adds that Auto mode asks until it
 * can, since those are the causes whose fix is elsewhere.
 */
export function JudgeWarning(props: {
  readonly cause: JudgeWarningCause;
  readonly stored: AutoJudgeSelection;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const { cause, stored } = props;
  const storedRow = props.harnesses?.find((row) => row.id === stored.harnessId);
  const fixLink =
    storedRow === undefined ? (
      "Providers"
    ) : (
      <Button
        type="button"
        variant="link"
        size="inline"
        className="text-current underline"
        onClick={() => props.onOpenProvider(storedRow)}
      >
        Providers
      </Button>
    );
  const providerCause =
    cause.kind === "provider" || cause.kind === "provider-disabled";
  return (
    <>
      <StatusLine tone="warning" testId="auto-judge-warning">
        <JudgeWarningSentence
          cause={cause}
          stored={stored}
          providerLabel={storedRow?.label ?? stored.harnessId}
          fixLink={fixLink}
        />
      </StatusLine>
      {providerCause ? (
        <StatusSubLine testId="auto-judge-warning-until">
          Until then, Auto mode asks you.
        </StatusSubLine>
      ) : null}
    </>
  );
}

function JudgeWarningSentence(props: {
  readonly cause: JudgeWarningCause;
  readonly stored: AutoJudgeSelection;
  readonly providerLabel: string;
  readonly fixLink: ReactNode;
}): ReactNode {
  const { cause, providerLabel } = props;
  switch (cause.kind) {
    case "provider-disabled":
      return (
        <ProviderBlockerSentence
          label={providerLabel}
          blocker="Turned off"
          fixLink={props.fixLink}
        />
      );
    case "unsupported-harness":
      return `This machine can't run a judge on ${providerLabel}. Pick another provider.`;
    case "unrecognized":
      return `This machine's judge is set to ${props.stored.harnessId}, which this version of the app doesn't know. Pick another provider.`;
    case "provider":
      return (
        <ProviderBlockerSentence
          label={providerLabel}
          blocker={cause.blocker}
          fixLink={props.fixLink}
        />
      );
    case "model":
      return `${props.stored.model} is no longer offered on this machine. Pick another model, or Auto mode asks you instead.`;
    case "profile":
      return `The account this judge used was removed from ${providerLabel}. Pick another account, or Auto mode asks you instead.`;
  }
}

function ProviderBlockerSentence(props: {
  readonly label: string;
  readonly blocker: JudgeProviderBlocker;
  readonly fixLink: ReactNode;
}): ReactNode {
  switch (props.blocker) {
    case "Turned off":
      return (
        <>
          {props.label} is turned off on this machine. Turn it on under{" "}
          {props.fixLink}, or pick another.
        </>
      );
    case "Signed out":
      return (
        <>
          {props.label} is signed out on this machine. Sign in under{" "}
          {props.fixLink}, or pick another.
        </>
      );
    case "Not installed":
      return (
        <>
          {props.label} isn&apos;t installed on this machine. Install it under{" "}
          {props.fixLink}, or pick another.
        </>
      );
    case "Not available":
      return (
        <>
          {props.label} isn&apos;t available on this machine. Check it under{" "}
          {props.fixLink}, or pick another.
        </>
      );
  }
}
