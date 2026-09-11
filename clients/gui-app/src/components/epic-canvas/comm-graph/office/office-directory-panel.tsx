/**
 * WHO IS IN THIS OFFICE, as a list.
 *
 * The floor is the readable rendering right up until the point where it is
 * not: at three hundred agents a character is a few pixels, and finding one
 * person by looking is no longer possible. This panel is the other half of
 * that answer - the same population the plan seats, grouped the same way, with
 * a click that takes the camera to whoever you name. It reads the SEAT BOOK
 * through `scene.locate`, not the last frame, so it can point at somebody
 * nowhere near the viewport.
 *
 * SAME PARTITION AS THE PLAN. Rows come from `OfficePopulation` and
 * `statusById`, which is what the layout, the boards and the accents are all
 * built from - so the directory cannot disagree with the floor about who leads
 * what. Team identity is read off `member.teamId`, never a roster lookup: a
 * member stranded on another host still carries its team's colour, and the
 * roster it names may no longer exist.
 */
import { useCallback, useMemo, useState } from "react";
import { PanelLeftClose, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { normalizeCommGraphFindText } from "@/components/epic-canvas/comm-graph/comm-graph-find-adapter";
import { officePipColor } from "@/components/epic-canvas/comm-graph/office/office-pip-color";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeFloorName } from "@/lib/comm-graph/office/office-floor-name";
import { officePalette } from "@/lib/comm-graph/office/office-pixel-art";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import type {
  OfficePopulation,
  OfficeTeam,
} from "@/lib/comm-graph/office/office-population";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";

/** How many pips a row shows before it starts counting instead. */
const MAX_ROW_PIPS = 5;

/**
 * Hottest first. The order is the one the rest of the office already sorts by
 * - somebody waiting on a person outranks somebody merely busy - and a team is
 * as hot as its hottest member.
 */
const STATUS_RANK: Readonly<Record<OfficeAgentStatus, number>> = {
  attention: 0,
  failure: 1,
  working: 2,
  awaiting: 3,
  background: 4,
  idle: 5,
  archived: 6,
};

/**
 * One word per status. Deliberately its own copy rather than the hover card's:
 * a pip's label is read out of context ("Reviewer, needs attention") where the
 * card's sits under a name that is already on screen.
 */
const STATUS_LABELS: Readonly<Record<OfficeAgentStatus, string>> = {
  failure: "crashed",
  attention: "needs attention",
  awaiting: "waiting for a reply",
  working: "working",
  background: "in background",
  idle: "idle",
  archived: "archived",
};

/** A status loud enough to be worth a mark as well as a colour. */
function statusGlyph(status: OfficeAgentStatus): string | null {
  if (status === "attention") return "!";
  if (status === "failure") return "×";
  return null;
}

interface DirectoryMember {
  readonly agentId: string;
  readonly name: string;
  readonly status: OfficeAgentStatus;
  /** The team whose accent this row wears, or `null` for nobody's. */
  readonly teamId: string | null;
}

interface DirectoryTeamRow {
  readonly teamId: string;
  readonly leadAgentId: string;
  readonly name: string;
  readonly rank: number;
  readonly members: ReadonlyArray<DirectoryMember>;
}

interface DirectorySection {
  /** Stable list identity; `hostId` is nullable and a key may not be. */
  readonly key: string;
  readonly hostId: string | null;
  readonly title: string;
  /**
   * The agent this floor is anchored on, where it is visible.
   *
   * It is a real agent at a real desk - counted in the footer, findable by
   * search - but it is in no team and no bullpen, so without a row of its own
   * the one agent that anchors each floor is the one nobody can browse to.
   */
  readonly hq: DirectoryMember | null;
  readonly teams: ReadonlyArray<DirectoryTeamRow>;
  /** Hot solos: the people with no team, at work right now. */
  readonly bullpen: ReadonlyArray<DirectoryMember>;
  readonly quietAgents: number;
  readonly quietTeams: number;
}

export interface OfficeDirectoryPanelProps {
  readonly partition: OfficePopulation;
  /**
   * Who exists AS OF THE CURSOR.
   *
   * The partition seats every agent the epic ever had, because the layout has
   * to keep a desk for somebody the cursor has not reached yet. What is on the
   * floor is the smaller set - so the list beside it is that set too, or
   * scrubbing back leaves rows pointing at empty desks and opening a panel
   * about an agent the rest of the tile says does not exist.
   */
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly selectedAgentId: string | null;
  /** Select the agent AND take the camera to it - one gesture, both halves. */
  readonly onSelectAgent: (agentId: string) => void;
  readonly onHoverAgent: (agentId: string | null) => void;
  readonly onClose: () => void;
}

function statusOf(
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
  agentId: string,
): OfficeAgentStatus {
  return statusById.get(agentId) ?? "idle";
}

function memberRow(args: {
  readonly agentId: string;
  readonly teamId: string | null;
  readonly nameById: ReadonlyMap<string, string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
}): DirectoryMember {
  return {
    agentId: args.agentId,
    name: args.nameById.get(args.agentId) ?? args.agentId,
    status: statusOf(args.statusById, args.agentId),
    teamId: args.teamId,
  };
}

function byHeat(a: DirectoryMember, b: DirectoryMember): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  return rank === 0 ? a.name.localeCompare(b.name) : rank;
}

function teamRow(args: {
  readonly team: OfficeTeam;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
}): DirectoryTeamRow {
  const members = args.team.memberAgentIds
    .filter((agentId) => args.visibleAgentIds.has(agentId))
    .map((agentId) =>
      memberRow({
        agentId,
        teamId: args.team.teamId,
        nameById: args.nameById,
        statusById: args.statusById,
      }),
    )
    .sort(byHeat);
  return {
    teamId: args.team.teamId,
    leadAgentId: args.team.leadAgentId,
    // A team is named by whoever leads it, which is the name on its door.
    name: args.nameById.get(args.team.leadAgentId) ?? args.team.leadAgentId,
    rank:
      members.length === 0 ? STATUS_RANK.idle : STATUS_RANK[members[0].status],
    members,
  };
}

/** The accent a row wears: the team's colour, as the painter derives it. */
function accentColor(teamId: string | null): string | undefined {
  if (teamId === null) return undefined;
  return agentAppearance(teamId, "chat", null).shirt;
}

function buildSections(args: {
  readonly partition: OfficePopulation;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly hostNameById: ReadonlyMap<string, string>;
}): ReadonlyArray<DirectorySection> {
  const sections = args.partition.hosts.map((host) => {
    const teams = host.teams
      .map((team) =>
        teamRow({
          team,
          visibleAgentIds: args.visibleAgentIds,
          nameById: args.nameById,
          statusById: args.statusById,
        }),
      )
      // A team nobody has been created into yet is not a team on this floor.
      .filter((team) => team.members.length > 0)
      .sort((a, b) =>
        a.rank === b.rank ? a.name.localeCompare(b.name) : a.rank - b.rank,
      );
    const solos = host.solos
      .filter((member) => args.visibleAgentIds.has(member.agentId))
      .map((member) =>
        memberRow({
          agentId: member.agentId,
          teamId: member.teamId,
          nameById: args.nameById,
          statusById: args.statusById,
        }),
      );
    const live = teams.filter((team) =>
      team.members.some((member) => isOfficeHotStatus(member.status)),
    );
    const hqId = host.hqAgentId;
    const hq =
      hqId === null || !args.visibleAgentIds.has(hqId)
        ? null
        : memberRow({
            agentId: hqId,
            teamId: args.partition.members.get(hqId)?.teamId ?? null,
            nameById: args.nameById,
            statusById: args.statusById,
          });
    return {
      key: host.hostId ?? "unattributed",
      hostId: host.hostId,
      title: officeFloorName(host.hostId, args.hostNameById),
      hq,
      teams: live,
      bullpen: solos
        .filter((member) => isOfficeHotStatus(member.status))
        .sort(byHeat),
      // Everyone this host is not currently drawing at a live desk: the cold
      // teams' members and the quiet solos, counted rather than listed.
      quietAgents:
        solos.filter((member) => !isOfficeHotStatus(member.status)).length +
        teams
          .filter((team) => !live.includes(team))
          .reduce((total, team) => total + team.members.length, 0),
      quietTeams: teams.length - live.length,
    };
  });
  // A floor the cursor has not populated yet is a heading over nothing. The
  // partition keeps the host because the LAYOUT still owes it a building; the
  // list is about who is in one.
  return sections.filter(
    (section) =>
      section.hq !== null ||
      section.teams.length > 0 ||
      section.bullpen.length > 0 ||
      section.quietAgents > 0,
  );
}

export function OfficeDirectoryPanel(props: OfficeDirectoryPanelProps) {
  const {
    hostNameById,
    nameById,
    onClose,
    onHoverAgent,
    onSelectAgent,
    partition,
    selectedAgentId,
    statusById,
    visibleAgentIds,
  } = props;
  const [query, setQuery] = useState("");
  const { resolvedTheme } = useResolvedTheme();
  const palette = useMemo(() => officePalette(resolvedTheme), [resolvedTheme]);

  const sections = useMemo(
    () =>
      buildSections({
        partition,
        visibleAgentIds,
        nameById,
        statusById,
        hostNameById,
      }),
    [hostNameById, nameById, partition, statusById, visibleAgentIds],
  );

  // Everyone on the floor right now, for the search and the footer - the
  // partition's own map, minus whoever the cursor has not reached. Searching
  // the full map would find agents the floor cannot show you.
  const everyone = useMemo<ReadonlyArray<DirectoryMember>>(
    () =>
      [...partition.members.values()]
        .filter((member) => visibleAgentIds.has(member.agentId))
        .map((member) =>
          memberRow({
            agentId: member.agentId,
            teamId: member.teamId,
            nameById,
            statusById,
          }),
        ),
    [nameById, partition.members, statusById, visibleAgentIds],
  );

  // The SAME normalisation tile Find uses, so a query that matches on the
  // floor matches here - case folding is a decision, not an incidental.
  const matches = useMemo<ReadonlyArray<DirectoryMember>>(() => {
    const needle = normalizeCommGraphFindText(query.trim(), false);
    if (needle.length === 0) return [];
    return everyone
      .filter((member) =>
        normalizeCommGraphFindText(member.name, false).includes(needle),
      )
      .sort(byHeat);
  }, [everyone, query]);

  const atWork = everyone.filter((member) =>
    isOfficeHotStatus(member.status),
  ).length;

  const renderPip = useCallback(
    (member: DirectoryMember) => (
      <button
        key={member.agentId}
        type="button"
        // The pip is the per-agent handle on a row that names a team: the row
        // itself goes to the lead, and these go to the people under them.
        aria-label={`${member.name}, ${STATUS_LABELS[member.status]}`}
        data-testid={`comm-graph-office-directory-pip-${member.agentId}`}
        className="relative size-3 shrink-0 rounded-xs leading-none"
        style={{ backgroundColor: officePipColor(member.status, palette) }}
        onClick={() => onSelectAgent(member.agentId)}
        onPointerEnter={() => onHoverAgent(member.agentId)}
        onPointerLeave={() => onHoverAgent(null)}
      >
        {/* Colour is never the only channel: the two statuses that mean "come
            and look" carry a mark as well. */}
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-background"
        >
          {statusGlyph(member.status)}
        </span>
      </button>
    ),
    [onHoverAgent, onSelectAgent, palette],
  );

  const renderAgentRow = useCallback(
    (member: DirectoryMember) => (
      <li key={member.agentId}>
        <button
          type="button"
          data-testid={`comm-graph-office-directory-agent-${member.agentId}`}
          aria-current={member.agentId === selectedAgentId}
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-xs",
            "hover:bg-foreground/8",
            member.agentId === selectedAgentId && "bg-foreground/8",
          )}
          onClick={() => onSelectAgent(member.agentId)}
          onPointerEnter={() => onHoverAgent(member.agentId)}
          onPointerLeave={() => onHoverAgent(null)}
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: officePipColor(member.status, palette) }}
          />
          <span className="min-w-0 flex-1 truncate">{member.name}</span>
          <span className="shrink-0 text-muted-foreground">
            {STATUS_LABELS[member.status]}
          </span>
        </button>
      </li>
    ),
    [onHoverAgent, onSelectAgent, palette, selectedAgentId],
  );

  return (
    <aside
      aria-label="Office directory"
      data-testid="comm-graph-office-directory"
      // Reserved space rather than an overlay: it is read WHILE the floor is
      // read, and a panel that covered the office would be answering one
      // question by hiding the other.
      className="flex h-full w-[min(30vw,15rem)] min-w-0 shrink-0 flex-col border-r border-border bg-background"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground/90">
          Directory
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Hide the directory"
          data-testid="comm-graph-office-directory-close"
          onClick={onClose}
        >
          <PanelLeftClose aria-hidden />
        </Button>
      </header>
      <div className="relative border-b border-border p-1.5">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Find someone in this office"
          data-testid="comm-graph-office-directory-search"
          placeholder="Find someone"
          className="h-7 pl-7 text-ui-xs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {query.trim().length > 0 ? (
          <ul className="flex flex-col">
            {matches.length === 0 ? (
              <li className="px-1.5 py-1 text-ui-xs text-muted-foreground">
                Nobody here by that name.
              </li>
            ) : (
              matches.map(renderAgentRow)
            )}
          </ul>
        ) : (
          sections.map((section) => (
            <section key={section.key} className="mb-2">
              {/* One host needs no header: the whole office IS that host, and
                  a label over everything says nothing. */}
              {sections.length > 1 ? (
                <p className="truncate px-1.5 py-1 text-ui-xs font-medium text-muted-foreground">
                  {section.title}
                </p>
              ) : null}
              {section.hq === null ? null : (
                <ul className="flex flex-col">{renderAgentRow(section.hq)}</ul>
              )}
              {section.teams.length === 0 ? null : (
                <>
                  <p className="px-1.5 py-0.5 text-ui-xs text-muted-foreground">
                    Teams at work
                  </p>
                  <ul className="flex flex-col">
                    {section.teams.map((team) => (
                      <li
                        key={team.teamId}
                        className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1"
                      >
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: accentColor(team.teamId) }}
                        />
                        <button
                          type="button"
                          data-testid={`comm-graph-office-directory-team-${team.teamId}`}
                          aria-current={team.leadAgentId === selectedAgentId}
                          className={cn(
                            "min-w-0 flex-1 truncate rounded-sm text-left text-ui-xs",
                            team.leadAgentId === selectedAgentId &&
                              "text-foreground",
                          )}
                          onClick={() => onSelectAgent(team.leadAgentId)}
                          onPointerEnter={() => onHoverAgent(team.leadAgentId)}
                          onPointerLeave={() => onHoverAgent(null)}
                        >
                          {team.name}
                        </button>
                        <span className="flex shrink-0 items-center gap-0.5">
                          {team.members.slice(0, MAX_ROW_PIPS).map(renderPip)}
                          {team.members.length > MAX_ROW_PIPS ? (
                            <span className="pl-0.5 text-ui-xs text-muted-foreground tabular-nums">
                              +{team.members.length - MAX_ROW_PIPS}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {section.bullpen.length === 0 ? null : (
                <div className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1">
                  <span className="min-w-0 flex-1 truncate text-ui-xs">
                    Bullpen
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {section.bullpen.slice(0, MAX_ROW_PIPS).map(renderPip)}
                    {section.bullpen.length > MAX_ROW_PIPS ? (
                      <span className="pl-0.5 text-ui-xs text-muted-foreground tabular-nums">
                        +{section.bullpen.length - MAX_ROW_PIPS}
                      </span>
                    ) : null}
                  </span>
                </div>
              )}
              {section.quietAgents === 0 && section.quietTeams === 0 ? null : (
                <p
                  data-testid="comm-graph-office-directory-quiet"
                  className="px-1.5 py-1 text-ui-xs text-muted-foreground tabular-nums"
                >
                  Quiet · {section.quietAgents} idle or archived
                  {section.quietTeams === 0
                    ? null
                    : ` · ${section.quietTeams} cold ${section.quietTeams === 1 ? "team" : "teams"}`}
                </p>
              )}
            </section>
          ))
        )}
      </div>
      <footer
        data-testid="comm-graph-office-directory-footer"
        className="border-t border-border px-2.5 py-1.5 text-ui-xs text-muted-foreground tabular-nums"
      >
        {everyone.length} {everyone.length === 1 ? "agent" : "agents"} ·{" "}
        {atWork} at work
      </footer>
    </aside>
  );
}
