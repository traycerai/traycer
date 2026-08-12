import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";

/**
 * Every optional method the version-manager panel's controls call.
 *
 * The handshake negotiates support PER METHOD, so one member cannot stand in
 * for the other three. It used to: the panel gated on `usePackVersion` alone,
 * reasoning that a host either has the whole surface or none of it. That holds
 * for the hosts that exist today, but nothing enforces it - a host advertising
 * a strict subset would light up controls whose calls deterministically return
 * unsupported-method.
 *
 * All four are required rather than gated per control. The panel is one
 * surface: a version list you cannot download into, or can download into but
 * not switch to, is not a degraded version manager, it is a broken one.
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
