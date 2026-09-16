import type { SchemaVersion } from "@traycer/protocol/framework/index";
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

/**
 * The `providers.list` line that PUBLISHES `autoJudge`.
 *
 * `providers.setAutoJudge` writes the value and `providers.list@9.1` is its
 * only carrier back ("nothing read it back, so the Providers > General switch
 * could not show its own stored state after a reload"). A `9.0` response is a
 * within-major re-parse that strips the key.
 */
const PROVIDERS_LIST_AUTO_JUDGE_MINOR = 1;
const PROVIDERS_LIST_AUTO_JUDGE_MAJOR = 9;

/**
 * Whether this negotiated `providers.list` line can report the stored judge.
 *
 * The version half of {@link providerAutoJudgeFor}, and it lives beside it for
 * the reason that function gives for existing at all: absent `autoJudge` means
 * two different things, and only the negotiated line tells them apart. On `9.1`
 * an absent key is "nothing was ever chosen" and `"traycer"` is the right
 * answer. On `9.0` it is "this line cannot say", and `"traycer"` is a GUESS -
 * one the host may contradict, because `providers.setAutoJudge` is a separate
 * optional method a `9.0` host can still advertise. A caller that would act on
 * the difference has to ask this first.
 *
 * The major is pinned rather than compared with `>`, the way every other
 * version predicate in the tree pins its own: a `10.0` line is a new contract
 * whose relationship to this field is not knowable from here, and reading it as
 * "newer, therefore carries it" is the inference that gets version gates wrong.
 * A `10.x` will need a line here.
 *
 * `null` - no handshake yet - reads as NOT reporting, the safe direction: it
 * withholds a claim rather than making one from a line nobody has negotiated.
 */
export function providersListReportsAutoJudge(
  version: SchemaVersion | null,
): boolean {
  return (
    version !== null &&
    version.major === PROVIDERS_LIST_AUTO_JUDGE_MAJOR &&
    version.minor >= PROVIDERS_LIST_AUTO_JUDGE_MINOR
  );
}
