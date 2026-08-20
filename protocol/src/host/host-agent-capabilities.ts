/**
 * Cross-host target-side capabilities that first shipped as local A2A tools:
 * repo → path enumeration, path-policy-gated file read/write, and a
 * non-persistent one-off shell. Brand-new unary methods on the
 * optional-capability channel (`degrade: unsupported`).
 *
 * File payloads stay inside the unary body. Mux whole-body chunking already
 * carries large unary frames; there is no stream grant for host-agent in v1.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { z } from "zod";

export const hostFileEncodingSchema = z.enum(["utf8", "base64"]);
export type HostFileEncoding = z.infer<typeof hostFileEncodingSchema>;

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

export const hostFileReadRequestSchema = z.object({
  epicId: z.string().min(1),
  path: z.string().min(1),
  encoding: hostFileEncodingSchema,
});
export type HostFileReadRequest = z.infer<typeof hostFileReadRequestSchema>;

export const hostFileReadResponseSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
  encoding: hostFileEncodingSchema,
});
export type HostFileReadResponse = z.infer<typeof hostFileReadResponseSchema>;

export const hostFileReadV10 = defineRpcContract({
  method: "host.file.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileReadRequestSchema,
  responseSchema: hostFileReadResponseSchema,
});

export const hostFileWriteRequestSchema = z.object({
  epicId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  encoding: hostFileEncodingSchema,
});
export type HostFileWriteRequest = z.infer<typeof hostFileWriteRequestSchema>;

export const hostFileWriteResponseSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  atomic: z.literal(true),
});
export type HostFileWriteResponse = z.infer<typeof hostFileWriteResponseSchema>;

export const hostFileWriteV10 = defineRpcContract({
  method: "host.file.write",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileWriteRequestSchema,
  responseSchema: hostFileWriteResponseSchema,
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
