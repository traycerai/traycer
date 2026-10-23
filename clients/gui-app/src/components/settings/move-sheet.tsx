import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { EnvironmentMovePlanResponse } from "@traycer/protocol/host/environment/move-contracts";
import {
  DEFAULT_KEY_CHOICE,
  MOVE_ACCEPTS_AS_SHOWN,
  MOVE_DISCLOSURE,
  MOVE_SECTIONS,
  moveAcceptRequest,
  PLAN_CHANGED_TEXT,
  type MoveKeyChoice,
  type MoveRow,
} from "@/components/settings/move-sheet-model";
import { needsUpdateSubtitle } from "@/components/settings/environment/environment-picker-model";
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
 * `Not now` closes and records nothing.
 *
 * Mounted once, in the Settings sidebar; opened through `useMoveSheetStore`.
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
  const [choices, setChoices] = useState<ReadonlyMap<string, MoveKeyChoice>>(
    () => new Map(),
  );
  const [planChanged, setPlanChanged] = useState(false);
  const accept = useHostScopedMutationForClient(client, {
    method: "environment.move.accept",
    mutationKey: environmentMutationKeys.moveAccept(),
    errorMessage: "Couldn't start the move.",
    invalidateMethods: ["environment.status", "environment.move.plan"],
  });
  const choose = (key: string, choice: MoveKeyChoice): void => {
    setChoices((current) => new Map(current).set(key, choice));
  };
  const send = (data: EnvironmentMovePlanResponse): void => {
    accept.mutate(moveAcceptRequest(data, choices), {
      onSuccess: (response) => {
        if (response.outcome === "plan_changed") {
          setPlanChanged(true);
          setChoices(new Map());
          void plan.refetch().catch(ignoreError);
          return;
        }
        props.onClose();
      },
    });
  };
  return (
    <>
      <SheetHeader>
        <SheetTitle>Move {target.hostName}'s settings to Personal</SheetTitle>
        <SheetDescription>
          {target.hostName} keeps working either way. Every row opens to its
          items.
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
        {supported === true && plan.data === undefined && !plan.isError ? (
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
        {plan.data === undefined ? null : (
          <MovePlanRows plan={plan.data} choices={choices} onChoose={choose} />
        )}
      </div>
      <SheetFooter className="flex-row justify-end gap-2">
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
          disabled={plan.data === undefined || accept.isPending}
          onClick={() => {
            if (plan.data !== undefined) send(plan.data);
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
      </SheetFooter>
    </>
  );
}

function MovePlanRows(props: {
  readonly plan: EnvironmentMovePlanResponse;
  readonly choices: ReadonlyMap<string, MoveKeyChoice>;
  readonly onChoose: (key: string, choice: MoveKeyChoice) => void;
}): ReactNode {
  const { rows } = props.plan;
  return (
    <>
      {MOVE_SECTIONS.map((section) =>
        section.empty === null && rows[section.rows].length === 0 ? null : (
          <MoveSection
            key={section.rows}
            testId={`move-sheet-${section.rows}`}
            title={section.title}
            rows={rows[section.rows]}
            empty={section.empty ?? ""}
          />
        ),
      )}
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
                choice={props.choices.get(row.key) ?? DEFAULT_KEY_CHOICE}
                onChoose={(choice) => props.onChoose(row.key, choice)}
              />
            ))}
          </ul>
        </section>
      )}
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="move-sheet-disclosure"
      >
        {MOVE_DISCLOSURE} {MOVE_ACCEPTS_AS_SHOWN}
      </p>
    </>
  );
}

function MoveSection(props: {
  readonly testId: string;
  readonly title: string;
  readonly rows: readonly MoveRow[];
  readonly empty: string;
}): ReactNode {
  return (
    <section className="flex flex-col gap-1" data-testid={props.testId}>
      <h3 className="font-medium text-ui-sm">{props.title}</h3>
      {props.rows.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <ChevronRight className="size-3.5" aria-hidden />
              {props.rows.length === 1
                ? "1 item"
                : `${props.rows.length} items`}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col gap-1 pl-6">
              {props.rows.map((row) => (
                <li
                  key={`${row.kind}:${row.key}:${row.os ?? ""}`}
                  className="text-ui-sm"
                >
                  {row.label}
                  {row.detail === null ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      · {row.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
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
        <code>{row.label}</code>
        {choice === "secret" ? " would become a secret." : null}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={choice === "variable" ? "secondary" : "outline"}
          aria-pressed={choice === "variable"}
          onClick={() =>
            props.onChoose(choice === "variable" ? "secret" : "variable")
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
            props.onChoose(choice === "stays" ? "secret" : "stays")
          }
        >
          Leave on this computer only
        </Button>
      </div>
    </li>
  );
}
