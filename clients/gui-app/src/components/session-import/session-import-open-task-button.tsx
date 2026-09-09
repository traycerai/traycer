import { ExternalLink } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { SessionImportCandidateState } from "@traycer/protocol/host/session-import/candidate";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useStreamHostId } from "@/lib/host/stream-runtime-context";
import { sessionImportQueryKeys } from "@/lib/query-keys";
import { toastFromHostErrorWithDetail } from "@/lib/host-error-toast";
import { activateTabIntent, resourceEpicTabIntent } from "@/lib/tab-navigation";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

type ImportedTask = Extract<
  SessionImportCandidateState,
  { kind: "already_in_traycer" }
>;
interface OpenImportedTaskVariables {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly title: string;
}

/** Recheck the destination on its source host before opening its chat tile. */
export function SessionImportOpenTaskButton(props: {
  readonly target: ImportedTask;
  readonly title: string;
  readonly onTaskOpened: () => void;
  readonly onBeforeTaskOpen: (() => Promise<boolean>) | null;
}) {
  const binding = useHostBinding();
  const hostId = useStreamHostId();
  const navigate = useNavigate();
  const openTask = useHostMutation<
    HostRpcRegistry,
    "epic.getChatRunSettings",
    undefined,
    OpenImportedTaskVariables
  >({
    client: (variables) => resolveNamedHostClient(binding, variables.hostId),
    method: "epic.getChatRunSettings",
    mapVariables: ({ epicId, chatId }) => ({ epicId, chatId }),
    onResponse: (response) => {
      // Imported chats are created with run settings. A missing tuple also
      // covers a deleted/unavailable chat without creating an empty tab.
      if (response.settings === null)
        throw new Error("This imported task is no longer available.");
    },
    options: {
      mutationKey: sessionImportQueryKeys.openTask(hostId),
      onSuccess: async (_response, variables) => {
        if (
          props.onBeforeTaskOpen !== null &&
          !(await props.onBeforeTaskOpen())
        )
          return;
        await new Promise<void>((resolve, reject) => {
          const accepted = activateTabIntent(
            async (options) => {
              try {
                await navigate(options);
                resolve();
              } catch (error) {
                const failure =
                  error instanceof Error ? error : new Error(String(error));
                reject(failure);
                throw failure;
              }
            },
            resourceEpicTabIntent({
              epicId: variables.epicId,
              tabId: null,
              name: variables.title,
              focus: {
                focusedAt: undefined,
                focusArtifactId: undefined,
                focusThreadId: undefined,
                migrationSource: undefined,
              },
              preparation: {
                kind: "open-tile",
                gesture: "explicit",
                node: {
                  type: "chat",
                  id: variables.chatId,
                  instanceId: crypto.randomUUID(),
                  name: variables.title,
                  hostId: variables.hostId,
                },
              },
              includeNestedFocus: true,
            }),
            { onRejected: reject },
          );
          if (!accepted)
            reject(new Error("The task could not be opened. Try again."));
        });
        props.onTaskOpened();
      },
      onError: (error) =>
        toastFromHostErrorWithDetail(error, "Couldn't open imported task."),
    },
  });
  return (
    <TooltipWrapper
      label="Open task"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        disabled={hostId === null || openTask.isPending}
        aria-label={`Open task: ${props.title}`}
        onClick={() => {
          if (hostId === null || openTask.isPending) return;
          openTask.mutate({
            epicId: props.target.epicId,
            chatId: props.target.chatId,
            hostId,
            title: props.title,
          });
        }}
      >
        {openTask.isPending ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <ExternalLink aria-hidden className="size-3.5" />
        )}
      </Button>
    </TooltipWrapper>
  );
}
