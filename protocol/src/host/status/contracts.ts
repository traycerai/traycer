import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";

export const hostStatusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
  }),
});
