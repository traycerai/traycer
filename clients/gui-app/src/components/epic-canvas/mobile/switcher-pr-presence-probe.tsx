import { usePrPresenceProbe } from "@/hooks/pr/use-pr-presence-probe";

interface SwitcherPrPresenceProbeProps {
  readonly epicId: string;
  readonly hostId: string | null;
}

/**
 * The category is presence-gated like the desktop rail icon, but presence is written only by the PR panel body - and on a phone the switcher tab is the ONLY thing that mounts that body.
 * Without a bootstrap the two gate each other: a device that has never opened this epic's PR panel has no presence, so no tab, so the body never mounts to record any.
 */
export function SwitcherPrPresenceProbe(props: SwitcherPrPresenceProbeProps) {
  usePrPresenceProbe({
    hostId: props.hostId,
    epicId: props.epicId,
    enabled: true,
  });
  return null;
}
