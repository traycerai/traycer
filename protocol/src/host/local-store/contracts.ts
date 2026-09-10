import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  rebindLocalStoreRequestSchema,
  rebindLocalStoreResponseSchema,
} from "@traycer/protocol/host/local-store/schemas";

export const hostRebindLocalStoreV10 = defineRpcContract({
  method: "host.rebindLocalStore",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: rebindLocalStoreRequestSchema,
  responseSchema: rebindLocalStoreResponseSchema,
});
