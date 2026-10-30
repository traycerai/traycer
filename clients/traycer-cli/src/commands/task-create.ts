import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";
import { createEpicResponseSchemaV12 } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import { CURRENT_EPIC_VERSION } from "@traycer-clients/shared/epic/epic-version";
import { plainTextPromptContent } from "@traycer-clients/shared/epic/plain-text-content";
import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  RetryableTransportError,
  type HostTransportEndpoint,
  type RequestOfMethod,
} from "../../../shared/host-transport/host-messenger";
import { hostRejectedBeforeRequest } from "../../../shared/host-transport/auth-aware-messenger";
import { RetryEpisodeOutcomeUnknownError } from "../../../shared/host-transport/retrying-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import { config } from "../config";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import { resolveHostAuth, type HostAuth } from "../internal/host-auth";
import {
  callHostRpcAtResolvedEndpoint,
  FRAME_TIMEOUT_MS,
  hostRpcToCliError,
  isRequestVersionProjectionError,
  parseCanonicalHostResponse,
  parseUserInput,
  resolveEndpoint,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import { CREDENTIALS_LOCK_WAIT_MS } from "../store/credentials-store";
import { cliTaskCreateKeysDir } from "../store/paths";
import {
  clearTaskCreateKey,
  readTaskCreateKey,
  taskCreateKeyRecordPath,
  withTaskCreateKeyLock,
  writeTaskCreateKey,
} from "../store/task-create-keys";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";

/**
 * `traycer task create` - start a Task with one first agent and its first
 * message, as the signed-in person, on this machine's host.
 *
 * It states the whole `epic.create` request the GUI's new-Task composer
 * states: the Task, a folded first chat and its initial message, sent by the
 * person, billed to their personal account. The host owns the rest (title
 * generation, the first turn), so nothing here resolves a profile, a catalog
 * default or a worktree; `--harness` and `--model` are required because
 * there is no host default model and a silent one would be a spend surprise.
 *
 * Exit 0 means the Task and its first agent exist and the host accepted the
 * message. It does not mean the first turn has started.
 */
export interface TaskCreateOptions {
  readonly title: string | null;
  readonly message: string;
  readonly workspaces: readonly string[];
  readonly repos: readonly string[];
  readonly harness: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string | null;
  readonly profile: string | null;
  readonly idempotencyKey: string | null;
}

/**
 * `epic.create@1.1` is the local-first create: seeded into this host's store
 * as the person, and the minor whose create refusal arrives as data. Below it
 * the request is refused before any frame, which reads as "update the host".
 */
const LOCAL_FIRST_CREATE_FLOOR = {
  method: "epic.create",
  version: { major: 1, minor: 1 },
} as const;

/**
 * How long a second run of a key waits on its lock before it gives up having
 * created nothing. One create holds the lock for a single attempt, a dial and
 * its response wait, with no attestation window and no resend after a
 * refreshed sign-in; the wait allows twice that plus the credentials lock
 * wait. Read when the command runs, not at import.
 */
function keyLockWaitMs(): number {
  return (
    2 * (DEFAULT_DIAL_TIMEOUT_MS + FRAME_TIMEOUT_MS) + CREDENTIALS_LOCK_WAIT_MS
  );
}

interface TaskCreateInput {
  readonly title: string;
  readonly message: string;
  readonly workspaces: readonly string[];
  readonly repos: readonly { readonly owner: string; readonly repo: string }[];
  readonly settings: RequestSettings;
}

type EpicCreateRequest = RequestOfMethod<HostRpcRegistry, "epic.create">;
type RequestSettings = NonNullable<
  NonNullable<EpicCreateRequest["chat"]>["initialMessage"]
>["settings"];

interface TaskIds {
  readonly taskId: string;
  readonly agentId: string;
}

/**
 * What a sent create came to. `not-created` is only ever a failure that
 * PROVES nothing was made; anything the host may have committed is
 * `unknown`, and a key record keeps its `intent` for it.
 */
type CreateOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "not-created"; readonly error: unknown }
  | { readonly kind: "unknown"; readonly error: unknown };

export function buildTaskCreateCommand(opts: TaskCreateOptions): CommandFn {
  return async () => {
    refuseInAgentSession();
    const input = parseTaskCreateInput(opts);
    const auth = await resolveHostAuth();
    if (auth === null) {
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
        message:
          "traycer: not signed in - run `traycer login` to authenticate.",
        details: null,
        exitCode: 1,
      });
    }
    // Resolved once, before any record: a host that is not running stops the
    // command here with nothing written, and the send below goes to exactly
    // this endpoint rather than a fresh read of it.
    const endpoint = await resolveEndpoint();

    if (opts.idempotencyKey === null) {
      const ids = mintIds();
      const outcome = await sendCreate(input, ids, auth, endpoint);
      if (outcome.kind !== "created") throw failureFor(outcome, ids, null);
      return created(ids, false);
    }

    const recordPath = taskCreateKeyRecordPath(
      cliTaskCreateKeysDir(config.environment),
      auth.userId,
      opts.idempotencyKey,
    );
    const fingerprint = fingerprintOf(input);
    return withTaskCreateKeyLock(recordPath, keyLockWaitMs(), async () => {
      const existing = await readTaskCreateKey(recordPath, Date.now());
      if (existing.kind === "damaged") {
        throw cliError({
          code: CLI_ERROR_CODES.UNEXPECTED,
          message: `traycer: the record for this --idempotency-key cannot be read: ${recordPath}. A Task may exist for it; check your Task list, then delete that file to use the key again.`,
          details: null,
          exitCode: 1,
        });
      }
      // An unsettled send is reported whatever this run asked for: a Task
      // may exist, and that is the fact a rerun has to act on.
      if (existing.kind === "intent") {
        throw cliError({
          code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
          message: `traycer: an earlier run with this --idempotency-key sent Task ${existing.record.taskId} (first agent ${existing.record.agentId}) and never learned whether it was created. Check your Task list before starting it again; delete ${recordPath} to use the key again.`,
          details: null,
          exitCode: 1,
        });
      }
      if (existing.kind === "done") {
        if (existing.record.fingerprint !== fingerprint) {
          throw cliError({
            code: CLI_ERROR_CODES.INVALID_ARGUMENT,
            message: `traycer: this --idempotency-key was used with different options. Use a key per Task you mean to start, or delete ${recordPath} to reuse it.`,
            details: null,
            exitCode: 1,
          });
        }
        return created(
          { taskId: existing.record.taskId, agentId: existing.record.agentId },
          true,
        );
      }

      const ids = mintIds();
      // Durable before the request goes out, so a run that dies after the
      // send leaves a record the next run refuses on. If this write fails the
      // command stops here having sent nothing, and removes the record: the
      // atomic write renames before it flushes the folder, so a late failure
      // can leave an intent the next run would read as a send.
      try {
        await writeTaskCreateKey(recordPath, {
          state: "intent",
          ...ids,
          fingerprint,
          writtenAt: Date.now(),
        });
      } catch (error) {
        await clearTaskCreateKey(recordPath).catch(() => undefined);
        throw error;
      }
      const outcome = await sendCreate(input, ids, auth, endpoint);
      if (outcome.kind === "not-created") {
        await clearTaskCreateKey(recordPath);
        throw failureFor(outcome, ids, null);
      }
      if (outcome.kind === "unknown") {
        throw failureFor(outcome, ids, recordPath);
      }
      try {
        await writeTaskCreateKey(recordPath, {
          state: "done",
          ...ids,
          fingerprint,
          writtenAt: Date.now(),
        });
      } catch {
        // The host answered created, so the ids are the result. The atomic
        // write renames the record into place before it flushes the folder,
        // so a write that failed late may already read done: read it back
        // rather than send the person to delete a record a rerun reports.
        const after = await readTaskCreateKey(recordPath, Date.now()).catch(
          () => null,
        );
        if (after?.kind === "done") {
          throw cliError({
            code: CLI_ERROR_CODES.UNEXPECTED,
            message: `traycer: Task ${ids.taskId} (first agent ${ids.agentId}) was created; a rerun with this --idempotency-key reports it.`,
            details: { taskId: ids.taskId, agentId: ids.agentId },
            exitCode: 1,
          });
        }
        if (after?.kind === "intent") {
          throw cliError({
            code: CLI_ERROR_CODES.UNEXPECTED,
            message: `traycer: Task ${ids.taskId} (first agent ${ids.agentId}) was created, but the record for this --idempotency-key could not be updated. A rerun with this key refuses until you delete ${recordPath}.`,
            details: { taskId: ids.taskId, agentId: ids.agentId },
            exitCode: 1,
          });
        }
        // Unreadable: it may read done, so deleting it is not advice.
        throw cliError({
          code: CLI_ERROR_CODES.UNEXPECTED,
          message: `traycer: Task ${ids.taskId} (first agent ${ids.agentId}) was created, but the record for this --idempotency-key at ${recordPath} could not be read back. Do not start this Task again.`,
          details: { taskId: ids.taskId, agentId: ids.agentId },
          exitCode: 1,
        });
      }
      return created(ids, false);
    });
  };
}

// A rail, not a boundary: an agent that holds this shell also holds the
// stored sign-in. It points an agent at the tool, which carries the per-agent
// rate cap, rather than at a shell loop.
function refuseInAgentSession(): void {
  if (readTuiAgentId(null) === null && readEpicId(null) === null) return;
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message:
      "traycer: task create starts a Task as the person signed in at this shell, and this is an agent session (TRAYCER_AGENT_ID or TRAYCER_EPIC_ID is set). An agent starts a Task with its traycer_create_task tool.",
    details: null,
    exitCode: 1,
  });
}

function parseTaskCreateInput(opts: TaskCreateOptions): TaskCreateInput {
  if (opts.message.trim().length === 0) {
    throw invalid("task create: --message must not be empty.");
  }
  if (opts.harness === null || opts.model === null) {
    throw invalid(
      "task create: --harness and --model are required. Use 'traycer agent list-harness-models <harness>' to find a model id.",
    );
  }
  const settings = parseUserInput(chatRunSettingsSchema, {
    ultracode: false,
    harnessId: opts.harness,
    model: opts.model,
    permissionMode: opts.permissionMode ?? "full_access",
    reasoningEffort: opts.reasoningEffort,
    serviceTier: null,
    // Epic Mode was removed from the product; the protocol still carries the
    // field, so every create states the one remaining mode.
    agentMode: "regular",
    profileId:
      opts.profile === null || opts.profile === "ambient" ? null : opts.profile,
  });
  return {
    title: opts.title ?? "",
    message: opts.message,
    workspaces: opts.workspaces.map(requireAbsoluteWorkspace),
    repos: opts.repos.map(parseRepo),
    settings,
  };
}

// Not trimmed: a folder name may end in whitespace. The host is this
// machine's, so the path means a folder on this machine. The refusals below
// name the flag and never echo the value: it is printed and logged as is, and
// a value carrying a line break would forge a line there.
function requireAbsoluteWorkspace(rawPath: string): string {
  if (!path.isAbsolute(rawPath)) {
    throw invalid("task create: every --workspace must be an absolute path.");
  }
  return path.resolve(rawPath);
}

function parseRepo(raw: string): { owner: string; repo: string } {
  const parts = raw.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw invalid("task create: every --repo must be owner/repo.");
  }
  return { owner: parts[0], repo: parts[1] };
}

function invalid(message: string): CliError {
  return cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `traycer: ${message}`,
    details: null,
    exitCode: 1,
  });
}

function mintIds(): TaskIds {
  return { taskId: randomUUID(), agentId: randomUUID() };
}

// Of what the person asked for, so a rerun of the same schedule slot matches
// and a changed one is refused; never of the ids a run mints.
function fingerprintOf(input: TaskCreateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.title,
        input.message,
        input.workspaces,
        input.repos.map((repo) => `${repo.owner}/${repo.repo}`),
        input.settings,
      ]),
    )
    .digest("hex");
}

async function sendCreate(
  input: TaskCreateInput,
  ids: TaskIds,
  auth: HostAuth,
  endpoint: HostTransportEndpoint,
): Promise<CreateOutcome> {
  const now = Date.now();
  const request: EpicCreateRequest = {
    epic: {
      id: ids.taskId,
      title: input.title,
      initialUserPrompt: input.message,
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "todo",
      createdAt: now,
      updatedAt: now,
      createdBy: auth.userId,
      version: CURRENT_EPIC_VERSION,
    },
    repoIdentifiers: [...input.repos],
    workspaces: input.workspaces.map((workspacePath) => ({ workspacePath })),
    chat: {
      chatId: ids.agentId,
      parentId: null,
      hostId: endpoint.hostId,
      // Stored untitled, as the composer stores it; the host titles it.
      title: "",
      workspaceMode: input.workspaces.length === 0 ? "folderless" : "inherit",
      worktreeIntent: null,
      initialMessage: {
        messageId: randomUUID(),
        clientActionId: randomUUID(),
        content: plainTextPromptContent(input.message),
        sender: { type: "user", userId: auth.userId },
        settings: input.settings,
        accountContext: { type: "PERSONAL" },
        // The machine this command runs on, which is the host it dials.
        sentFromHostId: endpoint.hostId,
      },
    },
    // The person's own Task. A team Task needs the team's sharing story,
    // which this command does not have.
    owner: null,
  };
  const dispatch: HostRpcDispatch = {
    responseTimeoutMs: null,
    requiredHostMethodVersion: LOCAL_FIRST_CREATE_FLOOR,
    signal: null,
    // One transport attempt. A retry after a send whose answer was lost can
    // come back as the typed refusal, which is DATA, and data carries no
    // trace of the earlier send: read as "nothing was created", it would
    // clear the key record of a create the first attempt may have committed.
    // With one attempt, a refusal answers the only request that went out.
    failFast: true,
    // A refreshed sign-in is sent again only when the host refused the open
    // frame, before any request went out: a send that ended UNAUTHORIZED may
    // have reached the host, so that UNAUTHORIZED comes back here and keeps
    // the record.
    reauthenticate: "before-request",
    // The Task id this run minted. A second RUN mints new ids, so this is not
    // the dedupe across runs; the key record is.
    idempotencyKey: ids.taskId,
  };
  let response: unknown;
  try {
    response = await callHostRpcAtResolvedEndpoint(
      "epic.create",
      request,
      endpoint,
      auth,
      dispatch,
    );
  } catch (error) {
    return requestFrameNeverWritten(error)
      ? { kind: "not-created", error: hostRpcToCliError(error) }
      : { kind: "unknown", error: hostRpcToCliError(error) };
  }
  try {
    const parsed = parseCanonicalHostResponse(
      "epic.create",
      createEpicResponseSchemaV12,
      response,
    );
    if (parsed.refusal === undefined) return { kind: "created" };
    // Both refusal kinds are decided before the host's commit point, so
    // nothing was seeded. The host's message and remedy name the fix.
    return {
      kind: "not-created",
      error: cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: `traycer: the host did not create the Task. ${parsed.refusal.message} ${parsed.refusal.remedy}`,
        details: { refusal: parsed.refusal.kind },
        exitCode: 1,
      }),
    };
  } catch (error) {
    // An answer this CLI cannot read came from a host that may have
    // committed the create.
    return { kind: "unknown", error };
  }
}

/**
 * True only for a failure that proves the request frame was never written,
 * read off the transport's class and flags. A host error response, a lost
 * answer, or a retry episode whose earlier attempt went out are not on this
 * list: the host commits a create before it answers, and can still fail
 * after that (a response that fails validation, a downgrade), so each of
 * those may have made the Task.
 */
function requestFrameNeverWritten(error: unknown): boolean {
  if (error instanceof RetryEpisodeOutcomeUnknownError) return false;
  // Refused against this connection's manifest, before the request frame.
  if (error instanceof HostMethodVersionUnsatisfiedError) return true;
  if (error instanceof HostRequestAbortedError) return !error.mayHaveDispatched;
  // Retryable without a key's say-so is the provably pre-dispatch kind.
  if (error instanceof RetryableTransportError) {
    return !error.replaySafetyFromKey;
  }
  // The host refused the open frame (a sign-in the refresh could not fix);
  // a host error envelope carries no fatal details and is not on this list.
  if (hostRejectedBeforeRequest(error)) return true;
  // Request projection fails while the request is being prepared.
  return isRequestVersionProjectionError(error);
}

function failureFor(
  outcome: Exclude<CreateOutcome, { kind: "created" }>,
  ids: TaskIds,
  recordPath: string | null,
): unknown {
  if (outcome.kind === "not-created") return outcome.error;
  const keyNote =
    recordPath === null
      ? ""
      : ` A rerun with this --idempotency-key refuses until you check your Task list and delete ${recordPath}.`;
  const note = `Task ${ids.taskId} (first agent ${ids.agentId}) may have been created.${keyNote}`;
  if (outcome.error instanceof CliError) {
    return cliError({
      code: outcome.error.code,
      message: `${outcome.error.message} ${note}`,
      details: outcome.error.details,
      exitCode: outcome.error.exitCode,
    });
  }
  return cliError({
    code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
    message: `traycer: the create failed after it was sent. ${note}`,
    details: null,
    exitCode: 1,
  });
}

function created(ids: TaskIds, alreadyCreated: boolean): CommandResult {
  return {
    data: { taskId: ids.taskId, agentId: ids.agentId, alreadyCreated },
    human: `${ids.taskId} ${ids.agentId}`,
    exitCode: 0,
  };
}
