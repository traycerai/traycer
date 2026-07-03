import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  worktreeDeleteByPathServerFrameSchema,
  type WorktreeDeleteOutputChannel,
} from "@traycer/protocol/host/worktree-delete-stream";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { MutableBearerLease } from "../../../shared/auth/bearer-source";
import { WsStreamClient } from "../../../shared/host-transport/ws-stream-client";
import { createWhatwgStreamWebSocketFactory } from "../../../shared/host-transport/whatwg-stream-ws-factory";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "../../../shared/host-transport/i-stream-session";
import { resolveHostAuth } from "../internal/host-auth";
import { resolveEndpoint } from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import type { CommandContext, CommandFn } from "../runner/runner";

// Stream timing knobs, mirroring `traycer monitor`. `worktree.deleteByPath`
// is a one-shot: it runs a teardown script (which can be slow) then removes the
// worktree, so the ping/pong keepalive must outlast a quiet teardown. A fatal
// close ends the command - unlike the monitor there is no forever-reconnect
// loop and no auth-refresh recovery (`auth: null`); a short-lived delete runs
// on the freshly-read login bearer.
const OPEN_ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface WorktreeDeleteCommandOpts {
  readonly worktreePath: string;
}

/**
 * `traycer worktree delete --path <p>` - drives the host's streaming
 * `worktree.deleteByPath@1.0` pipeline (busy-check -> teardown script ->
 * `git worktree remove`). Teardown/remove output is relayed live as it
 * streams; the terminal `complete` frame carries the final `deleted` flag and
 * a `failed` frame (busy path, unexpected host error) surfaces as a clean
 * non-zero CliError. Hidden in the `readonly` CLI surface (registered like
 * `agent create`).
 */
export function buildWorktreeDeleteCommand(
  opts: WorktreeDeleteCommandOpts,
): CommandFn {
  return async (ctx) => {
    const worktreePath = opts.worktreePath.trim();
    if (worktreePath.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: worktree delete requires --path <worktree path>.",
        details: null,
        exitCode: 1,
      });
    }
    const deleted = await runWorktreeDeleteStream(worktreePath, ctx);
    return {
      data: { worktreePath, deleted },
      // Output already streamed; add a one-line confirmation for the human
      // path (dropped in JSON mode, where `data` carries `deleted`).
      human: deleted
        ? `Removed worktree ${worktreePath}.`
        : `Host reported the worktree was not removed: ${worktreePath}.`,
      exitCode: deleted ? 0 : 1,
    };
  };
}

/**
 * Subscribe to the delete stream and resolve with the final `deleted` flag on
 * the terminal `complete` frame. Rejects with a CliError on a `failed` frame
 * (the host's reason is preserved) or a fatal stream close.
 */
async function runWorktreeDeleteStream(
  worktreePath: string,
  ctx: CommandContext,
): Promise<boolean> {
  const auth = await resolveHostAuth();
  if (auth === null) {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "traycer: not signed in - run `traycer login` to authenticate.",
      details: null,
      exitCode: 1,
    });
  }
  const endpoint = await resolveEndpoint();
  const lease = new MutableBearerLease(auth.token, auth.userId);
  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: () => endpoint,
    bearer: () => lease,
    auth: null,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  });

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const session = client.subscribe("worktree.deleteByPath", {
      worktreePath,
      scripts: null,
    });
    // Tear down both the session and the client on any terminal outcome so the
    // process can exit (an open socket keeps the event loop alive).
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      session.close();
      client.close();
      act();
    };
    session.onServerFrame((envelope) => {
      const parsed = worktreeDeleteByPathServerFrameSchema.safeParse(envelope);
      if (!parsed.success) return;
      const frame = parsed.data;
      switch (frame.kind) {
        case "started":
          relayStatus(
            ctx,
            frame.hasTeardown
              ? "starting delete (running teardown script)"
              : "starting delete",
          );
          return;
        case "phase":
          relayStatus(ctx, `phase: ${frame.phase}`);
          return;
        case "output":
          relayOutput(ctx, frame.channel, frame.chunk);
          return;
        case "complete":
          finish(() => resolve(frame.deleted));
          return;
        case "failed":
          finish(() =>
            reject(
              cliError({
                code: CLI_ERROR_CODES.UNEXPECTED,
                message: `traycer: worktree delete failed - ${frame.reason}`,
                details: null,
                exitCode: 1,
              }),
            ),
          );
          return;
        case "pong":
          return;
      }
    });
    session.onStatusChange(
      (status: StreamConnectionStatus, reason: StreamCloseReason | null) => {
        if (status !== "closed" || reason === null || reason.kind !== "fatalError") {
          return;
        }
        finish(() => reject(fatalCloseToCliError(reason.details)));
      },
    );
  });
}

/**
 * Relay a lifecycle line (started / phase). In JSON mode it rides the NDJSON
 * `progress` channel so stdout stays parseable; in human mode it goes to
 * stderr, keeping stdout for the teardown output itself.
 */
function relayStatus(ctx: CommandContext, message: string): void {
  if (ctx.runtime.json) {
    ctx.progress({
      stage: "worktree-delete",
      message,
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    return;
  }
  process.stderr.write(`[traycer worktree delete] ${message}\n`);
}

/**
 * Relay a teardown/remove output chunk as it streams. In JSON mode each chunk
 * becomes a `progress` event (stdout must stay newline-delimited JSON); in
 * human mode the raw chunk is written straight through on its own channel.
 */
function relayOutput(
  ctx: CommandContext,
  channel: WorktreeDeleteOutputChannel,
  chunk: string,
): void {
  if (ctx.runtime.json) {
    ctx.progress({
      stage: `worktree-delete:${channel}`,
      message: chunk,
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    return;
  }
  const sink = channel === "stderr" ? process.stderr : process.stdout;
  sink.write(chunk);
}

/**
 * Map a fatal stream close to a stable CliError. `UNAUTHORIZED` means the host
 * rejected the bearer (no auth recovery is wired for this one-shot); a protocol
 * skew maps to `HOST_INCOMPATIBLE`; anything else is unexpected.
 */
function fatalCloseToCliError(details: FatalErrorDetails): CliError {
  if (details.code === "UNAUTHORIZED") {
    return cliError({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "traycer: host rejected the credential for worktree delete - run `traycer login` and retry.",
      details: null,
      exitCode: 1,
    });
  }
  if (details.code === "INCOMPATIBLE" || details.code === "DOWNGRADE_UNSUPPORTED") {
    return cliError({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: `traycer: ${details.reason} - update the host or CLI so their worktree.deleteByPath versions match.`,
      details: null,
      exitCode: 1,
    });
  }
  return cliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message: `traycer: worktree delete stream closed - ${details.reason}`,
    details: null,
    exitCode: 1,
  });
}
