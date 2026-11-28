import { useContext, type ReactNode } from "react";
import { HOST_KIND_WORDS } from "@traycer/protocol/host/host-status";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import {
  useHostScope,
  type SettingsHostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { SettingsSectionContext } from "@/components/settings/settings-section-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/** The scope a phone's section page keeps visible after its pickers disappear. */
export function SettingsPhoneScopeLine(): ReactNode {
  const section = useContext(SettingsSectionContext);
  const mobile = useIsMobileViewport();
  const group = SETTINGS_SECTIONS.find((entry) => entry.id === section)?.group;
  if (!mobile || (group !== "host" && group !== "personal")) return null;
  return group === "host" ? (
    <PhoneHostScopeLine />
  ) : (
    <PhoneScopeLine prefix host={null} />
  );
}

/**
 * A Host page's line. A host Settings shows from its account row has no
 * environment known to run it, so the line names the host alone.
 */
function PhoneHostScopeLine(): ReactNode {
  const scope = useHostScope();
  return (
    <PhoneScopeLine
      prefix={!scope.shownFromRow}
      host={
        <PhoneHostScope
          scope={scope}
          separator={scope.shownFromRow ? "" : " › "}
        />
      }
    />
  );
}

/** `prefix` only hides the environment; its reads stay mounted either way. */
function PhoneScopeLine(props: {
  readonly prefix: boolean;
  readonly host: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  const teamLabel = usePickedTeamLabel(
    pick.kind === "team" ? pick.environmentId : "",
  );
  let environment: ReactNode = "Personal";
  if (pick.kind === "unresolved") {
    environment = (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  } else if (pick.kind === "local") {
    environment = pick.hostName;
  } else if (pick.kind === "team") {
    environment = teamLabel ?? (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  return (
    <p
      className="text-ui-xs text-muted-foreground wrap-anywhere"
      data-testid="settings-phone-scope-line"
    >
      {props.prefix ? environment : null}
      {props.host}
    </p>
  );
}

function PhoneHostScope(props: {
  readonly scope: SettingsHostScope;
  readonly separator: string;
}): ReactNode {
  const { scope } = props;
  if (scope.host === null) {
    const label =
      scope.vanishedSelection === null
        ? scope.hostLabel
        : `${scope.vanishedSelection.name} is no longer here.`;
    return (
      <>
        {props.separator}
        {label}
      </>
    );
  }
  return (
    <>
      {props.separator}
      {scope.host.name}
      {scope.host.kind === null
        ? null
        : ` · ${HOST_KIND_WORDS[scope.host.kind]}`}
    </>
  );
}
