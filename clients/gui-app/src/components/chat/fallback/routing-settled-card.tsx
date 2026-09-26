import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Settings,
} from "lucide-react";
import type {
  ProviderNoticeDetail,
  ProviderNoticeReceipt,
  ProviderNoticeReceiptStep,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useSampledNow } from "@/lib/relative-time";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  BUG_REPORT_DETAILS_LABEL,
  NOTHING_COULD_BE_TRIED_LABEL,
  ROUTING_SETTINGS_LABEL,
} from "./fallback-copy";
import {
  fallbackHarnessForProviderLabel,
  useFallbackModelLabels,
  type FallbackModelLabelResolver,
} from "./fallback-identity";
import { FallbackNoticeDetailList } from "./fallback-notice-attribution";
import { useOpenFallbackSettings } from "./open-fallback-settings";
import { receiptCrossesProviders, receiptStepText } from "./routing-receipt";

/**
 * The settled notice, as the card reads it: the notice's own words and its
 * receipt, which is non-null by construction (a notice without one is a
 * divider and never reaches this card).
 */
export interface RoutingSettledNotice {
  readonly title: string;
  readonly message: string | null;
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
  readonly receipt: ProviderNoticeReceipt;
}

/**
 * Routing tried everything and gave up: ONE card, on the latest attempt's row
 * (spec Flow 5).
 *
 * It is the failed-turn card with the routing account folded in - the notice's
 * headline and message, a numbered receipt of what was tried and why each step
 * ended, a gear (routing is this card's subject, and settings is where the
 * receipt's "why" gets fixed), and the failed-turn card's own actions, so the
 * user continues from here rather than hunting for the original error further
 * up. The raw error and the notice's hop rows move under "Details for a bug
 * report", beside the debug icon that files one.
 *
 * Warning-toned, never the red error treatment: nothing is broken, an account
 * or a provider said no and routing ran out of places to go.
 */
export function RoutingSettledCard({
  notice,
  noticeFindUnitId,
  errorMessage,
  errorCode,
  reportAction,
  actions,
}: {
  readonly notice: RoutingSettledNotice;
  /** The notice's own find unit: its headline and message are painted here. */
  readonly noticeFindUnitId: string | null;
  readonly errorMessage: string;
  readonly errorCode: string | null;
  /** The debug icon, built by the error row that owns the report context. */
  readonly reportAction: ReactNode;
  /** The failed-turn card's action row, or `null` where it has none. */
  readonly actions: ReactNode;
}) {
  const hostId = useMaybeChatTranscript()?.hostId ?? null;
  const openSettings = useOpenFallbackSettings(hostId);
  return (
    <div
      data-testid="routing-settled-card"
      className="flex w-full flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-warning-foreground"
        />
        <div
          data-chat-find-unit={noticeFindUnitId ?? undefined}
          className="flex min-w-0 flex-1 flex-col gap-1"
        >
          <span className="font-medium text-warning-foreground">
            {notice.title}
          </span>
          {notice.message === null || notice.message.length === 0 ? null : (
            <span className="whitespace-pre-wrap break-words text-foreground/90">
              {notice.message}
            </span>
          )}
        </div>
        {/* The debug icon brings its own corner offset; the gear matches it. */}
        <div className="flex shrink-0 items-start gap-0.5">
          <TooltipWrapper
            label={ROUTING_SETTINGS_LABEL}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              size="icon-xs"
              variant="muted"
              className="-mt-1"
              aria-label={ROUTING_SETTINGS_LABEL}
              onClick={openSettings}
            >
              <Settings aria-hidden />
            </Button>
          </TooltipWrapper>
          {reportAction}
        </div>
      </div>
      <div className="flex flex-col gap-2 pl-5.5">
        <SettledReceipt steps={notice.receipt.steps} />
        <BugReportDetails
          errorMessage={errorMessage}
          errorCode={errorCode}
          details={notice.details}
        />
        {actions}
      </div>
    </div>
  );
}

/**
 * The receipt, with its model slugs named the way every routing surface names
 * them.
 *
 * Two components for the reason `FallbackManualRungActions` gives: resolving a
 * model label needs the chat's host client, which THROWS outside a host
 * runtime, and this card is durable transcript that suites render on its own.
 * Outside a chat the slugs stay slugs - the honest degradation the resolver
 * itself uses for a catalogue it cannot read.
 */
function SettledReceipt({
  steps,
}: {
  readonly steps: ReadonlyArray<ProviderNoticeReceiptStep>;
}) {
  const transcript = useMaybeChatTranscript();
  const epicId = useMaybeOpenEpicHandle()?.epicId ?? null;
  if (transcript === null || epicId === null) {
    return <ReceiptList steps={steps} modelLabelFor={RAW_MODEL_LABEL} />;
  }
  return <ResolvedReceipt steps={steps} hostId={transcript.hostId} />;
}

const RAW_MODEL_LABEL: FallbackModelLabelResolver = (_harnessId, model) =>
  model;

function ResolvedReceipt({
  steps,
  hostId,
}: {
  readonly steps: ReadonlyArray<ProviderNoticeReceiptStep>;
  readonly hostId: string;
}) {
  const client = useHostClientForHostId(hostId);
  const modelLabelFor = useFallbackModelLabels(
    client,
    steps.map((step) => fallbackHarnessForProviderLabel(step.providerLabel)),
    steps.length > 0,
  );
  return <ReceiptList steps={steps} modelLabelFor={modelLabelFor} />;
}

/**
 * "1  Switched to Fable · Surya          rate limited", one line per step, the
 * way each step ended in the destructive text colour. Empty is its own
 * sentence: a traversal that settled before trying anything still says so.
 *
 * The provider is named only on a receipt that CROSSES providers - the route
 * line's rule, for the same reason: within one provider it is the same word on
 * every line.
 */
function ReceiptList({
  steps,
  modelLabelFor,
}: {
  readonly steps: ReadonlyArray<ProviderNoticeReceiptStep>;
  readonly modelLabelFor: FallbackModelLabelResolver;
}) {
  const now = useSampledNow();
  if (steps.length === 0) {
    return (
      <p
        data-testid="routing-receipt-empty"
        className="m-0 text-ui-xs text-muted-foreground"
      >
        {NOTHING_COULD_BE_TRIED_LABEL}
      </p>
    );
  }
  const crossesProviders = receiptCrossesProviders(steps);
  // A step has no id, and none is needed: a receipt is written once and never
  // reorders, so its position IS its identity - and the number on screen.
  const numbered = steps.map((step, index) => ({ step, number: index + 1 }));
  return (
    <ol
      data-testid="routing-receipt"
      // Model labels resolve at render and the find index cannot, so the
      // receipt stays out of it rather than counting matches it cannot paint.
      data-find-skip="true"
      className="m-0 flex list-none flex-col gap-1.5 p-0 text-ui-xs text-muted-foreground"
    >
      {numbered.map(({ step, number }) => (
        <li
          key={number}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2"
        >
          <span
            aria-hidden
            className="grid size-4.5 place-items-center rounded-sm bg-foreground/6 tabular-nums"
          >
            {number}
          </span>
          <span className="min-w-0 text-foreground/90 wrap-anywhere">
            <span className="sr-only">{`Step ${number}: `}</span>
            {receiptStepText(step, {
              modelLabelFor,
              crossesProviders,
              now,
            })}
          </span>
          <span className="text-destructive">{step.endedLabel}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The raw record, collapsed: the error the turn ended with and the notice's
 * own detail rows. For whoever files the bug report, not for the decision in
 * front of the user, which is why it sits closed below the receipt.
 */
function BugReportDetails({
  errorMessage,
  errorCode,
  details,
}: {
  readonly errorMessage: string;
  readonly errorCode: string | null;
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const rows: ReadonlyArray<ProviderNoticeDetail> = [
    { label: "Error", value: errorMessage },
    ...(errorCode === null || errorCode.length === 0
      ? []
      : [{ label: "Code", value: errorCode }]),
    ...details,
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size="inline-xs"
        variant="muted"
        className="self-start"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <Chevron aria-hidden />
        {BUG_REPORT_DETAILS_LABEL}
      </Button>
      {open ? (
        <div
          data-find-skip="true"
          className="rounded-md border border-border/60 bg-foreground/3 p-2.5"
        >
          <FallbackNoticeDetailList details={rows} />
        </div>
      ) : null}
    </div>
  );
}
