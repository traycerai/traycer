/** Frozen durable plain-terminal schemas shipped in desktop/host v1.2.0-rc.1. */
import { z } from "zod";
import { isoMillisecondTimestampSchema } from "@traycer/protocol/common/schemas";

export const plainTerminalScopeSchemaV10 = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("epic"), epicId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("independent") }),
]);

export const plainTerminalLaunchSchemaV10 = z.strictObject({
  cwd: z.string().min(1),
  shellCommand: z.string().min(1),
  shellArgs: z.array(z.string()),
});

export const plainTerminalRecordSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
  hostId: z.string().min(1),
  scope: plainTerminalScopeSchemaV10,
  launch: plainTerminalLaunchSchemaV10,
  manualTitle: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: isoMillisecondTimestampSchema,
  updatedAt: isoMillisecondTimestampSchema,
});

export const dormantPlainTerminalRuntimeSchemaV10 = z.strictObject({
  status: z.literal("dormant"),
});

export const runningPlainTerminalRuntimeSchemaV10 = z.strictObject({
  status: z.literal("running"),
  sessionId: z.string().min(1),
  currentCwd: z.string().min(1),
  activeProcessName: z.string().nullable(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const plainTerminalRuntimeSchemaV10 = z.discriminatedUnion("status", [
  dormantPlainTerminalRuntimeSchemaV10,
  runningPlainTerminalRuntimeSchemaV10,
]);

export const plainTerminalProjectionSchemaV10 = z
  .strictObject({
    record: plainTerminalRecordSchemaV10,
    runtime: plainTerminalRuntimeSchemaV10,
  })
  .superRefine((projection, ctx) => {
    if (
      projection.runtime.status === "running" &&
      projection.runtime.sessionId !== projection.record.terminalId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "sessionId"],
        message: "sessionId must equal the logical terminalId",
      });
    }
  });
export type PlainTerminalProjectionV10 = z.infer<
  typeof plainTerminalProjectionSchemaV10
>;

export const runningPlainTerminalProjectionSchemaV10 = z
  .strictObject({
    record: plainTerminalRecordSchemaV10,
    runtime: runningPlainTerminalRuntimeSchemaV10,
  })
  .superRefine((projection, ctx) => {
    if (projection.runtime.sessionId !== projection.record.terminalId) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "sessionId"],
        message: "sessionId must equal the logical terminalId",
      });
    }
  });

const gridFieldsV10 = {
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
} as const;

export const createPlainTerminalRequestSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
  scope: plainTerminalScopeSchemaV10,
  cwd: z.string().min(1),
  ...gridFieldsV10,
});
export const createPlainTerminalResponseSchemaV10 = z.strictObject({
  terminal: runningPlainTerminalProjectionSchemaV10,
});
export const listPlainTerminalsRequestSchemaV10 = z.strictObject({
  scope: plainTerminalScopeSchemaV10,
});
export const listPlainTerminalsResponseSchemaV10 = z.strictObject({
  terminals: z.array(plainTerminalProjectionSchemaV10),
});
export const renamePlainTerminalRequestSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
  manualTitle: z.string().nullable(),
});
export const renamePlainTerminalResponseSchemaV10 = z.strictObject({
  terminal: plainTerminalProjectionSchemaV10,
});
export const ensurePlainTerminalRunningRequestSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
  ...gridFieldsV10,
});
export const ensurePlainTerminalRunningResponseSchemaV10 = z.strictObject({
  terminal: runningPlainTerminalProjectionSchemaV10,
});
export const closePlainTerminalRequestSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
});
export const closePlainTerminalResponseSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export const importLegacyPlainTerminalRequestSchemaV10 = z.strictObject({
  terminalId: z.string().min(1),
  hostId: z.string().min(1),
  scope: plainTerminalScopeSchemaV10,
  cwd: z.string().min(1),
  name: z.string(),
  titleSource: z.enum(["default", "manual"]),
  sourceStoreVersion: z.number().int().nonnegative(),
});
export const importLegacyPlainTerminalResponseSchemaV10 = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("imported"),
      terminal: plainTerminalProjectionSchemaV10,
    }),
    z.strictObject({
      status: z.literal("existing"),
      terminal: plainTerminalProjectionSchemaV10,
    }),
    z.strictObject({
      status: z.literal("deleted"),
      terminalId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    }),
  ],
);
