import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ShareImageSources } from "@/components/share-on-x/share-image-sources";
import {
  shuffledShareOnXLines,
  type ShareOnXLine,
  type ShareOnXLineContext,
} from "@/components/share-on-x/share-on-x-lines";
import {
  X_POST_LIMIT,
  xPostIntentUrl,
  xPostLength,
} from "@/components/share-on-x/post-length";
import { setUpHarnesses } from "@/components/share-on-x/set-up-harnesses";
import type { ShareImage } from "@/components/share-on-x/share-images";
import { shareUsageFacts } from "@/components/share-on-x/share-usage-facts";
import { XLogo } from "@/components/share-on-x/x-logo";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsShareImage,
} from "@/lib/analytics";
import { copyImageBlobPromiseToClipboard } from "@/lib/images/copy-image-to-clipboard";
import { isMac } from "@/lib/keybindings/platform";
import { useOpenLinkWithPending } from "@/lib/links/open-link";
import { cn } from "@/lib/utils";
import { useShareOnXNudgeStore } from "@/stores/settings/share-on-x-nudge-store";

/** Posts shown at once; "Show 4 others" moves to the next group. */
const LINES_PER_PAGE = 4;

const IMAGE_ORDER: ReadonlyArray<AnalyticsShareImage> = [
  "setup",
  "screen",
  "usage",
  "team",
];

const IMAGE_LABELS: Record<AnalyticsShareImage, string> = {
  setup: "Your setup",
  screen: "This screen",
  usage: "Task usage",
  team: "Agent team",
};

export interface ShareOnXDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly epicId: string;
  /** The host the thanked chat runs on, for reading the task's usage. */
  readonly hostId: string | null;
  /** The app window, captured as the dialog opened; `null` when it could not be. */
  readonly screenCapture: ShareImage | null;
}

/**
 * Lets the person pick one of the ready-made posts (editing it if they like),
 * pick an image, and open X with the post filled in. X's post link cannot
 * carry an image, so the chosen image goes to the clipboard first and the
 * person pastes it.
 */
export function ShareOnXDialog(props: ShareOnXDialogProps): ReactNode {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {props.open ? <ShareOnXDialogContent {...props} /> : null}
    </Dialog>
  );
}

function pasteShortcut(): string {
  return isMac() ? "⌘V" : "Ctrl+V";
}

function ShareOnXDialogContent(props: ShareOnXDialogProps): ReactNode {
  const { epicId, hostId, screenCapture, onClose } = props;
  const [sources] = useState(shuffledShareOnXLines);
  const [pageStart, setPageStart] = useState(0);
  const [selectedId, setSelectedId] = useState(sources[0].id);
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [selectedImage, setSelectedImage] =
    useState<AnalyticsShareImage | null>("setup");
  const [images, setImages] = useState<
    Readonly<Partial<Record<AnalyticsShareImage, ShareImage>>>
  >(() => (screenCapture === null ? {} : { screen: screenCapture }));
  const { openLink, isPending: opening } = useOpenLinkWithPending();
  const recordPosted = useShareOnXNudgeStore((state) => state.recordPosted);
  const recordOptOut = useShareOnXNudgeStore((state) => state.recordOptOut);
  const recordDialogAbandoned = useShareOnXNudgeStore(
    (state) => state.recordDialogAbandoned,
  );
  const checkboxId = useId();

  // Sources for the generated images.
  const providers = useProvidersList({ enabled: true, subscribed: false });
  const harnesses = useMemo(
    () => setUpHarnesses(providers.data?.providers ?? []),
    [providers.data],
  );
  const usageClient = useHostClientForHostId(hostId);
  const usageRequest = useMemo(
    () => buildUsageSummaryRequest({ windowDays: 7, epicId, plane: null }),
    [epicId],
  );
  const usageQuery = useUsageSummaryForClient(
    usageClient,
    usageRequest,
    true,
    false,
  );
  const usage = useMemo(
    () =>
      usageQuery.data !== undefined &&
      usageQuery.data.summary.totals.factCount > 0
        ? shareUsageFacts(usageQuery.data)
        : null,
    [usageQuery.data],
  );

  // Written from the person's own setup and usage, so a post can quote them
  // once they load.
  const lines = useMemo((): ReadonlyArray<ShareOnXLine> => {
    const context: ShareOnXLineContext = {
      setUpAgents: harnesses.map((harness) => harness.name),
      task:
        usage === null
          ? null
          : {
              agentCount: usage.chatCount,
              harnesses: usage.agents.map((agent) => agent.name),
              tokens: usage.totalTokens,
              machineCount: usage.machineCount,
            },
    };
    return sources.map((source) => ({
      id: source.id,
      text: source.write(context),
    }));
  }, [sources, harnesses, usage]);
  const selectedLine: ShareOnXLine =
    lines.find((line) => line.id === selectedId) ?? lines[0];
  const text = edits[selectedLine.id] ?? selectedLine.text;
  const edited = text !== selectedLine.text;
  const length = xPostLength(text);

  const textCopy = useClipboardCopy({
    resetMs: 1_500,
    onSuccess: () => {
      Analytics.getInstance().track(AnalyticsEvent.ShareTextCopied, {
        line_id: selectedLine.id,
        edited,
      });
    },
    onError: () => {
      toast.error("Couldn't copy the post");
    },
  });

  const availableImages = IMAGE_ORDER.filter(
    (image) => images[image] !== undefined,
  );
  const chosenImage =
    selectedImage !== null && availableImages.includes(selectedImage)
      ? selectedImage
      : null;

  useEffect(() => {
    Analytics.getInstance().track(AnalyticsEvent.ShareDialogOpened, {
      source: "toast",
      screen_captured: screenCapture !== null,
    });
  }, [screenCapture]);

  function close(posted: boolean): void {
    const now = Date.now();
    if (!posted) recordDialogAbandoned(now);
    if (dontAskAgain) {
      recordOptOut();
      Analytics.getInstance().track(AnalyticsEvent.ShareOptedOut, {
        from: "dialog",
      });
    }
    onClose();
  }

  function selectLine(line: ShareOnXLine, position: number): void {
    setSelectedId(line.id);
    Analytics.getInstance().track(AnalyticsEvent.ShareLineSelected, {
      line_id: line.id,
      position,
    });
  }

  function copyImage(image: AnalyticsShareImage): void {
    const captured = images[image];
    if (captured === undefined) return;
    copyImageBlobPromiseToClipboard(Promise.resolve(captured.blob)).then(
      () => {
        toast.success("Image copied");
        Analytics.getInstance().track(AnalyticsEvent.ShareImageCopied, {
          image,
        });
      },
      () => {
        toast.error("Couldn't copy the image");
      },
    );
  }

  async function postOnX(): Promise<void> {
    const blob = chosenImage === null ? undefined : images[chosenImage]?.blob;
    // Started inside the click, while the page still holds the person's
    // gesture: the clipboard refuses an image write after it lapses.
    // Settled to a flag at once, so a failed copy is never left unhandled
    // whichever way the open below goes.
    const imageCopied: Promise<boolean> | null =
      blob === undefined
        ? null
        : copyImageBlobPromiseToClipboard(Promise.resolve(blob)).then(
            () => true,
            () => false,
          );
    try {
      await openLink(xPostIntentUrl(text), "app", null);
    } catch {
      // X never opened, and the link open has already said so. Nothing was
      // shared: the dialog stays up and no post is recorded.
      return;
    }
    Analytics.getInstance().track(AnalyticsEvent.ShareXOpened, {
      line_id: selectedLine.id,
      edited,
      image: chosenImage ?? "none",
      char_count: length,
    });
    recordPosted(Date.now());
    if (imageCopied === null) {
      toast.success("Thanks for sharing Traycer");
    } else {
      void imageCopied.then((copied) => {
        if (copied) {
          toast.success("Image copied", {
            description: `Paste it into your post on X with ${pasteShortcut()}.`,
          });
        } else {
          toast.error("Couldn't copy the image");
        }
      });
    }
    close(true);
  }

  const page = Array.from(
    { length: Math.min(LINES_PER_PAGE, lines.length) },
    (_, offset) => {
      const position = (pageStart + offset) % lines.length;
      return { line: lines[position], position: position + 1 };
    },
  );

  return (
    <DialogContent
      layout="banded"
      // Every way out goes through `close`, which records the outcome; the
      // primitive's corner button would close without it.
      showCloseButton={false}
      className="w-[min(94vw,62rem)] sm:max-w-5xl"
      onInteractOutside={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        // While X is opening, the post is decided; `postOnX` closes.
        if (!opening) close(false);
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <XLogo className="size-4" />
          Share Traycer on X
        </DialogTitle>
        <DialogDescription>
          Pick a post and an image. Nothing is posted until you post it on X.
        </DialogDescription>
      </DialogHeader>

      <div className="grid min-w-0 grid-cols-1 gap-5 px-5 py-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-2.5">
          <div className="flex items-baseline gap-2 text-ui-xs font-medium text-muted-foreground">
            <span>1 · Pick a post</span>
            <span className="ml-auto font-normal">
              {String(LINES_PER_PAGE)} of {String(lines.length)} · edit any of
              them
            </span>
          </div>
          <div
            role="group"
            aria-label="Post to share"
            className="flex flex-col gap-2"
          >
            {page.map(({ line, position }) =>
              line.id === selectedLine.id ? (
                <div
                  key={line.id}
                  role="group"
                  aria-current="true"
                  aria-label={`Post ${String(position)}, selected`}
                  className="flex flex-col gap-2 rounded-lg border border-primary p-3 ring-1 ring-primary"
                >
                  <Textarea
                    aria-label="Post text"
                    value={text}
                    readOnly={opening}
                    rows={4}
                    onChange={(event) => {
                      const value = event.target.value;
                      setEdits((current) => ({ ...current, [line.id]: value }));
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={opening}
                      onClick={() => textCopy.copy(text)}
                    >
                      {textCopy.copied ? "Copied" : "Copy text"}
                    </Button>
                    <span
                      className={cn(
                        "ml-auto text-ui-xs tabular-nums",
                        length > X_POST_LIMIT
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {String(length)} / {String(X_POST_LIMIT)}
                    </span>
                  </div>
                </div>
              ) : (
                <button
                  key={line.id}
                  type="button"
                  // A post emptied by an edit still needs a name to be found.
                  aria-label={
                    (edits[line.id] ?? line.text).trim().length === 0
                      ? `Post ${String(position)}, empty`
                      : undefined
                  }
                  disabled={opening}
                  onClick={() => selectLine(line, position)}
                  className="rounded-lg border border-border p-3 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="line-clamp-2">
                    {edits[line.id] ?? line.text}
                  </span>
                </button>
              ),
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            disabled={opening}
            onClick={() => {
              // The selection moves with the page, so the post on screen is
              // always the one "Post on X" sends.
              const next = (pageStart + LINES_PER_PAGE) % lines.length;
              setPageStart(next);
              setSelectedId(lines[next].id);
            }}
          >
            Show {String(LINES_PER_PAGE)} others
          </Button>
        </section>

        <section className="flex min-w-0 flex-col gap-2.5">
          <div className="flex items-baseline gap-2 text-ui-xs font-medium text-muted-foreground">
            <span>2 · Add an image</span>
            <span className="ml-auto font-normal">optional</span>
          </div>
          {availableImages.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">
              Preparing images…
            </p>
          ) : (
            <div
              role="group"
              aria-label="Image to attach"
              className="grid grid-cols-2 gap-2.5"
            >
              {availableImages.map((image) => (
                <ShareImageTile
                  key={image}
                  image={image}
                  src={images[image]?.src ?? null}
                  selected={chosenImage === image}
                  disabled={opening}
                  onSelect={() =>
                    setSelectedImage((current) =>
                      current === image ? null : image,
                    )
                  }
                  onCopy={() => copyImage(image)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <DialogFooter className="flex-row items-center sm:justify-start">
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={dontAskAgain}
            disabled={opening}
            onCheckedChange={(checked) => setDontAskAgain(checked === true)}
          />
          <label
            htmlFor={checkboxId}
            className="text-ui-sm text-muted-foreground"
          >
            Don't ask me again
          </label>
        </div>
        <span className="ml-auto hidden text-ui-xs text-muted-foreground md:inline">
          {chosenImage === null
            ? null
            : `The image is copied when you post. Paste it into X with ${pasteShortcut()}.`}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={opening}
          onClick={() => close(false)}
        >
          Not now
        </Button>
        <Button
          type="button"
          disabled={opening}
          onClick={() => {
            void postOnX();
          }}
        >
          <XLogo className="size-3.5" />
          Post on X
        </Button>
      </DialogFooter>

      <ShareImageSources
        setUpHarnesses={harnesses}
        usage={usage}
        screenCapture={screenCapture}
        onCaptured={(image, captured) =>
          setImages((current) => ({ ...current, [image]: captured }))
        }
        onFailed={(image) => {
          // A screen that could not be framed is still offered as captured.
          if (image === "screen") return;
          setImages((current) => {
            const next = { ...current };
            delete next[image];
            return next;
          });
        }}
      />
    </DialogContent>
  );
}

function ShareImageTile(props: {
  readonly image: AnalyticsShareImage;
  readonly src: string | null;
  readonly selected: boolean;
  /**
   * Choosing and copying are held while X opens: the post is decided, and
   * its image may be on its way to the clipboard.
   */
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly onCopy: () => void;
}): ReactNode {
  const label = IMAGE_LABELS[props.image];
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg border p-1.5",
        props.selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <button
        type="button"
        aria-pressed={props.selected}
        aria-label={label}
        disabled={props.disabled}
        onClick={props.onSelect}
        className="overflow-hidden rounded-md bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none"
      >
        {props.src === null ? null : (
          <img
            src={props.src}
            alt=""
            className="aspect-video w-full object-cover object-top"
          />
        )}
      </button>
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-ui-xs font-medium">{label}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="ml-auto"
          aria-label={`Copy ${label}`}
          disabled={props.disabled}
          onClick={props.onCopy}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
