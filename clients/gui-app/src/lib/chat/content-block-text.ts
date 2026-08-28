import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { isRenderableSubAgentBlock } from "./subagent-blocks";

const CONTENT_BLOCKS_PREVIEW_MAX_CHARS = 200;
const CONTENT_BLOCKS_PREVIEW_SOURCE_SCAN_LIMIT = 16_384;
const WHITESPACE_RE = /\s/;

/**
 * Builds the small assistant-row text projection used by the turn minimap.
 * The message body itself renders from structured segments, so retaining a
 * second, fully joined copy of every block only makes the transcript larger.
 */
export function contentBlocksPreview(
  blocks: ReadonlyArray<ContentBlock>,
): string {
  if (blocks.length === 0) return "Working...";
  const preview = new ContentBlocksPreviewBuilder();
  for (const block of blocks) {
    if (preview.stopped) break;
    preview.append("\n\n");
    appendContentBlockPreview(preview, block);
  }
  return preview.finish();
}

class ContentBlocksPreviewBuilder {
  private output = "";
  private pendingSpace = false;
  private sourceUnitsRead = 0;
  private truncated = false;

  get stopped(): boolean {
    return this.truncated;
  }

  get visibleLength(): number {
    return this.output.length;
  }

  append(text: string): void {
    if (text.length === 0 || this.truncated) return;
    const remainingSourceUnits =
      CONTENT_BLOCKS_PREVIEW_SOURCE_SCAN_LIMIT - this.sourceUnitsRead;
    if (remainingSourceUnits <= 0) {
      this.truncated = true;
      return;
    }

    const scanLength = Math.min(text.length, remainingSourceUnits);
    for (let index = 0; index < scanLength; index += 1) {
      this.sourceUnitsRead += 1;
      const character = text[index];
      if (WHITESPACE_RE.test(character)) {
        if (this.output.length > 0) this.pendingSpace = true;
        continue;
      }
      if (this.pendingSpace) {
        this.output += " ";
        this.pendingSpace = false;
      }
      this.output += character;
      if (this.output.length > CONTENT_BLOCKS_PREVIEW_MAX_CHARS + 1) {
        this.truncated = true;
        return;
      }
    }
    if (scanLength < text.length) this.truncated = true;
  }

  finish(): string {
    if (this.output.length === 0) return "";
    if (
      !this.truncated &&
      this.output.length <= CONTENT_BLOCKS_PREVIEW_MAX_CHARS
    ) {
      return this.output;
    }
    return `${sliceWholeCodePoints(
      this.output,
      CONTENT_BLOCKS_PREVIEW_MAX_CHARS,
    ).trimEnd()}…`;
  }
}

function sliceWholeCodePoints(text: string, maxUnits: number): string {
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  const endsOnLeadingSurrogate = last >= 0xd800 && last <= 0xdbff;
  return endsOnLeadingSurrogate ? cut.slice(0, -1) : cut;
}

function appendContentBlockPreview(
  preview: ContentBlocksPreviewBuilder,
  block: ContentBlock,
): void {
  switch (block.type) {
    case "text": {
      const notice = block.providerNotice;
      if (notice === null) {
        preview.append(block.text);
        return;
      }
      appendSeparated(preview, [notice.title, notice.message ?? ""], " · ");
      for (const detail of notice.details) {
        if (detail.label.length === 0 && detail.value.length === 0) continue;
        preview.append(" · ");
        appendSeparated(preview, [detail.label, detail.value], ": ");
      }
      return;
    }
    case "reasoning":
      preview.append("Reasoning\n");
      preview.append(block.content);
      return;
    case "tool_call":
      preview.append("Tool: ");
      preview.append(block.toolName);
      return;
    case "file_change":
      preview.append("File change: ");
      preview.append(block.filePath);
      return;
    case "command":
      preview.append("$ ");
      preview.append(block.command);
      return;
    default:
      appendStructuredContentBlockPreview(preview, block);
  }
}

type StructuredContentBlock = Exclude<
  ContentBlock,
  { type: "text" | "reasoning" | "tool_call" | "file_change" | "command" }
>;

function appendStructuredContentBlockPreview(
  preview: ContentBlocksPreviewBuilder,
  block: StructuredContentBlock,
): void {
  switch (block.type) {
    case "subagent": {
      if (!isRenderableSubAgentBlock(block)) return;
      preview.append(block.result ?? block.task ?? "Subagent");
      return;
    }
    case "approval":
      preview.append(block.description ?? "Approval requested");
      return;
    case "todo":
      for (const item of block.items) {
        preview.append(item.status);
        preview.append(": ");
        preview.append(item.text);
        preview.append("\n");
      }
      return;
    case "plan":
      preview.append(block.markdownPreview);
      return;
    case "error":
      preview.append(block.message);
      return;
    default:
      appendLifecycleContentBlockPreview(preview, block);
  }
}

type LifecycleContentBlock = Exclude<
  StructuredContentBlock,
  { type: "subagent" | "approval" | "todo" | "plan" | "error" }
>;

function appendLifecycleContentBlockPreview(
  preview: ContentBlocksPreviewBuilder,
  block: LifecycleContentBlock,
): void {
  switch (block.type) {
    case "compaction":
      preview.append(
        block.status === "errored"
          ? (block.error ?? "Context compaction failed")
          : (block.summary ?? "Context compacted"),
      );
      return;
    case "autonomous_resume": {
      if (block.triggers.length === 0) {
        preview.append("Resumed");
        return;
      }
      preview.append("Resumed: ");
      for (const trigger of block.triggers) {
        preview.append(trigger.title);
        preview.append(" ");
        preview.append(trigger.status);
        preview.append("; ");
      }
      return;
    }
    case "interview":
      preview.append(block.title ?? block.description ?? "Interview requested");
      return;
    case "steer":
      appendComposerContentPreview(preview, block.content);
      return;
    case "artifact_operation": {
      switch (block.operation) {
        case "create":
          preview.append("Created ");
          break;
        case "update":
          preview.append("Updated ");
          break;
        case "delete":
          preview.append("Deleted ");
          break;
      }
      preview.append(block.kind);
      return;
    }
  }
}

function appendSeparated(
  preview: ContentBlocksPreviewBuilder,
  values: ReadonlyArray<string>,
  separator: string,
): void {
  let appended = false;
  for (const value of values) {
    if (value.length === 0) continue;
    if (appended) preview.append(separator);
    preview.append(value);
    appended = true;
  }
}

function appendComposerContentPreview(
  preview: ContentBlocksPreviewBuilder,
  content: JsonContent,
): void {
  const visibleLengthBefore = preview.visibleLength;
  appendComposerNodesPreview(preview, content.content ?? []);
  if (preview.visibleLength === visibleLengthBefore) {
    preview.append("Follow-up queued");
  }
}

function appendComposerNodesPreview(
  preview: ContentBlocksPreviewBuilder,
  nodes: ReadonlyArray<JsonContent>,
): void {
  for (const node of nodes) {
    if (preview.stopped) return;
    if (node.type === "text") {
      preview.append(node.text ?? "");
    } else if (node.type === "hardBreak") {
      preview.append("\n");
    } else if (node.type === "mention" || node.type === "slashCommand") {
      const label = node.attrs?.label;
      const name = node.attrs?.name;
      if (typeof label === "string") preview.append(label);
      else if (typeof name === "string") preview.append(name);
    } else {
      appendComposerNodesPreview(preview, node.content ?? []);
    }
  }
}
