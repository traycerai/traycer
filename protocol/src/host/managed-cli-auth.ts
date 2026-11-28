import type { HostRpcRegistry } from "./registry";
import { z } from "zod";

/** HEAD discovers support, GET with a bearer reads the verified account. */
export const MANAGED_CLI_AUTH_PATH = "/cli-auth/v1";
export const MANAGED_CLI_RPC_PATH = "/cli-auth/v1/rpc";
export const MANAGED_CLI_HOST_HEADER = "x-traycer-host-id";
export const MANAGED_CLI_OPEN_PREFIX = "traycer-managed-cli-v1:";

export const MANAGED_CLI_UNARY_METHODS = [
  "host.status",
  "worktree.listBindingsForEpic",
] as const satisfies readonly (keyof HostRpcRegistry & string)[];

export const managedCliIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("team"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
]);

export type ManagedCliIdentity = z.infer<typeof managedCliIdentitySchema>;
