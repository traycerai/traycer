import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { epicDisplayTitle } from "@/lib/display-title";
import type { ProjectProfile } from "@/lib/profiles/types";
import { cn } from "@/lib/utils";
import { profileColorHex, profileIcon } from "./profile-options";

export interface ProfileHomeCardProps {
  readonly profile: ProjectProfile;
  readonly epics: ReadonlyArray<HistoryItem>;
  readonly onOpenEpic: (epicId: string) => void;
}

export function ProfileHomeCard(props: ProfileHomeCardProps): ReactNode {
  const Icon = profileIcon(props.profile.icon);
  const color = profileColorHex(props.profile.color);

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
      data-testid={`all-projects-profile-card-${props.profile.id}`}
    >
      <header className="flex items-center gap-2">
        <span
          className="flex size-7 items-center justify-center rounded-md"
          style={{ backgroundColor: `${color}22`, color }}
          aria-hidden
        >
          <Icon className="size-3.5" />
        </span>
        <h2 className="text-ui-sm font-medium text-foreground">
          {props.profile.name}
        </h2>
      </header>
      {props.epics.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground">No epics yet</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {props.epics.map((item) => (
            <li key={item.epicId}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left",
                  "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
                onClick={() => {
                  props.onOpenEpic(item.epicId);
                }}
                data-testid={`all-projects-epic-${item.epicId}`}
              >
                <span className="truncate text-ui-sm text-foreground">
                  {epicDisplayTitle({
                    title: item.title,
                    initialUserPrompt: item.initialUserPrompt,
                  })}
                </span>
                <span className="shrink-0 text-ui-xs text-muted-foreground">
                  {item.updatedLabel}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface UnassignedEpicRowProps {
  readonly item: HistoryItem;
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly onAssign: (profileId: string, epicId: string) => void;
}

export function UnassignedEpicRow(props: UnassignedEpicRowProps): ReactNode {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
      data-testid={`all-projects-unassigned-${props.item.epicId}`}
    >
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="truncate text-ui-sm text-foreground">
          {epicDisplayTitle({
            title: props.item.title,
            initialUserPrompt: props.item.initialUserPrompt,
          })}
        </span>
        <span className="text-ui-xs text-muted-foreground">
          {props.item.updatedLabel}
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            data-testid={`all-projects-assign-${props.item.epicId}`}
          >
            Assign to…
            <ChevronDown className="ml-1 size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {props.profiles.map((profile) => (
            <DropdownMenuItem
              key={profile.id}
              onSelect={() => {
                props.onAssign(profile.id, props.item.epicId);
              }}
              data-testid={`all-projects-assign-to-${profile.id}-${props.item.epicId}`}
            >
              {profile.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export interface UnassignedSectionProps {
  readonly items: ReadonlyArray<HistoryItem>;
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly onAssign: (profileId: string, epicId: string) => void;
  readonly initialCap: number;
}

export function UnassignedSection(props: UnassignedSectionProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? props.items
    : props.items.slice(0, props.initialCap);
  const hasMore = props.items.length > props.initialCap && !expanded;

  if (props.items.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="all-projects-unassigned-section"
    >
      <h2 className="text-ui-sm font-medium text-foreground">
        Unassigned
        <span className="ml-1.5 text-ui-xs font-normal text-muted-foreground">
          {props.items.length}
        </span>
      </h2>
      <div className="flex flex-col gap-1.5">
        {visible.map((item) => (
          <UnassignedEpicRow
            key={item.epicId}
            item={item}
            profiles={props.profiles}
            onAssign={props.onAssign}
          />
        ))}
      </div>
      {hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          onClick={() => {
            setExpanded(true);
          }}
          data-testid="all-projects-unassigned-show-more"
        >
          Show more
        </Button>
      ) : null}
    </section>
  );
}
