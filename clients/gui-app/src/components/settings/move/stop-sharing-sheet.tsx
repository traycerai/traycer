/**
 * Preview of what Personal manages on this computer and what needs a choice
 * before Stop sharing can complete. Confirm stays disabled until every
 * needs-choice row has `Keep locally`, `Remove from this computer` or
 * `Resolve`.
 */
import { useState, type ReactNode } from "react";
import {
  stopChoiceEntries,
  stopSharingConfirmEnabled,
  type StopChoiceEntry,
  type StopChoiceMap,
  type StopManagedRow,
  type StopNeedsChoiceRow,
} from "@/components/settings/move/stop-sharing-choices";
import {
  STOP_CHOICES,
  STOP_SHARING_CONFIRM,
  STOP_SHARING_KEEP,
  STOP_SHARING_MANAGED,
  STOP_SHARING_MANAGED_EMPTY,
  STOP_SHARING_NEEDS_CHOICE,
  STOP_SHARING_TITLE,
  stopChoiceReasonLine,
  stopSharingDescription,
  type StopChoice,
} from "@/components/settings/move/stop-sharing-copy";
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

export type { StopChoice, StopChoiceEntry, StopManagedRow, StopNeedsChoiceRow };

export type StopPreviewStatus = "loading" | "ready" | "failed";

export function StopSharingSheet(props: {
  readonly open: boolean;
  readonly hostName: string;
  readonly managed: readonly StopManagedRow[];
  readonly needsChoice: readonly StopNeedsChoiceRow[];
  readonly previewStatus: StopPreviewStatus;
  readonly confirmPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStop: (choices: readonly StopChoiceEntry[]) => void;
}): ReactNode {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <StopSharingBody
          hostName={props.hostName}
          managed={props.managed}
          needsChoice={props.needsChoice}
          previewStatus={props.previewStatus}
          confirmPending={props.confirmPending}
          onOpenChange={props.onOpenChange}
          onStop={props.onStop}
        />
      ) : null}
    </Dialog>
  );
}

function StopSharingBody(props: {
  readonly hostName: string;
  readonly managed: readonly StopManagedRow[];
  readonly needsChoice: readonly StopNeedsChoiceRow[];
  readonly previewStatus: StopPreviewStatus;
  readonly confirmPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStop: (choices: readonly StopChoiceEntry[]) => void;
}): ReactNode {
  const [choices, setChoices] = useState<StopChoiceMap>({});
  const previewReady = props.previewStatus === "ready";
  const confirmEnabled =
    previewReady && stopSharingConfirmEnabled(props.needsChoice, choices);

  return (
    <DialogContent
      layout="banded"
      className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,40rem)] flex-col overflow-hidden sm:max-w-none"
      data-testid="stop-sharing-sheet"
    >
      <DialogHeader>
        <DialogTitle>{STOP_SHARING_TITLE}</DialogTitle>
        <DialogDescription>
          {stopSharingDescription(props.hostName)}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
        {props.previewStatus === "loading" ? (
          <p
            className="flex items-center gap-2 text-ui-sm text-muted-foreground"
            data-testid="stop-sharing-preview-loading"
          >
            Loading what Personal manages here
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          </p>
        ) : null}
        {props.previewStatus === "failed" ? (
          <p
            className="text-ui-sm text-muted-foreground"
            data-testid="stop-sharing-preview-failed"
          >
            Couldn't load what Personal manages here.
          </p>
        ) : null}
        {previewReady ? (
          <>
            <section data-testid="stop-sharing-managed">
              <h3 className="mb-2 text-ui-sm font-medium text-foreground">
                {STOP_SHARING_MANAGED}
              </h3>
              {props.managed.length === 0 ? (
                <p className="text-ui-sm text-muted-foreground">
                  {STOP_SHARING_MANAGED_EMPTY}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {props.managed.map((row) => (
                    <PreviewRow
                      key={row.key}
                      label={row.label}
                      detail={row.detail}
                      testId={`stop-sharing-managed-${row.key}`}
                    />
                  ))}
                </ul>
              )}
            </section>
            {props.needsChoice.length > 0 ? (
              <section data-testid="stop-sharing-needs-choice">
                <h3 className="mb-2 text-ui-sm font-medium text-foreground">
                  {STOP_SHARING_NEEDS_CHOICE}
                </h3>
                <ul className="flex flex-col gap-3">
                  {props.needsChoice.map((row) => (
                    <li
                      key={row.key}
                      className="flex flex-col gap-1.5"
                      data-testid={`stop-sharing-choice-row-${row.key}`}
                    >
                      <PreviewRow
                        label={row.label}
                        detail={row.detail}
                        testId={`stop-sharing-choice-label-${row.key}`}
                      />
                      <p className="text-ui-xs text-muted-foreground">
                        {stopChoiceReasonLine(row.reason)}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {STOP_CHOICES.map((action) => {
                          const selected = choices[row.key] === action.choice;
                          return (
                            <Button
                              key={action.choice}
                              type="button"
                              size="xs"
                              variant="outline"
                              aria-pressed={selected}
                              disabled={props.confirmPending}
                              data-testid={`stop-sharing-choice-${row.key}-${action.choice}`}
                              onClick={() =>
                                setChoices(
                                  selectChoice(choices, row.key, action.choice),
                                )
                              }
                            >
                              {action.label}
                            </Button>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
      <DialogFooter>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.confirmPending}
          data-testid="stop-sharing-keep"
          onClick={() => props.onOpenChange(false)}
        >
          {STOP_SHARING_KEEP}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!confirmEnabled || props.confirmPending}
          data-testid="stop-sharing-confirm"
          onClick={() =>
            props.onStop(stopChoiceEntries(props.needsChoice, choices))
          }
        >
          {STOP_SHARING_CONFIRM}
          {props.confirmPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PreviewRow(props: {
  readonly label: string;
  readonly detail: string | null;
  readonly testId: string;
}): ReactNode {
  return (
    <div data-testid={props.testId}>
      <p className="text-ui-sm text-foreground">{props.label}</p>
      {props.detail !== null ? (
        <p className="text-ui-xs text-muted-foreground">{props.detail}</p>
      ) : null}
    </div>
  );
}

function selectChoice(
  current: StopChoiceMap,
  key: string,
  choice: StopChoice,
): StopChoiceMap {
  return { ...current, [key]: choice };
}
