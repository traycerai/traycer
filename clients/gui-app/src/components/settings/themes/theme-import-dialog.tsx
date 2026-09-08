import { useEffect, useRef, useState, type RefObject } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import {
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Package,
  Search,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { themeQueryKeys } from "@/lib/query-keys/theme-query-keys";
import { importThemeFiles, importThemeText } from "@/lib/themes/theme-import";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";
import {
  installOpenVsxTheme,
  searchOpenVsxThemes,
  type OpenVsxExtension,
} from "@/lib/themes/open-vsx";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { cn } from "@/lib/utils";
import { useOpenLink } from "@/lib/links/open-link";

interface ThemeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
type ImportSource =
  | { kind: "extension"; extension: OpenVsxExtension }
  | { kind: "files"; files: File[] }
  | { kind: "json"; text: string };
interface StagedImport {
  themes: ThemeDefinition[];
  source: ImportSource;
  collectionId: string | null;
  baseline: string;
}
type Sort = "downloadCount" | "rating" | "timestamp" | "relevance";
const sorts: { value: Sort; label: string }[] = [
  { value: "downloadCount", label: "Most downloaded" },
  { value: "rating", label: "Highest rated" },
  { value: "timestamp", label: "Recently updated" },
  { value: "relevance", label: "Most relevant" },
];
const popularSearches = [
  { label: "Popular", query: "" },
  { label: "Dracula", query: "Dracula" },
  { label: "Catppuccin", query: "Catppuccin" },
  { label: "Nord", query: "Nord" },
  { label: "Tokyo Night", query: "tokyo" },
];
const numberFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

async function readImportSource(
  source: ImportSource,
  signal: AbortSignal,
): Promise<ThemeDefinition[]> {
  switch (source.kind) {
    case "extension":
      return installOpenVsxTheme(source.extension, signal);
    case "files":
      return importThemeFiles(source.files);
    case "json":
      return importThemeText(source.text, "Imported theme");
  }
}

export function ThemeImportDialog({
  open,
  onOpenChange,
}: ThemeImportDialogProps) {
  return open ? <ThemeImportDialogBody onOpenChange={onOpenChange} /> : null;
}

function ThemeImportDialogBody({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("downloadCount");
  const [json, setJson] = useState("");
  const [dragging, setDragging] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const openLink = useOpenLink();
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const controllers = useRef(new Set<AbortController>());
  const themes = useThemeLibraryStore((state) => state.themes);
  const storageError = useThemeLibraryStore((state) => state.error);
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  useEffect(() => {
    const pending = controllers.current;
    return () => {
      for (const controller of pending) controller.abort();
    };
  }, []);
  const search = useQuery(
    queryOptions({
      queryKey: themeQueryKeys.search(debouncedQuery, sort),
      queryFn: ({ signal }) =>
        searchOpenVsxThemes(debouncedQuery, sort, signal),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    }),
  );
  const loadThemes = useMutation({
    mutationKey: themeQueryKeys.import(),
    mutationFn: async (source: ImportSource) => {
      const collectionId =
        source.kind === "extension" ? `open-vsx:${source.extension.id}` : null;
      const baseline = JSON.stringify(
        useThemeLibraryStore
          .getState()
          .themes.filter((theme) => theme.collection?.id === collectionId),
      );
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const imported = await readImportSource(source, controller.signal);
        controller.signal.throwIfAborted();
        return { themes: imported, source, collectionId, baseline };
      } finally {
        controllers.current.delete(controller);
      }
    },
  });
  const staged = loadThemes.data;
  useEffect(() => {
    if (staged) preview.current?.scrollIntoView({ block: "nearest" });
  }, [staged]);
  const replacing =
    staged?.source.kind === "extension"
      ? themes.filter((theme) => theme.collection?.id === staged.collectionId)
          .length
      : 0;
  function load(source: ImportSource) {
    if (loadThemes.isPending) return;
    setSuccess(null);
    setConflictError(null);
    loadThemes.mutate(source);
  }
  function save(copy: boolean) {
    if (!staged) return;
    if (
      !copy &&
      staged.collectionId !== null &&
      JSON.stringify(
        useThemeLibraryStore
          .getState()
          .themes.filter(
            (theme) => theme.collection?.id === staged.collectionId,
          ),
      ) !== staged.baseline
    ) {
      setConflictError(
        "This theme pack changed while you were reviewing it. Review the update again or save copies to keep those changes.",
      );
      return;
    }
    setConflictError(null);
    const collectionIds = new Map<string, string>();
    const imported = copy
      ? staged.themes.map((theme) => {
          if (theme.collection && !collectionIds.has(theme.collection.id))
            collectionIds.set(
              theme.collection.id,
              `copy:${crypto.randomUUID()}`,
            );
          return {
            ...theme,
            id: crypto.randomUUID(),
            ...(theme.collection
              ? {
                  collection: {
                    ...theme.collection,
                    id:
                      collectionIds.get(theme.collection.id) ??
                      theme.collection.id,
                  },
                }
              : {}),
          };
        })
      : staged.themes;
    if (useThemeLibraryStore.getState().installThemes(imported)) {
      setSuccess(
        `${imported.length} ${imported.length === 1 ? "theme" : "themes"} added to your library. Choose a light or dark variant in Appearance to use it.`,
      );
      loadThemes.reset();
    }
  }
  function close(next: boolean) {
    if (!next) for (const controller of controllers.current) controller.abort();
    onOpenChange(next);
  }
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="max-h-[calc(var(--spacing-safe-svh)-var(--safe-area-inset-bottom)-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
          <DialogDescription>
            Find community themes on Open VSX, or import a theme file.
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-3" aria-label="Community themes">
          <Label htmlFor="theme-search">Search community themes</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="theme-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Theme name or publisher.extension"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1" aria-label="Popular searches">
              {popularSearches.map((entry) => (
                <Button
                  key={entry.label}
                  size="sm"
                  variant="ghost"
                  aria-pressed={query === entry.query}
                  onClick={() => setQuery(entry.query)}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
            <Select
              value={sort}
              onValueChange={(value) => {
                const selected = sorts.find((entry) => entry.value === value);
                if (selected) setSort(selected.value);
              }}
            >
              <SelectTrigger aria-label="Sort themes">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sorts.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {search.isPending ? (
            <div
              role="status"
              className="flex items-center gap-2 py-6 text-muted-foreground"
            >
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
              Loading community themes
            </div>
          ) : null}
          {search.isError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 p-3 text-destructive"
            >
              {search.error.message}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void search.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {search.data?.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              No themes found. Try a different name or import a file below.
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {search.data?.map((extension) => {
              const installed = themes.some(
                (theme) => theme.collection?.id === `open-vsx:${extension.id}`,
              );
              const pending =
                loadThemes.isPending &&
                loadThemes.variables.kind === "extension" &&
                loadThemes.variables.extension.id === extension.id;
              return (
                <article
                  key={extension.id}
                  className="flex min-w-0 flex-col gap-3 rounded-xl bg-foreground/5 p-3"
                >
                  <div className="flex min-w-0 gap-3">
                    {extension.iconUrl ? (
                      <img
                        src={extension.iconUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="size-9 shrink-0 rounded-lg object-contain"
                      />
                    ) : (
                      <Package
                        aria-hidden
                        className="size-9 shrink-0 rounded-lg p-1 text-muted-foreground"
                      />
                    )}
                    <div className="min-w-0">
                      <h3 className="break-words font-medium">
                        {extension.name}
                      </h3>
                      <p className="truncate text-xs text-muted-foreground">
                        {extension.publisher} ·{" "}
                        {numberFormat.format(extension.downloadCount)} downloads
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-2 grow text-xs text-muted-foreground">
                    {extension.description}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`View ${extension.name} on Open VSX`}
                      onClick={(event) =>
                        void openLink(
                          `https://open-vsx.org/extension/${extension.id.split(".").map(encodeURIComponent).join("/")}`,
                          "docs",
                          event,
                        )
                      }
                    >
                      <ExternalLink aria-hidden className="size-3.5" />
                    </Button>
                    <span className="mr-auto truncate text-xs text-muted-foreground">
                      {extension.version}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loadThemes.isPending}
                      onClick={() => load({ kind: "extension", extension })}
                    >
                      {pending ? (
                        <AgentSpinningDots
                          className={undefined}
                          testId={undefined}
                          variant={undefined}
                        />
                      ) : (
                        <Download aria-hidden className="size-3.5" />
                      )}
                      {installed ? "Review update" : "Install"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
          <span className="h-px grow bg-border" />
          OR IMPORT A FILE
          <span className="h-px grow bg-border" />
        </div>
        <section className="space-y-3" aria-label="Import theme files">
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4",
              dragging
                ? "border-primary bg-primary/10"
                : "border-border bg-foreground/3",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget instanceof Node
                    ? event.relatedTarget
                    : null,
                )
              )
                setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (event.dataTransfer.files.length)
                load({
                  kind: "files",
                  files: Array.from(event.dataTransfer.files),
                });
            }}
          >
            <div>
              <p className="font-medium">Theme files</p>
              <p className="text-xs text-muted-foreground">
                Drop Traycer or VS Code .json, .jsonc, or .vsix files
              </p>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.jsonc,.vsix"
              multiple
              className="sr-only"
              aria-label="Choose theme files"
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length) load({ kind: "files", files });
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={loadThemes.isPending}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp aria-hidden className="size-4" />
              Choose files
            </Button>
          </div>
          <Label htmlFor="theme-json">Theme JSON</Label>
          <Textarea
            id="theme-json"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            placeholder="Paste exported Traycer theme JSON or a VS Code color theme…"
            rows={5}
            className="font-mono text-xs"
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              disabled={!json.trim() || loadThemes.isPending}
              onClick={() => load({ kind: "json", text: json })}
            >
              Preview import
            </Button>
          </div>
        </section>
        {loadThemes.isPending ? (
          <div
            role="status"
            className="flex items-center gap-2 text-muted-foreground"
          >
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
            Reading theme data
          </div>
        ) : null}
        {loadThemes.isError ? (
          <p role="alert" className="text-destructive">
            {loadThemes.error.message}
          </p>
        ) : null}
        {conflictError ? (
          <p role="alert" className="text-destructive">
            {conflictError}
          </p>
        ) : null}
        {storageError ? (
          <p role="alert" className="text-destructive">
            {storageError}
          </p>
        ) : null}
        <ThemeImportPreview
          staged={staged}
          replacing={replacing}
          previewRef={preview}
          onCancel={() => loadThemes.reset()}
          onSave={save}
        />
        {success ? (
          <p role="status" className="text-sm text-muted-foreground">
            {success}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ThemeImportPreview({
  staged,
  replacing,
  previewRef,
  onCancel,
  onSave,
}: {
  staged: StagedImport | undefined;
  replacing: number;
  previewRef: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onSave: (copy: boolean) => void;
}) {
  if (!staged) return null;
  return (
    <div
      ref={previewRef}
      className="space-y-3 rounded-xl border border-border bg-foreground/5 p-4"
    >
      <p className="font-medium">
        {staged.themes.length} {staged.themes.length === 1 ? "theme" : "themes"}{" "}
        ready to import
      </p>
      <ul className="flex max-h-[25svh] flex-wrap gap-2 overflow-y-auto">
        {staged.themes.map((theme) => (
          <li
            key={theme.id}
            className="rounded-md bg-foreground/8 px-2 py-1 text-xs"
          >
            {theme.name} · {theme.appearance}
          </li>
        ))}
      </ul>
      {replacing > 0 ? (
        <p className="text-xs text-muted-foreground">
          Updating replaces {replacing} installed{" "}
          {replacing === 1 ? "theme" : "themes"}, including your color edits.
          Save copies to keep those edits.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel import
        </Button>
        {replacing > 0 ? (
          <Button variant="outline" onClick={() => onSave(true)}>
            <Copy aria-hidden className="size-4" />
            Save copies
          </Button>
        ) : null}
        <Button onClick={() => onSave(staged.source.kind !== "extension")}>
          <Download aria-hidden className="size-4" />
          {replacing > 0 ? "Update themes" : "Add to library"}
        </Button>
      </div>
    </div>
  );
}
