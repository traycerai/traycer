/**
 * Cross-host target-side capabilities: repo → path enumeration, a
 * non-persistent one-off shell, and the host directory an agent needs in
 * order to name a peer at all. Brand-new unary methods on the
 * optional-capability channel (`degrade: unsupported`).
 *
 * **There is deliberately no `host.file.read` / `host.file.write` here.**
 * Both existed briefly and were removed before release: their `content` was
 * a plain string, so every byte crossed the wire *through agent context* —
 * the model had to re-emit the whole file as a tool argument, which caps the
 * useful size at tens of KB regardless of any byte limit, and is worse for
 * binary at base64's 4/3 expansion. They also bought no capability the
 * one-off shell lacks (`cat` and a heredoc are equally context-bound). The
 * host-side plumbing they used — chunked source, `AsyncIterable` sink,
 * atomic temp+rename, path policy — is kept in the host's own file service
 * for a future copy verb that moves bytes host-to-host without the agent
 * ever holding them. Do not reintroduce a byte-carrying file RPC.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { z } from "zod";

export const hostResolveRepoPathsRequestSchema = z.object({
  epicId: z.string().min(1),
  identity: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("remote-url"),
      remoteUrl: z.string().min(1),
    }),
    z.object({
      kind: z.literal("workspace"),
      workspacePath: z.string().min(1),
    }),
  ]),
});
export type HostResolveRepoPathsRequest = z.infer<
  typeof hostResolveRepoPathsRequestSchema
>;

export const hostResolveRepoPathsResponseSchema = z.object({
  paths: z.array(z.string()),
  scratchDirectory: z.string(),
});
export type HostResolveRepoPathsResponse = z.infer<
  typeof hostResolveRepoPathsResponseSchema
>;

export const hostResolveRepoPathsV10 = defineRpcContract({
  method: "host.resolveRepoPaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostResolveRepoPathsRequestSchema,
  responseSchema: hostResolveRepoPathsResponseSchema,
});

export const hostOneOffShellRunRequestSchema = z.object({
  epicId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000),
});
export type HostOneOffShellRunRequest = z.infer<
  typeof hostOneOffShellRunRequestSchema
>;

export const hostOneOffShellRunResponseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  outputLimitExceeded: z.boolean(),
  outputBytes: z.number().int().nonnegative(),
});
export type HostOneOffShellRunResponse = z.infer<
  typeof hostOneOffShellRunResponseSchema
>;

export const hostOneOffShellRunV10 = defineRpcContract({
  method: "host.oneOffShell.run",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostOneOffShellRunRequestSchema,
  responseSchema: hostOneOffShellRunResponseSchema,
});

/**
 * One machine in the caller's own fleet, as the cloud host directory
 * describes it. This is the answer to "which hosts exist?", which every
 * other cross-host verb assumes has already been answered: they all take a
 * target host id, and until this method existed an agent had no supported
 * way to obtain one for any machine but its own.
 *
 * **`relayAttached` is a FACT, not a verdict.** It reports what the cloud
 * last observed, and it is deliberately not named `reachable`: nothing in
 * the dial path gates on it. The router resolves a target and *attempts the
 * dial*, letting a genuine failure surface as `HOST_UNREACHABLE`, precisely
 * so a stale directory reading cannot refuse a machine that would in fact
 * answer. Treat this as a hint for choosing among hosts, never as a
 * precondition to check before calling — a second dialability predicate
 * living here would be a second reading of a rule the dialer already owns.
 *
 * `publicKey` is **not** projected: it is the dialer's Noise material, not
 * something an agent has any use for.
 *
 * `platform` is passed through as the cloud's free-text string (it is what
 * feeds the desktop host directory). Do not narrow it to an enum here — the
 * value's shape is authn's to define, and an enum would drift the moment it
 * writes something new. It is, incidentally, how an agent learns which shell
 * flavour a one-off command will meet on that machine.
 */
export const hostDirectoryEntrySchema = z.object({
  hostId: z.string(),
  displayName: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  relayAttached: z.boolean(),
  busy: z.boolean(),
});
export type HostDirectoryEntrySummary = z.infer<
  typeof hostDirectoryEntrySchema
>;

export const hostDirectoryListRequestSchema = z.object({});
export type HostDirectoryListRequest = z.infer<
  typeof hostDirectoryListRequestSchema
>;

export const hostDirectoryListResponseSchema = z.object({
  hosts: z.array(hostDirectoryEntrySchema),
});
export type HostDirectoryListResponse = z.infer<
  typeof hostDirectoryListResponseSchema
>;

export const hostDirectoryListV10 = defineRpcContract({
  method: "host.directory.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostDirectoryListRequestSchema,
  responseSchema: hostDirectoryListResponseSchema,
});
