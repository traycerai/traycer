import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { interviewQuestionSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { z } from "zod";

const repositorySchema = lazySchema(() =>
  z.object({ owner: z.string().min(1), repo: z.string().min(1) }),
);

const chatRefSchema = lazySchema(() =>
  z.object({ epicId: z.string().min(1), chatId: z.string().min(1) }),
);

const toolVersionSchema = lazySchema(() =>
  z.object({ tool: z.string().min(1), version: z.string().min(1) }),
);

const questionSchema = lazySchema(() =>
  z.object({
    /** Answer through the setup chat's ordinary interview controls. */
    blockId: z.string().min(1),
    question: interviewQuestionSchema,
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("answer") }),
      z.object({ kind: z.literal("secret"), name: z.string().min(1) }),
      z.object({ kind: z.literal("tool-version"), tool: z.string().min(1) }),
    ]),
  }),
);

const progressSchema = lazySchema(() =>
  z.object({
    phase: z.enum([
      "inspect",
      "resolve",
      "system",
      "install",
      "check",
      "write-ready",
    ]),
    tool: toolVersionSchema.nullable(),
    question: questionSchema.nullable(),
  }),
);

const cardLinkFields = {
  repository: repositorySchema,
  setupChat: chatRefSchema,
} as const;

const runningCardSchema = lazySchema(() =>
  z.object({
    kind: z.literal("running"),
    ...cardLinkFields,
    progress: progressSchema,
  }),
);

const versionCardSchema = lazySchema(() =>
  z.object({
    kind: z.enum(["ready", "waiting", "out-of-date", "approved"]),
    ...cardLinkFields,
    /** The app reads script, evidence and build status for this exact version. */
    versionId: z.uuid(),
  }),
);

const offerCardSchema = lazySchema(() =>
  z.object({ kind: z.literal("offer"), repository: repositorySchema }),
);

const taskCardSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    offerCardSchema,
    runningCardSchema,
    versionCardSchema,
  ]),
);
export type SandboxSetupTaskCard = z.infer<typeof taskCardSchema>;

const toolSourceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("newest") }),
    z.object({
      kind: z.literal("repository"),
      repository: repositorySchema,
      file: z.string().min(1),
    }),
  ]),
);

const setupPanelSchema = lazySchema(() =>
  z.object({
    card: z
      .discriminatedUnion("kind", [runningCardSchema, versionCardSchema])
      .nullable(),
    tools: z.array(toolVersionSchema.extend({ source: toolSourceSchema })),
    repositoryVersions: z.array(
      toolVersionSchema.extend({ repository: repositorySchema }),
    ),
    repositoryScript: z.string().nullable(),
    secrets: z.array(z.object({ name: z.string().min(1), set: z.boolean() })),
    checks: z.array(
      z.object({
        command: z.string().min(1),
        result: z.enum(["running", "passed", "failed", "skipped"]),
      }),
    ),
    /** Host path for the existing editor action. The host rechecks on edits. */
    workingFile: z.string().min(1).nullable(),
  }),
);
export type SandboxSetupPanel = z.infer<typeof setupPanelSchema>;

const toolSwitchSchema = lazySchema(() =>
  z.object({
    switchId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    changes: z
      .array(
        z.object({
          tool: z.string().min(1),
          previous: z.string().min(1).nullable(),
          current: z.string().min(1).nullable(),
        }),
      )
      .min(1),
  }),
);
export type SandboxSetupToolSwitch = z.infer<typeof toolSwitchSchema>;

const startSourceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("offer") }),
    z.object({ kind: z.literal("settings") }),
    z.object({
      kind: z.literal("fix"),
      versionId: z.uuid(),
      script: z.string(),
      buildLog: z.string(),
    }),
    z.object({ kind: z.literal("update"), versionId: z.uuid() }),
    z.object({
      kind: z.literal("continue"),
      versionId: z.uuid(),
      baseVersionId: z.uuid().nullable(),
      script: z.string(),
    }),
  ]),
);

export const sandboxSetupStartRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    repository: repositorySchema,
    /** Issued for this sandbox by Start on the person's sign-in. */
    setupId: z.uuid(),
    /** The client reuses this ID when it retries this repository handover. */
    operationId: z.uuid(),
    turnOnCount: z.number().int().nonnegative(),
    /** Null when the viewer already has a setup chat in this sandbox. */
    agent: z
      .object({ harnessId: z.string().min(1), modelId: z.string().min(1) })
      .nullable(),
    source: startSourceSchema,
  }),
);
export type SandboxSetupStartRequest = z.infer<
  typeof sandboxSetupStartRequestSchema
>;

export const sandboxSetupStartResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("accepted"), setupChat: chatRefSchema }),
    z.object({
      kind: z.literal("refused"),
      code: z.enum([
        "setup_disabled",
        "setup_stale_turn_on_count",
        "setup_sandbox_unavailable",
        "setup_unavailable",
        "setup_waiting",
        "setup_already_running",
      ]),
    }),
  ]),
);
export type SandboxSetupStartResponse = z.infer<
  typeof sandboxSetupStartResponseSchema
>;

/** Report the result of a version action the app took on the person's sign-in. */
export const sandboxSetupVersionActionRequestSchema = lazySchema(() =>
  chatRefSchema.extend({
    versionId: z.uuid(),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.enum(["approved", "sent", "discarded"]) }),
      z.object({
        kind: z.literal("refused"),
        code: z.enum(["setup_waiting", "setup_out_of_date"]),
      }),
    ]),
  }),
);
export type SandboxSetupVersionActionRequest = z.infer<
  typeof sandboxSetupVersionActionRequestSchema
>;

export const sandboxSetupCurrentChatV10 = defineRpcContract({
  method: "sandboxSetup.currentChat",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: lazySchema(() => z.object({})),
  responseSchema: lazySchema(() =>
    z.object({ setupChat: chatRefSchema.nullable() }),
  ),
});

export const sandboxSetupStartV10 = defineRpcContract({
  method: "sandboxSetup.start",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: sandboxSetupStartRequestSchema,
  responseSchema: sandboxSetupStartResponseSchema,
});

export const sandboxSetupVersionActionV10 = defineRpcContract({
  method: "sandboxSetup.versionAction",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: sandboxSetupVersionActionRequestSchema,
  responseSchema: lazySchema(() => z.object({ applied: z.boolean() })),
});

export const sandboxSetupSubscribeOpenRequestSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task"), epicId: z.string().min(1) }),
    chatRefSchema.extend({ kind: z.literal("setup") }),
  ]),
);
export type SandboxSetupSubscribeOpenRequest = z.infer<
  typeof sandboxSetupSubscribeOpenRequestSchema
>;

/** Each frame replaces its view. Null clears the view when setup is unavailable. */
export const sandboxSetupSubscribeServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("task"),
      hasBinaryPayload: z.literal(false),
      state: z
        .object({
          /** Only the authenticated viewer's chat, in this sandbox. */
          setupChat: chatRefSchema.nullable(),
          cards: z.array(taskCardSchema),
          /** Durable switch rows from the task's bounded chat history. */
          toolSwitches: z.array(toolSwitchSchema),
        })
        .nullable(),
    }),
    z.object({
      kind: z.literal("setup"),
      hasBinaryPayload: z.literal(false),
      state: setupPanelSchema.nullable(),
    }),
  ]),
);
export type SandboxSetupSubscribeServerFrame = z.infer<
  typeof sandboxSetupSubscribeServerFrameSchema
>;

export const sandboxSetupSubscribeV10 = defineStreamRpcContract({
  method: "sandboxSetup.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: sandboxSetupSubscribeOpenRequestSchema,
  serverFrameSchema: sandboxSetupSubscribeServerFrameSchema,
  clientFrameSchema: lazySchema(() =>
    z.object({
      kind: z.literal("refresh"),
      hasBinaryPayload: z.literal(false),
    }),
  ),
});
