import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { ChevronDown, History } from "lucide-react";
import { htmlArtifactVersionIdentity } from "@traycer/protocol/host/epic/html-artifact-versions";
import type { HtmlArtifactVersionState } from "@/hooks/epic/use-epic-html-artifact-version";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function HtmlArtifactVersionPicker({
  version,
}: {
  readonly version: HtmlArtifactVersionState;
}) {
  const coarsePointer = useCoarsePointer();
  const { selectedVersion } = version;
  if (!version.supported && selectedVersion === null) return null;
  const label =
    selectedVersion === null
      ? "Latest"
      : new Date(selectedVersion.manifest.capturedAt).toLocaleString(
          undefined,
          {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          },
        );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={coarsePointer ? "touch" : "sm"}
          aria-label={`HTML version history: ${label}`}
        >
          <History />
          <span>{label}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-max">
        <DropdownMenuLabel>Version history</DropdownMenuLabel>
        <HtmlArtifactVersionChoices version={version} />
        <HtmlArtifactHistoryPages version={version} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HtmlArtifactVersionChoices({
  version,
}: {
  readonly version: HtmlArtifactVersionState;
}) {
  const { selectedVersion, history } = version;
  const selectedIdentity =
    selectedVersion === null
      ? null
      : htmlArtifactVersionIdentity(selectedVersion);
  const versions = history.data?.versions ?? [];
  const selectedId =
    selectedVersion === null
      ? "latest"
      : (versions.find(
          (item) => htmlArtifactVersionIdentity(item) === selectedIdentity,
        )?.id ?? "selected");
  return (
    <DropdownMenuRadioGroup
      value={selectedId}
      onValueChange={(id) => {
        if (id === "latest") version.selectVersion(null);
        else {
          const next = versions.find((item) => item.id === id);
          if (next !== undefined) version.selectVersion(next);
        }
      }}
    >
      <DropdownMenuRadioItem value="latest">Latest</DropdownMenuRadioItem>
      {selectedId === "selected" && selectedVersion !== null ? (
        <DropdownMenuRadioItem value="selected">
          {new Date(selectedVersion.manifest.capturedAt).toLocaleString()}
        </DropdownMenuRadioItem>
      ) : null}
      {versions.map((item) => (
        <DropdownMenuRadioItem key={item.id} value={item.id}>
          {new Date(item.manifest.capturedAt).toLocaleString()}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function HtmlArtifactHistoryPages({
  version,
}: {
  readonly version: HtmlArtifactVersionState;
}) {
  const { history } = version;
  const nextCursor = history.data?.nextCursor;
  const hasOlder = nextCursor !== undefined && nextCursor !== null;
  return (
    <>
      {history.isPending && version.supported ? (
        <DropdownMenuItem disabled>Loading versions…</DropdownMenuItem>
      ) : null}
      {history.isError ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void history.refetch();
          }}
        >
          Couldn't load versions. Retry
        </DropdownMenuItem>
      ) : null}
      {version.hasNewer || hasOlder ? <DropdownMenuSeparator /> : null}
      {version.hasNewer ? (
        <DropdownMenuItem
          disabled={history.isFetching}
          onSelect={(event) => {
            event.preventDefault();
            version.showNewest();
          }}
        >
          Newest versions
        </DropdownMenuItem>
      ) : null}
      {hasOlder ? (
        <DropdownMenuItem
          disabled={history.isFetching}
          onSelect={(event) => {
            event.preventDefault();
            version.showOlder();
          }}
        >
          Older versions
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
