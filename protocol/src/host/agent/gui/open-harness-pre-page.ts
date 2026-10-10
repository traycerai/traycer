/** The released 1.22 record bodies: open harness ids, before page/app stamps. */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  approvalBlockSchema,
  artifactOperationBlockSchema,
  autonomousResumeBlockSchema,
  commandBlockSchema,
  compactionBlockSchema,
  errorBlockSchema,
  fileChangeBlockSchema,
  interviewBlockSchema,
  reasoningBlockSchema,
  subAgentBlockSchema,
  todoBlockSchema,
  toolCallBlockSchemaPrePage,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { assistantMessageSchemaPrePage } from "@traycer/protocol/persistence/epic/messages";
import {
  openAgentSenderSchema,
  openPlanBlockSchema,
  openSteerBlockSchema,
  openTextBlockSchema,
  openUserMessageSchema,
} from "@traycer/protocol/persistence/epic/open-harness-records";

const openContentBlockSchemaPrePage = lazySchema(() =>
  z.discriminatedUnion("type", [
    openTextBlockSchema,
    reasoningBlockSchema,
    toolCallBlockSchemaPrePage,
    fileChangeBlockSchema,
    commandBlockSchema,
    subAgentBlockSchema,
    approvalBlockSchema,
    todoBlockSchema,
    openPlanBlockSchema,
    errorBlockSchema,
    compactionBlockSchema,
    autonomousResumeBlockSchema,
    openSteerBlockSchema,
    interviewBlockSchema,
    artifactOperationBlockSchema,
  ]),
);
const openAssistantMessageSchemaPrePage = lazySchema(() =>
  assistantMessageSchemaPrePage.extend({
    sender: openAgentSenderSchema,
    blocks: z.array(openContentBlockSchemaPrePage),
  }),
);
export const openMessageSchemaPrePage = lazySchema(() =>
  z.discriminatedUnion("role", [
    openUserMessageSchema,
    openAssistantMessageSchemaPrePage,
  ]),
);
