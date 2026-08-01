import { useState } from "react";
import type {
  CloudChatIdentity,
  CloudChatSummary,
} from "@traycer/protocol/host/epic/cloud-chat";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useHostClient } from "@/lib/host/runtime";
import { cn } from "@/lib/utils";
import { describeCloudChatRefusal } from "@/lib/chats/cloud-chat-refusal";
import type {
  TranscriptBlockDisplay,
  TranscriptMessageDisplay,
  TranscriptPayloadFetch,
} from "@/lib/chats/cloud-chat-transcript-display";
import { useCloudChatPayload } from "@/hooks/chats/use-cloud-chat-queries";
import { useCloudChatTranscript } from "@/hooks/chats/use-cloud-chat-transcript";

/**
 * Read-only reader for a chat published by a host this device cannot reach
 * live - the "my laptop is asleep, show me the chat from my phone" surface.
 *
 * A DIALOG rather than a canvas tile on purpose. The content is an archival copy
 * at publication freshness: nothing here can be steered, approved or re-run, so
 * it does not earn a tab kind plus the persistence and focus machinery that
 * comes with one. Continuing a cloud chat is CLONE, not open - and a clone opens
 * a real chat tab bound to the host that minted its id.
 *
 * ## A deliberate reduction, not renderer parity
 *
 * The live transcript models fifteen block kinds with their own cards. Rebuilding
 * those here would buy a second renderer to keep in sync, for a surface that
 * cannot act on any of it. What this must NOT do is drop anything: a block this
 * build cannot interpret still gets a row with the presenter's shared generic
 * label, because a dropped block is indistinguishable from a chat that never had
 * one.
 */

export interface CloudChatDialogProps {
  readonly identity: CloudChatIdentity | null;
  readonly summary: CloudChatSummary | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function CloudChatDialog(props: CloudChatDialogProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-full max-w-3xl">
        <DialogHeader>
          <DialogTitle>{props.summary?.title ?? "Published chat"}</DialogTitle>
          <DialogDescription>
            A read-only copy, as it was when the owning device last published it.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on the identity so switching rows remounts rather than
            reusing one row's scroll position and expansion state for another. */}
        <CloudChatDialogBody
          key={`${props.identity?.taskId ?? ""}:${props.identity?.ownerUserId ?? ""}:${props.identity?.chatId ?? ""}`}
          identity={props.identity}
          open={props.open}
        />
      </DialogContent>
    </Dialog>
  );
}

function CloudChatDialogBody(props: {
  readonly identity: CloudChatIdentity | null;
  readonly open: boolean;
}): React.JSX.Element {
  const client = useHostClient();
  const state = useCloudChatTranscript({
    client,
    identity: props.identity,
    // The read starts when the dialog opens and not before: a list of fifty
    // chats must not fetch fifty transcripts.
    enabled: props.open && props.identity !== null,
  });

  if (state.kind === "loading") {
    return (
      <div className="flex w-full items-center gap-2 py-8 text-sm text-muted-foreground">
        <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} />
        <span>Loading the published copy…</span>
      </div>
    );
  }

  if (state.kind === "unsupported") {
    return (
      <Notice
        title="This device's host is too old"
        body="Update Traycer on this device to read chats published from your other devices."
      />
    );
  }

  if (state.kind === "failed") {
    return (
      <Notice
        title="Could not reach the cloud"
        body="The published copy could not be fetched. Check your connection and reopen this chat."
      />
    );
  }

  if (state.kind === "refused") {
    const refusal = describeCloudChatRefusal(state.read.outcome);
    // `refused` is only produced for a non-ok outcome, so the null arm is
    // unreachable rather than a silent fallback.
    return refusal === null ? (
      <Notice title="This chat could not be opened" body="" />
    ) : (
      <Notice title={refusal.title} body={refusal.body} />
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {state.fidelityNotice !== null && (
        <p className="text-xs text-muted-foreground">{state.fidelityNotice}</p>
      )}
      <ScrollArea className="max-h-[60vh] w-full">
        <div className="flex w-full flex-col gap-4 pr-3">
          {state.transcript.messages.map((message) => (
            <MessageRow
              key={message.key}
              identity={props.identity}
              message={message}
            />
          ))}
          {/* The event log is rendered, not just counted. `fidelityNotice`
              includes unknown EVENTS in its "N items need a newer version"
              total, so omitting the rows would point that warning at content
              the reader cannot find - which is worse than either rendering
              them or not counting them. */}
          {state.transcript.events.length > 0 && (
            <div className="flex w-full flex-col gap-1 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                Activity
              </p>
              {state.transcript.events.map((event) => (
                <p
                  key={event.key}
                  className={cn(
                    "text-xs",
                    event.isUnknown
                      ? "italic text-muted-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {event.detail === null
                    ? event.label
                    : `${event.label} · ${event.detail}`}
                </p>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Notice(props: {
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <div className="flex w-full flex-col gap-1 py-8">
      <p className="text-sm font-medium">{props.title}</p>
      {props.body.length > 0 && (
        <p className="text-sm text-muted-foreground">{props.body}</p>
      )}
    </div>
  );
}

function MessageRow(props: {
  readonly identity: CloudChatIdentity | null;
  readonly message: TranscriptMessageDisplay;
}): React.JSX.Element {
  const { message } = props;
  return (
    <div className="flex w-full flex-col gap-2">
      <p
        className={cn(
          "text-xs font-medium",
          message.isUnknown ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {message.author}
      </p>
      {message.body !== null && (
        <p className="whitespace-pre-wrap text-sm">{message.body}</p>
      )}
      {message.blocks.map((block) => (
        <BlockRow key={block.key} identity={props.identity} block={block} />
      ))}
    </div>
  );
}

function BlockRow(props: {
  readonly identity: CloudChatIdentity | null;
  readonly block: TranscriptBlockDisplay;
}): React.JSX.Element {
  const { block } = props;
  return (
    <div className="flex w-full flex-col gap-1 rounded-md border p-2">
      <p
        className={cn(
          "text-xs font-medium",
          block.isUnknown ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {block.label}
      </p>
      {block.body !== null && (
        <p className="whitespace-pre-wrap text-sm">{block.body}</p>
      )}
      {block.details.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {block.details.join(" · ")}
        </p>
      )}
      {/* Stated explicitly rather than left blank: an empty card reads as
          "this chat has no diff", which is both plausible and wrong. */}
      {block.missingPayloads.map((message) => (
        <p key={message} className="text-xs italic text-muted-foreground">
          {message}
        </p>
      ))}
      {block.fetchablePayloads.map((payload) => (
        <PayloadRow
          key={payload.key}
          identity={props.identity}
          payload={payload}
        />
      ))}
    </div>
  );
}

/**
 * One fetchable payload, fetched only when asked for.
 *
 * A transcript can name many, and a chat with fifty file changes would spend a
 * hundred requests on content nobody looked at. The request is gated on
 * `requested` for that reason, not for latency.
 *
 * The bytes arrive already hashed against the ref they were requested by - see
 * `useCloudChatPayload`. This component never sees an unverified payload, which
 * is why it has no verification of its own to forget.
 */
function PayloadRow(props: {
  readonly identity: CloudChatIdentity | null;
  readonly payload: TranscriptPayloadFetch;
}): React.JSX.Element {
  const [requested, setRequested] = useState(false);
  const client = useHostClient();
  const query = useCloudChatPayload({
    client,
    identity: props.identity,
    ref: { kind: props.payload.ref.kind, sha256: props.payload.ref.hash },
    enabled: requested,
  });

  if (!requested) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => setRequested(true)}
      >
        {props.payload.label}
      </Button>
    );
  }

  // A settled FAILURE is an answer, and the row has to say so. Without this the
  // row falls through to the spinner below and stays there forever: retries are
  // exhausted, `data` never arrives, and a host that simply lacks the payload
  // method answers `E_HOST_UNSUPPORTED` on the first try. An unavailable marker
  // is the honest end state, and it is the one this surface drew before the
  // payload channel existed at all.
  if (query.isError) return <PayloadUnavailable label={props.payload.label} />;

  if (query.data === undefined) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} />
        <span>{props.payload.label}</span>
      </div>
    );
  }

  // `unavailable`, `digest-mismatch` and `ambiguous-identity` all render the
  // same marker. They are different facts - not in the cloud, not the content
  // this ref names, answered from another owner's row - and a reader can act on
  // none of them differently, so the union carries the distinction for the logs
  // and the tests while the UI states the one thing that is true for all three.
  if (query.data.kind !== "text") {
    return <PayloadUnavailable label={props.payload.label} />;
  }

  const bytes = query.data;
  return (
    <div className="flex w-full flex-col gap-1">
      <p className="text-xs text-muted-foreground">{props.payload.label}</p>
      <pre className="max-h-64 w-full overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
        {bytes.text}
      </pre>
      {bytes.isTruncated ? (
        <p className="text-xs italic text-muted-foreground">
          Showing the first part of {bytes.byteLength} bytes.
        </p>
      ) : null}
    </div>
  );
}

function PayloadUnavailable(props: {
  readonly label: string;
}): React.JSX.Element {
  return (
    <p className="text-xs italic text-muted-foreground">
      {props.label} is not available here.
    </p>
  );
}
