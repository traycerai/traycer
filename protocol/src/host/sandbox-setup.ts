import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { interviewQuestionSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";
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
  /** The card is visible to the owner of this setup chat. */
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

/** The app reads the proposal on the viewer's sign-in to decide what to show. */
const reviewCardSchema = lazySchema(() =>
  z.object({
    kind: z.literal("review"),
    repository: repositorySchema,
    versionId: z.uuid(),
  }),
);

const taskCardSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    offerCardSchema,
    reviewCardSchema,
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

/** Wire length bounds. The host checks UTF-8 bytes before accepting a handover. */
export const SANDBOX_SETUP_HANDOVER_SCRIPT_MAX_CHARS = 8 * 1024 * 1024;
export const SANDBOX_SETUP_HANDOVER_BUILD_LOG_MAX_CHARS = 64 * 1024;

const startSourceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("offer") }),
    z.object({ kind: z.literal("settings") }),
    z.object({
      kind: z.literal("fix"),
      versionId: z.uuid(),
      script: z.string().max(SANDBOX_SETUP_HANDOVER_SCRIPT_MAX_CHARS),
      /** The build log service returns a tail of at most 64 KiB in UTF-8. */
      buildLog: z.string().max(SANDBOX_SETUP_HANDOVER_BUILD_LOG_MAX_CHARS),
    }),
    z.object({ kind: z.literal("update"), versionId: z.uuid() }),
    z.object({
      kind: z.literal("continue"),
      versionId: z.uuid(),
      baseVersionId: z.uuid().nullable(),
      script: z.string().max(SANDBOX_SETUP_HANDOVER_SCRIPT_MAX_CHARS),
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
    /** Ordinary chat launch settings. Null reuses the viewer's setup chat. */
    agent: chatRunSettingsSchema.nullable(),
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
        "setup_script_too_large",
      ]),
    }),
  ]),
);
export type SandboxSetupStartResponse = z.infer<
  typeof sandboxSetupStartResponseSchema
>;

/** Report an account version action to the viewer's own setup chat. */
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
          /** Offers, the viewer's setup cards, and waiting version IDs the app can authorize for review. */
          cards: z.array(taskCardSchema),
          /** Durable switch rows from the task's bounded chat history. */
          toolSwitches: z.array(toolSwitchSchema),
        })
        .refine(
          ({ setupChat, cards }) =>
            cards.every(
              (card) =>
                !("setupChat" in card) ||
                (setupChat !== null &&
                  card.setupChat.epicId === setupChat.epicId &&
                  card.setupChat.chatId === setupChat.chatId),
            ),
          {
            path: ["cards"],
            message: "Setup cards must link to the viewer's setup chat",
          },
        )
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
