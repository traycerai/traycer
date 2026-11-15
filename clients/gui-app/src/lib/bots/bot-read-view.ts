import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  lastingHostRefusal,
  type LastingHostRefusal,
} from "@/lib/host/lasting-host-refusal";
import { isTransientCloudFailure } from "@/lib/host/transient-cloud-failure";

/**
 * Why a bot read failed, as what the person can do about it:
 * - `reconnecting`: the host could not reach the cloud; its cloud-recovery
 *   doorbell asks again when it can.
 * - `host-not-answering`: Traycer on the computer serving the bot did not
 *   answer; the host's availability sweep asks again when it does.
 * - a lasting refusal (`lastingHostRefusal`): signed out, no access, or a host
 *   that cannot serve the bot.
 * - `server`: anything else the host answered with.
 */
export type BotReadFailureKind =
  | "reconnecting"
  | "host-not-answering"
  | LastingHostRefusal
  | "server";

/** A failure whose read keeps what it last showed, under a line saying so. */
export type BotReadStaleKind = "reconnecting" | "host-not-answering" | "server";

export function botReadFailureKind(error: unknown): BotReadFailureKind {
  if (isTransientCloudFailure(error)) return "reconnecting";
  if (error instanceof HostTransportFailureError) return "host-not-answering";
  return lastingHostRefusal(error) ?? "server";
}

/**
 * What a bot read draws:
 * - `ok`: its answer, or nothing yet.
 * - `stale`: its last answer, kept under a line saying why it may be out of
 *   date and when it loaded.
 * - `failed`: the failure in place of the rows, because there are none to
 *   keep, or because the person must stop seeing them (signed out, no
 *   access) or no re-ask can bring them back (a host that cannot serve the
 *   bot).
 */
export type BotReadView =
  | { readonly kind: "ok" }
  | {
      readonly kind: "stale";
      readonly failure: BotReadStaleKind;
      /** When the kept answer loaded. */
      readonly loadedAt: number;
    }
  | { readonly kind: "failed"; readonly failure: BotReadFailureKind };

/** A read view with a failure to say. */
export type BotReadFailing = Exclude<BotReadView, { readonly kind: "ok" }>;

const OK: BotReadView = { kind: "ok" };

export function botReadView(read: {
  readonly isError: boolean;
  readonly data: unknown;
  readonly error: unknown;
  readonly dataUpdatedAt: number;
}): BotReadView {
  if (!read.isError) return OK;
  const failure = botReadFailureKind(read.error);
  if (read.data === undefined || hidesRows(failure)) {
    return { kind: "failed", failure };
  }
  return { kind: "stale", failure, loadedAt: read.dataUpdatedAt };
}

/**
 * Whether a failure takes away rows already loaded: the person must stop
 * seeing them (signed out, no access), or no re-ask can bring them back.
 */
export function hidesRows(
  failure: BotReadFailureKind,
): failure is LastingHostRefusal {
  return (
    failure === "signed-out" ||
    failure === "access-refused" ||
    failure === "cannot-serve"
  );
}

/** The failure a stale view's line says; `null` for any other view. */
export function staleFailureOf(view: BotReadView): BotReadStaleKind | null {
  return view.kind === "stale" ? view.failure : null;
}

/**
 * Whether the box holds its message, the draft kept, while a read fails this
 * way: a send would be refused before it left (`reconnecting`) or would only
 * time out with no word whether it arrived (`host-not-answering`). The one
 * place a change to how sends wait through a cloud drop belongs.
 */
export function sendWaitsOn(view: BotReadView): boolean {
  return (
    view.kind !== "ok" &&
    (view.failure === "reconnecting" || view.failure === "host-not-answering")
  );
}
