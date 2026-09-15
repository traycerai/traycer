import type { AutoJudgeKind } from "@traycer/protocol/host/auto-mode/contracts";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

/**
 * Which classifier decides this provider's `auto`-mode approvals, as the host
 * has it stored.
 *
 * THE ONE READ SEAM for that value. `ProviderCliState.autoJudge` is
 * `.optional()` on the wire rather than defaulted, deliberately (see its own
 * comment): a host that predates auto mode omits the key, and absent has to
 * stay distinguishable from a stored value at the protocol boundary. Spelling
 * the fallback once, here, is the other half of that decision - every reader
 * getting it right individually is not a thing a type can enforce.
 *
 * `"traycer"` is the answer for two situations that want identical treatment:
 * nothing was ever chosen (the host's own default in
 * `provider-overrides.json`), and the host is too old to have the notion. Both
 * land on Traycer's judge, the same direction every failure mode in the host's
 * own reader takes, because the other direction would tell a user their actions
 * are being reviewed by a provider classifier that is not in the loop.
 */
export function providerAutoJudgeFor(state: ProviderCliState): AutoJudgeKind {
  return state.autoJudge ?? "traycer";
}
