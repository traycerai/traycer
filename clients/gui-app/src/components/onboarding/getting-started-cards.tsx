import { ArrowRight, Check } from "lucide-react";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { useOpenLink, type OpenLink } from "@/lib/links/open-link";
import { cn } from "@/lib/utils";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import {
  type GettingStartedCardId,
  type GettingStartedEntry,
} from "@/components/onboarding/getting-started-checklist";
import "@/components/settings/panels/getting-started-settings.css";

/**
 * The card grid. `settings` is the Getting started page itself; `home` is the
 * Home tab's copy of it, which is denser because it sits above the task
 * sections, and carries no search anchors - both surfaces can be mounted at
 * once (Settings over Home), and the anchor reveal must land on the Settings
 * card.
 */
export function GettingStartedCards(props: {
  readonly entries: readonly GettingStartedEntry[];
  readonly surface: CardSurface;
}) {
  const navigate = useNavigate();
  const openLink = useOpenLink();
  const signInUrl = useRunnerHostOrNull()?.signInUrl;
  const downloadUrl = `${resolvePlatformBaseUrl(signInUrl === undefined || signInUrl.length === 0 ? "https://traycer.ai/sign-in" : signInUrl)}/download`;
  return (
    <div
      className={cn(
        "grid gap-3",
        cardGridColumns(props.surface, props.entries.length),
      )}
    >
      {props.entries.map((entry) => (
        <GettingStartedCardButton
          key={entry.card.id}
          entry={entry}
          surface={props.surface}
          onOpen={(event) => {
            openGettingStartedCard(entry.card.id, {
              navigate,
              openLink,
              downloadUrl,
              event,
            });
          }}
        />
      ))}
    </div>
  );
}

function openGettingStartedCard(
  id: GettingStartedCardId,
  ctx: {
    readonly navigate: UseNavigateResult<string>;
    readonly openLink: OpenLink;
    readonly downloadUrl: string;
    readonly event: {
      readonly altKey: boolean;
      readonly ctrlKey: boolean;
      readonly metaKey: boolean;
      readonly shiftKey: boolean;
      readonly button: number;
    };
  },
): void {
  switch (id) {
    case "provider":
      navigateToSettingsSection("providers");
      return;
    case "task":
      activateTabIntent(ctx.navigate, openNewEpicIntent(), undefined);
      return;
    case "secret":
      navigateToSettingsSection("secrets");
      return;
    case "install":
      void (async () => {
        try {
          await ctx.openLink(ctx.downloadUrl, "app", ctx.event);
        } catch (error) {
          ignoreError(error);
        }
      })();
      return;
    case "credits":
      navigateToSettingsSection("credits");
      return;
  }
}

type CardSurface = "settings" | "home";

/**
 * Settings lets the row find its own count. Home steps between whole rows
 * instead - four across, two by two, one - because Home can be a slim tile in
 * a wide window, and an auto-fit row there leaves a single card orphaned under
 * three. It reads its own width, not the viewport's, so the section around it
 * must be a `@container`.
 */
function cardGridColumns(surface: CardSurface, count: number): string {
  if (surface === "settings")
    return "grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))]";
  if (count === 4) return "grid-cols-1 @xs:grid-cols-2 @2xl:grid-cols-4";
  if (count === 5) return "grid-cols-1 @xs:grid-cols-2 @2xl:grid-cols-5";
  return "grid-cols-1 @lg:grid-cols-3";
}

/** How much air a card has, the other thing the two surfaces draw differently. */
const CARD_SPACING: Record<
  CardSurface,
  {
    readonly card: string;
    readonly header: string;
    readonly footer: string;
  }
> = {
  settings: {
    card: "p-5",
    header: "mb-6",
    footer: "pt-7",
  },
  home: {
    card: "p-4",
    header: "mb-3",
    footer: "pt-4",
  },
};

function GettingStartedCardButton(props: {
  readonly entry: GettingStartedEntry;
  readonly surface: CardSurface;
  readonly onOpen: (event: {
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly button: number;
  }) => void;
}) {
  const { card, presentation } = props.entry;
  const spacing = CARD_SPACING[props.surface];
  const anchored = props.surface === "settings";
  const { done, status, action } = presentation;
  const label = card.row.label;
  const description = card.row.description ?? "";
  return (
    <button
      type="button"
      data-settings-anchor={
        anchored ? (card.row.anchor ?? undefined) : undefined
      }
      data-testid={`getting-started-card-${card.id}`}
      onClick={props.onOpen}
      aria-label={[label, status].join(", ")}
      className={cn(
        "settings-setup-card group flex min-w-0 flex-col items-start overflow-hidden rounded-xl border border-border/60 bg-card/40 text-left transition-[background-color,border-color] duration-150 hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        spacing.card,
        done && "border-primary/20",
      )}
    >
      <div
        className={cn(
          "flex w-full items-center justify-between gap-2",
          spacing.header,
        )}
      >
        <card.icon
          className="size-5 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className={cn(
            "flex items-center gap-1.5 text-ui-xs",
            done ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {done ? (
            <Check
              className="size-3.5 text-[var(--term-ansi-green)]"
              aria-hidden="true"
            />
          ) : null}
          {status}
        </span>
      </div>
      <h2 className="text-ui-sm font-medium">{label}</h2>
      <p className="mt-1 text-ui-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <span
        className={cn(
          "mt-auto flex w-full items-center justify-between gap-2 text-ui-xs text-muted-foreground",
          spacing.footer,
        )}
      >
        {action}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </span>
    </button>
  );
}
