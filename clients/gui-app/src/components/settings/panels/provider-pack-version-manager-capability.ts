import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";

/**
 * The optional methods the WHOLE PANEL requires - all four or none.
 *
 * Membership is a claim that the panel is worthless without the method, because
 * a missing member takes the entire version manager off screen and replaces it
 * with the "host too old" branch. That is the right trade for these four and
 * only these four: the panel is one surface, and a version list you cannot
 * download into, or can download into but not switch to, is not a degraded
 * version manager, it is a broken one.
 *
 * The handshake negotiates support PER METHOD, so one member cannot stand in
 * for the other three. It used to: the panel gated on `usePackVersion` alone,
 * reasoning that a host either has the whole surface or none of it. That holds
 * for the hosts that exist today, but nothing enforces it - a host advertising
 * a strict subset would light up controls whose calls deterministically return
 * unsupported-method.
 *
 * NOT every optional method the panel calls, and the difference matters.
 * `providers.refreshPackDiscovery` is a deliberate NON-MEMBER: it backs one
 * button in the footer, so a host that has these four and not that one must
 * keep its version manager and lose the button. Adding it here to "fix the
 * omission" would collapse the whole panel to the unsupported branch on every
 * such host. The panel gates that button on its own, with
 * `useHostSupportsMethod`, precisely so it can hide alone. Any future
 * single-control method belongs there too, not in this array.
 */
export const PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS = [
  "providers.installPackVersion",
  "providers.removePackVersion",
  "providers.usePackVersion",
  "providers.setPackPolicy",
] as const;

/**
 * Three-valued support for the version manager as a whole.
 *
 * `false` (a host answered and lacks a method) outranks `null` (nothing known
 * yet), because a known-absent member is a decided answer about the surface
 * while an unanswered sibling is not. `null` only survives when no member is
 * known absent, which keeps a first paint silent instead of flashing "your
 * host is too old" at a host that supports it perfectly.
 *
 * Deliberately NOT `useHostSupportsMethod`: that form collapses "not answered
 * yet" into `false`, which is safe for a surface that merely hides itself and
 * wrong for one that renders a reason.
 *
 * Called unconditionally, one hook per method, so the hook order is fixed.
 *
 * Lives beside the panel rather than inside it because a component module that
 * also exports hooks and constants loses fast refresh
 * (`react-refresh/only-export-components`).
 */
export function useProviderPackVersionManagerSupport(
  hostId: string | null,
): boolean | null {
  const install = useHostMethodSupport(hostId, "providers.installPackVersion");
  const remove = useHostMethodSupport(hostId, "providers.removePackVersion");
  const use = useHostMethodSupport(hostId, "providers.usePackVersion");
  const policy = useHostMethodSupport(hostId, "providers.setPackPolicy");
  const answers = [install, remove, use, policy];
  if (answers.includes(false)) return false;
  if (answers.includes(null)) return null;
  return true;
}
