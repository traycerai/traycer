import { type ComponentType, type ReactNode } from "react";
import { TraycerMarkdown } from "@/markdown";
import { AgentReferenceChip } from "@/components/chat/agent-reference-chip";
import { CodeBlock } from "@/markdown/components/code-block";
import { extractText } from "@/markdown/components/extract-react-node-text";
import { TRAYCER_AGENT_TAG } from "@/markdown/plugins/const";
import { rehypeTraycerAgentReferences } from "@/markdown/plugins/rehype-traycer-agent-references";
import { z } from "zod";

const AGENT_ID_SCHEMA = z.uuid();

const AGENT_REFERENCE_REHYPE_PLUGINS = [rehypeTraycerAgentReferences];

const AGENT_REFERENCE_MARKDOWN_COMPONENTS: Record<
  string,
  ComponentType<Record<string, unknown>>
> = {
  [TRAYCER_AGENT_TAG]: AgentReferenceMarkdownNode as ComponentType<
    Record<string, unknown>
  >,
  code: AgentAwareCodeBlock as ComponentType<Record<string, unknown>>,
};

/**
 * Renders a markdown string through {@link TraycerMarkdown} with the
 * agent-reference plugin set wired in: `@agent` mentions and bare
 * agent-id code spans resolve to live {@link AgentReferenceChip}s. This is
 * the single renderer shared by assistant text segments and the A2A
 * sent/received message cards so all three surface the same formatted
 * markdown (lists, headings, tables, code, agent chips) instead of a raw
 * single-line blob.
 */
export function AgentReferenceMarkdown({
  isStreaming,
  markdown,
  proseSize,
  quotable,
}: {
  readonly isStreaming: boolean;
  readonly markdown: string;
  readonly proseSize: "compact" | "normal";
  readonly quotable: boolean;
}): ReactNode {
  if (markdown.length === 0) return null;
  return (
    <TraycerMarkdown
      className={null}
      proseSize={proseSize}
      components={AGENT_REFERENCE_MARKDOWN_COMPONENTS}
      remarkPlugins={null}
      rehypePlugins={AGENT_REFERENCE_REHYPE_PLUGINS}
      quotable={quotable}
      isStreaming={isStreaming}
    >
      {markdown}
    </TraycerMarkdown>
  );
}

function AgentReferenceMarkdownNode(props: Record<string, unknown>) {
  const agentId =
    typeof props["data-agent-id"] === "string" ? props["data-agent-id"] : null;
  const display = props["data-display"] === "code" ? "code" : "text";
  if (agentId === null) return <>{props.children as ReactNode}</>;
  return <AgentReferenceChip agentId={agentId} display={display} />;
}

function AgentAwareCodeBlock(props: Record<string, unknown>) {
  const children = props.children as ReactNode;
  const className =
    typeof props.className === "string" ? props.className : undefined;
  const text = extractText(children).trim();
  if (className === undefined && AGENT_ID_SCHEMA.safeParse(text).success) {
    return <AgentReferenceChip agentId={text} display="code" />;
  }
  return (
    <CodeBlock
      className={className}
      containerClassName={undefined}
      node={props.node}
    >
      {children}
    </CodeBlock>
  );
}
