/**
 * Past-tense inventory of what an earlier version already shared. Closing
 * records no consent; `Got it` records acknowledgement. Shown and
 * acknowledged are two timestamps, written by the parent through
 * `environment.review.record`; shown is recorded once the inventory it shows
 * has loaded, never for a sheet still loading.
 */
import { useEffect, useRef, type ReactNode } from "react";
import {
  RETROSPECTIVE_APPLIED_ON,
  RETROSPECTIVE_DISCLOSURE,
  RETROSPECTIVE_GOT_IT,
  RETROSPECTIVE_HELD_HOOK,
  RETROSPECTIVE_HELD_NOT_IN_USE,
  RETROSPECTIVE_MOVE_TO_PERSONAL,
  RETROSPECTIVE_RECORD_LINE,
  RETROSPECTIVE_SHARED_FROM_ROOM,
  RETROSPECTIVE_SHARED_IN_USE,
  RETROSPECTIVE_STILL_ON_THIS_COMPUTER,
  RETROSPECTIVE_STOP_SHARING,
  HELD_HOOK_CHOICES,
  HELD_VALUE_CHOICES,
  NO_MOVE_SHEET_ACCEPTANCE,
  retrospectiveEvidenceLine,
  retrospectiveTitle,
  type HeldApplyChoice,
  type HeldChoiceAction,
  type ReviewEvidence,
} from "@/components/settings/move/retrospective-copy";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { navigateToSettingsSection } from "@/lib/settings-navigation";

export type RetrospectivePageId = Extract<
  SettingsSectionId,
  | "providers"
  | "mcp-servers"
  | "skills"
  | "shell"
  | "fallback"
  | "permissions"
  | "agents"
  | "secrets"
  | "agent-definitions"
  | "browser-agent-access"
  | "machine-setup"
>;

export interface SharedInUseItem {
  readonly id: string;
  readonly label: string;
  readonly names: readonly string[];
  readonly page: RetrospectivePageId;
}

export interface HeldRow {
  readonly heldId: string;
  readonly name: string;
  readonly kind: "value" | "hook";
  readonly detail: string;
}

export interface StillLocalRow {
  readonly id: string;
  readonly summary: string;
}

export function RetrospectiveSheet(props: {
  readonly open: boolean;
  readonly inventoryReady: boolean;
  readonly hostName: string;
  readonly evidence: ReviewEvidence;
  readonly sharedInUse: readonly SharedInUseItem[];
  readonly roomShared: string | null;
  readonly appliedOn: readonly string[];
  readonly held: readonly HeldRow[];
  readonly stillLocal: readonly StillLocalRow[];
  readonly heldPendingId: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onShown: () => void;
  readonly onAcknowledged: () => void;
  readonly onHeldApply: (heldId: string, choice: HeldApplyChoice) => void;
  readonly onMoveToPersonal: () => void;
  readonly onStopSharing: () => void;
}): ReactNode {
  const { open, inventoryReady, onShown } = props;
  const shownForOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      shownForOpen.current = false;
      return;
    }
    if (!inventoryReady || shownForOpen.current) return;
    shownForOpen.current = true;
    onShown();
  }, [open, inventoryReady, onShown]);

  const valueHeld = props.held.filter((row) => row.kind === "value");
  const hookHeld = props.held.filter((row) => row.kind === "hook");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,40rem)] flex-col overflow-hidden sm:max-w-none"
        data-testid="retrospective-sheet"
      >
        <DialogHeader>
          <DialogTitle>{retrospectiveTitle(props.hostName)}</DialogTitle>
          <DialogDescription>
            {retrospectiveEvidenceLine(props.evidence)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
          <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
            {RETROSPECTIVE_RECORD_LINE}
          </p>
          <p
            className="max-w-[72ch] text-ui-sm text-muted-foreground"
            data-testid="retrospective-no-consent"
          >
            {NO_MOVE_SHEET_ACCEPTANCE}
          </p>
          <dl className="flex flex-col gap-3">
            {props.sharedInUse.length > 0 ? (
              <InventoryRow
                term={RETROSPECTIVE_SHARED_IN_USE}
                testId="retrospective-shared-in-use"
              >
                <SharedInUseList items={props.sharedInUse} />
              </InventoryRow>
            ) : null}
            {props.roomShared !== null ? (
              <InventoryRow
                term={RETROSPECTIVE_SHARED_FROM_ROOM}
                testId="retrospective-shared-from-room"
              >
                {props.roomShared}
              </InventoryRow>
            ) : null}
            {props.appliedOn.length > 0 ? (
              <InventoryRow
                term={RETROSPECTIVE_APPLIED_ON}
                testId="retrospective-applied-on"
              >
                {props.appliedOn.join(" · ")}
              </InventoryRow>
            ) : null}
            {valueHeld.length > 0 ? (
              <InventoryRow
                term={RETROSPECTIVE_HELD_NOT_IN_USE}
                testId="retrospective-held-values"
              >
                <HeldList
                  rows={valueHeld}
                  actions={HELD_VALUE_CHOICES}
                  pendingId={props.heldPendingId}
                  onHeldApply={props.onHeldApply}
                />
              </InventoryRow>
            ) : null}
            {hookHeld.length > 0 ? (
              <InventoryRow
                term={RETROSPECTIVE_HELD_HOOK}
                testId="retrospective-held-hooks"
              >
                <HeldList
                  rows={hookHeld}
                  actions={HELD_HOOK_CHOICES}
                  pendingId={props.heldPendingId}
                  onHeldApply={props.onHeldApply}
                />
              </InventoryRow>
            ) : null}
            {props.stillLocal.length > 0 ? (
              <InventoryRow
                term={RETROSPECTIVE_STILL_ON_THIS_COMPUTER}
                testId="retrospective-still-local"
              >
                <div className="flex flex-col gap-2">
                  <ul className="flex flex-col gap-1">
                    {props.stillLocal.map((row) => (
                      <li key={row.id}>{row.summary}</li>
                    ))}
                  </ul>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="retrospective-move-to-personal"
                    onClick={props.onMoveToPersonal}
                  >
                    {RETROSPECTIVE_MOVE_TO_PERSONAL}
                  </Button>
                </div>
              </InventoryRow>
            ) : null}
          </dl>
          <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
            {RETROSPECTIVE_DISCLOSURE}
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="retrospective-stop-sharing"
            onClick={props.onStopSharing}
          >
            {RETROSPECTIVE_STOP_SHARING}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="retrospective-got-it"
            onClick={() => {
              props.onAcknowledged();
              props.onOpenChange(false);
            }}
          >
            {RETROSPECTIVE_GOT_IT}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryRow(props: {
  readonly term: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
      data-testid={props.testId}
    >
      <dt className="text-ui-sm font-medium text-foreground">{props.term}</dt>
      <dd className="min-w-0 text-ui-sm text-foreground">{props.children}</dd>
    </div>
  );
}

function SharedInUseList(props: {
  readonly items: readonly SharedInUseItem[];
}): ReactNode {
  return (
    <span>
      {props.items.map((item, index) => (
        <span key={item.id}>
          {index > 0 ? " · " : null}
          <SharedInUseLink item={item} />
        </span>
      ))}
    </span>
  );
}

function SharedInUseLink(props: { readonly item: SharedInUseItem }): ReactNode {
  const names = props.item.names.join(" · ");
  return (
    <TooltipWrapper
      label={names}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        data-testid={`retrospective-link-${props.item.id}`}
        onClick={() => {
          navigateToSettingsSection(props.item.page);
        }}
      >
        {props.item.label}
      </Button>
    </TooltipWrapper>
  );
}

function HeldList(props: {
  readonly rows: readonly HeldRow[];
  readonly actions: readonly HeldChoiceAction[];
  readonly pendingId: string | null;
  readonly onHeldApply: (heldId: string, choice: HeldApplyChoice) => void;
}): ReactNode {
  return (
    <ul className="flex flex-col gap-3">
      {props.rows.map((row) => {
        const pending = props.pendingId === row.heldId;
        return (
          <li
            key={row.heldId}
            className="flex flex-col gap-1.5"
            data-testid={`retrospective-held-${row.heldId}`}
          >
            <p>
              <span className="font-mono">{row.name}</span> {row.detail}
              {pending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                  tone="muted"
                />
              ) : null}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {props.actions.map((action) => (
                <Button
                  key={action.choice}
                  type="button"
                  size="xs"
                  variant={action.choice === "discard" ? "muted" : "outline"}
                  disabled={props.pendingId !== null}
                  data-testid={`retrospective-held-${row.heldId}-${action.choice}`}
                  onClick={() => props.onHeldApply(row.heldId, action.choice)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
