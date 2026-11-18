import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  GUIDE_DIFFERS_NOTE,
  MOVE_DISCLOSURE,
  MOVE_DISCLOSURE_VERSION,
  MOVE_SECTIONS,
  moveKeyChoices,
  moveRecipientSentence,
  moveItemChoiceKey,
  moveRowChoices,
  movesSectionRows,
  movesSummary,
  MOVE_SHEET_DESCRIPTION,
  notAwaitingLine,
  nothingToMoveLine,
  PLAN_CHANGED_TEXT,
  planMovesASecret,
  planMovesNothing,
  rowsLeftHere,
  STAYS_MCP_SERVERS_TITLE,
  staysRowsByName,
  type MoveChoices,
  type MoveKeyChoice,
  type MovePlan,
  type MoveRow,
  type MovesSectionRow,
} from "@/components/settings/move-sheet-model";
import { needsUpdateSubtitle } from "@/components/settings/environment/environment-picker-model";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { HowTraycerHandlesThis } from "@/components/settings/members/how-traycer-handles-this";
import { moveRowLabel } from "@/components/settings/personal/personal-page-status";
import { useMoveRerun } from "@/components/settings/move/use-move-rerun";
import type { PersonalForMove } from "@traycer-clients/shared/environment/personal-for-move";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useEnvironmentMoveStartMutation } from "@/hooks/environment/use-environment-move-start-mutation";
import { usePersonalForMoveQuery } from "@/hooks/environment/use-personal-for-move-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useMoveProgressDialogStore } from "@/stores/settings/move-progress-dialog-store";
import {
  useMoveSheetStore,
  type MoveSheetTarget,
} from "@/stores/settings/move-sheet-store";

/**
 * The move sheet: everything a computer that has not moved would send to
 * Personal, computed by that computer (`environment.move.plan`), shown
 * before anything leaves it. `Move to Personal` accepts this list as shown:
 * the computer stages it, the person's sign-in records the acceptance at
 * authn, and the computer then moves itself (`runEnvironmentMove`).
 * `Not now` closes and records nothing. A plan that moves nothing says so in
 * one line and offers the same two: the computer moves to Personal all the
 * same, with an acceptance that carries no items.
 *
 * A centred dialog: what moves as counts, and every row in one `Details`
 * fold. Mounted once, app-wide (`EnvironmentSheetsHost`); opened through
 * `useMoveSheetStore`. While open it names the computers running Personal,
 * where the moved settings reach.
 */
export function MoveSheet(): ReactNode {
  const target = useMoveSheetStore((state) => state.target);
  const closeSheet = useMoveSheetStore((state) => state.closeSheet);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeSheet();
      }}
    >
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,40rem)] flex-col overflow-hidden sm:max-w-none"
      >
        {target === null ? null : (
          <MoveSheetBody
            key={target.hostId}
            target={target}
            onClose={closeSheet}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoveSheetBody(props: {
  readonly target: MoveSheetTarget;
  readonly onClose: () => void;
}): ReactNode {
  const { target } = props;
  // Read only while the sheet is open: the same reads the Environment
  // dropdown makes, which the app-wide mount must not hold open otherwise.
  const runningPersonal = useHostsRunningPersonal(true);
  // The same `environment.list` read the host list waits on, so its failure
  // is the host list's, with that list's Retry.
  const personal = usePersonalEnvironment(true);
  const client = useHostClientForHostId(target.hostId);
  const supported = useHostMethodSupport(
    target.hostId,
    "environment.move.plan",
  );
  // The computer draws the sheet against what this app read of Personal, on
  // the person's own sign-in; the plan waits for that read.
  const personalRead = usePersonalForMoveQuery(supported === true);
  const personalItems = personalRead.data ?? null;
  const rerun = useMoveRerun(client, target.hostId);
  const plan = useHostQuery<HostRpcRegistry, "environment.move.plan">({
    cacheKeyIdentity: rerun.planKey,
    client,
    method: "environment.move.plan",
    params: {
      target: { kind: "personal", environmentId: personal.environmentId ?? "" },
      personal: personalItems,
    },
    options: {
      enabled: planAsked(
        supported,
        personal.environmentId,
        personalRead.data,
        rerun.planReadable,
      ),
      refetchOnWindowFocus: false,
    },
  });
  // Held here, above the `Details` fold, so a choice made inside it outlives
  // the fold closing, and the fold's own state outlives a plan read again.
  const [choices, setChoices] = useState<MoveChoices>(() => new Map());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [planChanged, setPlanChanged] = useState(false);
  const [notAwaiting, setNotAwaiting] = useState(false);
  const accept = useEnvironmentMoveStartMutation(
    client,
    "Couldn't start the move.",
  );
  const openProgress = useMoveProgressDialogStore((state) => state.openDialog);
  // `null` takes a Moves row's choice back: it moves as planned.
  const choose = (key: string, choice: MoveKeyChoice | null): void => {
    setChoices((current) => {
      const next = new Map(current);
      if (choice === null) next.delete(key);
      else next.set(key, choice);
      return next;
    });
  };
  const send = (data: MovePlan, environmentId: string): void => {
    accept.mutate(
      {
        hostId: target.hostId,
        target: { kind: "personal", environmentId },
        planHash: data.planHash,
        keyChoices: moveKeyChoices(data, choices),
        personal: personalItems,
      },
      {
        onSuccess: (result) => {
          if (result.kind === "sign_in_changed") return;
          if (result.kind === "plan_changed" || result.kind === "refused") {
            // Personal is read again, and the plan with it; authn refusing the
            // acceptance is the same ask: read the list again.
            void personalRead.refetch().catch(ignoreError);
            setPlanChanged(true);
            setChoices(new Map());
            return;
          }
          if (result.kind === "not_awaiting") {
            setNotAwaiting(true);
            return;
          }
          props.onClose();
          openProgress(target);
        },
      },
    );
  };
  // A plan refused for want of Personal is asked again only with Personal
  // read again: rows read now give the plan a new request, which it reads by
  // itself; a read that fails again asks the same plan again.
  const retryPlan = (): void => {
    if (rerun.stopped) {
      rerun.rerun(() => {
        setChoices(new Map());
        setNotAwaiting(false);
      });
      return;
    }
    if (personalRead.data !== null) {
      void plan.refetch().catch(ignoreError);
      return;
    }
    void personalRead
      .refetch()
      .then((reread) => (reread.data === null ? plan.refetch() : undefined))
      .catch(ignoreError);
  };
  const reachedHostNames = runningPersonal.hosts
    .filter((host) => host.hostId !== target.hostId)
    .map((host) => host.name);
  // Who the settings reach is said, and the plan offered, only once the
  // host list has answered: an unread list is not "no other computer".
  const shownPlan = planOnceReachKnown(
    runningPersonal,
    plan.data,
    plan.isError,
  );
  const environmentId = personal.environmentId;
  const versionDiffers = disclosureDiffers(shownPlan);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Move {target.hostName} to Personal?</DialogTitle>
        <DialogDescription data-testid="move-sheet-description">
          {MOVE_SHEET_DESCRIPTION}
        </DialogDescription>
      </DialogHeader>
      <div
        className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5"
        data-testid="move-sheet"
      >
        {shownPlan === null ? null : (
          <MovePlanSummary
            plan={shownPlan}
            hostName={target.hostName}
            choices={choices}
          />
        )}
        {supported === false || versionDiffers ? (
          <p className="text-ui-sm text-muted-foreground">
            {needsUpdateSubtitle(target.hostName)}
          </p>
        ) : null}
        {plan.isError ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
          >
            <span className="min-w-0">{plan.error.message}</span>
            <PlanRetryButton pending={rerun.pending} onRetry={retryPlan} />
          </div>
        ) : null}
        <HostListReadFailed running={runningPersonal} />
        {supported === true &&
        shownPlan === null &&
        runningPersonal.state !== "failed" &&
        !plan.isError ? (
          <AgentSpinningDots
            className={undefined}
            testId="move-sheet-loading"
            variant={undefined}
            tone="muted"
          />
        ) : null}
        {planChanged ? (
          <p
            role="status"
            className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
            data-testid="move-sheet-plan-changed"
          >
            {PLAN_CHANGED_TEXT}
          </p>
        ) : null}
        {notAwaiting ? (
          <p
            role="status"
            className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
            data-testid="move-sheet-not-awaiting"
          >
            {notAwaitingLine(target.hostName)}
          </p>
        ) : null}
        {shownPlan === null ? null : (
          <MovePlanDetails
            plan={shownPlan}
            choices={choices}
            reachedHostNames={reachedHostNames}
            onChoose={choose}
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
          />
        )}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          data-testid="move-sheet-not-now"
          onClick={props.onClose}
        >
          Not now
        </Button>
        <MoveAcceptButton
          plan={shownPlan}
          environmentId={environmentId}
          pending={accept.isPending}
          onAccept={send}
        />
      </DialogFooter>
    </>
  );
}

/** A plan whose disclosure is another version than {@link MOVE_DISCLOSURE}'s. */
function disclosureDiffers(plan: MovePlan | null): boolean {
  return plan !== null && plan.disclosureVersion !== MOVE_DISCLOSURE_VERSION;
}

/**
 * Move to Personal: disabled until the plan is read, and absent for a plan
 * whose disclosure this app cannot draw.
 */
function MoveAcceptButton(props: {
  readonly plan: MovePlan | null;
  readonly environmentId: string | null;
  readonly pending: boolean;
  readonly onAccept: (plan: MovePlan, environmentId: string) => void;
}): ReactNode {
  const { plan, environmentId } = props;
  if (disclosureDiffers(plan)) return null;
  return (
    <Button
      type="button"
      data-testid="move-sheet-accept"
      disabled={plan === null || environmentId === null || props.pending}
      onClick={() => {
        if (plan !== null && environmentId !== null)
          props.onAccept(plan, environmentId);
      }}
    >
      Move to Personal
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
    </Button>
  );
}

/**
 * The plan, once the host list has answered: its lines name where it reaches.
 * A refused read keeps the last plan in the cache, which is not the plan the
 * computer would move now.
 */
function planOnceReachKnown(
  running: HostsRunningConfiguration,
  plan: MovePlan | undefined,
  refused: boolean,
): MovePlan | null {
  return running.state === "ready" && plan !== undefined && !refused
    ? plan
    : null;
}

function planAsked(
  supported: boolean | null,
  environmentId: string | null,
  personal: PersonalForMove | null | undefined,
  readable: boolean,
): boolean {
  return (
    supported === true &&
    environmentId !== null &&
    personal !== undefined &&
    readable
  );
}

/** The refused plan's Retry; busy while a stopped move is started again. */
function PlanRetryButton(props: {
  readonly pending: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={props.pending}
      onClick={props.onRetry}
    >
      Retry
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
    </Button>
  );
}

/** The host list could not be read, so nothing says where the move reaches. */
function HostListReadFailed(props: {
  readonly running: HostsRunningConfiguration;
}): ReactNode {
  if (props.running.state !== "failed") return null;
  return (
    <TeamReadFailed
      message="Couldn't read which computers run Personal."
      onRetry={props.running.retry}
    />
  );
}

/** What moves, as counts: or, for a plan that moves nothing, that line. */
function MovePlanSummary(props: {
  readonly plan: MovePlan;
  readonly hostName: string;
  readonly choices: MoveChoices;
}): ReactNode {
  const moving = movesSectionRows(props.plan, props.choices);
  // Every Moves row left on this computer: no box, as no Moves section.
  if (!planMovesNothing(props.plan) && moving.length === 0) return null;
  return (
    <section className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <h3 className="font-medium text-ui-sm">Moves to Personal</h3>
      {planMovesNothing(props.plan) ? (
        <p className="text-ui-sm" data-testid="move-sheet-nothing-to-move">
          {nothingToMoveLine(props.hostName)}
        </p>
      ) : (
        <p className="text-ui-sm" data-testid="move-sheet-moves-summary">
          {movesSummary(moving)}
        </p>
      )}
    </section>
  );
}

/** Every row, closed under `Details`: the sheet's one fold. */
function MovePlanDetails(props: {
  readonly plan: MovePlan;
  readonly choices: MoveChoices;
  readonly reachedHostNames: readonly string[];
  readonly onChoose: (key: string, choice: MoveKeyChoice | null) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const { plan, choices } = props;
  const { rows } = plan;
  const movesNothing = planMovesNothing(plan);
  const moving = movesSectionRows(plan, choices);
  const leftHere = rowsLeftHere(plan, choices);
  const storesASecret = planMovesASecret(plan, choices);
  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="move-sheet-details"
        >
          <ChevronRight className="size-3.5" aria-hidden />
          Details
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 pt-2">
        {moving.length === 0 ? null : (
          <MovesSection rows={moving} onChoose={props.onChoose} />
        )}
        {MOVE_SECTIONS.map((section) => {
          // Stays lists the rows the person left here after the plan's own.
          const stays = section.rows === "staysOnThisComputer";
          const sectionRows = rows[section.rows];
          const chosen = stays ? leftHere : [];
          // A sheet that moves nothing says so in its own line instead.
          const hidden =
            sectionRows.length + chosen.length === 0 &&
            (section.empty === null || movesNothing);
          return hidden ? null : (
            <MoveSection
              key={section.rows}
              testId={`move-sheet-${section.rows}`}
              title={section.title}
              rows={sectionRows}
              namesMcpServers={stays}
              chosen={chosen}
              onTakeBack={(row) => props.onChoose(moveItemChoiceKey(row), null)}
              empty={section.empty ?? ""}
              detailSeparator={section.detailSeparator}
            />
          );
        })}
        {plan.guideDiffers ? (
          // In no section and with no choice: the move never puts this guide
          // over Personal's.
          <p
            className="text-ui-sm text-muted-foreground"
            data-testid="move-sheet-guide-differs"
          >
            {GUIDE_DIFFERS_NOTE}
          </p>
        ) : null}
        {movesNothing ? null : (
          <div className="flex flex-col gap-1">
            {storesASecret ? (
              <p
                className="text-ui-sm text-muted-foreground"
                data-testid="move-sheet-disclosure"
              >
                {`${MOVE_DISCLOSURE} ${moveRecipientSentence(props.reachedHostNames)}`}
              </p>
            ) : null}
            <HowTraycerHandlesThis noticeText={dataHandlingNoticeText()} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Moves with its count: every row by name, each with its choice. */
function MovesSection(props: {
  readonly rows: readonly MovesSectionRow[];
  readonly onChoose: (key: string, choice: MoveKeyChoice | null) => void;
}): ReactNode {
  return (
    <section className="flex flex-col gap-1" data-testid="move-sheet-moves">
      <SectionTitle
        title="Moves to Personal"
        count={props.rows.length}
        testId="move-sheet-moves-count"
      />
      <ul className="flex flex-col gap-2">
        {props.rows.map((entry) => (
          <MovesRow
            key={`${entry.row.kind}:${entry.row.key}:${entry.row.os ?? ""}`}
            entry={entry}
            onChoose={(choice) => props.onChoose(entry.choiceKey, choice)}
          />
        ))}
      </ul>
    </section>
  );
}

/** A section's title and its count. */
function SectionTitle(props: {
  readonly title: string;
  readonly count: number;
  readonly testId: string;
}): ReactNode {
  return (
    <h3 className="font-medium text-ui-sm">
      {props.title}{" "}
      <span className="text-muted-foreground" data-testid={props.testId}>
        {props.count}
      </span>
    </h3>
  );
}

/** One Moves row: its name and, on a row the person may keep here, its choice. */
function MovesRow(props: {
  readonly entry: MovesSectionRow;
  readonly onChoose: (choice: MoveKeyChoice | null) => void;
}): ReactNode {
  const { entry } = props;
  const offers = moveRowChoices(entry.row);
  return (
    <li className="flex flex-col gap-1" data-testid="move-sheet-moves-row">
      <span className="text-ui-sm">
        {moveRowLabel(entry.row)}
        {entry.row.detail === null ? null : (
          <span className="text-muted-foreground"> · {entry.row.detail}</span>
        )}
      </span>
      {offers.stays ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={false}
            onClick={() => props.onChoose("stays")}
          >
            Leave on this computer only
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A section after Moves, with its count. `chosen` are Moves rows the person
 * left on this computer only, listed after the section's own rows with the
 * pressed `Leave on this computer only` that takes the choice back.
 * `namesMcpServers` draws the section's MCP servers on one line, by name.
 */
function MoveSection(props: {
  readonly testId: string;
  readonly title: string;
  readonly rows: readonly MoveRow[];
  readonly namesMcpServers: boolean;
  readonly chosen: readonly MoveRow[];
  readonly onTakeBack: (row: MoveRow) => void;
  readonly empty: string;
  readonly detailSeparator: string | null;
}): ReactNode {
  const count = props.rows.length + props.chosen.length;
  const { mcpServerNames, others } = props.namesMcpServers
    ? staysRowsByName(props.rows)
    : { mcpServerNames: [], others: props.rows };
  return (
    <section className="flex flex-col gap-1" data-testid={props.testId}>
      <SectionTitle
        title={props.title}
        count={count}
        testId={`${props.testId}-count`}
      />
      {count === 0 ? (
        <p className="text-ui-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {mcpServerNames.length === 0 ? null : (
            <li
              className="text-ui-sm"
              data-testid={`${props.testId}-mcp-servers`}
            >
              <span>{STAYS_MCP_SERVERS_TITLE}</span>{" "}
              {mcpServerNames.map((name, index) => (
                <Fragment key={`${String(index)}:${name}`}>
                  {index === 0 ? null : ", "}
                  <span className="text-muted-foreground">{name}</span>
                </Fragment>
              ))}
            </li>
          )}
          {others.map((row) => (
            <li
              key={`${row.kind}:${row.key}:${row.os ?? ""}`}
              className="text-ui-sm"
            >
              <MoveRowText row={row} separator={props.detailSeparator} />
            </li>
          ))}
          {props.chosen.map((row) => (
            <li
              key={`chosen:${row.kind}:${row.key}:${row.os ?? ""}`}
              className="flex flex-col gap-1 text-ui-sm"
              data-testid="move-sheet-left-here-row"
            >
              <span>{moveRowLabel(row)}</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-pressed
                  onClick={() => props.onTakeBack(row)}
                >
                  Leave on this computer only
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A row's label and detail; a detail that names the item stands alone. */
function MoveRowText(props: {
  readonly row: MoveRow;
  readonly separator: string | null;
}): ReactNode {
  const { row, separator } = props;
  if (row.detail === null) return moveRowLabel(row);
  if (separator === null) return row.detail;
  return (
    <>
      {moveRowLabel(row)}
      <span className="text-muted-foreground">
        {separator}
        {row.detail}
      </span>
    </>
  );
}
