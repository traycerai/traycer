import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  moveKeyChoice,
  existingSecretsArriveSentence,
  MOVE_ACCEPTS_AS_SHOWN,
  MOVE_DISCLOSURE,
  MOVE_SECTIONS,
  moveAcceptRequest,
  moveReachSentence,
  moveRecipientSentence,
  moveItemChoiceKey,
  moveRowChoices,
  movesRowText,
  movesSectionRows,
  movesSummary,
  guideDiffersNote,
  nothingToMoveLine,
  notAwaitingLine,
  PLAN_CHANGED_TEXT,
  planMovesASecret,
  planMovesNothing,
  rowsLeftHere,
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
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { environmentMutationKeys } from "@/lib/query-keys";
import {
  useMoveSheetStore,
  type MoveSheetTarget,
} from "@/stores/settings/move-sheet-store";

const EMPTY_PARAMS = {};

/**
 * The move sheet: everything a computer that has not moved would send to
 * Personal, computed by that computer (`environment.move.plan`), shown
 * before anything leaves it. `Move to Personal` accepts this list as shown
 * (`environment.move.accept` with the plan's hash and the key choices);
 * `Not now` closes and records nothing. A plan that moves nothing reads so,
 * with `Done` alone.
 *
 * Mounted once, app-wide (`EnvironmentSheetsHost`); opened through
 * `useMoveSheetStore`. While open it names the computers running Personal,
 * where the moved settings reach.
 */
export function MoveSheet(): ReactNode {
  const target = useMoveSheetStore((state) => state.target);
  const closeSheet = useMoveSheetStore((state) => state.closeSheet);
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeSheet();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-xl" showCloseButton>
        {target === null ? null : (
          <MoveSheetBody
            key={target.hostId}
            target={target}
            onClose={closeSheet}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function MoveSheetBody(props: {
  readonly target: MoveSheetTarget;
  readonly onClose: () => void;
}): ReactNode {
  const { target } = props;
  // Read only while the sheet is open: the same reads the Environment
  // dropdown makes, which the app-wide mount must not hold open otherwise.
  const runningPersonal = useHostsRunningPersonal();
  const client = useHostClientForHostId(target.hostId);
  const supported = useHostMethodSupport(
    target.hostId,
    "environment.move.plan",
  );
  const plan = useHostQuery<HostRpcRegistry, "environment.move.plan">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.move.plan",
    params: EMPTY_PARAMS,
    options: { enabled: supported === true, refetchOnWindowFocus: false },
  });
  const [choices, setChoices] = useState<MoveChoices>(() => new Map());
  const [planChanged, setPlanChanged] = useState(false);
  const [notAwaiting, setNotAwaiting] = useState(false);
  const accept = useHostScopedMutationForClient(client, {
    method: "environment.move.accept",
    mutationKey: environmentMutationKeys.moveAccept(),
    errorMessage: "Couldn't start the move.",
    invalidateMethods: ["environment.status", "environment.move.plan"],
  });
  // `null` takes a Moves row's choice back: it moves as planned.
  const choose = (key: string, choice: MoveKeyChoice | null): void => {
    setChoices((current) => {
      const next = new Map(current);
      if (choice === null) next.delete(key);
      else next.set(key, choice);
      return next;
    });
  };
  const send = (data: MovePlan): void => {
    accept.mutate(moveAcceptRequest(data, choices), {
      onSuccess: (response) => {
        if (response.outcome === "plan_changed") {
          // The accept's success invalidates `environment.move.plan`, which
          // re-reads the plan the sheet shows.
          setPlanChanged(true);
          setChoices(new Map());
          return;
        }
        if (response.outcome === "not_awaiting") {
          setNotAwaiting(true);
          return;
        }
        props.onClose();
      },
    });
  };
  const movesNothing = plan.data !== undefined && planMovesNothing(plan.data);
  const reachedHostNames = runningPersonal.hosts
    .filter((host) => host.hostId !== target.hostId)
    .map((host) => host.name);
  // Who the settings reach is said, and the plan offered, only once the
  // host list has answered: an unread list is not "no other computer".
  const shownPlan = planOnceReachKnown(runningPersonal, plan.data);
  return (
    <>
      <SheetHeader>
        <SheetTitle>Move {target.hostName}'s settings to Personal</SheetTitle>
        <SheetDescription data-testid="move-sheet-description">
          {movesNothing
            ? nothingToMoveLine(target.hostName)
            : moveSheetLead(runningPersonal, reachedHostNames, target.hostName)}
        </SheetDescription>
      </SheetHeader>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4"
        data-testid="move-sheet"
      >
        {supported === false ? (
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
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void plan.refetch().catch(ignoreError)}
            >
              Retry
            </Button>
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
          <MovePlanRows
            plan={shownPlan}
            hostName={target.hostName}
            choices={choices}
            reachedHostNames={reachedHostNames}
            onChoose={choose}
          />
        )}
      </div>
      <SheetFooter className="flex-row justify-end gap-2">
        {movesNothing ? (
          <Button
            type="button"
            data-testid="move-sheet-done"
            onClick={props.onClose}
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              data-testid="move-sheet-not-now"
              onClick={props.onClose}
            >
              Not now
            </Button>
            <Button
              type="button"
              data-testid="move-sheet-accept"
              disabled={shownPlan === null || accept.isPending}
              onClick={() => {
                if (shownPlan !== null) send(shownPlan);
              }}
            >
              Move to Personal
              {accept.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                  tone="muted"
                />
              ) : null}
            </Button>
          </>
        )}
      </SheetFooter>
    </>
  );
}

/** The plan, once the host list has answered: its lines name where it reaches. */
function planOnceReachKnown(
  running: HostsRunningConfiguration,
  plan: MovePlan | undefined,
): MovePlan | null {
  return running.state === "ready" && plan !== undefined ? plan : null;
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

/**
 * The sheet's lead. Until the host list has answered it names nobody the
 * settings reach.
 */
function moveSheetLead(
  running: HostsRunningConfiguration,
  reachedHostNames: readonly string[],
  hostName: string,
): string {
  const reach =
    running.state === "ready"
      ? `${moveReachSentence(reachedHostNames, hostName)} `
      : "";
  return `${reach}${hostName} keeps working either way. Every row opens to its items.`;
}

function MovePlanRows(props: {
  readonly plan: MovePlan;
  readonly hostName: string;
  readonly choices: MoveChoices;
  readonly reachedHostNames: readonly string[];
  readonly onChoose: (key: string, choice: MoveKeyChoice | null) => void;
}): ReactNode {
  const { plan, choices } = props;
  const { rows } = plan;
  const movesNothing = planMovesNothing(plan);
  const moving = movesSectionRows(plan, choices);
  const leftHere = rowsLeftHere(plan, choices);
  const storesASecret = planMovesASecret(plan, choices);
  return (
    <>
      {plan.guideDiffers ? (
        // Above Moves, in no section and with no choice: the move never puts
        // this guide over Personal's.
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="move-sheet-guide-differs"
        >
          {guideDiffersNote(props.hostName)}
        </p>
      ) : null}
      {moving.length === 0 ? null : (
        <MovesSection plan={plan} rows={moving} onChoose={props.onChoose} />
      )}
      {MOVE_SECTIONS.map((section) => {
        // Stays lists the rows the person left here after the plan's own.
        const stays = section.rows === "staysOnThisComputer";
        const sectionRows = stays
          ? [...rows.staysOnThisComputer, ...leftHere.keys]
          : rows[section.rows];
        const chosen = stays ? leftHere.items : [];
        // A sheet that moves nothing says so in its description instead.
        const hidden =
          sectionRows.length + chosen.length === 0 &&
          (section.empty === null || movesNothing);
        return hidden ? null : (
          <MoveSection
            key={section.rows}
            testId={`move-sheet-${section.rows}`}
            title={section.title}
            rows={sectionRows}
            chosen={chosen}
            onTakeBack={(row) => props.onChoose(moveItemChoiceKey(row), null)}
            empty={section.empty ?? ""}
            detailSeparator={section.detailSeparator}
          />
        );
      })}
      {rows.looksLikeAKey.length === 0 ? null : (
        <section
          className="flex flex-col gap-2"
          data-testid="move-sheet-looksLikeAKey"
        >
          <h3 className="font-medium text-ui-sm">Looks like a key</h3>
          <ul className="flex flex-col gap-2">
            {rows.looksLikeAKey.map((row) => (
              <LooksLikeAKeyRow
                key={row.key}
                row={row}
                choice={moveKeyChoice(row, choices.get(row.key) ?? "secret")}
                onChoose={(choice) => props.onChoose(row.key, choice)}
              />
            ))}
          </ul>
        </section>
      )}
      {movesNothing ? null : (
        <div className="flex flex-col gap-1">
          <p
            className="text-ui-sm text-muted-foreground"
            data-testid="move-sheet-disclosure"
          >
            {disclosureText(
              storesASecret,
              plan.personalHoldsSecrets,
              props.reachedHostNames,
              props.hostName,
            )}
          </p>
          <HowTraycerHandlesThis noticeText={dataHandlingNoticeText()} />
        </div>
      )}
    </>
  );
}

/**
 * Who receives what: the custody sentence and its recipient boundary when
 * this move stores a secret; that Personal's existing keys and secrets
 * arrive when it stores none but Personal holds some; then that Move accepts
 * the list as shown.
 */
function disclosureText(
  storesASecret: boolean,
  personalHoldsSecrets: boolean,
  reachedHostNames: readonly string[],
  hostName: string,
): string {
  if (storesASecret) {
    return `${MOVE_DISCLOSURE} ${moveRecipientSentence(reachedHostNames)} ${MOVE_ACCEPTS_AS_SHOWN}`;
  }
  if (personalHoldsSecrets) {
    return `${existingSecretsArriveSentence(hostName)} ${MOVE_ACCEPTS_AS_SHOWN}`;
  }
  return MOVE_ACCEPTS_AS_SHOWN;
}

/**
 * Moves as counts, with `Show all <n>` opening every row; on a host that
 * honours them, each row has its own choices.
 */
function MovesSection(props: {
  readonly plan: MovePlan;
  readonly rows: readonly MovesSectionRow[];
  readonly onChoose: (key: string, choice: MoveKeyChoice | null) => void;
}): ReactNode {
  return (
    <section className="flex flex-col gap-1" data-testid="move-sheet-moves">
      <h3 className="font-medium text-ui-sm">Moves</h3>
      <p className="text-ui-sm" data-testid="move-sheet-moves-summary">
        {movesSummary(props.rows)}
      </p>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            <ChevronRight className="size-3.5" aria-hidden />
            Show all {props.rows.length}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="flex flex-col gap-2 pl-6">
            {props.rows.map((entry) => (
              <MovesRow
                key={`${entry.row.kind}:${entry.row.key}:${entry.row.os ?? ""}`}
                plan={props.plan}
                entry={entry}
                onChoose={(choice) => props.onChoose(entry.choiceKey, choice)}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * One Moves row: its name, how it moves, and its choices. A row from Looks
 * like a key takes its choices there; a row a host does not let the person
 * choose for has none.
 */
function MovesRow(props: {
  readonly plan: MovePlan;
  readonly entry: MovesSectionRow;
  readonly onChoose: (choice: MoveKeyChoice | null) => void;
}): ReactNode {
  const { entry } = props;
  const offers = entry.looksLikeAKey
    ? { secret: false, stays: false }
    : moveRowChoices(props.plan, entry.row);
  const marked = entry.treatment === "secret";
  return (
    <li className="flex flex-col gap-1" data-testid="move-sheet-moves-row">
      <span className="text-ui-sm">
        {movesRowText(entry)}
        {entry.row.detail === null ? null : (
          <span className="text-muted-foreground"> · {entry.row.detail}</span>
        )}
      </span>
      {offers.secret || offers.stays ? (
        <div className="flex flex-wrap gap-2">
          {offers.secret ? (
            <Button
              type="button"
              size="sm"
              variant={marked ? "secondary" : "outline"}
              aria-pressed={marked}
              onClick={() => props.onChoose(marked ? null : "secret")}
            >
              Mark as a secret
            </Button>
          ) : null}
          {offers.stays ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={false}
              onClick={() => props.onChoose("stays")}
            >
              Leave on this computer only
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A section after Moves, collapsed to its count. `chosen` are Moves rows the
 * person left on this computer only, listed after the section's own rows
 * with the pressed `Leave on this computer only` that takes the choice back.
 */
function MoveSection(props: {
  readonly testId: string;
  readonly title: string;
  readonly rows: readonly MoveRow[];
  readonly chosen: readonly MoveRow[];
  readonly onTakeBack: (row: MoveRow) => void;
  readonly empty: string;
  readonly detailSeparator: string | null;
}): ReactNode {
  const count = props.rows.length + props.chosen.length;
  return (
    <section className="flex flex-col gap-1" data-testid={props.testId}>
      <h3 className="font-medium text-ui-sm">{props.title}</h3>
      {count === 0 ? (
        <p className="text-ui-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <ChevronRight className="size-3.5" aria-hidden />
              {count === 1 ? "1 item" : `${count} items`}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col gap-1 pl-6">
              {props.rows.map((row) => (
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
          </CollapsibleContent>
        </Collapsible>
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

function LooksLikeAKeyRow(props: {
  readonly row: MoveRow;
  readonly choice: MoveKeyChoice;
  readonly onChoose: (choice: MoveKeyChoice) => void;
}): ReactNode {
  const { row, choice } = props;
  return (
    <li className="flex flex-col gap-1" data-testid="move-sheet-key-row">
      <span className="text-ui-sm">
        <code>{moveRowLabel(row)}</code>
        {choice === "secret" ? " would become a secret." : null}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={choice === "variable" ? "secondary" : "outline"}
          aria-pressed={choice === "variable"}
          onClick={() =>
            props.onChoose(
              moveKeyChoice(row, choice === "variable" ? "secret" : "variable"),
            )
          }
        >
          Leave as a variable
        </Button>
        <Button
          type="button"
          size="sm"
          variant={choice === "stays" ? "secondary" : "outline"}
          aria-pressed={choice === "stays"}
          onClick={() =>
            props.onChoose(
              moveKeyChoice(row, choice === "stays" ? "secret" : "stays"),
            )
          }
        >
          Leave on this computer only
        </Button>
      </div>
    </li>
  );
}
