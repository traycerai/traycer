import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ChatFallbackListTargetsResponse,
  FallbackModelTarget,
  FallbackProfileTarget,
  FallbackTargetSkip,
} from "@traycer/protocol/host/chat-fallback";
import { tierRungSkipReasonSchema } from "@traycer/protocol/host/fallback-policy";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
  type RateLimitWindowSeverity,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";
import {
  EQUIVALENT_MODELS_HEADING,
  FINDING_DESTINATIONS_LABEL,
  NO_DESTINATIONS_LABEL,
  OTHER_PROFILES_HEADING,
  PAUSING_COUNTDOWN_LABEL,
  RECOMMENDED_LABEL,
  describeListTargetsOutcome,
} from "./fallback-copy";
import {
  fallbackHarnessLabelFor,
  fallbackKnownHarnessFor,
  useFallbackProfileLabels,
} from "./fallback-identity";
import { FallbackNoticeSettingsLink } from "./fallback-notice-attribution";
import {
  useFallbackListTargets,
  type FallbackTargetSelector,
} from "./use-fallback-targets";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The destination menu - where a switch actually gets chosen.
 *
 * ## What it is and is not
 *
 * It renders what `chat.fallback.listTargets` returned and hands a picked tuple
 * back to its caller. It does **not** own a verb: the three entry points send
 * three different ones (`chooseTarget` with a lease from the grace card, the
 * same verb with no lease from the waiting card, `runManualRung(switch)` from
 * the error card), and the surface that knows which lease or which failed
 * attempt is in play is the one that should be sending it. So `onPick` takes
 * the tuple and the caller decides.
 *
 * Open state is CONTROLLED for the same reason. The grace card has to keep the
 * popover open across an in-flight hold and close it on a refusal, and a menu
 * with its own `useState` would fight that.
 *
 * ## Three rules the rows follow
 *
 * **No group headings.** A group is policy STRUCTURE and the vocabulary table
 * bans "tier"/"ladder"/"rung"; a heading naming the group is the same thing in
 * a friendlier word, and one rendering the raw `groupId` puts an internal id in
 * front of a user. `groupId` orders same-group rows adjacently and nothing
 * more.
 *
 * **`usedPercent: null` means NOT COMPARABLE, never zero.** The row renders no
 * meter at all rather than an empty track: a bar drawn at 0% for an unread
 * gauge tells the user the opposite of what is true.
 *
 * **`selectable` is the verb's CAPABILITY answer, and the menu adds exactly one
 * policy on top of it.** `selectable === (target !== null)` means "would the
 * verb accept this": the host validates usability alone and consults neither
 * the tried set nor severity, so an `already-tried` row and a `rate-limited`
 * row both come back selectable. `already-tried` stays clickable — it is a fact
 * about this traversal, not about the destination, and a user re-choosing
 * somewhere the ladder already tried may know something the ladder does not.
 * `rate-limited` does **not**: a manual switch restamps the queued messages onto
 * that tuple, and we have current evidence it is dead. That is a concrete harm
 * rather than a policy nicety, which is why it is the one place this surface
 * overrides a capability the host would have granted.
 *
 * The branch parses `skip.reason` with `tierRungSkipReasonSchema`, which is
 * exactly what the wire contract says to do with it — the field is an open
 * string beside a rendered `label` so an unknown reason degrades to its label
 * rather than failing the response, and an unknown reason here degrades to
 * clickable rather than to a guess.
 */
export function FallbackDestinationMenu({
  triggerLabel,
  triggerDisabled,
  header,
  selector,
  epicId,
  chatId,
  client,
  open,
  onOpenChange,
  onPick,
  picking,
  preparing,
  refusal,
  emptyStateActions,
}: {
  readonly triggerLabel: string;
  readonly triggerDisabled: boolean;
  /**
   * One line above the rows, or `null`. The two card entry points use it to say
   * what is happening to the window behind the menu - "countdown paused while
   * you choose", "resumes at 3:00 PM unless you pick something" - which the
   * error card has no equivalent of.
   */
  readonly header: string | null;
  readonly selector: FallbackTargetSelector;
  readonly epicId: string;
  readonly chatId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (target: ChatRunSettings) => void;
  readonly picking: boolean;
  /**
   * The menu is open and NOT ENTITLED TO LIST - it does not hold the window it
   * would be listing destinations for.
   *
   * Two states reach it, and reading the name as "still loading" is what got
   * the second one wrong once: the grace card's `fallback.holdForChoice` is in
   * flight, **or** the host refused it. A refused hold is not a transient state
   * on the way to a held one; it means the traversal moved on, so every row the
   * menu could draw would be a pick that could only answer
   * `traversal_advanced`.
   *
   * It suppresses the FETCH, not just the rows, and that is the point: listing
   * destinations under a countdown that is still running would offer a choice
   * the window could spend while the user was reading it. The ticket's rule is
   * that this menu renders after the ack carries the lease AND the DTO reports
   * `choosing`; this is the half the menu can enforce.
   *
   * While it is set, {@link refusal} - not the pausing label - is what the body
   * says, whenever the caller has one.
   */
  readonly preparing: boolean;
  /** A refusal the caller's verb answered, rendered inline before it closes. */
  readonly refusal: string | null;
  /**
   * Actions for the EMPTY state, or `null` for none.
   *
   * The error card passes its Retry / Wait-until, built from `eligibleRungs` -
   * a menu that found nothing is exactly where those are worth repeating. The
   * two card entry points pass `null`: their equivalents ("Don't switch",
   * "Stop waiting") are already on the card the popover is anchored to, and a
   * second button for one action is two controls telling one truth.
   */
  readonly emptyStateActions: ReactNode | null;
}) {
  const listing = open && !preparing;
  const targets = useFallbackListTargets(client, {
    epicId,
    chatId,
    selector,
    enabled: listing,
  });
  const labelFor = useFallbackProfileLabels(client, listing);
  const data = targets.data;
  const failedTuple = data?.failedTuple ?? null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" disabled={triggerDisabled}>
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-full max-w-[min(90vw,26rem)] flex-col gap-2 p-2 text-ui-sm"
      >
        {header === null ? null : (
          <div className="px-1 text-ui-xs text-muted-foreground">{header}</div>
        )}
        {/*
         * Suppressed while `preparing`, because the body renders the refusal
         * there instead. The two states are different: a menu that IS listing
         * shows its refusal above the rows it is still showing (the error
         * card's stale-pick case), while a menu that never became entitled has
         * no rows and the refusal IS its whole content. Rendering the line in
         * both places would print it twice on the second.
         */}
        {refusal === null || preparing ? null : (
          <div className="px-1 text-ui-xs text-amber-700 dark:text-amber-300">
            {refusal}
          </div>
        )}
        <MenuBody
          data={data}
          preparing={preparing}
          refusal={refusal}
          isPending={targets.isPending}
          isError={targets.isError}
          failedTuple={failedTuple}
          labelFor={labelFor}
          picking={picking}
          onPick={onPick}
          emptyStateActions={emptyStateActions}
        />
      </PopoverContent>
    </Popover>
  );
}

function MenuBody({
  data,
  preparing,
  refusal,
  isPending,
  isError,
  failedTuple,
  labelFor,
  picking,
  onPick,
  emptyStateActions,
}: {
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly preparing: boolean;
  readonly refusal: string | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly failedTuple: ChatRunSettings | null;
  readonly labelFor: (profileId: string | null) => string;
  readonly picking: boolean;
  readonly onPick: (target: ChatRunSettings) => void;
  readonly emptyStateActions: ReactNode | null;
}) {
  // Checked BEFORE the query's own pending flag. A disabled query also reports
  // `isPending`, so without this the hold and the listing would render the same
  // sentence, and "Finding destinations…" while the countdown is still running
  // is the one thing this state must not say.
  if (preparing) {
    // A refusal WINS over the pausing label. Both describe the same gate, but
    // only one of them is true at a time: "Pausing the countdown…" beside
    // "Couldn't pause the countdown" would be the menu contradicting itself in
    // two adjacent lines, and the refusal is the more specific fact.
    return (
      <div className="px-1 py-2 text-ui-xs text-muted-foreground">
        {refusal ?? PAUSING_COUNTDOWN_LABEL}
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="px-1 py-2 text-ui-xs text-muted-foreground">
        {FINDING_DESTINATIONS_LABEL}
      </div>
    );
  }
  // A transport failure, which IS an error - unlike every `outcome` below, all
  // of which arrive in a successful response. The menu says so and offers
  // nothing rather than rendering an empty list that reads as "no options".
  if (isError || data === undefined) {
    return (
      <div className="flex flex-col gap-2 px-1 py-2">
        <span className="text-ui-xs text-muted-foreground">
          Couldn&apos;t reach this chat&apos;s host just now.
        </span>
        <FallbackNoticeSettingsLink />
      </div>
    );
  }

  const moved = describeListTargetsOutcome(data.outcome);
  if (moved !== null) {
    return (
      <div className="px-1 py-2 text-ui-xs text-muted-foreground">{moved}</div>
    );
  }

  const hasRows =
    data.profileTargets.length > 0 || data.modelTargets.length > 0;
  if (!hasRows) {
    return (
      <div className="flex flex-col gap-2 px-1 py-2">
        <span className="text-ui-xs text-muted-foreground">
          {/*
           * The host's own words when it gave them. `modelTargetsSkip` sits
           * BESIDE the array rather than inside it because it describes the
           * absence of candidates rather than a candidate - and `no-group`, the
           * commonest ineligibility, is exactly the case a generic sentence
           * would fail. Rendered verbatim per the contract: `label` is always
           * safe to show, and re-wording it here would be a second voice.
           */}
          {data.modelTargetsSkip?.label ?? NO_DESTINATIONS_LABEL}
        </span>
        {emptyStateActions}
        <FallbackNoticeSettingsLink />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {data.profileTargets.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="px-1 text-overline font-semibold uppercase text-muted-foreground">
            {OTHER_PROFILES_HEADING}
          </h3>
          {data.profileTargets.map((target) => (
            <ProfileRow
              // The ambient account's `null` IS its identity, so it is the key:
              // React stringifies it, and a provider has at most one ambient
              // login, so there is nothing a literal fallback would
              // disambiguate that this does not.
              key={target.profileId}
              target={target}
              failedTuple={failedTuple}
              picking={picking}
              onPick={onPick}
            />
          ))}
        </section>
      )}
      {data.modelTargets.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="px-1 text-overline font-semibold uppercase text-muted-foreground">
            {EQUIVALENT_MODELS_HEADING}
          </h3>
          {data.modelTargets.map((target) => (
            <ModelRow
              key={`${target.groupId}:${target.harnessId}:${target.modelFamily}:${target.profileId ?? "ambient"}`}
              target={target}
              labelFor={labelFor}
              picking={picking}
              onPick={onPick}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * A sibling ACCOUNT on the failed tuple's own provider.
 *
 * The tuple it sends is the failed one with `profileId` swapped, and that is the
 * one place this menu builds a tuple rather than forwarding one. It is exact and
 * not a reconstruction: same provider, same model, same permission and agent
 * modes - only the account moves, so there is nothing for the engine to
 * re-derive. That is precisely why a MODEL row carries its own `target` and
 * this one does not: crossing providers re-derives effort and fast mode against
 * the destination's catalog, which a client would drift from on the next
 * catalog change.
 *
 * Disabled with no failed tuple in hand. A response that answered `listed` with
 * `failedTuple: null` has nothing to swap into, and sending a half-built tuple
 * would be worse than offering nothing.
 */
function ProfileRow({
  target,
  failedTuple,
  picking,
  onPick,
}: {
  readonly target: FallbackProfileTarget;
  readonly failedTuple: ChatRunSettings | null;
  readonly picking: boolean;
  readonly onPick: (target: ChatRunSettings) => void;
}) {
  const disabled =
    picking ||
    !target.selectable ||
    failedTuple === null ||
    skipIsCurrentDeadEvidence(target.skip);
  return (
    <TargetRow
      disabled={disabled}
      onClick={() => {
        if (failedTuple === null) return;
        onPick({ ...failedTuple, profileId: target.profileId });
      }}
      icon={null}
      title={target.label}
      recommended={target.recommended}
      severity={target.severity}
      usedPercent={target.usedPercent}
      note={target.skip?.label ?? null}
      warnings={[]}
    />
  );
}

/** An equivalent model on ANOTHER provider - the tuple comes from the engine. */
function ModelRow({
  target,
  labelFor,
  picking,
  onPick,
}: {
  readonly target: FallbackModelTarget;
  readonly labelFor: (profileId: string | null) => string;
  readonly picking: boolean;
  readonly onPick: (target: ChatRunSettings) => void;
}) {
  const tuple = target.target;
  // `selectable` is documented as exactly `target !== null`, and this reads the
  // tuple rather than the flag: a row with nothing to send cannot be clicked
  // whatever the flag says, and the narrowing is what lets `onPick` take a
  // non-null tuple.
  const disabled =
    picking || tuple === null || skipIsCurrentDeadEvidence(target.skip);
  // `null` for a harness this build has never heard of - the row still renders,
  // named by its wire id, just without a glyph. The alternative would be a cast
  // of the open wire string into `GuiHarnessId`.
  const knownHarness = fallbackKnownHarnessFor(target.harnessId);
  return (
    <TargetRow
      disabled={disabled}
      onClick={() => {
        if (tuple === null) return;
        onPick(tuple);
      }}
      icon={
        knownHarness === null ? null : (
          <HarnessIcon harnessId={knownHarness} className="size-3" />
        )
      }
      title={`${fallbackHarnessLabelFor(target.harnessId)} · ${target.modelFamily}`}
      recommended={false}
      severity={target.severity}
      usedPercent={target.usedPercent}
      note={target.skip?.label ?? labelFor(target.profileId)}
      warnings={target.warnings}
    />
  );
}

/** One row's presentation, shared so the two kinds cannot drift apart. */
function TargetRow({
  disabled,
  onClick,
  icon,
  title,
  recommended,
  severity,
  usedPercent,
  note,
  warnings,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode | null;
  readonly title: string;
  readonly recommended: boolean;
  readonly severity: string;
  readonly usedPercent: number | null;
  readonly note: string | null;
  readonly warnings: ReadonlyArray<string>;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left",
        "hover:bg-foreground/8 focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {recommended ? (
          <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-ui-xs text-muted-foreground">
            {RECOMMENDED_LABEL}
          </span>
        ) : null}
        <UsageMeter severity={severity} usedPercent={usedPercent} />
      </span>
      {note === null ? null : (
        <span className="text-ui-xs text-muted-foreground">{note}</span>
      )}
      {warnings.map((warning) => (
        <span key={warning} className="text-ui-xs text-muted-foreground">
          {warning}
        </span>
      ))}
    </button>
  );
}

/**
 * `listTargets`'s severity vocabulary, mapped onto the app's.
 *
 * They are DIFFERENT vocabularies and that is not a mistake to paper over:
 * `fallbackProfileTargetSchema.severity` is an open string documented as
 * `ok | near_limit | hard_limit | unknown`, while every meter in this app is
 * coloured from `LiveProviderRateLimitSeverity` (`healthy | running_low |
 * limited`). Mapping through the shared helper rather than picking new colours
 * is what keeps a menu row and the same account's row in Settings the same
 * shade.
 *
 * A severity this build has never heard of maps to `null` and renders NO bar -
 * the same degradation `fallbackReasonLabelFor` makes for an unknown reason,
 * and for the same reason: a bar is a claim about headroom, and a colour picked
 * by default would be a claim we did not receive.
 */
const METER_SEVERITY_BY_WIRE_ID: ReadonlyMap<string, RateLimitWindowSeverity> =
  new Map([
    ["ok", "healthy"],
    ["near_limit", "running_low"],
    ["hard_limit", "limited"],
  ]);

function UsageMeter({
  severity,
  usedPercent,
}: {
  readonly severity: string;
  readonly usedPercent: number | null;
}) {
  const mapped = METER_SEVERITY_BY_WIRE_ID.get(severity);
  // `null` is NOT COMPARABLE, never zero. An empty track at 0% for a gauge
  // nobody read says "plenty of headroom", which is the opposite of what an
  // unread gauge means.
  if (usedPercent === null || mapped === undefined) return null;
  return (
    <span
      aria-hidden
      className="h-1 w-[clamp(3.5rem,22%,5.5rem)] shrink-0 overflow-hidden rounded-full bg-foreground/15"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          rateLimitWindowSeverityBarClassName(mapped),
        )}
        style={{ width: `${rateLimitWindowFillPercent(usedPercent)}%` }}
      />
    </span>
  );
}

/**
 * Whether a row's skip reason is CURRENT evidence the destination is dead.
 *
 * One reason qualifies, and only one. `rate-limited` says we have a live gauge
 * reading for that account right now - so a manual switch would restamp the
 * queued messages onto a tuple we already know will fail. Every other reason is
 * either a property of this traversal (`already-tried`) or a static
 * ineligibility the host has already turned into `selectable: false`.
 *
 * Parsed rather than string-compared, which is what the wire contract asks for:
 * the field is an open string beside a rendered `label` precisely so a reason a
 * released client has never heard of degrades instead of failing the response.
 * Here it degrades to CLICKABLE - refusing an unrecognised reason would be this
 * surface inventing a policy out of a word it does not know.
 */
function skipIsCurrentDeadEvidence(skip: FallbackTargetSkip | null): boolean {
  if (skip === null) return false;
  const parsed = tierRungSkipReasonSchema.safeParse(skip.reason);
  return parsed.success && parsed.data === "rate-limited";
}
