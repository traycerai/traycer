/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ The notices strip).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  REMOTE_ACCESS_QUESTION,
  remoteAccessQuestionShown,
} from "@/components/settings/host-scope/host-access-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useRemoteAccessSetMutation } from "@/hooks/environment/use-remote-access-set-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

/**
 * The one-time Remote access question, in the strip above the Overview's
 * tabs, so it is seen on whichever tab is open. Asked while the host's remote
 * access is off and this desktop has no answer for the host; On turns it on,
 * Not now leaves it off. Either answer is remembered per host on this desktop
 * (the host keeps no "asked" mark, so another desktop asks again).
 *
 * Draws its own strip row, or nothing.
 */
export function RemoteAccessQuestion(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** Whether the scope can reach the host, and so whether a read may mount. */
  readonly enabled: boolean;
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
    return null;
  }
  const hostId = props.hostId;
  return (
    <div className="flex shrink-0 flex-col px-5 pb-3">
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border/60 bg-foreground/3 px-3 py-2.5 text-ui-sm"
        data-testid="remote-access-question"
      >
        <span className="min-w-0 text-foreground">
          {REMOTE_ACCESS_QUESTION}
        </span>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={set.isPending}
            onClick={() => answerRemoteAccess(hostId)}
          >
            Not now
          </Button>
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
        </div>
      </div>
    </div>
  );
}
