import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
import { useOpenLink } from "@/lib/links/open-link";
import {
  consequenceClauses,
  consequencesShownSubject,
  priceClause,
  type ConsequencesInput,
  type StageConfiguration,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  ADD_CREDITS_LINK,
  CONSEQUENCES_WORDING_VERSION,
  MOVE_THEM_FIRST,
  OPEN_TERMINAL_INSTEAD,
  SHOW_LESS,
  WHAT_THIS_MEANS,
} from "@/lib/sandboxes/sandbox-strings";
import {
  consequencesShown,
  consequencesShownKey,
  useTeamHostDisclosureSeenStore,
} from "@/stores/hosts/team-host-disclosure-seen-store";

/**
 * Everything a person must know before the first action creates or wakes a
 * host, under the staged host (sandboxes redesign, Flow 1). The price clause
 * always shows and never collapses. The full block renders the first time
 * this person stages in a configuration, audience category and wording
 * version, and that render is recorded as SHOWN (never as read or
 * consented); an unchanged repeat collapses to the price and `What this
 * means`.
 */
export function ConsequencesBlock(props: {
  readonly input: ConsequencesInput;
  /** Opens the move flow for the unmoved computer; `null` offers none. */
  readonly onMoveFirst: (() => void) | null;
  /** `Open terminal instead`, beside Send; `null` offers none. */
  readonly onOpenTerminalInstead: (() => void) | null;
}): ReactNode {
  const viewerUserId = useCloudChatViewerId();
  const subject = consequencesShownSubject(
    props.input.configuration,
    props.input.audience,
    CONSEQUENCES_WORDING_VERSION,
  );
  // Keyed on the context: a changed configuration, audience or wording is a
  // new first render.
  return (
    <ConsequencesBlockBody
      key={subject}
      input={props.input}
      subject={subject}
      viewerUserId={viewerUserId}
      onMoveFirst={props.onMoveFirst}
      onOpenTerminalInstead={props.onOpenTerminalInstead}
    />
  );
}

function ConsequencesBlockBody(props: {
  readonly input: ConsequencesInput;
  readonly subject: string;
  readonly viewerUserId: string;
  readonly onMoveFirst: (() => void) | null;
  readonly onOpenTerminalInstead: (() => void) | null;
}): ReactNode {
  const markSeen = useTeamHostDisclosureSeenStore((s) => s.markSeen);
  // Decided once per context: recording the full render must not collapse
  // the block under the person reading it.
  const [firstRender] = useState(
    () =>
      !consequencesShown(
        useTeamHostDisclosureSeenStore.getState().seen,
        props.viewerUserId,
        props.subject,
      ),
  );
  const [expanded, setExpanded] = useState(firstRender);
  useEffect(() => {
    if (!expanded || props.viewerUserId.length === 0) return;
    markSeen(props.viewerUserId, consequencesShownKey(props.subject));
  }, [expanded, markSeen, props.subject, props.viewerUserId]);

  const clauses = consequenceClauses(props.input);
  const price = priceClause(props.input);
  const rest = clauses.filter((clause) => clause.kind !== "price");
  return (
    <div
      className="col-span-full flex min-w-0 flex-col gap-1 text-ui-xs text-muted-foreground"
      data-testid="consequences-block"
    >
      <p className="m-0 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-foreground/85" data-testid="consequences-price">
          {price.text}
        </span>
        {props.input.needsCredits ? (
          <AddCreditsLink
            configuration={props.input.configuration}
            testId="consequences-add-credits"
          />
        ) : null}
        {!expanded && rest.length > 0 ? (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="consequences-what-this-means"
            onClick={() => setExpanded(true)}
          >
            {`· ${WHAT_THIS_MEANS}`}
          </Button>
        ) : null}
        {props.onOpenTerminalInstead === null ? null : (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="consequences-open-terminal-instead"
            onClick={props.onOpenTerminalInstead}
          >
            {OPEN_TERMINAL_INSTEAD}
          </Button>
        )}
      </p>
      {expanded
        ? rest.map((clause) => (
            <p
              key={clause.kind}
              className="m-0"
              data-testid={`consequences-clause-${clause.kind}`}
            >
              {clause.text}
              {clause.kind === "move" && props.onMoveFirst !== null ? (
                <>
                  {" "}
                  <Button
                    type="button"
                    variant="link"
                    size="inline-xs"
                    onClick={props.onMoveFirst}
                  >
                    {MOVE_THEM_FIRST}
                  </Button>
                </>
              ) : null}
            </p>
          ))
        : null}
      {expanded && rest.length > 0 && !firstRender ? (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          className="self-start"
          data-testid="consequences-show-less"
          onClick={() => setExpanded(false)}
        >
          {SHOW_LESS}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * `Add credits ↗` beside the price clause at a zero or short balance: the
 * configuration's billing page, in the browser. The shape sheet repeats it
 * where it repeats the clause.
 */
export function AddCreditsLink(props: {
  readonly configuration: StageConfiguration;
  readonly testId: string;
}): ReactNode {
  const billingUrl = useConfigurationBillingUrl(props.configuration);
  const openLink = useOpenLink();
  return (
    <Button
      type="button"
      variant="link"
      size="inline-xs"
      data-testid={props.testId}
      onClick={(event) => void openLink(billingUrl, "account", event)}
    >
      {ADD_CREDITS_LINK}
    </Button>
  );
}
