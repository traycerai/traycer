import type { ReactNode } from "react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { CloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";

/**
 * What a published chat shows when there is no transcript to show.
 *
 * Replaces the tile body rather than sitting above an empty one: unlike a live
 * chat, there is no cached history underneath to keep reading. Each arm has its
 * own remedy, which is why they are not collapsed into one "unavailable" - a
 * host that is too old, a cloud that could not be reached, and a chat this
 * viewer may not read are three different next actions.
 */

export interface PublishedChatNoticeProps {
  readonly state: CloudChatTranscriptState;
  readonly ownerLabel: string;
  /** Resolved refusal copy, when the read settled on a refusal. */
  readonly refusal: { readonly title: string; readonly body: string } | null;
}

export function PublishedChatNotice(
  props: PublishedChatNoticeProps,
): ReactNode {
  const notice = describe(props);
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid="published-chat-notice"
    >
      <p className="max-w-md font-medium text-foreground">{notice.title}</p>
      {notice.body.length > 0 && <p className="max-w-md">{notice.body}</p>}
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Published chat could not be opened",
          message: notice.title,
          code: null,
          source: "Agent",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

function describe(props: PublishedChatNoticeProps): {
  readonly title: string;
  readonly body: string;
} {
  if (props.state.kind === "unsupported") {
    return {
      title: "This device's Traycer is too old to read published chats",
      body: `Update Traycer here to read the copy ${props.ownerLabel} published.`,
    };
  }
  if (props.state.kind === "failed") {
    return {
      title: "Could not reach the cloud",
      body: "The published copy could not be fetched. Check your connection and reopen this agent.",
    };
  }
  if (props.refusal !== null) return props.refusal;
  // `loading` never reaches here (the tile renders its skeleton for that), and
  // `ready` is the whole point of the surface - so this is the refusal arm
  // whose outcome produced no copy the reader can act on.
  return {
    title: "This agent has no published copy yet",
    body: `${props.ownerLabel} has not published this agent, so there is nothing to read from here.`,
  };
}
