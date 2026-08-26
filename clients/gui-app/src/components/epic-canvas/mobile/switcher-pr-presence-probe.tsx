import { usePrPresenceProbe } from "@/hooks/pr/use-pr-presence-probe";

interface SwitcherPrPresenceProbeProps {
  readonly epicId: string;
  readonly hostId: string | null;
}

/**
 * Bootstraps the switcher's Pull requests category. Renders nothing.
 *
 * The category is presence-gated like the desktop rail icon, but presence is
 * written only by the PR panel body - and on a phone the switcher tab is the
 * ONLY thing that mounts that body. Without a bootstrap the two gate each
 * other: a device that has never opened this epic's PR panel has no presence,
 * so no tab, so the body never mounts to record any. The rail escapes that
 * through its context menu ("No PRs yet" force-visible); the sheet has no
 * equivalent affordance, so it answers the question itself.
 *
 * Mounted inside the drawer content, so it lives exactly as long as an OPEN
 * sheet - opening an epic still costs no PR traffic, and the probe shares the
 * panel's session whenever the Pull requests category is the one showing.
 */
export function SwitcherPrPresenceProbe(props: SwitcherPrPresenceProbeProps) {
  usePrPresenceProbe({
    hostId: props.hostId,
    epicId: props.epicId,
    enabled: true,
  });
  return null;
}
