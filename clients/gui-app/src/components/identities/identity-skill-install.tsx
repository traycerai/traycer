/**
 * "Install skill" for the identity tab: opens the skill composer pointed at
 * THIS identity's `skills/` folder, over the tab's own host.
 *
 * The composer is the provider Skills tab's dialog with its target selector
 * listing this host's identities; this one is preselected. The host answers
 * an import only once its projection holds the files, so the new rows are on
 * the index lane by the time the dialog closes, and the installed skill's
 * `SKILL.md` is opened in the body.
 *
 * Hidden on a host that does not advertise the installer.
 */
import { useState, type ReactNode } from "react";
import { PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ProviderSkillComposerDialog } from "@/components/settings/panels/provider-skill-composer-dialog";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useIdentitySkillTargets } from "@/hooks/identities/use-identity-skill-targets";
import { useOpenIdentityState } from "@/lib/identity-selectors";

const SKILL_MD_SUFFIX = "/SKILL.md";

export function IdentitySkillInstallButton(props: {
  readonly identityId: string;
  readonly disabled: boolean;
  /** Opens a file the install wrote. */
  readonly onInstalled: (path: string) => void;
}): ReactNode {
  const { identityId, disabled, onInstalled } = props;
  const hostId = useTabHostId();
  const client = useTabHostClient();
  const title = useOpenIdentityState((state) => state.identity?.title ?? null);
  const [open, setOpen] = useState(false);
  const skillTargets = useIdentitySkillTargets({
    client,
    hostId,
    enabled: open,
    pinned: {
      identityId,
      title: title !== null && title.length > 0 ? title : "This identity",
    },
    onImported: (targetId, paths) => {
      if (targetId !== identityId) return;
      const skillMd = paths.find((path) => path.endsWith(SKILL_MD_SUFFIX));
      if (skillMd !== undefined) onInstalled(skillMd);
    },
  });

  if (!skillTargets.supported) return null;

  return (
    <>
      <TooltipWrapper
        label="Install skill"
        side="bottom"
        sideOffset={4}
        align={undefined}
      >
        <Button
          type="button"
          variant="muted"
          size="icon-sm"
          aria-label="Install skill"
          data-testid="identity-install-skill"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <PackagePlus className="size-3.5" />
        </Button>
      </TooltipWrapper>
      {open ? (
        <ProviderSkillComposerDialog
          provider={null}
          identities={skillTargets.targets}
          initialTarget={{ kind: "identity", identityId }}
          pending={skillTargets.pending}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
