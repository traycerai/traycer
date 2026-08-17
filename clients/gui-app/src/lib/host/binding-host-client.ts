import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * The ONE home for "given a runtime binding, which host client does it mean".
 *
 * Ten call sites used to spell this inline, character for character
 * (`binding === null ? null : binding.hostClient.createRequesterForHostId(id)`),
 * and every one of them was the same bug: the CLIENT came from the binding
 * while the NAME came from `useEffectiveHostId()` beside it, so a subtree that
 * re-provided a pinned client had it immediately rebuilt for the ambient host.
 * A copied idiom also guarantees the eleventh copy, which is why the decision
 * lives here rather than being fixed ten times.
 *
 * PURE FUNCTIONS, NOT HOOKS, and that is deliberate rather than stylistic. A
 * hook would have to call `useHostBinding()` itself, which moves that call out
 * of the consumer and into this module - and roughly forty suites inject their
 * binding by overriding `useHostBinding` on `@/lib/host` or `@/lib/host/runtime`.
 * A hook here reads the module-local import instead of the consumer's, so every
 * one of those injections is silently bypassed: the suite's binding is ignored,
 * the real hook answers `null` outside a provider, and the test fails as a
 * missing RPC rather than as a wiring error. Taking the binding as an ARGUMENT
 * keeps the read at the call site, where the suite's override still reaches it.
 */

/**
 * The client for THIS SUBTREE.
 *
 * A binding that NAMES a host has already answered the question - that is a
 * re-provided (host-scoped) binding, and `hostClient` is the pinned client. Only
 * the app-wide binding names none, and only then does the selection layer's
 * effective host decide.
 *
 * The ORDER is the whole fix. Composing it the other way - take the binding's
 * client, then resolve the ambient name against it - is what shipped, and it
 * silently discarded the pin: `createRequesterForHostId` is not one of the six
 * members `createPinnedRequester` intercepts, so calling it on a pinned client
 * falls through `Reflect.get` to the spine. Every host-scoped panel in the app
 * re-provided a client that was then thrown away.
 *
 * `typeof === "string"`, NOT `!== null`: a `vi.mock` factory's return is not
 * checked against `HostRuntimeBinding`, so a mock written before `hostId`
 * existed supplies `undefined` - which `!== null` would read as "this binding
 * names a host" and pin the subtree to a name that is not one. A string is the
 * only thing that names a host; anything else falls through to the app-wide
 * resolution these callers had before.
 */
export function resolveSubtreeHostClient(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  effectiveHostId: string | null,
): HostClient<HostRpcRegistry> | null {
  if (binding === null) {
    return null;
  }
  if (typeof binding.hostId === "string") {
    return binding.hostClient;
  }
  return binding.hostClient.createRequesterForHostId(effectiveHostId);
}

/**
 * The APP-WIDE host, DELIBERATELY, whatever subtree the caller is in.
 *
 * Separate from {@link resolveSubtreeHostClient} because the callers are
 * separate: several consumers are app-wide by intent, not by accident, and
 * before this they were spelled identically to the ones that were simply wrong.
 * Reading a call site could not tell you which. Now it can, and a future copy
 * of the raw idiom has nowhere to hide.
 *
 * Correct even beneath a re-provided binding, and only because of the same
 * unintercepted fall-through described above: called on a pinned client,
 * `createRequesterForHostId` reaches the spine and resolves the ambient host
 * from there. That fall-through is the DEFECT in the pinned case and the
 * MECHANISM in this one. Do not "fix" one without the other.
 */
export function resolveAppWideHostClient(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  effectiveHostId: string | null,
): HostClient<HostRpcRegistry> | null {
  if (binding === null) {
    return null;
  }
  return binding.hostClient.createRequesterForHostId(effectiveHostId);
}
