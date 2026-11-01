import { hostRowTitle } from "@/components/settings/host-scope/host-option-model";
import { findHostOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { UNNAMED_HOST_LABEL } from "@/lib/host/host-name";
import { stageFallbackHostLine } from "@/lib/sandboxes/sandbox-strings";

/**
 * The action that takes a stage off a composer, named for `hostId`, the host
 * its chip falls back to, in the words that chip uses.
 */
export function useStageFallbackHostLine(hostId: string | null): string {
  const { hosts } = useHostOptions();
  const host = findHostOption(hosts, hostId);
  const title = host === null ? null : hostRowTitle(host, true);
  return stageFallbackHostLine(title === UNNAMED_HOST_LABEL ? null : title);
}
