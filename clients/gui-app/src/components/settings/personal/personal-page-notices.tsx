/**
 * Docs: see ../SETTINGS.md (Personal ▸ Notices and "needs you").
 * Update that file whenever this settings surface changes.
 */
import { useContext, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  LocalOverrideTarget,
} from "@traycer/protocol/host/environment-schemas";
import {
  keepLocalTarget,
  keepLocalText,
  keptUndoFailedText,
  noticeText,
  reviewText,
  undoRefusalText,
} from "@/components/settings/host-scope/host-access-model";
import { HeldValueReview } from "@/components/settings/personal/held-value-review";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { itemLabel } from "@/components/settings/personal/personal-page-status";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";

/**
 * Under a Personal page's status line: its convergence notices ("LOG_LEVEL
 * from dev-box now applies everywhere.", with Undo and, on that host, "Keep
 * dev-box's value on dev-box") and its "needs you" rows: a held value's opens
 * the retrospective sheet, every other one Secrets.
 * Nothing when the page has neither.
 */
export function PersonalPageNotices(): ReactNode {
  const value = useContext(PersonalPageContext);
  if (value === null || value.client === null) return null;
  if (value.notices.length === 0 && value.review.length === 0) return null;
  const { client } = value;
  return (
    <ul
      className="flex max-w-[72ch] flex-col gap-1.5"
      data-testid="personal-page-notices"
    >
      {value.notices.map((notice) => (
        <NoticeRow
          key={notice.noticeId}
          client={client}
          hostId={value.hostId}
          hostName={value.hostName}
          notice={notice}
        />
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

/** What an Undo or a Keep changes: the notices, the host's status, the values. */
const UNDO_READS = [
  "environment.notices",
  "environment.status",
  "config.env.list",
  "providers.list",
] as const;

function NoticeRow(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly notice: EnvironmentNotice;
}): ReactNode {
  const { notice } = props;
  const label = itemLabel(notice);
  const [refusal, setRefusal] = useState<string | null>(null);
  const grant = useExecutableWriteGrant();
  const undo = useHostScopedMutationForClient(props.client, {
    method: "environment.undo",
    // The displaced value can run on every host, so the undo carries the grant.
    prepareRequest: grant,
    mutationKey: environmentMutationKeys.undo(),
    errorMessage: "Couldn't undo.",
    invalidateMethods: UNDO_READS,
  });
  const keepTarget = keepLocalTarget(notice, props.hostId);
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
          {keepTarget === null ? null : (
            <KeepLocalButton
              client={props.client}
              hostName={props.hostName}
              target={keepTarget}
              disabled={undo.isPending}
              onKept={async () => {
                try {
                  const outcome = await undo.mutateAsync({
                    noticeId: notice.noticeId,
                    executableWriteGrant: null,
                  });
                  setRefusal(
                    undoRefusalText(outcome, label, {
                      hostName: props.hostName,
                    }),
                  );
                } catch {
                  setRefusal(keptUndoFailedText(props.hostName));
                }
              }}
              onRefused={setRefusal}
            />
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={undo.isPending}
            onClick={() =>
              undo.mutate(
                { noticeId: notice.noticeId, executableWriteGrant: null },
                {
                  onSuccess: (outcome) =>
                    setRefusal(undoRefusalText(outcome, label, null)),
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

/**
 * "Keep dev-box's value on dev-box": keeps the value this host has now as its
 * own, then undoes the change everywhere. Shown only on the host the change
 * came from, once its current value is read; the value is read the way the
 * page that shows it reads it, so the two agree.
 */
function KeepLocalButton(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostName: string;
  readonly target: LocalOverrideTarget;
  readonly disabled: boolean;
  readonly onKept: () => Promise<void>;
  readonly onRefused: (text: string) => void;
}): ReactNode {
  const current = useCurrentValue(props.client, props.target);
  const grant = useExecutableWriteGrant();
  const keep = useHostScopedMutationForClient(props.client, {
    method: "config.env.localOverride.set",
    // The value can select what starts, so it carries the grant.
    prepareRequest: grant,
    mutationKey: environmentMutationKeys.localOverrideSet(),
    errorMessage: "Couldn't keep the value on this host.",
    scope: { id: "config.env.localOverride" },
    invalidateMethods: ["environment.localOverrides"],
  });
  if (current === null) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={props.disabled || keep.isPending}
      onClick={() => {
        void keep
          .mutateAsync({
            target: props.target,
            value: current,
            executableWriteGrant: null,
          })
          .then(async (answer) => {
            if (answer.outcome === "needs_grant") {
              props.onRefused(
                "Couldn't keep the value without your confirmation.",
              );
              return;
            }
            await props.onKept();
          })
          // A refused write was toasted by the mutation; nothing was undone.
          .catch(ignoreError);
      }}
    >
      {keepLocalText(props.hostName)}
      {keep.isPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
    </Button>
  );
}

/** This host's current value for `target`, or `null` until read (or unset). */
function useCurrentValue(
  client: HostClient<HostRpcRegistry>,
  target: LocalOverrideTarget,
): string | null {
  const variables = useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.env.list",
    params: {},
    options: { enabled: target.kind === "variable" },
  });
  // Subscribed: the row must read the value itself, not rely on the
  // Providers page's own read being mounted beside it.
  const providers = useProvidersListForClient(client, {
    enabled: target.kind === "env_override",
    subscribed: target.kind === "env_override",
  });
  if (target.kind === "variable") {
    return (
      variables.data?.entries.find((entry) => entry.key === target.key)
        ?.value ?? null
    );
  }
  return (
    providers.data?.providers
      .find((provider) => provider.providerId === target.providerId)
      ?.envOverrides.find((override) => override.key === target.key)?.value ??
    null
  );
}

/**
 * A "needs you" row. A held key-shaped value's `Review` opens the
 * retrospective sheet for that value; a held command's opens it for the host
 * this page reads, where its Approve and Discard are; any other row's opens
 * Secrets.
 */
function ReviewRow(props: {
  readonly entry: EnvironmentReviewEntry;
  readonly hostId: string | null;
  readonly hostName: string;
}): ReactNode {
  const openRetrospective = useRetrospectiveSheetStore(
    (state) => state.openSheet,
  );
  const { hostId } = props;
  if (props.entry.reason === "credential_like_value") {
    return (
      <li className={ROW_CLASS} data-testid="personal-review-row">
        <span className="min-w-0 text-foreground">
          {reviewText(props.entry)}
          {" · "}
          <HeldValueReview entry={props.entry} />
        </span>
      </li>
    );
  }
  return (
    <li className={ROW_CLASS} data-testid="personal-review-row">
      <span className="min-w-0 text-foreground">{reviewText(props.entry)}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="personal-review-link"
        onClick={() => {
          if (props.entry.reason === "executable_entry" && hostId !== null) {
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
