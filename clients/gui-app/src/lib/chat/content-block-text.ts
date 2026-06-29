import type {
  ApprovalBlock,
  CompactionBlock,
  ContentBlock,
  InterviewBlock,
  PlanBlock,
  SteerBlock,
  SubAgentBlock,
  TodoBlock,
} from "@traycer/protocol/persistence/epic/schemas";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { isRenderableSubAgentBlock } from "./subagent-blocks";

export function contentBlocksText(blocks: ReadonlyArray<ContentBlock>): string {
  if (blocks.length === 0) return "Working...";
  return blocks
    .flatMap((block) => {
      const text = contentBlockText(block);
      return text.length > 0 ? [text] : [];
    })
    .join("\n\n");
}

function contentBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return `Reasoning\n${block.content}`;
    case "tool_call":
      return `Tool: ${block.toolName}`;
    case "file_change":
      return `File change: ${block.filePath}`;
    case "command":
      return `$ ${block.command}`;
    case "subagent":
      return subAgentBlockText(block);
    case "approval":
      return approvalBlockText(block);
    case "todo":
      return todoBlockText(block);
    case "plan":
      return planBlockText(block);
    case "error":
      return block.message;
    case "compaction":
      return compactionBlockText(block);
    case "autonomous_resume":
      return autonomousResumeBlockText(block);
    case "interview":
      return interviewBlockText(block);
    case "steer":
      return steerBlockText(block);
    case "artifact_operation":
      return artifactOperationBlockText(block);
  }
}

function autonomousResumeBlockText(
  block: Extract<ContentBlock, { type: "autonomous_resume" }>,
): string {
  if (block.triggers.length === 0) return "Resumed";
  return `Resumed: ${block.triggers
    .map((trigger) => `${trigger.title} ${trigger.status}`)
    .join("; ")}`;
}

function artifactOperationBlockText(
  block: Extract<ContentBlock, { type: "artifact_operation" }>,
): string {
  switch (block.operation) {
    case "create":
      return `Created ${block.kind}`;
    case "update":
      return `Updated ${block.kind}`;
    case "delete":
      return `Deleted ${block.kind}`;
  }
}

function subAgentBlockText(block: SubAgentBlock): string {
  if (!isRenderableSubAgentBlock(block)) return "";
  return block.result ?? block.task ?? "Subagent";
}

function approvalBlockText(block: ApprovalBlock): string {
  return block.description ?? "Approval requested";
}

function todoBlockText(block: TodoBlock): string {
  return block.items.map((item) => `${item.status}: ${item.text}`).join("\n");
}

function planBlockText(block: PlanBlock): string {
  return block.markdownPreview;
}

function compactionBlockText(block: CompactionBlock): string {
  return block.summary ?? "Context compacted";
}

function interviewBlockText(block: InterviewBlock): string {
  return block.title ?? block.description ?? "Interview requested";
}

function steerBlockText(block: SteerBlock): string {
  const text = extractPlainTextFromComposerJSONContent(block.content).trim();
  return text.length === 0 ? "Follow-up queued" : text;
}
