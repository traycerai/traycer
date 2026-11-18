import type { ReactNode } from "react";
import {
  HOST_FROZEN_WORD,
  hostSandboxStateWord,
} from "@traycer/protocol/host/host-status";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import type {
  ChatSandboxLine,
  ChatSandboxState,
  RestingChatSandbox,
} from "@/lib/sandboxes/chat-sandbox-state";
import { useSampledNow } from "@/lib/relative-time";
import { costLine } from "@/lib/sandboxes/sandbox-strings";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import {
  sandboxFrozenCause,
  sandboxFrozenClock,
} from "@/lib/sandboxes/sandbox-row-lines";
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
import { useOpenLink } from "@/lib/links/open-link";

/**
 * The resolver's footer line under a chat: a resting sandbox whose
 * configuration is known, or an awake one that cannot be reached.
 */
export function ChatSandboxFooter(props: {
  readonly line: ChatSandboxLine | null;
}): ReactNode {
  if (props.line?.place !== "footer") return null;
  const state = props.line.state;
  if (state.kind === "unreachable")
    return <UnreachableSandboxFooter state={state} />;
  if (state.sandbox.frozen) return <FrozenSandboxFooter state={state} />;
  const { sandbox } = state;
  const wake =
    sandbox.state === "stopped"
      ? "is stopped · your next message starts it from a cold boot"
      : "is suspended · your next message resumes it";
  const price =
    sandbox.priceMcPerHour === null
      ? ""
      : ` · ${costLine(sandbox.priceMcPerHour.awakeMc, state.configuration)}`;
  return (
    <p className="shrink-0 border-t border-border px-4 py-2 text-ui-sm text-muted-foreground">
      {sandbox.displayName} {wake}
      {price}
    </p>
  );
}

function FrozenSandboxFooter(props: {
  readonly state: RestingChatSandbox;
}): ReactNode {
  const { sandbox, configuration } = props.state;
  const verb = useSandboxVerb(sandbox.id);
  const operation = useSandboxOperation(sandbox.id);
  const pending = operation?.kind === "pending";
  const retryVerb =
    configuration.kind === "team" &&
    operation?.kind === "failed" &&
    (operation.verb === "start" || operation.verb === "resume")
      ? operation.verb
      : null;
  const billingUrl = useConfigurationBillingUrl(configuration);
  const openLink = useOpenLink();
  const pageConfiguration = {
    ...configuration,
    environmentId: sandbox.environmentId,
  };
  const removal = sandboxFrozenClock(sandbox.frozenAt);
  return (
    <div className="flex min-w-0 shrink-0 flex-col items-start gap-2 border-t border-border px-4 py-2 text-ui-sm text-muted-foreground">
      <p className="min-w-0 w-full wrap-anywhere font-medium">
        {hostSandboxStateWord(sandbox.state)} · {HOST_FROZEN_WORD}
      </p>
      <p className="min-w-0 w-full wrap-anywhere">
        {sandboxFrozenCause(pageConfiguration)}
      </p>
      {removal === null ? null : (
        <p className="min-w-0 w-full wrap-anywhere">{removal}</p>
      )}
      {configuration.kind === "team" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            verb.mutate(sandbox.state === "stopped" ? "start" : "resume")
          }
        >
          {pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Resume
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void openLink(billingUrl, "account", null)}
        >
          Add credits ↗
        </Button>
      )}
      <SandboxOperationFailure
        sandboxId={sandbox.id}
        name={sandbox.displayName}
        configuration={configuration}
        operation={retryVerb === null ? null : operation}
        busy={pending}
        onRetry={retryVerb === null ? null : () => verb.mutate(retryVerb)}
      />
    </div>
  );
}

function UnreachableSandboxFooter(props: {
  readonly state: Extract<ChatSandboxState, { readonly kind: "unreachable" }>;
}): ReactNode {
  const { sandbox, lastSeenAt } = props.state;
  const now = useSampledNow();
  const lastContactMinutes =
    lastSeenAt === null
      ? null
      : Math.max(0, Math.floor((now - lastSeenAt) / 60_000));
  const stop = useSandboxVerb(sandbox.id);
  const operation = useSandboxOperation(sandbox.id);
  const pending = operation?.kind === "pending";
  const retryVerb =
    operation?.kind === "failed" && operation.verb === "stop"
      ? operation.verb
      : null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-ui-sm text-muted-foreground">
      <p className="min-w-0 flex-1">
        {sandbox.displayName} is running, but Traycer can’t connect
        {lastContactMinutes === null
          ? ""
          : ` · last contact ${lastContactMinutes} min ago`}
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => stop.mutate("stop")}
      >
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Stop
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => openSandboxDetails(sandbox.id)}
      >
        Details
      </Button>
      <SandboxOperationFailure
        sandboxId={sandbox.id}
        name={sandbox.displayName}
        hostId={sandbox.hostId}
        operation={retryVerb === null ? null : operation}
        busy={pending}
        onRetry={retryVerb === null ? null : () => stop.mutate(retryVerb)}
      />
    </div>
  );
}
