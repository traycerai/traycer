import { useMemo } from "react";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The runtime binding a host-scoped panel re-provides so every hook beneath it
 * targets the host the page is SHOWING rather than a spine that names none.
 *
 * THE ONE implementation FOR A `HostScope`, with two governed exceptions. It
 * used to claim to be the only one anywhere — `providers-settings-panel.tsx`
 * had carried a byte-equivalent copy inline — and that claim was false when it
 * was written, which is worse than no claim: an audit that trusted it missed
 * two live copies. The honest list, and why each is legitimate:
 *
 *   - `agent-selection-guide-section.tsx` re-provides on `ready` ONLY, with no
 *     `following` arm. A deliberate narrowing, not an oversight: its gate holds
 *     non-usable children in a hidden `<Activity>`, so it needs no third state.
 *   - `provider-reauth-banner.tsx` is TAB-bound, not scope-bound — its client is
 *     `useTabHostClient()` and its host `useTabHostId()`. It has no `HostScope`
 *     to hand this hook, so it structurally cannot use it.
 *
 * SEVEN surfaces re-provide `HostRuntimeContext` in total: the five panels
 * through this hook (`rate-limit-icon`, `shell`, `diagnostics`, `providers`,
 * `host`) plus those two. Anything reading `useHostClient()` /
 * `useAddressableHostId()` beneath any of them gets that surface's host.
 *
 * ⚠ A RE-PROVIDER MUST NOT WRAP A SURFACE CONTAINING THE MIC PATH.
 * `useDictationAvailability` reads `useHostClient()` and is app-wide BY DESIGN
 * (see its own doc and `AGENTS.md`): `speech.dictate` streams live microphone
 * audio, so pointing it at a pinned host ships a user's voice to a machine they
 * only picked to administer. Today it is safe only because no re-provider
 * happens to sit above a composer — a positional fact, not an invariant, which
 * is why it is written down here where the eighth re-provider gets added.
 *
 * ⚠ AND THE RULE BINDS `StreamRuntimeContext` AT LEAST AS HARD, which this
 * note used to imply it did not by naming only the unary provider.
 * `useDictationAvailability` (`speech.ensureModel`) is the unary half; the
 * AUDIO itself goes through `useVoiceDictation`, which reads
 * `useWsStreamClient()`. So the stream context is literally the transport a
 * user's microphone rides, and a stream re-provider above a composer is the
 * voice-to-the-wrong-machine outcome directly rather than by implication.
 * That population is no longer a single surface: `resource-monitor-popover`
 * was the only stream re-provider, and the epic sidebar's file tree and git
 * diff panel are now two more. All three are file/diff browsers containing no
 * composer, which is what keeps this safe — again positionally, not
 * structurally.
 *
 * Three arms, and which one you are in is the whole question:
 *
 *   - `status === "ready"` with an explicit pick re-provides `scope.client`.
 *     That client addresses the host the page names, which is what stops one
 *     host's data rendering under another host's name.
 *   - `connecting`, `unreachable` and `vanished` return null. They have no
 *     client at all, re-providing a null one would make `useHostClient()`
 *     throw, and falling back to the ambient host is the substitution above.
 *     The panels gate those states rather than render through them.
 *   - `following` NOW RE-PROVIDES TOO, and it did not used to. The old comment
 *     said the ambient binding already IS the scoped host's — true while a
 *     privileged bound host existed, and false the moment redesign P4.2
 *     deleted the active slot. The ambient binding's `hostClient` is the
 *     window's spine: it owns the messenger, coordinator and request context,
 *     and it deliberately addresses NO host, so a panel left beneath it would
 *     resolve every read against nothing.
 *
 * The `following` client is NOT re-derived here. `use-host-scope.ts` already
 * answers it — `client: status === "following" ? ambientClient : overrideClient`,
 * where `ambientClient` is `useHostClient()`, the effective host's own
 * requester. Re-deriving it in this hook would put a second decider behind the
 * same question, which is the defect the whole selection layer is being
 * rebuilt to remove. All this hook decides now is WHETHER to re-provide.
 *
 * NAMED BEHAVIOR PROPERTY of that third arm: a `following` subtree now
 * re-renders when the effective host moves, where before it re-rendered only
 * when the ambient binding itself changed. That is the point rather than a
 * cost — a following panel must re-point when the host it follows moves — and
 * it is semantics-preserving today, because today the ambient binding IS the
 * effective host's. It becomes load-bearing after the slot is gone.
 *
 * `hostId` IS THE FIELD THAT MAKES ANY OF THIS TRUE, and TypeScript cannot make
 * you set it here. The return below is a SPREAD into a declared return type, so
 * `...realBinding` already satisfies the required field with the app-wide
 * binding's `null` — the tree compiles clean while every panel silently falls
 * back to the ambient host, which is precisely the defect this closes. Nothing
 * but a test can hold this line: `window-host-client-resolution.test.tsx`
 * renders this hook and asserts the REQUEST lands on the scoped host. Delete
 * either `hostId:` below and it reddens; that is the only guard there is.
 */
export function useScopedHostBinding(
  scope: HostScope,
): HostRuntimeBinding<HostRpcRegistry> | null {
  const realBinding = useHostBinding();
  return useMemo(() => {
    if (realBinding === null) return null;
    // Fail closed on the status FIRST. `scope.client` is already null for
    // `connecting`/`unreachable`/`vanished`, but that is a guarantee made
    // upstream, and this is the boundary where re-providing the wrong client
    // renders one host's data under another host's name.
    if (scope.status !== "ready" && scope.status !== "following") return null;
    if (scope.client === null) return null;
    // `following` NAMES NO HOST on purpose: the subtree is meant to track the
    // app-wide effective host, so it must fall through to the same resolution
    // every ambient consumer uses and re-point when that moves. Naming
    // `scope.hostId` here would pin the panel to whichever host was effective
    // when it mounted — auto-follow, silently deleted.
    if (scope.status === "following") {
      return { ...realBinding, hostClient: scope.client, hostId: null };
    }
    // `ready` guarantees a host: `deriveHostScopeStatus` returns before `ready`
    // whenever `host === null`, and `scope.hostId` is `host?.hostId`.
    return { ...realBinding, hostClient: scope.client, hostId: scope.hostId };
  }, [scope.status, scope.hostId, scope.client, realBinding]);
}
