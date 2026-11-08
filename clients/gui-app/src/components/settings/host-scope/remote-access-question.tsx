/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ The notices strip).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { remoteAccessQuestionShown } from "@/components/settings/host-scope/host-access-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useRemoteAccessSetMutation } from "@/hooks/environment/use-remote-access-set-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

/** The unanswered Remote access row, using the same remembered per-host choice. */
export function RemoteAccessQuestion(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** Whether the scope can reach the host, and so whether a read may mount. */
  readonly enabled: boolean;
  readonly children?: ReactNode;
}): ReactNode {
  const status = useEnvironmentStatusRead(
    props.client,
    props.hostId,
    props.enabled,
  );
  const writable =
    useHostMethodSupport(props.hostId, "host.remoteAccess.set") === true;
  const answered = useHostAccessPromptsStore((state) =>
    props.hostId === null
      ? true
      : state.remoteAccessAnswered[props.hostId] === true,
  );
  const answerRemoteAccess = useHostAccessPromptsStore(
    (state) => state.answerRemoteAccess,
  );
  const set = useRemoteAccessSetMutation(props.client, () => undefined);
  if (
    !props.enabled ||
    !writable ||
    props.hostId === null ||
    status.data === null ||
    !remoteAccessQuestionShown(status.data, answered)
  ) {
    return props.children ?? null;
  }
  const hostId = props.hostId;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-ui-sm">
      <span
        className="text-muted-foreground"
        data-testid="remote-access-question"
      >
        Not set
      </span>

      <div className="flex max-w-full flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={set.isPending}
          onClick={() => set.mutate({ enabled: true })}
        >
          Turn on
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
    </div>
  );
}
