import type { ReactNode } from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
import { useConfigurationIsPersonal } from "./configuration-source";
import { useConfigurationName } from "./team-pick-label";

/**
 * A team's name on one line. Hover names the full team once the line
 * overflows. Personal is the word itself, not this span.
 */
export function ConfigurationTeamName(props: {
  readonly name: string;
}): ReactNode {
  const { ref, isTruncated } = useIsTextTruncated<HTMLSpanElement>(props.name);
  return (
    <TooltipWrapper
      label={isTruncated ? props.name : null}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span ref={ref} className="inline-block max-w-full truncate align-bottom">
        {props.name}
      </span>
    </TooltipWrapper>
  );
}

/** Variables and shells: whose plain values and shell this page sets. */
export function VariablesIntroduction(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  if (personal) {
    return "Plain values every computer and sandbox running Personal gets, and the shell agents run in.";
  }
  return (
    <>
      {"Plain values every host running "}
      <ConfigurationTeamName name={name} />
      {" gets, and the shell agents run in."}
    </>
  );
}

/** MCP servers: whose servers reach every provider. */
export function McpIntroduction(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  if (personal) {
    return "Tools agents can call. Personal's servers reach every provider on every computer and sandbox running Personal.";
  }
  return (
    <>
      {"Tools agents can call. "}
      <ConfigurationTeamName name={name} />
      {"'s servers reach every provider on its hosts."}
    </>
  );
}

/** Skills: whose skills reach every provider. */
export function SkillsIntroduction(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  if (personal) {
    return "Instructions agents follow for a kind of task. Personal's skills reach every provider on every computer and sandbox running Personal.";
  }
  return (
    <>
      {"Instructions agents follow for a kind of task. "}
      <ConfigurationTeamName name={name} />
      {"'s skills reach every provider on its hosts."}
    </>
  );
}
