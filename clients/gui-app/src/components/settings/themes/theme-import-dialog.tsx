import { useEffect, useRef, useState, type RefObject } from "react";
import { z } from "zod";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Moon,
  Package,
  Search,
  Sun,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { themeQueryKeys } from "@/lib/query-keys/theme-query-keys";
import {
  importThemeFiles,
  importThemeText,
  type ThemeImportBatch,
} from "@/lib/themes/theme-import";
import { getThemeImportConflicts } from "@/lib/themes/theme-library";
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
  replaceCollectionIds: string[];
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
): Promise<ThemeImportBatch> {
  switch (source.kind) {
    case "extension": {
      const themes = await installOpenVsxTheme(source.extension, signal);
      return {
        themes,
        replaceCollectionIds: themes.flatMap((theme) =>
          theme.collection ? [theme.collection.id] : [],
        ),
      };
    }
    case "files":
      return importThemeFiles(source.files, signal);
    case "json":
      return {
        themes: importThemeText(source.text, "Imported theme"),
        replaceCollectionIds: [],
      };
  }
}

async function stageThemeImport(
  source: ImportSource,
  controllers: Set<AbortController>,
): Promise<StagedImport> {
  const beforeRead = structuredClone(useThemeLibraryStore.getState().themes);
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const imported = await readImportSource(source, controller.signal);
    controller.signal.throwIfAborted();
    if (
      new Set(imported.themes.map((theme) => theme.id)).size !==
      imported.themes.length
    ) {
      throw new Error(
        "These files contain duplicate theme identities. Import one version of each theme at a time.",
      );
    }
    return {
      ...imported,
      baseline: JSON.stringify(
        getThemeImportConflicts(
          beforeRead,
          imported.themes,
          imported.replaceCollectionIds,
        ),
      ),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        "The theme contains unsupported values. Check its colors and syntax rules.",
      );
    }
    throw error;
  } finally {
    controllers.delete(controller);
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
    mutationFn: (source: ImportSource) =>
      stageThemeImport(source, controllers.current),
  });
  const staged = loadThemes.data;
  useEffect(() => {
    if (staged) preview.current?.scrollIntoView({ block: "nearest" });
  }, [staged]);
  const replacing = staged
    ? getThemeImportConflicts(
        themes,
        staged.themes,
        staged.replaceCollectionIds,
      ).length
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
      JSON.stringify(
        getThemeImportConflicts(
          useThemeLibraryStore.getState().themes,
          staged.themes,
          staged.replaceCollectionIds,
        ),
      ) !== staged.baseline
    ) {
      setConflictError(
        "These themes changed while you were reviewing them. Review the import again or save copies to keep those changes.",
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
    if (
      useThemeLibraryStore
        .getState()
        .installThemes(
          imported,
          copy ? [] : staged.replaceCollectionIds,
          copy ? null : staged.baseline,
        )
    ) {
      setSuccess(
        `${imported.length} ${imported.length === 1 ? "theme" : "themes"} added to your library. Close this dialog and choose it under Light theme or Dark theme.`,
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
      <DialogContent className="flex max-h-[calc(var(--spacing-safe-svh)-var(--safe-area-inset-bottom)-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border/60 p-4 pr-10">
          <DialogTitle className="text-ui-sm">Import themes</DialogTitle>
          <DialogDescription className="max-w-prose pr-4">
            Browse community themes from the Open VSX extension registry, or
            import theme files.
          </DialogDescription>
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
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">
          <Tabs defaultValue="browse" className="gap-3 pt-3">
            <TabsList
              variant="line"
              aria-label="Theme import source"
              className="w-full justify-start gap-5 border-b border-border/60 pb-2"
            >
              <TabsTrigger value="browse" className="flex-none px-0">
                <Search aria-hidden />
                Browse themes
              </TabsTrigger>
              <TabsTrigger value="files" className="flex-none px-0">
                <FileUp aria-hidden />
                Import files
              </TabsTrigger>
            </TabsList>
            <TabsContent value="browse" className="space-y-3">
              <section className="space-y-3" aria-label="Community themes">
                <div className="space-y-2">
                  <Label htmlFor="theme-search" className="sr-only">
                    Search community themes
                  </Label>
                  <div className="relative">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      id="theme-search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search by theme name or publisher"
                      className="h-9 border-border/70 pl-9"
                    />
                  </div>
                  <div
                    className="flex flex-wrap items-center gap-1 text-ui-xs"
                    aria-label="Popular searches"
                  >
                    <span className="mr-1 text-muted-foreground">Explore</span>
                    {popularSearches.map((entry) => (
                      <Button
                        key={entry.label}
                        size="sm"
                        variant="ghost"
                        aria-pressed={query === entry.query}
                        onClick={() => setQuery(entry.query)}
                        className={cn(
                          "h-7 rounded-full px-2.5 text-ui-xs",
                          query === entry.query && "bg-foreground/8",
                        )}
                      >
                        {entry.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-2">
                  <p className="text-ui-xs text-muted-foreground">
                    Color themes from Open VSX
                  </p>
                  <Select
                    value={sort}
                    onValueChange={(value) => {
                      const selected = sorts.find(
                        (entry) => entry.value === value,
                      );
                      if (selected) setSort(selected.value);
                    }}
                  >
                    <SelectTrigger
                      aria-label="Sort themes"
                      size="sm"
                      className="w-auto border-transparent bg-transparent text-ui-xs shadow-none"
                    >
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
                    className="flex items-center justify-center gap-2 py-6 text-muted-foreground"
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
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4 text-destructive"
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
                    No themes found. Try a different name or use Import files.
                  </p>
                ) : null}
                <div className="divide-y divide-border/60">
                  {search.data?.map((extension) => (
                    <CommunityThemeRow
                      key={extension.id}
                      extension={extension}
                      installed={themes.some(
                        (theme) =>
                          theme.collection?.id === `open-vsx:${extension.id}`,
                      )}
                      pending={Boolean(
                        loadThemes.isPending &&
                        loadThemes.variables.kind === "extension" &&
                        loadThemes.variables.extension.id === extension.id,
                      )}
                      disabled={loadThemes.isPending}
                      onLoad={() => load({ kind: "extension", extension })}
                    />
                  ))}
                </div>
              </section>
            </TabsContent>
            <TabsContent value="files" className="space-y-3">
              <section className="space-y-3" aria-label="Import theme files">
                <div
                  className={cn(
                    "flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-5 text-center transition-colors",
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
                  <div className="space-y-1.5">
                    <p className="text-ui-sm font-medium">
                      Drop your theme files here
                    </p>
                    <p className="max-w-prose text-ui-xs text-muted-foreground">
                      Traycer and VS Code themes, including entire extension
                      packs.
                    </p>
                    <p className="font-mono text-ui-xs text-muted-foreground">
                      .json · .jsonc · .vsix
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
                    Choose files
                  </Button>
                </div>
                <details className="group rounded-xl border border-border/60">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl p-4 text-ui-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    Paste theme JSON
                    <ChevronDown
                      aria-hidden
                      className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <div className="space-y-3 border-t border-border/60 p-4">
                    <Label htmlFor="theme-json">Theme JSON</Label>
                    <Textarea
                      id="theme-json"
                      value={json}
                      onChange={(event) => setJson(event.target.value)}
                      placeholder="Paste exported Traycer theme JSON or a VS Code color theme…"
                      rows={7}
                      className="bg-foreground/3 font-mono text-ui-xs"
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
                  </div>
                </details>
              </section>
            </TabsContent>
          </Tabs>
          <div className="space-y-3 pt-3">
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
              saveFailed={storageError !== null || conflictError !== null}
              previewRef={preview}
              onCancel={() => loadThemes.reset()}
              onSave={save}
            />
            {success ? (
              <p
                role="status"
                className="flex items-start gap-2 rounded-lg border border-border/60 bg-foreground/3 p-4 text-ui-sm"
              >
                <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
                {success}
              </p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CommunityThemeRow({
  extension,
  installed,
  pending,
  disabled,
  onLoad,
}: {
  extension: OpenVsxExtension;
  installed: boolean;
  pending: boolean;
  disabled: boolean;
  onLoad: () => void;
}) {
  const openLink = useOpenLink();
  return (
    <article className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-3 first:pt-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      {extension.iconUrl ? (
        <img
          src={extension.iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-7 rounded object-contain"
        />
      ) : (
        <Package aria-hidden className="size-7 p-1 text-muted-foreground" />
      )}
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2">
          <h3 className="break-words text-ui-sm font-medium">
            {extension.name}
          </h3>
          {installed ? (
            <span className="text-ui-xs text-muted-foreground">Installed</span>
          ) : null}
        </div>
        <p className="truncate text-ui-xs text-muted-foreground">
          {extension.publisher} · {numberFormat.format(extension.downloadCount)}{" "}
          downloads · {extension.version}
        </p>
        <p className="truncate text-ui-xs text-muted-foreground">
          {extension.description}
        </p>
      </div>
      <div className="col-start-2 flex items-center gap-1 sm:col-start-auto">
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
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onLoad}
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
          {installed ? "Review update" : "Preview themes"}
        </Button>
      </div>
    </article>
  );
}

function ThemeImportPreview({
  staged,
  replacing,
  saveFailed,
  previewRef,
  onCancel,
  onSave,
}: {
  staged: StagedImport | undefined;
  replacing: number;
  saveFailed: boolean;
  previewRef: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onSave: (copy: boolean) => void;
}) {
  if (!staged) return null;
  return (
    <div
      ref={previewRef}
      className="space-y-4 rounded-xl border border-border bg-foreground/3 p-4"
    >
      <p className="font-medium">
        {staged.themes.length} {staged.themes.length === 1 ? "theme" : "themes"}{" "}
        ready to import
      </p>
      <ul className="max-h-[25svh] divide-y divide-border/60 overflow-y-auto">
        {staged.themes.map((theme) => (
          <li
            key={theme.id}
            className="flex items-center gap-3 py-2.5 text-ui-xs"
          >
            <span
              aria-hidden
              className="flex size-8 shrink-0 overflow-hidden rounded-md border border-foreground/10"
            >
              <span
                className="w-2/3"
                style={{
                  background: theme.colors.background ?? "var(--background)",
                }}
              />
              <span
                className="flex-1"
                style={{ background: theme.colors.primary ?? "var(--primary)" }}
              />
            </span>
            <span className="min-w-0 flex-1 break-words">{theme.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              {theme.appearance === "light" ? (
                <Sun aria-hidden className="size-3.5" />
              ) : (
                <Moon aria-hidden className="size-3.5" />
              )}
              {theme.appearance}
            </span>
          </li>
        ))}
      </ul>
      {replacing > 0 ? (
        <p className="text-xs text-muted-foreground">
          Updating replaces {replacing} installed{" "}
          {replacing === 1 ? "theme" : "themes"}, including your color edits.
          Import as copies to keep your existing themes and their edits.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel import
        </Button>
        {replacing > 0 || staged.baseline !== "[]" || saveFailed ? (
          <Button variant="outline" onClick={() => onSave(true)}>
            <Copy aria-hidden className="size-4" />
            Import as copies
          </Button>
        ) : null}
        <Button onClick={() => onSave(false)}>
          <Download aria-hidden className="size-4" />
          {replacing > 0 ? "Update themes" : "Add to library"}
        </Button>
      </div>
    </div>
  );
}
