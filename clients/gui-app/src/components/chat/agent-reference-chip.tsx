import { Bot } from "lucide-react";
import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useEpicArtifactRecords,
  useOpenEpicId,
  type EpicTreeRecord,
} from "@/lib/epic-selectors";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { cn } from "@/lib/utils";

export function AgentReferenceChip(props: {
  readonly agentId: string;
  readonly display: "text" | "code";
}) {
  const records = useEpicArtifactRecords();
  const epicId = useOpenEpicId();
  const agent = records.find(
    (record) =>
      record.id === props.agentId &&
      (record.type === "chat" || record.type === "terminal-agent"),
  );

  if (agent === undefined) {
    return fallbackAgentId(props.agentId, props.display);
  }

  return (
    <TooltipWrapper
      label={`${agent.name}\n${props.agentId}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <AgentReferenceButton agent={agent} epicId={epicId} />
    </TooltipWrapper>
  );
}

function AgentReferenceButton(props: {
  readonly agent: EpicTreeRecord;
  readonly epicId: string;
}) {
  const openAgent = useCallback(() => {
    const canvas = useEpicCanvasStore.getState();
    const tabId = canvas.resolveTargetTabForEpic(props.epicId, undefined);
    canvas.openTileInTab(tabId, {
      id: props.agent.id,
      instanceId: uuidv4(),
      type: props.agent.type,
      name: props.agent.name,
      hostId: props.agent.hostId,
    });
  }, [props.agent, props.epicId]);

  return (
    <button
      type="button"
      onClick={openAgent}
      className={cn(
        "mx-[1px] inline-flex max-w-[min(26rem,80vw)] items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 align-baseline",
        "text-ui-sm font-medium text-primary transition-colors hover:bg-primary/15 hover:text-primary focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      data-agent-reference={props.agent.id}
      // Excluded from quote selection: it's an interactive chip inside quotable
      // prose, so a drag across it must not append its label as quoted text.
      data-quote-exclude=""
    >
      <Bot className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{props.agent.name}</span>
    </button>
  );
}

function fallbackAgentId(agentId: string, display: "text" | "code") {
  if (display === "code") return <code>{agentId}</code>;
  return <>{agentId}</>;
}
