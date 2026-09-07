import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";

/** That is the right trade for these four and only these four. */
export const PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS = [
  "providers.installPackVersion",
  "providers.removePackVersion",
  "providers.usePackVersion",
  "providers.setPackPolicy",
] as const;

/** `null` only survives when no member is known absent, which keeps a first paint silent instead of flashing
 * "your host is too old" at a host that supports it perfectly. */
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
