import type { HostRpcRegistry } from "./registry";
import { lazySchema } from "../framework/lazy-schema";
import { z } from "zod";

/** HEAD discovers support, GET with a bearer reads the verified account. */
export const MANAGED_CLI_AUTH_PATH = "/cli-auth/v1";
export const MANAGED_CLI_RPC_PATH = "/cli-auth/v1/rpc";
export const MANAGED_CLI_HOST_HEADER = "x-traycer-host-id";
export const MANAGED_CLI_OPEN_PREFIX = "traycer-managed-cli-v1:";
export const MANAGED_CLI_WAITING_HEADER = "x-traycer-account-waiting";
export const MANAGED_CLI_WAITING =
  "Waiting for this machine's Traycer account.";
export const MANAGED_CLI_UNCONFIRMED =
  "Could not confirm this machine's Traycer account.";
export const MANAGED_CLI_RETRY = MANAGED_CLI_UNCONFIRMED + " Try again.";
export const MANAGED_CLI_REFUSAL = "Sign-in is managed for this machine.";

export const MANAGED_CLI_UNARY_METHODS = [
  "host.status",
  "worktree.listBindingsForEpic",
] as const satisfies readonly (keyof HostRpcRegistry & string)[];

const userIdentitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("user"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
);
const teamIdentitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("team"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
);
export type ManagedCliIdentity =
  | z.infer<typeof userIdentitySchema>
  | z.infer<typeof teamIdentitySchema>;

export const managedCliAccountSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    userIdentitySchema.extend({
      user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
      authnBaseUrl: z.string().min(1),
    }),
    teamIdentitySchema,
  ]),
);
export type ManagedCliAccount = z.infer<typeof managedCliAccountSchema>;

const managedCliOpenSchema = lazySchema(() =>
  z.object({
    token: z.string(),
    taskCapability: z.string().nullable(),
  }),
);
export type ManagedCliOpen = z.infer<typeof managedCliOpenSchema>;

export function encodeManagedCliOpen(open: ManagedCliOpen): string {
  return MANAGED_CLI_OPEN_PREFIX + JSON.stringify(open);
}

export function readManagedCliOpen(value: string): ManagedCliOpen | null {
  if (!value.startsWith(MANAGED_CLI_OPEN_PREFIX)) return null;
  try {
    return managedCliOpenSchema.parse(
      JSON.parse(value.slice(MANAGED_CLI_OPEN_PREFIX.length)),
    );
  } catch {
    return null;
  }
}
