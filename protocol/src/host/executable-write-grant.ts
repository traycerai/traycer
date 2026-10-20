import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The scoped executable-write grant a host RPC that can reach an execution sink
 * carries. The GUI mints it on its own user session from authn's
 * `POST /api/v3/environments/:environmentId/executable-write-grants { hostId }`
 * (ten minutes, one host) and passes it here; the host's forwarder attaches it
 * to the environment write and never mints one. `null` is a call made without
 * one, which the host holds as "needs you" when the write reaches a sink.
 *
 * The token is a compact JWS, opaque to the client. The bound is the header's,
 * not the token's: a value past it is refused at the parse rather than
 * forwarded into a header authn would reject anyway.
 */
export const EXECUTABLE_WRITE_GRANT_MAX_LENGTH = 8192;

export const executableWriteGrantSchema = lazySchema(() =>
  z.string().min(1).max(EXECUTABLE_WRITE_GRANT_MAX_LENGTH).nullable(),
);
export type ExecutableWriteGrant = z.infer<typeof executableWriteGrantSchema>;
