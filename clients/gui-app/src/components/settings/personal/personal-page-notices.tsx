/**
 * Docs: see ../SETTINGS.md (Personal ▸ Notices and "needs you").
 * Update that file whenever this settings surface changes.
 */
import { useContext, useState, type ReactNode } from "react";
import type { ReviewHeldEntry } from "@traycer-clients/shared/environment/environment-review";
import type { EnvironmentNotice } from "@traycer/protocol/host/environment-schemas";
import {
  noticeText,
  reviewText,
  undoRefusalText,
} from "@/components/settings/host-scope/host-access-model";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { itemLabel } from "@/components/settings/personal/personal-page-status";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentUndoMutation } from "@/hooks/environment/use-environment-undo-mutation";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationName } from "@/components/settings/environment/mcp-servers-model";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Convergence notices and held changes for the settings on this page. */
export function PersonalPageNotices(): ReactNode {
  const value = useContext(PersonalPageContext);
  const source = useConfigurationSource();
  const team = source.kind === "pool" && source.configuration === "team";
  if (value === null || (value.client === null && !team)) return null;
  if (value.notices.length === 0 && value.review.length === 0) return null;
  return (
    <ul
      className="flex max-w-[72ch] flex-col gap-1.5"
      data-testid="personal-page-notices"
    >
      {value.client === null
        ? null
        : value.notices.map((notice) => (
            <NoticeRow key={notice.noticeId} notice={notice} />
          ))}
      {value.review.map((entry) => (
        <ReviewRow
          key={entry.entryId}
          entry={entry}
          hostId={value.hostId}
          hostName={value.hostName}
        />
      ))}
    </ul>
  );
}

const ROW_CLASS =
  "flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-md border border-border/60 bg-foreground/3 px-3 py-1.5 text-ui-sm";

function NoticeRow(props: { readonly notice: EnvironmentNotice }): ReactNode {
  const { notice } = props;
  const label = itemLabel(notice);
  const [refusal, setRefusal] = useState<string | null>(null);
  const undo = useEnvironmentUndoMutation();
  return (
    <li className={ROW_CLASS} data-testid="personal-notice">
      <span className="min-w-0 text-foreground">
        {noticeText(notice)}
        {refusal === null ? null : (
          <span
            className="block text-ui-xs text-warning-foreground"
            data-testid="personal-notice-refusal"
          >
            {refusal}
          </span>
        )}
      </span>
      {notice.undoAvailable ? (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={undo.isPending}
            onClick={() =>
              undo.mutate(
                { noticeId: notice.noticeId },
                {
                  onSuccess: (outcome) =>
                    setRefusal(undoRefusalText(outcome, label)),
                },
              )
            }
          >
            Undo
            {undo.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Review opens the sheet for this host, or Secrets when there is no host. */
function ReviewRow(props: {
  readonly entry: ReviewHeldEntry;
  readonly hostId: string | null;
  readonly hostName: string;
}): ReactNode {
  const source = useConfigurationSource();
  if (source.kind === "pool" && source.configuration === "team") {
    return (
      <TeamReviewRow entry={props.entry} environmentId={source.environmentId} />
    );
  }
  return <HostReviewRow {...props} />;
}

function HostReviewRow(props: {
  readonly entry: ReviewHeldEntry;
  readonly hostId: string | null;
  readonly hostName: string;
}): ReactNode {
  const openRetrospective = useRetrospectiveSheetStore(
    (state) => state.openSheet,
  );
  const { hostId } = props;
  return (
    <li className={ROW_CLASS} data-testid="personal-review-row">
      <span className="min-w-0 text-foreground">{reviewText(props.entry)}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="personal-review-link"
        onClick={() => {
          if (hostId !== null) {
            openRetrospective({ hostId, hostName: props.hostName });
            return;
          }
          navigateToSettingsSection("secrets");
        }}
      >
        Review
      </Button>
    </li>
  );
}

function TeamReviewRow(props: {
  readonly entry: ReviewHeldEntry;
  readonly environmentId: string;
}): ReactNode {
  const openReview = useRetrospectiveSheetStore(
    (state) => state.openEnvironmentReview,
  );
  const viewerId = useCloudChatViewerId();
  const environmentName = useConfigurationName();
  return (
    <li className={ROW_CLASS} data-testid="personal-review-row">
      <span className="min-w-0 text-foreground">{reviewText(props.entry)}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="personal-review-link"
        onClick={() => {
          if (
            viewerId.length === 0 ||
            useAuthStore.getState().contextMetadata?.userId !== viewerId
          )
            return;
          openReview({
            environmentId: props.environmentId,
            environmentName,
            viewerId,
          });
        }}
      >
        Review
      </Button>
    </li>
  );
}
