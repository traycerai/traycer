import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  UpdateChatRunSettingsRequest,
  UpdateChatRunSettingsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { appLogger } from "@/lib/logger";

type UpdateChatRunSettingsMutateAsync = (
  params: UpdateChatRunSettingsRequest,
) => Promise<UpdateChatRunSettingsResponse>;

// Module-scoped (not per-component) so every writer of a given chat's
// durable settings - the chat's own composer AND a sibling task-wide switch -
// funnels through the SAME per-chatId chain. `WsRpcClient.request()` opens a
// fresh connection per call with no ordering guarantee across concurrent
// requests, so independent fire-and-forget writes for the same chat could
// let an older write's response land after a newer one and pin the chat to
// stale settings.
//
// Each chatId's entry is removed once its chain settles (see the cleanup in
// `enqueuePersistChatRunSettings`) - otherwise every chat ever touched over
// the app's lifetime would accumulate here with no bound.
const chains = new Map<string, Promise<void>>();
const pending = new Map<string, UpdateChatRunSettingsRequest>();

/** Test-only: number of chats with a chain currently tracked (idle chats are
 *  removed once their chain settles - see the module comment above). */
export function __chainCountForTests(): number {
  return chains.size;
}

/**
 * Enqueues a durable `epic.updateChatRunSettings` write for `chatId`,
 * serialized behind any write already in flight for that chat (never two
 * requests for the same chat at once) and collapsed to the latest settings
 * if further calls land while one is pending - a rapid burst of composer
 * changes only ends up sending the final value.
 *
 * Best-effort: an old host rejects the optional method with
 * `E_HOST_UNSUPPORTED`, which callers treat as "legacy behavior: settings
 * persist on next send" and is swallowed silently. Any other failure is
 * logged at this transport boundary instead of vanishing.
 */
export function enqueuePersistChatRunSettings(
  mutateAsync: UpdateChatRunSettingsMutateAsync,
  request: UpdateChatRunSettingsRequest,
): void {
  const { chatId } = request;
  pending.set(chatId, request);
  const prior = chains.get(chatId) ?? Promise.resolve();
  const next: Promise<void> = prior
    .then(() => runPendingWrite(mutateAsync, chatId))
    .then(() => {
      // Only this chatId's OWN (latest) link may clear the entry - if a
      // newer write was already enqueued (and so already replaced this
      // entry with its own chain) before this link finished, deleting here
      // would drop that newer, still-pending chain instead of an idle one.
      if (chains.get(chatId) === next) {
        chains.delete(chatId);
      }
    });
  chains.set(chatId, next);
}

/**
 * Never rejects: a rejected link in a chat's chain would permanently starve
 * every future write queued behind it (`.then()` on a rejected promise skips
 * its handler and just re-throws), so every failure mode - `mutateAsync`
 * rejecting OR throwing synchronously, or even `appLogger.error` itself
 * throwing - is contained here rather than escaping to `chains`.
 */
async function runPendingWrite(
  mutateAsync: UpdateChatRunSettingsMutateAsync,
  chatId: string,
): Promise<void> {
  const latest = pending.get(chatId);
  if (latest === undefined) return;
  pending.delete(chatId);
  try {
    await mutateAsync(latest);
  } catch (error) {
    if (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED") {
      return;
    }
    try {
      appLogger.error(
        "Failed to persist chat run settings",
        { chatId, epicId: latest.epicId },
        error,
      );
    } catch {
      // Logging itself must not poison the chain either.
    }
  }
}
