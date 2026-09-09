import { useId, type ReactNode } from "react";
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
  DESTINATION_MENU_DIALOG_LABEL,
  EQUIVALENT_MODELS_HEADING,
  FINDING_DESTINATIONS_LABEL,
  HOST_UNREACHABLE_LABEL,
  NO_DESTINATIONS_LABEL,
  NO_SELECTABLE_DESTINATIONS_LABEL,
  OTHER_PROFILES_HEADING,
  PAUSING_COUNTDOWN_LABEL,
  RECOMMENDED_LABEL,
  describeListTargetsOutcome,
} from "./fallback-copy";
import {
  fallbackDestinationOfModelTarget,
  fallbackDestinationRowTitle,
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
   * on the way to a held one - no token was minted, so the menu holds no window
   * and every row it could draw would be a pick against a freeze nobody owns.
   *
   * Deliberately NOT "the traversal moved on". That was one cause stated as the
   * only one, and it is no longer even the common one: an ACCEPTED ack carrying
   * no token also lands here (`reconcileFallbackChoiceAck` - the host took the
   * freeze and minted nothing), and since B1 made reopening from `choosing` a
   * normal path, a refusal no longer implies the window is gone. What the menu
   * can say is that it has nothing to list; why is the host's to report.
   *
   * It suppresses the FETCH, not just the rows, and that is the point: listing
   * destinations under a countdown that is still running would offer a choice
   * the window could spend while the user was reading it. The ticket's rule is
   * that this menu renders after the ack carries the lease AND the DTO reports
   * `choosing`; this is the half the menu can enforce.
   *
   * While it is set AND the caller has a {@link refusal}, the body says
   * NOTHING: the refusal is rendered once, above, by the element that is both
   * the visible line and the live region, and `MenuBody`'s `preparing` arm
   * yields to it rather than repeating the pausing label underneath. One fact,
   * one element (D213) - an earlier revision printed it twice, which announced
   * it twice and double-matched `getByText`.
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
  const headerId = useId();

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" disabled={triggerDisabled}>
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // Radix gives this content `role="dialog"`, so it reached the
        // accessibility tree as an UNNAMED dialog - announced as "dialog" and
        // nothing else, which tells a screen-reader user that something opened
        // and not what. The header, when there is one, is its description
        // rather than a loose paragraph: the consequences of a pick are the
        // one thing that must be heard before the rows are.
        aria-label={DESTINATION_MENU_DIALOG_LABEL}
        aria-describedby={header === null ? undefined : headerId}
        className="flex w-full max-w-[min(90vw,26rem)] flex-col gap-2 p-2 text-ui-sm"
      >
        {header === null ? null : (
          <div id={headerId} className="px-1 text-ui-xs text-muted-foreground">
            {header}
          </div>
        )}
        {/*
         * The refusal, in ONE element that is both the visible line and the
         * live region.
         *
         * Persistent and empty until there is something to say, which is the
         * whole mechanism: a region mounted at the same moment its text
         * appears announces nothing, because assistive tech reports CHANGES
         * within a region it was already observing. Refusals here deliberately
         * bypass the toast layer, so before this the inline line was the only
         * feedback and a screen reader never learnt of it at all.
         *
         * `empty:sr-only`, NOT `empty:hidden`, and the difference is the whole
         * claim above. `display:none` takes an element out of the
         * accessibility tree entirely, so the "persistent" region was absent
         * for exactly as long as it had nothing to say and appeared already
         * carrying its text - the mount-with-content case this comment
         * describes as announcing nothing. It was written correct and built
         * inert. `sr-only` keeps the element in the tree, so the region is
         * observed from open, and it is `position: absolute`, so an empty one
         * is not a flex item and contributes no gap to the column - which is
         * the layout problem `empty:hidden` was there to solve.
         *
         * One element rather than a visible line plus an `sr-only` copy. A
         * second hidden copy is not a neutral addition: it says the same
         * sentence twice into the accessibility tree, and it is also visible
         * to `getByText`, so it turns every existing single-match query into a
         * double match. The lesson was not "the tests were too strict".
         *
         * That prediction was correct and has since been collected. F25 needed
         * the FAILURE and STALE states announced as well, and for those there
         * is no single-element form: the sentence lives inside `MenuBody`'s
         * branch, a persistent live wrapper around the body would announce
         * every destination row once the list arrived, and `aria-hidden` on
         * the visible copy would delete the only readable sentence for the
         * users the region exists for. So those two - and ONLY those two - are
         * deliberately duplicated, and the first run after the change reddened
         * `renders a sentence and no rows for every non-listed listTargets
         * outcome` on `Found multiple elements`, exactly as written above.
         *
         * The suite now pins the duplication at `toHaveLength(2)` rather than
         * tolerating it, so removing either copy reds. The paragraph above
         * still governs the REFUSAL, which keeps its single-element form for
         * the reason it gives: where one element can be both the visible line
         * and the live region, that is still the better shape.
         *
         * It is also why {@link MenuBody} renders nothing at all while
         * `preparing` with a refusal in hand: this line is the refusal now, and
         * "Pausing the countdown…" underneath it would be the menu
         * contradicting itself in two adjacent lines.
         */}
        <div
          role="status"
          aria-live="polite"
          className="px-1 text-ui-xs text-amber-700 empty:sr-only dark:text-amber-300"
        >
          {refusal}
        </div>
        {/*
         * Every OTHER settled state of the menu: the listing failed, the
         * listing is stale, or the rows are ready.
         *
         * This used to carry readiness alone, on the argument that the rest
         * "already render a line the reader can find". Findable is not
         * announced. The popover does not move focus when its body swaps, so a
         * screen-reader user who opened the menu and waited heard the row
         * count arrive and heard NOTHING when the listing failed or when the
         * chat had moved on underneath them - the two states where doing
         * nothing further is the wrong next move. Silence is not a neutral
         * default; it is the menu withholding the one fact that changes what
         * the user should do.
         *
         * The refusal is excluded because it has its own live region above,
         * which is both the visible line and the announcement - one element,
         * one sentence, said once.
         *
         * Failure and staleness are NOT excluded, and they do put their
         * sentence into the accessibility tree twice: once here, once in the
         * body that renders it visibly. That cost is taken deliberately. The
         * alternative - a second, terser wording for the live region only -
         * would be a parallel copy table for the same five outcomes, and this
         * module's own history is that the rule living in two places gets
         * fixed in one. Two mentions of the truth beats one mention of a
         * divergent version of it. Note for the suite: `getByText` sees both
         * copies, so queries on those sentences want `getAllByText` or a
         * role-scoped query.
         *
         * No focus movement anywhere. The fix for a silent popup is not to
         * start stealing focus.
         */}
        <div role="status" aria-live="polite" className="sr-only">
          {menuStatusAnnouncement({
            preparing,
            refusal,
            isPending: targets.isPending,
            isError: targets.isError,
            data,
          })}
        </div>
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

/**
 * What the menu has SETTLED on, for the live region - a failure, a stale
 * listing, or a count of what can be chosen. `""` only while nothing has
 * settled yet, or when another element is already announcing.
 *
 * The two silences left, and why each is right:
 *
 * - **A refusal.** Spoken by its own region above, which is simultaneously the
 *   visible line. Repeating it here would be the same sentence from two live
 *   regions in the same popover.
 * - **Preparing or loading.** A spinner is not a result. The user asked for
 *   this by opening the menu, the visible line says which wait it is, and an
 *   announcement per intermediate state turns the arrival of the real answer
 *   into the third thing they heard rather than the first.
 *
 * Everything after that speaks, including the two states that used to be
 * silent on the theory that a visible line was enough. It is not: nothing here
 * moves focus, so a body that swaps under an open popover is a change no
 * screen reader is looking at.
 *
 * Counts SELECTABLE rows rather than rows: "3 destinations available" over a
 * list where none can be clicked would be this region contradicting every row
 * under it, which is the same defect F12 fixed in the visible half.
 */
function menuStatusAnnouncement(input: {
  readonly preparing: boolean;
  readonly refusal: string | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data: ChatFallbackListTargetsResponse | undefined;
}): string {
  if (input.refusal !== null) return "";
  if (input.preparing || input.isPending) return "";
  // The transport failed. Same words the body prints, for the reason given at
  // the call site: one wording per fact, even at the cost of saying it twice.
  if (input.isError || input.data === undefined) return HOST_UNREACHABLE_LABEL;
  // The listing arrived and is already stale - the chat resumed, the decision
  // was made, a later turn ran, or the host could not read its own state. The
  // menu is open over rows that will refuse every pick, and this is the state
  // where hearing nothing costs the user the most: they are waiting to choose
  // from a list that is not going to work.
  const moved = describeListTargetsOutcome(input.data.outcome);
  if (moved !== null) return moved;
  const failedTuple = input.data.failedTuple;
  const selectable =
    input.data.profileTargets.filter((target) =>
      profileRowSelectable(target, failedTuple),
    ).length + input.data.modelTargets.filter(modelRowSelectable).length;
  // Not silent at zero: "nothing to choose from" is a readiness answer, and the
  // one a user waiting on a spinner most needs. The visible half says it in
  // different words, next to the recovery actions.
  if (selectable === 0) return "No destinations are available to choose.";
  return selectable === 1
    ? "1 destination available to choose."
    : `${selectable} destinations available to choose.`;
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
    //
    // The refusal is now rendered ONCE, by the status region above, so this
    // arm yields the space rather than printing it a second time.
    return refusal !== null ? null : (
      <div className="px-1 py-2 text-ui-xs text-muted-foreground">
        {PAUSING_COUNTDOWN_LABEL}
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
          {HOST_UNREACHABLE_LABEL}
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
  // "Rows exist" and "a destination is SELECTABLE" are different facts, and
  // treating the first as the second is what left a menu full of disabled rows
  // with no way out: no "nothing available" sentence, no Retry / Wait
  // alternative, and no Settings link - a popover that explained, at length,
  // why the user could not do any of the things it was offering.
  //
  // `picking` is deliberately NOT part of this: a menu does not become empty
  // because a pick is in flight. The rows' own `disabled` ORs it back in.
  const hasSelectableRow =
    data.profileTargets.some((target) =>
      profileRowSelectable(target, failedTuple),
    ) || data.modelTargets.some(modelRowSelectable);
  if (!hasSelectableRow) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 px-1 py-2">
          <span className="text-ui-xs text-muted-foreground">
            {/*
             * The host's own words when it gave them. `modelTargetsSkip` sits
             * BESIDE the array rather than inside it because it describes the
             * absence of candidates rather than a candidate - and `no-group`,
             * the commonest ineligibility, is exactly the case a generic
             * sentence would fail. Rendered verbatim per the contract: `label`
             * is always safe to show, and re-wording it here would be a second
             * voice.
             */}
            {data.modelTargetsSkip?.label ??
              (hasRows
                ? NO_SELECTABLE_DESTINATIONS_LABEL
                : NO_DESTINATIONS_LABEL)}
          </span>
          {emptyStateActions}
          <FallbackNoticeSettingsLink />
        </div>
        {/*
         * The rows still render underneath when there ARE any. Each carries
         * the host's own reason for being unusable, and those explanations are
         * the most useful thing on screen for deciding what to do next - the
         * defect was never that they were shown, it was that they were the
         * ONLY thing shown.
         */}
        {hasRows ? (
          <TargetSections
            data={data}
            failedTuple={failedTuple}
            labelFor={labelFor}
            picking={picking}
            onPick={onPick}
          />
        ) : null}
      </div>
    );
  }

  return (
    <TargetSections
      data={data}
      failedTuple={failedTuple}
      labelFor={labelFor}
      picking={picking}
      onPick={onPick}
    />
  );
}

function TargetSections({
  data,
  failedTuple,
  labelFor,
  picking,
  onPick,
}: {
  readonly data: ChatFallbackListTargetsResponse;
  readonly failedTuple: ChatRunSettings | null;
  readonly labelFor: (profileId: string | null) => string;
  readonly picking: boolean;
  readonly onPick: (target: ChatRunSettings) => void;
}) {
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
/**
 * Whether a sibling-account row is one the user could actually pick.
 *
 * Extracted so the ROW's `disabled` and the MENU's "is anything selectable"
 * question are answered by one function rather than two that agree today. They
 * did not agree before: the menu counted array length and the row counted
 * three separate conditions, so a menu of unusable rows called itself
 * populated. `picking` stays out of it deliberately - see `hasSelectableRow`.
 */
function profileRowSelectable(
  target: FallbackProfileTarget,
  failedTuple: ChatRunSettings | null,
): boolean {
  if (!target.selectable) return false;
  if (failedTuple === null) return false;
  return !skipIsCurrentDeadEvidence(target.skip);
}

/** The equivalent-model row's half of {@link profileRowSelectable}'s rule. */
function modelRowSelectable(target: FallbackModelTarget): boolean {
  if (target.target === null) return false;
  return !skipIsCurrentDeadEvidence(target.skip);
}

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
  const disabled = picking || !profileRowSelectable(target, failedTuple);
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
  // `selectable` is documented as exactly `target !== null`, and the shared
  // predicate reads the tuple rather than the flag: a row with nothing to send
  // cannot be clicked whatever the flag says. The null check stays HERE as
  // well, because it is what narrows `tuple` for `onPick`.
  const disabled = picking || !modelRowSelectable(target);
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
      // The RESOLVED model and its effort, with the family only as the
      // fallback for a candidate the host stopped resolving. Titling by
      // `modelFamily` unconditionally meant a group named `gpt` offered a
      // click that would launch `gpt-6-astra`, and the row never said so.
      title={fallbackDestinationRowTitle(
        fallbackDestinationOfModelTarget(target, labelFor),
      )}
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
        {/*
         * Text first, bar second. The bar is `aria-hidden` decoration; this
         * span is what the row actually says about its headroom, so it is part
         * of the button's accessible name rather than a tooltip or a colour.
         */}
        <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground">
          {usageStatusText(severity, usedPercent)}
        </span>
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

/**
 * The words for each severity - the SAME ones the profile rate-limit banner
 * uses for the same account.
 *
 * Borrowed rather than invented so a row here and that account's row in the
 * composer read alike; two vocabularies for one gauge is two things for a user
 * to learn about one fact.
 */
const METER_STATUS_TEXT: Readonly<Record<RateLimitWindowSeverity, string>> = {
  healthy: "Healthy",
  running_low: "Running low",
  limited: "Limited",
};

/**
 * The row's usage, as TEXT.
 *
 * The bar beside it is `aria-hidden` and colour-only, so without this a
 * screen-reader user could not tell a healthy account from one at 97%, and a
 * sighted user with no colour vision could not either. The meter stays
 * decorative; this is the actual statement.
 *
 * `null` usage is "not checked" and never "0%", which is the same rule the bar
 * follows by drawing nothing - and the distinction AX3 asks for explicitly. A
 * gauge nobody read and a gauge that read zero are opposite facts, and "0%"
 * for the first one says the account has all its headroom left when we have no
 * idea whether it has any.
 */
function usageStatusText(severity: string, usedPercent: number | null): string {
  const mapped = METER_SEVERITY_BY_WIRE_ID.get(severity);
  const status = mapped === undefined ? null : METER_STATUS_TEXT[mapped];
  if (usedPercent === null) {
    return status === null
      ? "Usage not checked"
      : `${status} · usage not checked`;
  }
  const used = `${Math.round(rateLimitWindowFillPercent(usedPercent))}% used`;
  return status === null ? used : `${status} · ${used}`;
}

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
