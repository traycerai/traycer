import type { ReactNode } from "react";
import { TaskSandboxEndDetails } from "@/components/hosts/task-sandbox-end-details";
import { Button } from "@/components/ui/button";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import type { ChatSandboxState } from "@/lib/sandboxes/chat-sandbox-state";
import {
  costLine,
  RESTING_STORAGE_CLAUSE,
  SHARED_USE_CLAUSE,
} from "@/lib/sandboxes/sandbox-strings";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import {
  sandboxFrozenLine,
  sandboxTeamFrozenStateLine,
} from "@/components/hosts/sandbox-card-model";
import { sandboxRowActionLabel } from "@/lib/sandboxes/sandbox-row-lines";
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
import { useOpenLink } from "@/lib/links/open-link";
import { useAuthStore } from "@/stores/auth/auth-store";

export function ChatSandboxFooter(props: {
  readonly state: ChatSandboxState;
}): ReactNode {
  const state = props.state;
  if (state.kind === "none") return null;
  if (state.kind === "destroyed") {
    return (
      <div className="shrink-0 border-t border-border px-4 py-2 text-ui-sm text-muted-foreground">
        <p>{taskSandboxEndLine(state.ended.name, state.ended.end)}</p>
        <TaskSandboxEndDetails ended={state.ended} />
      </div>
    );
  }
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
      {state.wakeChangesPayer
        ? ` ${RESTING_STORAGE_CLAUSE} ${SHARED_USE_CLAUSE}`
        : ""}
    </p>
  );
}

function FrozenSandboxFooter(props: {
  readonly state: Extract<ChatSandboxState, { readonly kind: "resting" }>;
}): ReactNode {
  const { sandbox, configuration } = props.state;
  const viewer = useAuthStore((state) => state.profile?.userId ?? null);
  const verb = useSandboxVerb(sandbox.id);
  const billingUrl = useConfigurationBillingUrl(configuration);
  const openLink = useOpenLink();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-ui-sm text-muted-foreground">
      <p className="min-w-0 flex-1">
        {configuration.kind === "team"
          ? sandboxTeamFrozenStateLine(sandbox, viewer)
          : sandboxFrozenLine(sandbox.frozenAt)}
      </p>
      {configuration.kind === "team" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={verb.isPending}
          onClick={() =>
            verb.mutate(sandbox.state === "stopped" ? "start" : "resume")
          }
        >
          {sandboxRowActionLabel("resume-paying", {
            ...configuration,
            environmentId: sandbox.environmentId,
          })}
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
    </div>
  );
}

function UnreachableSandboxFooter(props: {
  readonly state: Extract<ChatSandboxState, { readonly kind: "unreachable" }>;
}): ReactNode {
  const { sandbox, lastContactMinutes } = props.state;
  const stop = useSandboxVerb(sandbox.id);
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
        disabled={stop.isPending}
        onClick={() => stop.mutate("stop")}
      >
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
    </div>
  );
}
