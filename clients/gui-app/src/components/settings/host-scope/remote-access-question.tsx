/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ The notices strip).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  REMOTE_ACCESS_QUESTION,
  remoteAccessQuestionShown,
  remoteAccessFailureText,
} from "@/components/settings/host-scope/host-access-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useRemoteAccessSetMutation } from "@/hooks/environment/use-remote-access-set-mutation";
import { useCanSetRemoteAccess } from "@/hooks/environment/use-can-set-remote-access";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

/** One explanatory prompt in the Access row, using the remembered per-host choice. */
export function RemoteAccessQuestion(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** Whether the scope can reach the host, and so whether a read may mount. */
  readonly enabled: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const status = useEnvironmentStatusRead(
    props.client,
    props.hostId,
    props.enabled,
  );
  const answered = useHostAccessPromptsStore((state) =>
    props.hostId === null
      ? true
      : state.remoteAccessAnswered[props.hostId] === true,
  );
  const answerRemoteAccess = useHostAccessPromptsStore(
    (state) => state.answerRemoteAccess,
  );
  const eligible =
    status.data !== null && remoteAccessQuestionShown(status.data, answered);
  const writable = useCanSetRemoteAccess(
    props.client,
    props.hostId,
    status.data?.principal ?? null,
    props.enabled && eligible,
  );
  const set = useRemoteAccessSetMutation(props.client, () => undefined);
  if (!props.enabled || !writable || props.hostId === null || !eligible) {
    return props.children ?? null;
  }
  const hostId = props.hostId;
  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-3 text-ui-sm"
    >
      <span
        className="min-w-0 wrap-anywhere text-foreground"
        data-testid="remote-access-question"
      >
        {REMOTE_ACCESS_QUESTION}
      </span>

      <div className="flex max-w-full flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={set.isPending}
          onClick={() => set.mutate({ enabled: true })}
        >
          On
          {set.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={set.isPending}
          onClick={() => answerRemoteAccess(hostId)}
        >
          Not now
        </Button>
      </div>
      {set.error !== null ? (
        <p role="alert" className="w-full text-destructive">
          {remoteAccessFailureText(set.error.code)}
        </p>
      ) : null}
    </div>
  );
}
