/** The released 1.22 record bodies: open harness ids, before MCP App stamps. */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  approvalBlockSchema,
  artifactOperationBlockSchemaPreHtml,
  autonomousResumeBlockSchema,
  commandBlockSchema,
  compactionBlockSchemaPreNotApplied,
  errorBlockSchema,
  fileChangeBlockSchema,
  interviewBlockSchema,
  reasoningBlockSchema,
  subAgentBlockSchema,
  todoBlockSchema,
  toolCallBlockSchemaPreMcpApp,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { assistantMessageSchemaPreMcpApp } from "@traycer/protocol/persistence/epic/messages";
import {
  openAgentSenderSchema,
  openPlanBlockSchema,
  openSteerBlockSchema,
  openTextBlockSchema,
  openUserMessageSchemaPreConversation,
} from "@traycer/protocol/persistence/epic/open-harness-records";

const openContentBlockSchemaPreMcpApp = lazySchema(() =>
  z.discriminatedUnion("type", [
    openTextBlockSchema,
    reasoningBlockSchema,
    toolCallBlockSchemaPreMcpApp,
    fileChangeBlockSchema,
    commandBlockSchema,
    subAgentBlockSchema,
    approvalBlockSchema,
    todoBlockSchema,
    openPlanBlockSchema,
    errorBlockSchema,
    compactionBlockSchemaPreNotApplied,
    autonomousResumeBlockSchema,
    openSteerBlockSchema,
    interviewBlockSchema,
    artifactOperationBlockSchemaPreHtml,
  ]),
);
const openAssistantMessageSchemaPreMcpApp = lazySchema(() =>
  assistantMessageSchemaPreMcpApp.extend({
    sender: openAgentSenderSchema,
    blocks: z.array(openContentBlockSchemaPreMcpApp),
  }),
);
// The user arm is the pre-conversation freeze: `1.22` predates `1.25`'s
// `conversationRequest` key as it predates the MCP App stamps.
export const openMessageSchemaPreMcpApp = lazySchema(() =>
  z.discriminatedUnion("role", [
    openUserMessageSchemaPreConversation,
    openAssistantMessageSchemaPreMcpApp,
  ]),
);
