import { randomUUID } from "node:crypto";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  worktreeDeleteByPathServerFrameSchema,
  type WorktreeDeleteOutputChannel,
} from "@traycer/protocol/host/worktree-delete-stream";
import type {
  WorktreeDeleteBatchOutputChannel,
  WorktreeDeleteBatchPhase,
} from "@traycer/protocol/host/worktree-delete-batch-stream";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { MutableBearerLease } from "../../../shared/auth/bearer-source";
import { WsStreamClient } from "../../../shared/host-transport/ws-stream-client";
import { WorktreeDeleteBatchStreamClient } from "../../../shared/host-transport/worktree-delete-batch-stream-client";
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
import { writeStderr } from "../runner/std-write";

// Stream timing knobs, mirroring `traycer monitor`. A worktree delete is a
// one-shot: it runs a teardown script (which can be slow) then removes the
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
  // The delete is destructive, so it is a capability boundary - not merely a
  // hidden command - in the readonly agent surface. Commander's `hidden` flag
  // still runs the action when the subcommand is typed explicitly, so the
  // command itself refuses up front (before any network/stream work) when this
  // is true. Resolved from `TRAYCER_AGENT_CLI_SURFACE` at registration.
  readonly readonlySurface: boolean;
}

/**
 * `traycer worktree delete --path <p>` - drives the host's deletion pipeline
 * (busy-check -> teardown script -> `git worktree remove`). Teardown/remove
 * output is relayed live as it streams; the terminal frame carries the final
 * `deleted` flag, and a failure (busy path, unexpected host error) surfaces as
 * a clean non-zero CliError. Hidden in the `readonly` CLI surface (registered
 * like `agent create`).
 *
 * On a host that has `worktree.deleteBatchByPath` this runs as a ONE-TARGET
 * command, so the CLI's delete queues on the same host-wide scheduler as every
 * other deletion and leaves the same completion notification behind. Older
 * hosts fall back to the released single-target stream.
 */
export function buildWorktreeDeleteCommand(
  opts: WorktreeDeleteCommandOpts,
): CommandFn {
  return async (ctx) => {
    if (opts.readonlySurface) {
      throw cliError({
        code: CLI_ERROR_CODES.FORBIDDEN,
        message:
          "traycer: worktree delete is not available in the readonly agent surface - remove worktrees from Settings ▸ Worktrees, or run this from a full-surface session.",
        details: null,
        exitCode: 1,
      });
    }
    const worktreePath = opts.worktreePath.trim();
    if (worktreePath.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: worktree delete requires --path <worktree path>.",
        details: null,
        exitCode: 1,
      });
    }
    const deleted = await runWorktreeDelete(worktreePath, ctx);
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
 * Attempt the command stream first; fall back to the released single-target
 * stream only when the host proves it has no such method.
 *
 * The fallback is safe for a DESTRUCTIVE operation precisely because that
 * proof arrives from the openAck compatibility check, which runs before the
 * subscribe frame is sent - the host was never asked to delete anything, so
 * re-issuing the work on the older method cannot double it. Any other failure
 * mode (a drop, a fatal close, a host-side rejection) is reported, never
 * retried on the other method.
 *
 * Both attempts share one `WsStreamClient`: each session dials its own socket,
 * and an unsupported method disposes only that session.
 */
async function runWorktreeDelete(
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

  const attempt = await runDeleteCommand(worktreePath, ctx, client);
  if (attempt.kind === "settled") {
    client.close("worktree-delete-settled");
    if (attempt.error !== null) throw attempt.error;
    return attempt.deleted;
  }
  const deleted = await runLegacyDeleteStream(
    worktreePath,
    ctx,
    client,
  ).finally(() => {
    client.close("worktree-delete-settled");
  });
  return deleted;
}

type DeleteAttempt =
  | {
      readonly kind: "settled";
      readonly deleted: boolean;
      readonly error: CliError | null;
    }
  /** This host has no `worktree.deleteBatchByPath`, and ran nothing. */
  | { readonly kind: "unsupported" };

/**
 * Run the delete as a one-target `worktree.deleteBatchByPath` command.
 *
 * The command id is minted here, once per invocation. `WorktreeDeleteBatchStreamClient`
 * turns that into the replay-safe pair: it subscribes in `start` mode and, if
 * that session drops after reaching the host, re-opens in `observe` mode - so
 * the transport's automatic re-subscription can never re-execute the delete.
 *
 * This CLI then goes further and refuses to wait through a reconnect at all. A
 * one-shot command that silently blocks while a host comes back is the wrong
 * shape for a script, and the honest answer to a drop is the same as it always
 * was: the worktree may or may not be gone, go look. Nothing is replayed
 * either way.
 */
function runDeleteCommand(
  worktreePath: string,
  ctx: CommandContext,
  client: WsStreamClient<HostStreamRpcRegistry>,
): Promise<DeleteAttempt> {
  return new Promise<DeleteAttempt>((resolve) => {
    let settled = false;
    const holder: { command: WorktreeDeleteBatchStreamClient | null } = {
      command: null,
    };
    const finish = (attempt: DeleteAttempt): void => {
      if (settled) return;
      settled = true;
      holder.command?.close();
      resolve(attempt);
    };
    const command = new WorktreeDeleteBatchStreamClient({
      wsStreamClient: client,
      commandId: randomUUID(),
      source: "cli",
      targets: [{ worktreePath, scripts: null }],
      callbacks: {
        onTargetStarted: (_worktreePath, hasTeardown) =>
          relayStatus(
            ctx,
            hasTeardown
              ? "starting delete (running teardown script)"
              : "starting delete",
          ),
        onTargetPhase: (_worktreePath, phase: WorktreeDeleteBatchPhase) =>
          relayStatus(ctx, `phase: ${phase}`),
        onTargetOutput: (
          _worktreePath,
          channel: WorktreeDeleteBatchOutputChannel,
          chunk,
        ) => relayOutput(ctx, channel, chunk),
        onTargetComplete: (_worktreePath, deleted) =>
          finish({ kind: "settled", deleted, error: null }),
        onTargetFailed: (_worktreePath, reason) =>
          finish({
            kind: "settled",
            deleted: false,
            error: deleteFailedCliError(reason),
          }),
        // With one target this normally arrives after its terminal frame and
        // is a no-op under the settled guard. It matters when it does NOT: an
        // observer that attached to an already-settled command is told only
        // how the COMMAND ended, and the counts are then the whole answer.
        onCommandComplete: (counts) =>
          finish({
            kind: "settled",
            deleted: counts.deletedCount === 1,
            error: null,
          }),
        onCommandFailed: (reason) =>
          finish({
            kind: "settled",
            deleted: false,
            error: deleteFailedCliError(reason),
          }),
        onUnsupported: () => finish({ kind: "unsupported" }),
        onConnectionStatus: (
          status: StreamConnectionStatus,
          reason: StreamCloseReason | null,
        ) => {
          if (status === "connecting" || status === "open") return;
          if (
            status === "closed" &&
            reason !== null &&
            reason.kind === "fatalError"
          ) {
            finish({
              kind: "settled",
              deleted: false,
              error: fatalCloseToCliError(reason.details),
            });
            return;
          }
          finish({
            kind: "settled",
            deleted: false,
            error: streamDroppedCliError(),
          });
        },
      },
    });
    holder.command = command;
    // A callback can settle DURING construction (the compatibility check is
    // not contractually async), which would leave the transport open with
    // nobody holding it.
    if (settled) command.close();
  });
}

/**
 * Older-host path: the released single-target `worktree.deleteByPath@1.0`
 * stream, unchanged. Resolves with the final `deleted` flag on the terminal
 * `complete` frame; rejects with a CliError on a `failed` frame (the host's
 * reason is preserved) or a fatal stream close.
 */
async function runLegacyDeleteStream(
  worktreePath: string,
  ctx: CommandContext,
  client: WsStreamClient<HostStreamRpcRegistry>,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const session = client.subscribe("worktree.deleteByPath", {
      worktreePath,
      scripts: null,
    });
    // Tear the session down on any terminal outcome; the caller closes the
    // client (an open socket keeps the event loop alive).
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      session.close();
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
          finish(() => reject(deleteFailedCliError(frame.reason)));
          return;
        case "pong":
          return;
      }
    });
    session.onStatusChange(
      (status: StreamConnectionStatus, reason: StreamCloseReason | null) => {
        // The initial dial (`connecting`) and a healthy connection (`open`) are
        // normal; everything else is a drop. For this one-shot DESTRUCTIVE
        // command a drop before an application terminal frame (`complete` /
        // `failed`) must be terminal: the shared client would otherwise
        // reconnect and RE-SEND `worktree.deleteByPath`, re-entering the host's
        // delete pipeline. So the first `reconnecting`/`closed` transition
        // (before `finish` has run) fails the command with no resubscribe.
        if (status === "connecting" || status === "open") {
          return;
        }
        if (
          status === "closed" &&
          reason !== null &&
          reason.kind === "fatalError"
        ) {
          finish(() => reject(fatalCloseToCliError(reason.details)));
          return;
        }
        // `reconnecting`, or a non-fatal `closed` that isn't our own
        // `finish()`-driven caller close (the latter is a no-op under the
        // `settled` guard).
        finish(() => reject(streamDroppedCliError()));
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
  writeStderr(`[traycer worktree delete] ${message}\n`);
}

/**
 * Relay a teardown/remove output chunk as it streams. In JSON mode each chunk
 * becomes a `progress` event (stdout must stay newline-delimited JSON); in
 * human mode the raw chunk is written straight through on its own channel.
 */
function relayOutput(
  ctx: CommandContext,
  channel: WorktreeDeleteOutputChannel | WorktreeDeleteBatchOutputChannel,
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

/** The host reported this delete as failed, with a displayable reason. */
function deleteFailedCliError(reason: string): CliError {
  return cliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message: `traycer: worktree delete failed - ${reason}`,
    details: null,
    exitCode: 1,
  });
}

/**
 * A recoverable transport drop (socket close, dial/openAck timeout, missed
 * pong, malformed frame) arrived before the host sent a terminal frame. We
 * stop here rather than waiting the host out. The message is deliberately
 * honest about the destructive uncertainty: the worktree may or may not have
 * been removed, and nothing is replayed to find out.
 */
function streamDroppedCliError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message:
      "traycer: worktree delete stream dropped before the host reported a result - the worktree may or may not have been removed. Run `traycer worktree list` to check, then retry if needed.",
    details: null,
    exitCode: 1,
  });
}

/**
 * Map a fatal stream close to a stable CliError. `UNAUTHORIZED` means the host
 * rejected the bearer (no auth recovery is wired for this one-shot); a protocol
 * skew maps to `HOST_INCOMPATIBLE`; anything else is unexpected.
 *
 * A host that simply lacks the newer method never reaches here - that is an
 * `onUnsupported` hand-off to the released stream, not a failure.
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
  if (
    details.code === "INCOMPATIBLE" ||
    details.code === "DOWNGRADE_UNSUPPORTED"
  ) {
    return cliError({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: `traycer: ${details.reason} - update the host or CLI so their worktree delete versions match.`,
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
