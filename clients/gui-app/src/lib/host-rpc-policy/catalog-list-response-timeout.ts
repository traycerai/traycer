import { CATALOG_PROBE_TIMEOUT_MAX_SECONDS } from "@traycer/protocol/config/schema";

/**
 * Response allowance for `agent.gui.listModels` / `agent.gui.listCommands`.
 *
 * The host bounds one catalog probe by the user's Model list timeout
 * (`catalog.probeTimeoutSeconds`, at most `CATALOG_PROBE_TIMEOUT_MAX_SECONDS`)
 * and answers when it settles. Without an allowance the request rides the
 * ordinary unary deadline - 30 s on a remote session - which fails a picker
 * before the host's own bound (60 s by default) can, so the setting would
 * govern nothing over a remote link. This covers the longest bound the host
 * accepts plus 30 s of slack for a short wait behind the host's catalog gate
 * and for transport. A host that answers sooner settles the request sooner;
 * the allowance only stops the transport from giving up first.
 *
 * It does not cover an unbounded gate queue. The host's per-probe bound
 * starts once a probe is admitted to one of its four catalog slots, so a read
 * queued behind four probes each wedged for the full bound can still outlast
 * this allowance - as it outlasted the ordinary deadline before. Its answer is
 * still cached host-side when it lands, so the next read serves it.
 *
 * It is built from this client's `CATALOG_PROBE_TIMEOUT_MAX_SECONDS`, while
 * the host sends its own bounds. A host release that raises that maximum must
 * raise this allowance in the same release; a GUI released before it keeps
 * 210 s, so on such a host a remote read with a longer stored timeout can
 * still be cut at 210 s.
 */
export const CATALOG_LIST_RESPONSE_TIMEOUT_MS =
  CATALOG_PROBE_TIMEOUT_MAX_SECONDS * 1_000 + 30_000;
