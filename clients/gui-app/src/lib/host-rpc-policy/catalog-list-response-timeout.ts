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
 * accepts, plus 15 s for the probe to queue behind the host's catalog gate and
 * 15 s for transport, like `USAGE_SUMMARY_RESPONSE_TIMEOUT_MS`. A host that
 * answers sooner settles the request sooner; the allowance only stops the
 * transport from giving up first.
 */
export const CATALOG_LIST_RESPONSE_TIMEOUT_MS =
  CATALOG_PROBE_TIMEOUT_MAX_SECONDS * 1_000 + 30_000;
