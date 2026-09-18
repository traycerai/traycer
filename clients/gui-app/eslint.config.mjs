import {
  js,
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../../eslint/flat-base.mjs";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactRefresh from "eslint-plugin-react-refresh";
import pluginQuery from "@tanstack/eslint-plugin-query";
import pluginRouter from "@tanstack/eslint-plugin-router";
import oxlint from "eslint-plugin-oxlint";
import { plugin as shadcn } from "@shadcn/lint";
import { traycerTypeSafetyRestrictions } from "../../eslint/traycer-type-safety-rules.mjs";
import { traycerClientsImportBoundaryRestrictions } from "../../eslint/traycer-clients-import-boundary-rules.mjs";
import {
  nestedFocusBoundaryRestrictions,
  tabNavigationStoreActionRestrictions,
} from "../../eslint/traycer-nested-focus-boundary-rules.mjs";
import {
  LINK_EGRESS_BRIDGE_RESTRICTIONS,
  LINK_EGRESS_DOM_RESTRICTIONS,
  LINK_EGRESS_HOOK_RESTRICTIONS,
  LINK_EGRESS_RESTRICTIONS,
  TILE_OPEN_RESTRICTIONS,
} from "../../eslint/traycer-tile-open-boundary-rules.mjs";
import {
  hostSelectionReadAllowlist,
  hostSelectionReadImportRestrictions,
  selectByIdRestrictions,
  selectionAuthorityRestrictions,
  selectionAuthorityWriteAllowlist,
  selectionKernelImportRestrictions,
  selectionKernelOwner,
} from "../../eslint/traycer-host-selection-layer-rules.mjs";
import {
  cloudBearerFenceGuiAllowlist,
  cloudBearerFenceRestrictions,
} from "../../eslint/traycer-cloud-bearer-fence-rules.mjs";

// ── IMPORT RESTRICTIONS ARE COMPOSED FROM DIMENSIONS. READ THIS BEFORE ADDING ONE. ──
//
// Flat config REPLACES a rule's options; it does not merge them. So the LAST
// block matching a file supplies that file's ENTIRE
// `no-restricted-imports` value, and a new block appended with a from-scratch
// value silently switches OFF every restriction the earlier blocks set for the
// files it matches. Lint stays green. That failure is invisible in both
// directions and this config has already produced it twice.
//
// The idiom that caused it was RESTATEMENT: each block hand-copied the ones
// before it and added its own patterns. Four dimensions in, one dropped line is
// a deleted boundary nobody can see. So the dimensions are named and composed
// instead:
//
//   boundary  - the cross-package import boundary. Every file, always.
//   posthog   - PostHog only through the typed adapter. All of `src`, except
//               the adapter and its own test.
//   readPath  - D12: no active-host / default-client hooks outside the
//               allowlisted layer (`hostSelectionReadAllowlist`, which
//               deliberately includes every test).
//   kernel    - F2: only `renderer-selection-kernel.ts` may name
//               `SelectionEvidenceKernel` at runtime.
//
// The file sets are NOT nested, they PARTITION - `hostSelectionReadAllowlist`
// covers `src/hooks/**`, `src/lib/host/**` and all tests, so those files carry
// a different set from the rest of `src`. That is why one broad "add my ban"
// block cannot work: it would need to include `readPath` for some of the files
// it matches and omit it for others.
//
// TO ADD A RESTRICTION: add a dimension below, then name it in the blocks whose
// file sets should carry it. Do NOT append a block with a hand-written value.
// To EXEMPT one file, add a block whose `files` is that single file and whose
// dimensions are its partition's minus the one being lifted.
const importRestrictionDimensions = {
  posthog: [
    {
      group: ["posthog-js", "posthog-js/*"],
      message:
        "Import PostHog only through the typed adapter in @/lib/analytics.",
    },
  ],
  readPath: hostSelectionReadImportRestrictions.patterns,
  kernel: selectionKernelImportRestrictions.patterns,
  // Overlay portal enforcement: portal behavior stays in the shadcn wrappers
  // in src/components/ui/**. Reaching past a wrapper to the raw primitive
  // skips focus/concealment/safe-area policy those wrappers own.
  //
  // Scoped by `importNames`, not a whole-package ban: each package also
  // exports plain utilities with no portal/overlay behavior of their own
  // (`Slot`, `useComposedRefs`, `toast`, cmdk's item/group sub-components)
  // that are legitimately imported outside `src/components/ui/**` today.
  overlayPortal: [
    {
      group: ["radix-ui"],
      importNames: [
        "AlertDialog",
        "ContextMenu",
        "Dialog",
        "DropdownMenu",
        "HoverCard",
        "Menubar",
        "NavigationMenu",
        "Popover",
        "Portal",
        "Select",
        "Toast",
        "Tooltip",
      ],
      message:
        "Overlay portal primitives are built only by the shadcn wrappers in src/components/ui/**. Use the wrapper - Dialog/Popover/Select/DropdownMenu/Tooltip/ContextMenu/HoverCard from @/components/ui/* - instead of importing the Radix primitive directly.",
    },
    {
      group: ["radix-ui/internal"],
      importNames: [
        "DismissableLayer",
        "FocusGuards",
        "FocusScope",
        "Menu",
        "Popper",
        "Presence",
        "Primitive",
        "RovingFocus",
      ],
      message:
        "These radix-ui/internal exports hand-build overlay behavior (positioning, dismiss, focus) outside the registered wrappers. Use the shadcn wrapper in src/components/ui/** instead. `useComposedRefs` and the other ref/state utilities are unrestricted.",
    },
    {
      group: ["vaul"],
      message:
        "vaul is wrapped by @/components/ui/sheet and @/components/ui/drawer, which register with the browser-tile occlusion coordinator. Use the wrapper instead of importing vaul directly.",
    },
    {
      group: ["@radix-ui/*"],
      message:
        "Radix primitive packages (@radix-ui/react-dialog, @radix-ui/react-dismissable-layer, ...) are wrapped by the shadcn components in src/components/ui/**. Use the wrapper instead of importing a @radix-ui/* package directly.",
    },
    {
      // `regex`, not `group`: `group` matching is gitignore-style (the
      // `ignore` package) - a slash-less pattern like "sonner" matches any
      // path whose LAST SEGMENT is "sonner", which caught our own
      // `@/components/ui/sonner` wrapper alias along with the bare "sonner"
      // package specifier. Anchored regex matches only the literal package.
      regex: "^sonner$",
      importNames: ["Toaster"],
      message:
        'The sonner <Toaster/> portal is mounted once by @/components/ui/sonner, which registers with the browser-tile occlusion coordinator. Import `toast` from "sonner" to trigger a toast; do not mount another <Toaster/>.',
    },
    {
      group: ["cmdk"],
      importNames: ["Command", "CommandDialog", "CommandRoot"],
      message:
        "The cmdk Command root is wrapped by @/components/ui/command, which registers with the browser-tile occlusion coordinator. Use the wrapper's exports instead of importing cmdk's Command directly.",
    },
  ],
};

/** The `boundary` dimension plus whichever others this file set carries. */
function importRestrictions(...dimensions) {
  return [
    "error",
    {
      ...traycerClientsImportBoundaryRestrictions,
      patterns: [
        ...(traycerClientsImportBoundaryRestrictions.patterns ?? []),
        ...dimensions.flatMap((name) => importRestrictionDimensions[name]),
      ],
    },
  ];
}

/** Every test file, in the two spellings the read-path allowlist already uses. */
const testFileGlobs = [
  "**/__tests__/**/*.{ts,tsx}",
  "**/*.{test,spec}.{ts,tsx}",
];

// ── The bracket forms `shadcn/no-arbitrary-values` sanctions ────────────────
//
// Four families, and everything outside them is a value that belongs on the
// theme's scale - where the rule's own message already names the class that
// carries it.
const sanctionedArbitraryValues = [
  // 1. The value IS a custom property, or is computed from one, so the theme
  // is still where it comes from: `bg-[var(--term-ansi-red)]` is the terminal
  // palette, `color-mix(… var(--foreground) …)` is a tint of a token, and
  // `env()` reads a value only the OS knows (the window-controls-overlay
  // inset - safe-area insets stay in `index.css`, per AGENTS.md).
  "*-[var(--*)]",
  "*-[color-mix(*)]",
  "*-[env(*)]",

  // 2. Fluid sizing, which AGENTS.md requires of layout surfaces: a computed
  // value, or a unit relative to the viewport, the container or the element's
  // own text. A fixed step off the spacing scale is what these exist not to be.
  "*-[min(*)]",
  "*-[max(*)]",
  "*-[calc(*)]",
  "*-[clamp(*)]",
  "*-[*%]",
  "*-[*vw]",
  "*-[*vh]",
  "*-[*dvw]",
  "*-[*dvh]",
  "*-[*svw]",
  "*-[*svh]",
  "*-[*lvh]",
  "*-[*ch]",
  "*-[*lh]",
  "*-[*em]",

  // 3. An arbitrary PROPERTY - `[container-type:inline-size]`,
  // `[mask-image:…]`, `[-webkit-app-region:no-drag]`,
  // `[--shimmer-text-color:…]`. Tailwind has no utility for these at all, so
  // there is no scale to be off. The second entry is the same thing under a
  // variant (`data-[x=y]:[mask-image:…]`): an entry containing a `:` is
  // matched against the whole token, variants included.
  //
  // Deliberately not narrowed to a list of properties, and the cost is stated
  // rather than overlooked: `[padding:13px]` passes here while `p-[13px]` does
  // not. Enumerating the properties Tailwind has no utility for would be a
  // list that goes stale every Tailwind release, and the escape is rare enough
  // (95 sites) that a reviewer sees each one. Narrow this if it ever becomes
  // the way an off-scale value gets in.
  "[*:*]",
  "*:[*:*]",

  // 4. Utilities whose bracket holds a property value rather than a point on a
  // scale: a track list, a flex shorthand, a timing function, a gradient, a
  // multi-layer shadow. There is no scale for the theme to offer.
  "transition-[*]",
  "will-change-[*]",
  "ease-[*]",
  "grid-cols-[*]",
  "grid-rows-[*]",
  "col-[*]",
  "row-[*]",
  "flex-[*]",
  "aspect-[*]",
  "content-[*]",
  "bg-size-[*]",
  "shadow-[*]",
  "drop-shadow-[*]",
  "bg-[linear-gradient(*)]",
  "bg-[radial-gradient(*)]",
  "bg-[conic-gradient(*)]",

  // 5. Two values the 4px spacing scale cannot express and the design does not
  // want rounded: the half-pixel hairline the tab chrome and the header rule
  // draw (`h-px` is visibly thinner, `h-0.5` visibly thicker), and the
  // half-pixel gap between the rate-limit gauge's bars.
  "*-[1.5px]",
  "*-[2.5px]",

  // 6. Unitless line-height ratios on the composer's inline chips, whose font
  // size is itself `em`-relative. A length here would pin the leading while
  // the text keeps scaling; the theme's `--text-*` line heights are lengths,
  // so there is no ratio to reach for.
  "leading-[1.1]",
  "leading-[1.2]",
];

// Files whose colors are deliberately NOT the theme's, so the arbitrary-value
// rule's "use a token" advice does not apply to them. Everything else about
// the rule still holds here - only `#rrggbb` is added to what they may write.
const fixedPaletteFiles = [
  // The theme editor and its inspector paint their own chrome in fixed colors
  // ON PURPOSE: they are the surface you edit the theme from, so chrome that
  // followed the draft would change under the cursor while you drag a slider.
  "src/components/settings/themes/theme-editor-panel.tsx",
  "src/components/settings/themes/theme-inspector.tsx",

  // Vendor brand marks. The fill IS the logo; a theme token would be wrong.
  "src/components/icons/editor-icons.tsx",

  // The tour's diorama: a fixed dark scene rendered inside `StandaloneShell`,
  // including a simulated macOS window's traffic lights. It does not follow
  // the app theme because it is a picture OF an app, not the app.
  "src/components/onboarding/onboarding-page.tsx",
  "src/components/onboarding/onboarding-diorama.tsx",
  "src/components/onboarding/onboarding-host-picker.tsx",
  "src/components/onboarding/onboarding-login-import-stage.tsx",
  "src/components/onboarding/onboarding-detected-agents.tsx",
];

// ── `shadcn/no-restyle`: the contract per design-system component ───────────
//
// The rule is ON for every file, with `allow: ["layout"]` as the default: a
// call site places a component (`w-full`, `mt-4`, `absolute`, `shrink-0`) and
// the component owns how it LOOKS. A component is then let back out of that
// default by a contract entry below.
//
// `notYetTightened` was the ratchet: one entry per family that had not been
// tightened yet, each allowing everything, so the list read as the checklist of
// what was left. **It is empty, and the rollout is done.** Every design-system
// component in this app is now either on the `layout` default or has a contract
// below that says exactly what a call site may still write and why.
//
// It is kept, rather than deleted, because `noRestyle` refuses an override that
// names a family still in it - a guard that costs an empty array and keeps
// working if a future component is ever added the same way. Adding an entry
// here is re-opening the ratchet, and needs the same thing closing one did: a
// ticket that takes it back out.
//
// Patterns are regexes and the LAST matching entry wins, so a part-level entry
// (`^DialogFooter$`) can speak after a family-level one, and `^Button$` - last
// of all - can never be shadowed. A contract is needed only where a part allows
// MORE than `layout`, or where it wants a `message` of its own; a component
// with neither is enforced by having no entry at all.
const notYetTightened = [];

// The 9 globs covering our 17 `--text-*` FONT SIZE tokens. They are listed
// here rather than inline because `no-restyle` needs them for the same reason
// `no-raw-colors` does, and for the same upstream bug (shadcn-ui/lint#8): the
// classifier reads `text-<name>` as a COLOUR whenever `--color-<name>` is
// undeclared, so a contract that allows `typography` still rejects
// `text-ui-sm`. Where a component's type step genuinely belongs to the site,
// the contract has to name these as well as the category. Delete the second
// use when #8 closes; the `no-raw-colors` one goes with it.
const fontSizeTokens = [
  "text-ui",
  "text-ui-*",
  "text-title-*",
  "text-code",
  "text-code-*",
  "text-badge",
  "text-display",
  "text-micro",
  "text-overline",
];

// ── The inline, in-flow primitives (ticket 05) ──────────────────────────────
//
// Every family the ticket-05 block used to hold, now on `layout` plus what it
// names. A family that is NOT here came out of that block with nothing left to
// allow - Checkbox, Switch, ButtonGroup, TreeChevron, ShortcutHint,
// LeaderDigitBadge, LivePulse, PingRing and ProgressToastIcon are all on the
// `layout` default, because once their variants landed no call site wrote
// anything else.
//
// The test for a by-name entry is the one Button's contract set: the reason has
// to be a fact about the SITE, not about the component. A reason that
// generalises should have been a variant.
const inlinePrimitiveContracts = [
  {
    // `rounded-full` — a pill badge is orthogonal to both axes, exactly as it
    // is on Button. `tabular-nums` — a digit-metrics hint (a count that ticks)
    // rather than a typeface choice. `capitalize` / `uppercase` — the CASE of
    // the label is a fact about the STRING being rendered: these sites show a
    // raw status id (`running`, `done`) that the design wants sentence-cased,
    // and the badge has no say in where the string came from. The four
    // `hover:` entries — a badge inside a clickable row lights up WITH the
    // row; which badges are inside one is the row's business, and the alphas
    // are the surface-independent spelling AGENTS.md requires.
    pattern: "^Badge$",
    allow: [
      "layout",
      "rounded-full",
      "tabular-nums",
      "capitalize",
      "uppercase",
      "hover:bg-foreground/5",
      "hover:bg-foreground/8",
      "hover:text-foreground",
      "hover:text-muted-foreground",
    ],
    message: {
      color:
        '"{{className}}" is not allowed on <Badge>: Badge owns its colour. Use a variant: {{variants}}. `muted` is the quiet metadata tag (thin border, muted label, body weight); `success` / `warning` / `info` / `destructive` are the four status roles on the tint recipe in AGENTS.md. Add a variant in {{file}} only if the design calls for a treatment none of these provides.',
      typography:
        '"{{className}}" is not allowed on <Badge>: the size carries the type ({{sizes}}) - `xs` is the dense metadata chip, `sm` the overline tag on a list row. `tabular-nums` is allowed, because a badge whose label is a changing NUMBER jitters without it. See {{file}}.',
      spacing:
        '"{{className}}" is not allowed on <Badge>: Badge owns its spacing. Use a size ({{sizes}}) and snap a near-miss to the closest one rather than writing padding here; the base already sets `gap-1`. For space AROUND the badge use margin here, or gap on the parent. See {{file}}.',
      shape:
        '"{{className}}" is not allowed on <Badge>: the size carries the corner radius ({{sizes}}). `rounded-full` is the one shape a caller may choose, for a pill. See {{file}}.',
      effects:
        '"{{className}}" is not allowed on <Badge>: Badge owns its effects. Elevation and rings belong to a variant in {{file}} ({{variants}}).',
      motion:
        '"{{className}}" is not allowed on <Badge>: Badge owns its motion - its `transition-all` already covers colour and shape. Animate a wrapper element if the motion is really the layout\'s. See {{file}}.',
      default:
        '"{{className}}" is not allowed on <Badge>: the grammar does not recognize it, so no rule can tell what it changes. Fix the spelling, or allow it by name in the Badge contract in eslint.config.mjs with the reason.',
    },
  },
  {
    // A Collapsible is a CONTAINER, so the two things a caller may still paint
    // on it are both about what surrounds it rather than about the disclosure:
    // the quiet colour and compact step its trigger and content INHERIT (which
    // is the whole reason to put them on the root instead of on each child),
    // and the rule between it and the sibling above or below, which only the
    // list knows about.
    pattern: "^Collapsible$",
    allow: [
      "layout",
      ...fontSizeTokens,
      "text-muted-foreground",
      "border-t",
      "border-b",
      "last:border-b-0",
      "border-border/40",
      "border-border/50",
      "border-border/60",
    ],
  },
  {
    // `truncate` is the row's width talking, not the label's type.
    pattern: "^Label$",
    allow: ["layout", "truncate"],
  },
  {
    // Same, one element down: a URL in an address bar is elided by the bar.
    pattern: "^InputGroupInput$",
    allow: ["layout", "truncate"],
  },
  {
    // The trigger is a row of TEXT - it is the heading of the section it
    // discloses - so its type step is that section's and is set where the
    // heading is. Everything about the BOX is a variant.
    pattern: "^CollapsibleTrigger$",
    allow: ["layout", "typography", ...fontSizeTokens],
  },
  {
    // The disclosed panel is a pure container; its padding lines the body up
    // with the surface it opens inside (a dialog's gutter, a card's inset),
    // which only that surface knows.
    pattern: "^CollapsibleContent$",
    allow: ["layout", "spacing"],
  },
  {
    // `tabular-nums` and the horizontal padding family only. The padding is
    // room for something the SITE puts inside the field - a leading search
    // icon, a trailing unit, a clear button - so the field cannot know how much
    // it needs. Everything else is a `variant`, a `size` or `font="mono"`.
    // `bg-background` is the one colour: an input on a TINTED surface (the
    // sidebar) restates the page background so the field still reads as a
    // field rather than as part of the panel.
    pattern: "^Input$",
    allow: [
      "layout",
      "tabular-nums",
      "px-*",
      "pl-*",
      "pr-*",
      "ps-*",
      "pe-*",
      "bg-background",
    ],
    message: {
      color:
        '"{{className}}" is not allowed on <Input>: Input owns its colour. `variant="bare"` is the field drawn by something ELSE (an InputGroup, a find bar), which is what "no border, no fill" means here. See {{file}}.',
      typography:
        '"{{className}}" is not allowed on <Input>: the size carries the type ({{sizes}}) and `font="mono"` carries the face. The default is `text-ui md:text-ui-sm` on purpose - 16px on mobile is what stops iOS zooming a focused field - so reach for `size="sm"` only where the whole surface is compact chrome. See {{file}}.',
      spacing:
        '"{{className}}" is not allowed on <Input>: Input owns its spacing. Use a size ({{sizes}}); `pl-*` / `pr-*` are allowed, for room for an icon or an affordance the site places inside the field. See {{file}}.',
      shape:
        '"{{className}}" is not allowed on <Input>: the size carries the corner radius, and `variant="bare"` squares them for a field inside another box. See {{file}}.',
      effects:
        '"{{className}}" is not allowed on <Input>: Input owns its focus ring and its invalid state; `variant="bare"` is the one that cancels them. See {{file}}.',
      motion:
        '"{{className}}" is not allowed on <Input>: Input owns its motion. See {{file}}.',
      default:
        '"{{className}}" is not allowed on <Input>: the grammar does not recognize it. Fix the spelling, or allow it by name in the Input contract in eslint.config.mjs with the reason.',
    },
  },
  {
    // The reveal family, for the same reason it is on Button: which ancestor's
    // hover shows the clear/copy button in an address bar, and under which
    // `group/<name>`, is a fact about the GROUP. `pointer-coarse:` is the
    // accessibility half of it - a control revealed on hover has to be
    // permanently visible where there is no hover - and a `motion-reduce:`
    // cancel is never a lint rule's to delete.
    pattern: "^InputGroupButton$",
    allow: [
      "layout",
      "opacity-*",
      "transition-[color,opacity]",
      "transition-opacity",
      "duration-*",
      "motion-reduce:*",
      "pointer-coarse:opacity-*",
      "group-hover/*",
      "group-focus-within/*",
      "focus-visible:opacity-*",
    ],
  },
  {
    // `tabular-nums` as on Button - a chord that counts (`⌘1` … `⌘9`) must not
    // jitter. `text-code-xs` - a cap rendered INLINE in code-metric text (an
    // env editor's row, a model id) matches that line's metrics; the cap is
    // punctuation inside someone else's sentence.
    pattern: "^Kbd$",
    allow: ["layout", "tabular-nums", "text-code-xs"],
  },
  {
    // `bg-input` - the divider between GROUPED controls takes the control
    // border token rather than the page rule, which is `<ButtonGroup>`'s fact
    // about its children, not the separator's.
    pattern: "^Separator$",
    allow: ["layout", "bg-input"],
  },
  {
    // A skeleton is a stand-in for something that is not there yet, so its
    // radius is a fact about the THING it replaces - a circular avatar, a
    // square chip, a card - and no variant can know that. The opacity is the
    // same argument one level up: a placeholder STACK fades toward the back to
    // read as depth, which is a fact about the stack.
    pattern: "^Skeleton$",
    allow: ["layout", "rounded", "rounded-*", "opacity-*"],
  },
  {
    // Text primitives: they own a geometry (a sweeping highlight band, start-
    // side truncation) and nothing about the text itself. The type and the
    // colour belong to the sentence the component is rendering, which is the
    // site's. `--shimmer-text-color` is the sanctioned custom-property form
    // (ticket 02) and the `group-*` spellings of it are a fact about which row
    // is hovered.
    pattern: "^Shimmer$|^WorkingShimmerText$",
    allow: [
      "layout",
      "typography",
      ...fontSizeTokens,
      "[--shimmer-text-color:*]",
      "*:[--shimmer-text-color:*]",
    ],
  },
  {
    // `StartTruncatedText` is the LEAF that renders the text - there is no
    // element between it and the glyphs - so unlike the spinner it cannot
    // "inherit" anything a caller would otherwise set. It owns direction and
    // the truncation geometry; the type and the colour are the sentence's.
    pattern: "^StartTruncatedText$",
    allow: ["layout", "typography", "color", "focus-visible:outline-none"],
  },
  {
    // `leading-*` - a textarea holding PROSE sets its own leading; the type
    // ramp's line heights are tuned for one-line fields. Everything else is a
    // `variant`, a `size` or `font="mono"`, exactly as on Input.
    pattern: "^Textarea$",
    allow: ["layout", "leading-*"],
  },
];

// ── Dialog, tightened in ticket 06 ──────────────────────────────────────────
//
// The family had 377 findings, and 330 of them were one composition written
// out by hand: a header band, a body and a footer band, assembled from `p-0
// gap-0` on the content plus borders, padding and a fill restated on each
// band. Fifteen dialogs did it, and they disagreed - `px-5` fourteen times and
// `px-6` twelve, `border-border/40` nine times and `/70` four, `bg-foreground/2`
// five and `/3` five. `<DialogContent layout="banded">` is that composition
// with one name, and `DialogHeader` / `DialogFooter` read it off the content
// through `group-data-[layout=banded]`.
//
// The other defaults the numbers moved: `DialogTitle` to `font-semibold`
// (22 sites added it) and `leading-snug` (15 - `leading-none` is too tight for
// a title that wraps), `DialogDescription` to `leading-relaxed` (14). Sixteen
// titles also restated `text-ui` and thirty descriptions restated `text-ui-sm`
// / `text-muted-foreground`, which the defaults already carried; five more
// wrote `text-base`, which is the same 1rem. A title that genuinely wanted
// another rank - six sites, in both directions - gets `size`.
//
// What each part still allows is a fact about the SITE, not about the part:
//
//   - every `*Content` keeps `layout`, because sizing an overlay IS the
//     caller's job (`max-w-2xl`, and the safe-area classes that cap it
//     against the device region). The safe-area utilities are hand-written, so
//     the grammar cannot categorize them and they are named here.
//   - `gap-*` and `space-y-*` on Header, Title and Footer: the rhythm between
//     a title and its description, or between an icon and the words beside
//     it, is a fact about what the caller put INSIDE the part. No variant can
//     know how many children there are.
//   - `truncate` / `text-pretty` on Title and Description: what a long string
//     does when it runs out of room is the site's problem - a filename in a
//     viewer's header truncates, a sentence in a body does not.
//   - `rounded-none` and the `max-[28rem]:` pair on Footer: a dialog that
//     goes edge to edge at the bottom of a phone gives up its corner radius
//     and takes the home-indicator inset. That is a fact about the viewport,
//     not about the footer.
const dialogContracts = [
  {
    pattern: "^DialogContent$",
    // No safe-area utility is named here, deliberately. The plugin cannot
    // resolve a hand-written class, so each one it is given prints a warning
    // on every lint run, and no DialogContent site needs one today - the
    // primitive already caps itself against the safe region
    // (`max-w-[min(...,var(--safe-area-width))]`, `top-safe-center-y`). A
    // caller that genuinely needs one gets an error naming the class and adds
    // it here with its reason, which is the ratchet working.
    allow: ["layout"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <DialogContent>: the dialog owns its padding. A dialog whose header and footer are bands - their own padding, edge to edge - is `layout="banded"`, which is what `p-0 gap-0` used to build by hand. See {{file}}.',
      color:
        '"{{className}}" is not allowed on <DialogContent>: the dialog owns its surface. `bg-popover` is the raised-surface fill every preset defines distinctly; a translucent or muted variation of it disappears in the preset darks (see the raised-surface rule in clients/gui-app/AGENTS.md). See {{file}}.',
      shape:
        '"{{className}}" is not allowed on <DialogContent>: the dialog owns its corners ({{variants}}). A dialog that goes edge to edge on a phone says so on its footer. See {{file}}.',
      default:
        '"{{className}}" is not allowed on <DialogContent>: the grammar does not recognize it. If it is a safe-area utility, add it to the DialogContent contract in eslint.config.mjs; otherwise fix the spelling.',
    },
  },
  {
    pattern: "^DialogHeader$",
    allow: ["layout", "gap-*", "space-y-*"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <DialogHeader>: the header owns its padding. In a banded dialog (`<DialogContent layout="banded">`) it is a band with its own; in a padded one the content\'s padding is the header\'s. `gap-*` and `space-y-*` are yours, because only you know what is inside. See {{file}}.',
    },
  },
  {
    pattern: "^DialogFooter$",
    allow: [
      "layout",
      "gap-*",
      "rounded-none",
      "max-[28rem]:rounded-b-none",
      "max-[28rem]:pb-safe-bottom-gutter",
    ],
    message: {
      spacing:
        '"{{className}}" is not allowed on <DialogFooter>: the footer owns its band. `<DialogContent layout="banded">` gives it edge-to-edge padding; without it the footer negative-margins out of the content\'s own. `gap-*` between the buttons is yours. See {{file}}.',
      color:
        '"{{className}}" is not allowed on <DialogFooter>: the band\'s fill is `bg-foreground/5`, an alpha of the foreground rather than `bg-muted`, because every preset dark defines `--muted` equal to `--popover` and a muted band vanishes on the dialog. See the raised-surface rule in clients/gui-app/AGENTS.md.',
    },
  },
  {
    pattern: "^DialogTitle$",
    allow: ["layout", "gap-*", "truncate"],
    message: {
      typography:
        '"{{className}}" is not allowed on <DialogTitle>: the title owns its type. Use `size` - `sm` for a viewer\'s filename, `lg` for a full-page composer - rather than `text-*` or `font-*` here. `text-base` is the default `text-ui` under another name. See {{file}}.',
      spacing:
        '"{{className}}" is not allowed on <DialogTitle>: `gap-*` is allowed, for a title that lays out an icon beside its words; padding belongs to the header around it. See {{file}}.',
    },
  },
  {
    pattern: "^DialogDescription$",
    allow: ["layout", "gap-*", "text-pretty"],
    message: {
      typography:
        '"{{className}}" is not allowed on <DialogDescription>: the description owns its type - `text-ui-sm leading-relaxed text-muted-foreground`, which is what restating those three used to produce. `text-pretty` is allowed, since how a sentence breaks is about the sentence. See {{file}}.',
    },
  },
];

// ── DropdownMenu, tightened in ticket 06 ────────────────────────────────────
//
// Only the parts that allow MORE than `layout` need an entry: the rule's
// default is already `allow: ["layout"]`, so deleting `^DropdownMenu` from
// `notYetTightened` is what enforces Content, Label, Trigger, Separator and
// Shortcut. The entries below exist for the two things a menu part cannot own
// and for the messages that name the real fix.
//
// 63 of the family's 133 findings were on **Label**, and they were one
// section-heading treatment restated fourteen times - `uppercase` ×14,
// `text-overline` ×11, `tracking-wide` ×11, `text-muted-foreground/70` ×6 -
// with three sites reaching for `text-ui-xs font-medium` instead and three
// dropping the tracking. The default carries it now (see `ui/dropdown-menu.tsx`)
// and every one of those overrides is gone; the remaining nine labels, which
// had no class at all, were already the same kind of heading and now look like
// one.
//
// Three more defaults moved on the same evidence: a `muted` item variant for
// the quiet row (3 sites wrote `text-muted-foreground`), `aria-disabled:` beside
// the primitive's `data-disabled:` dimming (2 sites wrote `opacity-50` / `-60`
// on a SOFT-disabled row, which Radix leaves undimmed because it is not really
// disabled), and a checked tint on the radio and checkbox rows (a chosen row
// said so with a check glyph alone, which two sites had hand-filled - one with
// `bg-accent/70`, the fill AGENTS.md rules out inside a popover).
const dropdownMenuContracts = [
  {
    // Every tappable ROW. `gap-*` is the caller's for the same reason it is on
    // `DialogHeader`: the rhythm between an icon, a label and a trailing
    // timestamp is a fact about what the caller put inside the row, and no
    // variant can know how many children there are. Padding is not - the rows
    // of one menu have to line up with each other and with the label above
    // them.
    pattern:
      "^DropdownMenu(Item|CheckboxItem|RadioItem|SubTrigger|Group|RadioGroup)$",
    allow: ["layout", "gap-*", "space-y-*"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <{{component}}>: the menu owns its row rhythm - every row in every menu is `px-1.5 py-1`, and a roomier one pulls its own menu out of step with the rest of the app. `gap-*` between a row\'s own children is yours. See {{file}}.',
      color:
        '"{{className}}" is not allowed on <{{component}}>: use `variant` - `muted` for a quiet row, `destructive` for one that destroys something. A row that is the CURRENT choice is a `DropdownMenuRadioItem`, which tints itself. A hand-written `bg-accent/*` fill is also the one AGENTS.md rules out on a raised surface. See {{file}}.',
      effects:
        '"{{className}}" is not allowed on <{{component}}>: a dimmed row is a disabled row. Radix dims `disabled` items itself, and a SOFT-disabled row (`aria-disabled`, so it stays focusable and can explain itself) is dimmed by the primitive too - do not write the opacity here. See {{file}}.',
    },
  },
  {
    // A submenu holding a form or a paragraph rather than rows takes
    // `layout="panel"`, which is what `p-2 gap-3` and `p-3 space-y-3` were
    // building by hand at the two sites that needed it.
    pattern: "^DropdownMenuSubContent$",
    allow: ["layout", "gap-*", "space-y-*"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <DropdownMenuSubContent>: a submenu of ROWS is `layout="menu"` (the default) and one holding a form or a paragraph is `layout="panel"`. `gap-*` and `space-y-*` between the panel\'s children are yours. See {{file}}.',
    },
  },
];

// ── Popover, tightened in ticket 06 ────────────────────────────────────────
//
// The same story as Dialog's, one surface down: 34 of the family's 83 findings
// were `p-0` (19) and `gap-0` (15) - a popover whose CONTENT draws its own
// edges, said by cancelling the popover's - and the four largest panels added
// `rounded-xl overflow-hidden` on top of that. Three more sites restated
// `p-2.5` / `gap-2.5`, which is what the default already sets. So the box is a
// `layout` prop with three values (`padded`, `bare`, `panel`; see
// `ui/popover.tsx`) and the contract allows none of it.
//
// `gap-*` is deliberately NOT allowed here, unlike on `DialogHeader`:
// `PopoverContent` IS the flex column, so `gap-0` is how "the content draws its
// own rhythm" was being said, and allowing the category would leave 15 sites
// writing the layout by hand beside the prop that names it.
//
// The two `PopoverTrigger` findings were both a BUTTON drawn by hand - a border,
// a fill, a hover, a focus ring and a transition, on a Radix trigger that
// renders a bare `<button>`. They are `asChild` + `<Button>` now, which is the
// shadcn idiom and puts them under Button's contract instead of needing one
// here.
const popoverContracts = [
  {
    pattern: "^PopoverContent$",
    // The docking pair is a fact about the SITE: the worktree branch picker
    // opens flush against the field it belongs to, so the edge the two meet on
    // gives up its radius. Which edge depends on which way the popover flipped,
    // which is why it is written as a `data-[side=*]` pair rather than chosen.
    allow: [
      "layout",
      "data-[side=bottom]:rounded-t-none",
      "data-[side=top]:rounded-b-none",
    ],
    message: {
      spacing:
        '"{{className}}" is not allowed on <PopoverContent>: the popover owns its box. Use `layout` - `padded` (the default) when the popover IS the surface, `bare` when the content draws its own edges, `panel` for a wide surface with its own header and footer bands. See {{file}}.',
      shape:
        '"{{className}}" is not allowed on <PopoverContent>: the popover owns its corners. `layout="panel"` is the larger radius, for a plate big enough that `rounded-lg` reads as a sharp corner. See {{file}}.',
      color:
        '"{{className}}" is not allowed on <PopoverContent>: the popover owns its surface. `bg-popover` is the raised-surface fill every preset defines distinctly, and a muted or translucent variation of it disappears in the preset darks (see the raised-surface rule in clients/gui-app/AGENTS.md). See {{file}}.',
      typography:
        '"{{className}}" is not allowed on <PopoverContent>: the popover sets `text-ui-sm` for everything inside it. A denser block inside a popover sets its own type on the block, not on the plate around it. See {{file}}.',
    },
  },
];

// ── Tabs, tightened in ticket 06 ───────────────────────────────────────────
//
// The family already had the two styles it needed - a filled track
// (`variant="default"`) and a strip of underlined tabs (`variant="line"`) -
// and every `line` list in the app then drew the RULE it sits on by hand.
// Four of them, disagreeing: `border-border/60` three times and `border-border`
// once, `pb-1.5` twice and `pb-2` once, with `rounded-none` and `px-0` restated
// on top of what the variant already implies. The rule is the variant's now.
//
// The other half was a compact strip: five triggers across three surfaces
// wrote `text-ui-xs`, two of them with `px-2.5 py-0` beside it. That is a
// `size` on the LIST - read by the triggers through `group-data-[size=sm]` -
// so a tab bar cannot be half one size and half the other.
//
// `Tabs` and `TabsContent` allow `spacing` outright, for the reason ticket 05
// gives `CollapsibleContent`: they are pure containers with no box of their
// own, and the inset that lines a pane up with the surface it opens inside - a
// settings panel's gutter, a dialog's - is that surface's fact. There is
// nothing there for a contract to protect.
const tabsContracts = [
  {
    pattern: "^Tabs$|^TabsContent$",
    // `opacity-*` and its transition, exactly as on Button: a pane that is
    // INERT while a mutation runs fades, and whether a pane is inert is a fact
    // about the surface driving it, not about tabs.
    allow: [
      "layout",
      "spacing",
      "opacity-*",
      "transition-opacity",
      "duration-*",
    ],
  },
  {
    // How far apart the tabs sit depends on how many there are and how long
    // their labels run, which is the caller's.
    pattern: "^TabsList$",
    allow: ["layout", "gap-*"],
    message: {
      color:
        '"{{className}}" is not allowed on <TabsList>: the list owns its surface. `variant="default"` is the filled track, `variant="line"` the strip above a rule - the rule included. See {{file}}.',
      shape:
        '"{{className}}" is not allowed on <TabsList>: the variant owns the corners. `line` is already square, because a strip above a rule has no track to round. See {{file}}.',
      spacing:
        '"{{className}}" is not allowed on <TabsList>: the variant owns the strip\'s own padding and `size` its height ({{sizes}}). `gap-*` between the tabs is yours. See {{file}}.',
    },
  },
  {
    pattern: "^TabsTrigger$",
    allow: ["layout"],
    message: {
      typography:
        '"{{className}}" is not allowed on <TabsTrigger>: the LIST carries the type, through `size` - `sm` is the compact strip. Setting it per trigger is how a tab bar ends up half one size and half the other. See {{file}}.',
      spacing:
        "\"{{className}}\" is not allowed on <TabsTrigger>: the list's `size` carries the tab's padding, and `gap-*` on the list carries the space between tabs. See {{file}}.",
      color:
        '"{{className}}" is not allowed on <TabsTrigger>: the list\'s `variant` carries the active treatment - a fill on `default`, an underline on `line`. See {{file}}.',
    },
  },
];

// ── Command, tightened in ticket 06 ────────────────────────────────────────
//
// Two props carry what the family's 43 findings were writing by hand.
//
// `variant="embedded"` is the palette mounted inside a surface that already
// drew a plate - a popover, a pane - so it contributes none of its own. Five
// surfaces said that as some subset of `rounded-none bg-transparent p-0` and
// disagreed about which parts to include; the missing third is exactly why two
// of them then restored the row gutter on the list.
//
// `selection="flat"` is the OTHER kind of list: a picker of values, where a row
// can be the CHOSEN one as well as the one under the cursor. The primitive
// marks the cursor with the primary, which is also how a chosen row reads, so
// two pickers cancelled the lift by hand - both with `bg-accent`, the fill
// AGENTS.md rules out on a raised surface. 153 of the app's 155 items want the
// lift, so it stays the default.
//
// About a third of the rest were restates of the item default (`px-2`,
// `py-1.5`, `text-ui-sm`, `hover:text-foreground`,
// `data-[selected=true]:text-foreground`) and deleted with no visual change.
const commandContracts = [
  {
    // A pure container: `max-h`, scrolling and nothing else. The row gutter
    // inside it is the caller's, for the same reason `CollapsibleContent`'s
    // inset is - an embedded palette's rows line up with the surface around
    // them, which only that surface knows.
    pattern: "^CommandList$",
    allow: ["layout", "spacing"],
  },
  {
    pattern: "^CommandItem$|^CommandGroup$",
    allow: ["layout", "gap-*", "space-y-*"],
    message: {
      color:
        '"{{className}}" is not allowed on <{{component}}>: the row owns its states. The keyboard cursor is `selection` on the <Command> around it - `lifted` (the default) for a list of actions, `flat` for a picker whose chosen row is already marked in the primary. A hand-written `bg-accent/*` is also the fill AGENTS.md rules out on a raised surface. See {{file}}.',
      spacing:
        '"{{className}}" is not allowed on <{{component}}>: the palette owns its row rhythm, and `variant="embedded"` is how a palette gives up its own plate and gutter to the surface around it. `gap-*` inside a row is yours. See {{file}}.',
      shape:
        '"{{className}}" is not allowed on <{{component}}>: the row owns its corners, and they already answer to the surface - a palette inside a dialog rounds further than one inside a popover. See {{file}}.',
      effects:
        '"{{className}}" is not allowed on <{{component}}>: a dimmed row is a disabled row, which the primitive already dims. See {{file}}.',
    },
  },
];

// ── Sheet and Drawer, tightened in ticket 06 ───────────────────────────────
//
// These two ARE the exception the Dialog contract records: they name their
// safe-area classes, and they pay a warning per entry for it on every lint run
// ("Contract entry "pb-safe-bottom" is not a category …", because the plugin
// cannot resolve a hand-written class). Dialog does not, because no dialog
// needed one and the warnings bought nothing. These do: five sheets and a
// drawer take `pb-safe-bottom` today, the primitives deliberately leave the
// edge they are anchored to alone so the CONTENT can pad itself, and
// `clients/gui-app/AGENTS.md` mandates those classes. A lint rule must never be
// the reason one gets deleted.
//
// `gap-*` is the caller's on the content, unlike on `PopoverContent`. The
// difference is what the class was saying: a popover's `gap-0` came with `p-0`
// as one composition, at nineteen sites, and is now a `layout`. A sheet's is
// just a gap - four of the app's nine sheets hold a single scroll region and
// set their own rhythm inside it, which is the same argument `DialogHeader`
// makes.
//
// Drawer's 35 findings were almost entirely NOT call sites: 33 of them were
// `ui/drawer.tsx` itself, reported because the rules resolve `vaul`'s
// `Drawer.Content` back to the name `DrawerContent`. See the `ignoreImports`
// note in the settings block below.
// One pattern string, shared with the per-file override below. An override's
// `pattern` is matched against a contract's pattern STRING, not against the
// component name - so an override that spelled this `"^SheetFooter$"` would
// find no contract to widen, fall back to the bare `layout` default, and
// silently TIGHTEN the part it meant to open.
const SHEET_BAND_PATTERN =
  "^SheetHeader$|^SheetFooter$|^SheetTitle$|^SheetDescription$|^DrawerHeader$|^DrawerFooter$|^DrawerTitle$|^DrawerDescription$";

const sheetContracts = [
  {
    pattern: "^SheetContent$|^DrawerContent$",
    allow: ["layout", "gap-*", "pb-safe-bottom"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <{{component}}>: the bands inside it own their padding - `{{component}}Header`, `{{component}}Footer` - and the edge it is anchored to is left bare on purpose, so the content can pad itself. `gap-*` between the bands and `pb-safe-bottom` for the home indicator are yours. See {{file}}.',
      color:
        '"{{className}}" is not allowed on <{{component}}>: it owns its surface. `bg-popover` is the raised-surface fill every preset defines distinctly (see the raised-surface rule in clients/gui-app/AGENTS.md). See {{file}}.',
    },
  },
  {
    pattern: SHEET_BAND_PATTERN,
    allow: [
      "layout",
      "gap-*",
      "space-y-*",
      "truncate",
      "text-pretty",
      "pb-safe-bottom",
      "pb-safe-bottom-gutter",
    ],
    message: {
      spacing:
        '"{{className}}" is not allowed on <{{component}}>: the band owns its padding, and `pe-12` for the close button is read off the content rather than set here. `gap-*` between the band\'s own children, and the safe-area bottom inset, are yours. See {{file}}.',
    },
  },
];

// ── The last six families, tightened in ticket 06 ──────────────────────────
//
// Small enough to read together, and each is one idea.
//
// **Sidebar** (19). `SidebarGroup`'s default moved from `p-2` to `px-2 py-1`:
// the group holds rows that carry their own vertical padding, and all four of
// the app's real panels wrote that out while all four of their SKELETONS kept
// `p-2` - so a panel shifted 4px the moment it finished loading. The default
// fixes the skeletons for free. `space-y-*` on the group's content is the
// caller's, and `SidebarContent`'s `gap-0` was a restate.
//
// **Tooltip** (14). Nine of the fourteen were one `TooltipTrigger` drawn as a
// button by hand - a box, a focus ring, a type step - now `asChild` +
// `<Button>`. The rest is `gap-*` inside a two-line label, and `font-mono` for
// a tooltip whose content is a PATH: what is being labelled is code, which the
// tooltip cannot know.
//
// **DropLine** (9). Both allowances are facts about the moment rather than
// about the line: the entrance animation belongs to the thing that just
// appeared, and a line flush against a rail's edge squares the side it meets.
//
// **Card** (5). `size="lg"` for the full-screen centred status card - the boot
// card and the error screen were setting `py-6` and `py-8` on the CONTENT to
// get it, and disagreeing. `shadow-*` by name for the same reason Button
// allows it: elevation is about where the card floats, not what it is.
//
// **HoverCard** (5). The content owns the SURFACE and nothing else - the
// padding lives on `HOVER_PREVIEW_SCROLL_CLASS`, which a caller may or may not
// use - so what is inside the card is the caller's and the card's fill,
// border and elevation are not.
//
// **ContextMenu** (4). The same two changes its sibling menu took: a
// soft-disabled row dims on `aria-disabled:` too, and a submenu holding a
// control rather than rows is `layout="panel"`.
const tailContracts = [
  {
    pattern: "^SidebarGroupContent$|^SidebarContent$|^SidebarGroup$",
    allow: ["layout", "gap-*", "space-y-*"],
  },
  {
    pattern: "^TooltipContent$",
    allow: ["layout", "gap-*", "font-mono"],
    message: {
      typography:
        '"{{className}}" is not allowed on <TooltipContent>: the tooltip owns its type. `font-mono` is allowed, because whether the LABEL is a path or a command is a fact about what is being labelled. See {{file}}.',
    },
  },
  {
    // The entrance animation is a fact about the thing that just appeared -
    // a tab becoming active, a row taking the drop - not about the line, and
    // `ease-spring` is a hand-written easing in `index.css`.
    pattern: "^DropLine$",
    allow: [
      "layout",
      "animate-in",
      "fade-in",
      "slide-in-from-*",
      "duration-*",
      "ease-spring",
      // A line flush against a rail's edge squares the side it meets.
      "rounded-l-none",
      "rounded-r-none",
      "rounded-l",
      "rounded-r",
    ],
  },
  {
    // Elevation is about WHERE the card floats, exactly as on Button: the one
    // site is a status card floating over a booting app.
    pattern: "^Card$",
    allow: ["layout", "shadow-xs", "shadow-sm", "shadow-md", "shadow-lg"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <Card>: the card owns its band. Use `size` ({{sizes}}) - `lg` is the full-screen centred status card. See {{file}}.',
    },
  },
  {
    pattern: "^CardContent$|^CardHeader$|^CardFooter$",
    allow: ["layout", "gap-*", "space-y-*"],
  },
  {
    // The card is a SURFACE: it owns its fill, its border and its elevation,
    // and nothing else. A caller that does not use `HOVER_PREVIEW_SCROLL_CLASS`
    // supplies the inset and the type itself, because the card never had them.
    pattern: "^HoverCardContent$",
    allow: ["layout", "spacing", "typography", ...fontSizeTokens],
  },
  {
    pattern:
      "^ContextMenuItem$|^ContextMenuCheckboxItem$|^ContextMenuRadioItem$|^ContextMenuSubTrigger$|^ContextMenuGroup$",
    allow: ["layout", "gap-*", "space-y-*"],
    message: {
      effects:
        '"{{className}}" is not allowed on <{{component}}>: a dimmed row is a disabled row, and the primitive dims both a Radix-`disabled` and a SOFT-disabled (`aria-disabled`) one. See {{file}}.',
    },
  },
  {
    pattern: "^ContextMenuSubContent$",
    allow: ["layout", "gap-*", "space-y-*"],
    message: {
      spacing:
        '"{{className}}" is not allowed on <ContextMenuSubContent>: a submenu of ROWS is `layout="menu"` (the default) and one holding a control is `layout="panel"`. See {{file}}.',
    },
  },
];

// ── Button, the one family that IS enforced ─────────────────────────────────
//
// `layout` plus four named classes. Each is a treatment the component cannot
// own, measured across all 310 call sites rather than assumed:
//
//   - `opacity-*` / `transition-opacity` — the hover-reveal pattern (~45
//     sites). Which ancestor's hover reveals the button, and under which
//     `group/<name>`, is a fact about the ROW, not about the button, so no
//     variant can carry it. `opacity-*` also covers the per-site disabled
//     weights (`disabled:opacity-30`) for the same reason.
//   - `header-tab-close-button` — the same reveal, written in CSS because it
//     needs `:has()` (see `index.css`). One site; allowed rather than
//     categorized, since the grammar cannot see a hand-written class at all.
//   - `rounded-full` — a circular icon button (12 sites: the avatar trigger,
//     chip removes, the reaction row). It is orthogonal to both axes - every
//     size is a rounded rect and every variant can be round - so it is a
//     shape the caller picks, not a variant.
//   - `text-current` — not a colour CHOICE but a refusal to make one: the
//     control takes the colour of the sentence it sits in (the inline
//     "Report issue" action inside an error paragraph). A variant would have
//     to name a colour, which is the opposite of what these sites want.
//   - `shadow-*` — elevation belongs to WHERE the button is, not to what it
//     is: the six sites are all `absolute` / `fixed` buttons floating over
//     content (the artifact image affordance, the scroll-to-bottom pill, the
//     modal's corner close). The same button in flow must not carry it, which
//     is why it is not in a variant.
//   - `font-normal` — a Button used as a full-width LIST ROW (`w-full
//     justify-start text-left`) carries body weight; `font-medium` is for a
//     label on a control-shaped button. Four sites today, and the shape
//     recurs. Nothing else about the type is a caller's to set.
//   - `tabular-nums` — a digit-metrics hint, not a typeface choice: a button
//     whose label is a changing NUMBER (the zoom percentage, a page counter)
//     jitters without it. It changes no size, weight or family.
//   - `duration-*` and `motion-reduce:*` — the reveal's companions. A timing
//     travels with the transition it times, and a `motion-reduce:` cancel is
//     an accessibility affordance: a lint rule must never be the reason one
//     gets deleted. With every `transition-*` but `transition-opacity` still
//     denied, a duration here has nothing to lengthen but the reveal.
//   - `underline` / `underline-offset-*` — the other half of `text-current`.
//     A control that takes the colour of the sentence around it has no colour
//     cue left, so the underline is the only thing saying it is a control,
//     and `link`'s hover-only underline does not say it at rest.
//   - `rounded-l-none` / `rounded-r-none` — one end of a segmented control.
//     The flattened edge is a fact about the GROUP, and `<ButtonGroup>` says
//     it for direct children; a Button wrapped in a span so a disabled
//     control keeps its tooltip is not one, and the group's `>` selector
//     never reaches it.
//
// Everything else is a variant or a size in `src/components/ui/button.tsx`.
const buttonContract = {
  pattern: "^Button$",
  allow: [
    "layout",
    "opacity-*",
    "transition-opacity",
    "duration-*",
    "motion-reduce:*",
    "header-tab-close-button",
    "rounded-full",
    "rounded-l-none",
    "rounded-r-none",
    "text-current",
    "underline",
    "underline-offset-*",
    // The elevation steps only - not `shadow-none` (which would be removing a
    // variant's own treatment) and not a coloured `shadow-<token>/<alpha>`.
    "shadow-xs",
    "shadow-sm",
    "shadow-md",
    "shadow-lg",
    "font-normal",
    "tabular-nums",
  ],
  // These REPLACE the rule's own text, so each one has to carry at least as
  // much as the default did - the class, the component, the real variant or
  // size list, and the file to extend - and then add what only we know: which
  // variant means what, and that a near-miss padding is snapped to the
  // nearest size rather than written out here.
  message: {
    color:
      '"{{className}}" is not allowed on <Button>: Button owns its colour. Use a variant: {{variants}}. `muted` is the quiet toolbar/row button (muted label, foreground on hover), `destructive-ghost` reads as dangerous at rest, `muted-destructive` only on hover. `text-current` is allowed where the button must take the colour of the text around it. Add a variant in {{file}} only if the design calls for a treatment none of these provides.',
    typography:
      '"{{className}}" is not allowed on <Button>: the size carries the type. Pick the size whose font size you want ({{sizes}}) instead of setting `text-*` / `font-*` / `tabular-nums` here; if the label needs type the sizes do not have, it is not a Button label. See {{file}}.',
    spacing:
      '"{{className}}" is not allowed on <Button>: Button owns its spacing. Use a size ({{sizes}}) - `inline` / `inline-xs` are the no-box sizes for a control inside a line of text - and snap a near-miss to the closest one rather than writing padding here. For space AROUND the button use margin here, or gap on the parent. Add a size in {{file}} only if no existing size is close.',
    shape:
      '"{{className}}" is not allowed on <Button>: the size carries the corner radius ({{sizes}}). `rounded-full` is the one shape a caller may choose, for a circular icon button. See {{file}}.',
    effects:
      '"{{className}}" is not allowed on <Button>: Button owns its effects. `opacity-*` and `transition-opacity` are allowed, because only the parent row knows when a button is revealed; a shadow or a ring belongs to a variant in {{file}} ({{variants}}).',
    motion:
      '"{{className}}" is not allowed on <Button>: Button owns its motion, apart from `transition-opacity` for the reveal pattern. Its `transition-all` already covers colour and shape changes; animate a wrapper element if the motion is really the layout\'s. See {{file}}.',
    // `default` is what an UNCLASSIFIED class falls back to - the schema has
    // no `unclassified` key - and it is the only one of these the rule's own
    // text could not have written, since it is advice about this config.
    default:
      '"{{className}}" is not allowed on <Button>: the grammar does not recognize it, so no rule can tell what it changes. Fix the spelling, or - if it is a hand-written class in `index.css` - allow it by name in the Button contract in eslint.config.mjs with the reason.',
  },
};

const tightenedContracts = [
  ...dialogContracts,
  ...dropdownMenuContracts,
  ...popoverContracts,
  ...tabsContracts,
  ...commandContracts,
  ...sheetContracts,
  ...tailContracts,
  ...inlinePrimitiveContracts,
  buttonContract,
];

/**
 * The rule, with EXTRA entries added to ONE tightened contract for one file
 * set. `extras` is a list of `{ pattern, allow }`, where `pattern` names the
 * contract to widen (`"^Button$"`, `"^Badge$"`, …).
 *
 * Deliberately not `"shadcn/no-restyle": "off"` for those files, which is the
 * shape ticket 03's overrides took: turning the rule off would also stop
 * checking their spacing, their sizes and every component added to them later,
 * to let one class through. A widened contract keeps everything else enforced
 * and says in the override exactly which door is open.
 *
 * The widened entry is APPENDED rather than substituted in place. Contracts
 * are matched from the END, so the copy carrying the extra classes is the one
 * that answers.
 *
 * A family with no tightened contract is on the `layout` default, and widening
 * that is exactly as meaningful - the synthesized entry says so. What is
 * refused is a family still in `notYetTightened`: that contract already allows
 * everything, so an exemption naming one would be a line nobody could ever
 * delete, and the widened copy would in fact TIGHTEN it by accident.
 */
function noRestyle(extras) {
  const widened = extras.flatMap((extra) => {
    if (
      notYetTightened.some((contract) => contract.pattern === extra.pattern)
    ) {
      throw new Error(
        `restyleExemptions names ${extra.pattern}, which is still permissive.`,
      );
    }
    const base = tightenedContracts.find(
      (contract) => contract.pattern === extra.pattern,
    );
    const allow = base === undefined ? ["layout"] : base.allow;
    return [
      {
        ...(base ?? { pattern: extra.pattern }),
        allow: [...allow, ...extra.allow],
      },
    ];
  });
  return [
    "error",
    {
      allow: ["layout"],
      contracts: [...notYetTightened, ...tightenedContracts, ...widened],
    },
  ];
}

// ── The Buttons that are allowed out of part of the contract, per FILE ─────
//
// One entry per file, and `allow` names exactly which categories it opens, so
// everything else about Button stays enforced there. Deliberately NOT
// `"shadcn/no-restyle": "off"` the way ticket 03's overrides are shaped:
// turning the rule off would also stop checking that file's sizes and every
// Button added to it later, to let one class through.
//
// A file appears ONCE. Flat config is last-block-wins and each of these
// becomes its own block, so a file listed twice would silently keep only the
// second list - the hazard the note at the top of this file describes for
// `no-restricted-imports`, in miniature.
//
// Each reason is a fact about the SITE, not about the component. That is the
// test for belonging here: if the reason generalises, it should have been a
// variant.
//
// `contracts` names the family being widened, because a file can need one door
// open on two components. It has to name a TIGHTENED contract - `noRestyle`
// throws on a pattern with no contract to widen, so a typo or a family that is
// still permissive fails the config rather than silently doing nothing.
const restyleExemptions = [
  {
    // Not the theme's colours at all, and already exempt from `no-raw-colors`
    // for the same reason: the sign-in hero paints on `StandaloneShell`'s
    // fixed dark artwork (white button, near-black label, in BOTH
    // appearances), and the theme editor paints its own chrome in fixed
    // colours on purpose, so the chrome does not change under the cursor
    // while you drag a slider.
    files: ["src/components/layout/header/sign-in/device-code-progress.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // A SOLID status pip: `rounded-full bg-info text-white`, the update badge
    // in the header. Button's four status variants are the quiet shape (the
    // role's foreground on no fill); a solid one would be a variant per role
    // used once each, which is the trade the ticket says not to make.
    files: ["src/components/layout/header/app-update-button.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // Buttons that CANCEL a variant's own state, which no allow list can
    // express. The sidebar header's chevron carries `aria-expanded` as a
    // PERSISTENT panel state rather than "a menu is open right now", so the
    // variant's `aria-expanded:bg-foreground/8` would leave it permanently
    // lit; the rail's active treatment is a bottom indicator rather than a
    // filled tile, and a contract test asserts that fill is absent.
    files: [
      "src/components/epic-canvas/sidebar/epic-sidebar-header.tsx",
      "src/components/epic-canvas/sidebar/epic-sidebar-rail.tsx",
    ],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // A corner pill straddling the dialog edge and the overlay dim, so it
    // needs an OPAQUE fill; `outline` is the near miss and carries
    // `dark:bg-input/30`, which the dim shows through in every dark theme.
    files: ["src/components/epic-canvas/sidebar/new-conversation-modal.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // A quiet FILLED button (`bg-foreground/8 text-foreground`) and a disabled
    // state that repaints the pill grey rather than fading the primary. The
    // filled-quiet shape is one site, and the disabled repaint belongs to this
    // composer's send control rather than to Button.
    files: ["src/components/home/composer/composer-send-button.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // A resting fill on the pointer-coarse actions trigger, where the glyph
    // has to read as a button before it is tapped.
    files: ["src/components/chat/chat-message-user-body.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // `in-data-[slot=dialog-content]:bg-input/60`: secondary, but re-tinted
    // when this panel is mounted inside a dialog, because the Traycer Green
    // preset gives popovers and secondary buttons the same value. A variant
    // cannot be conditional on the surface it lands on.
    files: ["src/components/home/composer/terminal-launch-panel.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // Two `warning-ghost` buttons side by side, one of which is the confirm;
    // the border and fill are the only thing telling them apart. A bordered
    // status variant for one pair is the trade the ticket says not to make.
    files: ["src/components/home/worktree/worktree-scripts-dialog.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color"] }],
  },
  {
    // A popover-shaped ISLAND painted onto a Button: this file's sibling
    // `desktop-zoom-level-island` is a div carrying the same border, fill,
    // popover foreground, shadow and padding, and the reset control repeats
    // it because it happens to hold one control. The honest fix is to wrap it
    // in that island div, which moves the hover fill from the island to an
    // inset rect - a restructure with a visible result, so it is its own
    // change rather than this ticket's.
    files: ["src/components/layout/bridges/desktop-zoom-controller.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color", "spacing"] }],
  },
  {
    // A Button used as a ROW carries the row's padding, because the row is
    // what has to stay clickable: shrinking the hit area to the label would
    // be a real regression. The mobile drawer is one step up the whole ramp
    // for the 44px touch floor (`gap-3 px-3` rows); the next-step card's
    // `py-2 pr-10 pl-1` is its hit target and the positioning context of the
    // copy button that floats over it, which also needs an opaque scrim so
    // its glyph stays legible over the wrapped text underneath; and
    // `@max-[30rem]:px-0` folds a row's stop control to an icon when its
    // CONTAINER narrows, which no size can be conditional on.
    files: ["src/components/layout/shell/mobile-nav-drawer.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["spacing"] }],
  },
  {
    files: ["src/components/chat/segments/next-steps-action-group.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["color", "spacing"] }],
  },
  {
    files: ["src/components/home-focus/home-focus-rows.tsx"],
    contracts: [{ pattern: "^Button$", allow: ["spacing"] }],
  },
  {
    // The last row of a settings list whose `<li>`s are `px-5 py-2.5`, with
    // the list's own top divider on it, so its padding, its squared corners
    // and that divider all line up with siblings it does not own.
    //
    // And the sheet's footer rule: this sheet's body is a SCROLL region, so
    // the footer is a fixed band the content runs under and needs an edge the
    // scrolling content stops at. A sheet whose body is short does not, which
    // is why the rule is not the footer's default.
    files: ["src/components/settings/browser-settings-section.tsx"],
    contracts: [
      { pattern: "^Button$", allow: ["color", "shape", "spacing"] },
      {
        pattern: SHEET_BAND_PATTERN,
        allow: ["border-t", "border-border/60"],
      },
    ],
  },
  {
    // A stand-in for the web platform's own `alert` / `confirm` / `prompt`, for
    // a browser tile that cannot show the native ones. The dialog's MESSAGE is
    // the body text rather than a subtitle - it is the whole reason the sheet
    // opened - so it takes the foreground rather than the muted tone a
    // description carries.
    files: ["src/components/browser-tile/browser-peek-tile.tsx"],
    contracts: [{ pattern: "^SheetDescription$", allow: ["color"] }],
  },
  {
    // The mobile sidebar is the app's NAVIGATION surface reflowed into a sheet,
    // not a raised overlay on top of one: it takes the page background so the
    // panel inside it reads exactly as it does when docked, and `--sidebar-*`
    // paints the rest.
    files: ["src/components/ui/sidebar.tsx"],
    contracts: [{ pattern: "^SheetContent$", allow: ["color"] }],
  },

  // ── ticket 05: the inline primitives' tail ────────────────────────────────
  {
    // A badge that floats OVER something rather than sitting in the flow, so
    // it needs an opaque plate the ambient variants deliberately do not have:
    // a shortcut chip over the command list, an edge label over the graph
    // canvas, an agent role chip over a sidebar row that is itself tinted.
    // `agent-role-badges` also takes `border-current/30`, which is the row's
    // colour and not a colour at all.
    files: [
      "src/components/command-palette/palette-cmdk.tsx",
      "src/components/epic-canvas/comm-graph/comm-graph-edge.tsx",
      "src/components/epic-canvas/sidebar/agent-role-badges.tsx",
    ],
    contracts: [{ pattern: "^Badge$", allow: ["color", "effects", "shape"] }],
  },
  {
    // The worktree list's badges say what a row IS about to become - swept,
    // pending, provisional - and a DASHED border is how this panel has said
    // "not yet real" since it shipped. A dashed status variant per role is the
    // trade the ticket says not to make.
    files: ["src/components/settings/panels/worktrees-settings-panel.tsx"],
    contracts: [{ pattern: "^Badge$", allow: ["color", "shape"] }],
  },
  {
    // A PR state pill dimmed to say the PR is closed, and a metadata chip that
    // restates the card's own plate so it reads on the PR row's fill.
    files: [
      "src/components/epic-canvas/pr/pr-state-pill.tsx",
      "src/components/worktree/worktree-pr-metadata.tsx",
    ],
    contracts: [{ pattern: "^Badge$", allow: ["color", "effects"] }],
  },
  {
    // Disclosure triggers whose colour is the SEGMENT's state, not the
    // trigger's: a failed interview turns its own header red, a segment row
    // carries the tool's own error colour, and the comm-graph row is
    // deliberately quieter than every other trigger because a graph row is
    // mostly chrome.
    files: [
      "src/components/chat/segments/resolved-interview-card.tsx",
      "src/components/chat/segments/segment-row.tsx",
      "src/components/epic-canvas/comm-graph/comm-graph-event-row.tsx",
    ],
    contracts: [
      {
        pattern: "^CollapsibleTrigger$",
        allow: ["color", "effects", "spacing", "focus-visible:outline-*"],
      },
    ],
  },
  {
    // A trigger that IS the top edge of a card: its corners have to meet the
    // card's, and its bottom rule is the card's divider. Both are facts about
    // the card, and `subagent-segment` additionally paints the header as its
    // own raised surface while the body stays flat.
    files: [
      "src/components/chat/segments/segment-card.tsx",
      "src/components/chat/segments/subagent-segment.tsx",
    ],
    contracts: [
      { pattern: "^CollapsibleTrigger$", allow: ["color", "shape", "effects"] },
      { pattern: "^Collapsible$", allow: ["color"] },
    ],
  },
  {
    // The sign-in hero's fixed dark artwork again (see the Button entry for
    // `device-code-progress`): this disclosure is painted in white alphas in
    // BOTH appearances, and falls back to theme tokens off that surface.
    files: ["src/components/layout/header/sign-in/device-code-fallback.tsx"],
    contracts: [
      { pattern: "^CollapsibleTrigger$", allow: ["color", "spacing"] },
      { pattern: "^Collapsible$", allow: ["color"] },
    ],
  },
  {
    // A settings section whose rows are `px-5 py-3`: the trigger is one of
    // those rows and has to line up with siblings it does not own, and its
    // open body is a recessed well inside the section.
    files: ["src/components/settings/panels/host-settings-disclosure.tsx"],
    contracts: [
      { pattern: "^CollapsibleTrigger$", allow: ["color", "spacing"] },
      { pattern: "^CollapsibleContent$", allow: ["color"] },
    ],
  },
  {
    // A queued message is shown at 95% while it waits its turn - the one place
    // in the transcript where "not yet sent" is said with opacity.
    files: ["src/components/chat/queued-message-surface.tsx"],
    contracts: [{ pattern: "^Collapsible$", allow: ["effects"] }],
  },
  {
    // The generated-image disclosure: a bordered well under its own header.
    files: [
      "src/components/chat/segments/image-generation/image-generation.tsx",
    ],
    contracts: [{ pattern: "^CollapsibleContent$", allow: ["color", "shape"] }],
  },
  {
    // Two doors, both about this toolbar. The Button one is a resting
    // ghost-weight fill applied by a CONTAINER QUERY
    // (`@[26rem]/viewport:bg-foreground/5`), so the control reads as a select
    // field only once its toolbar is wide enough, which no variant can be
    // conditional on. The Input one is the zoom field, which reads as a chip
    // until it is focused rather than as something to fill in.
    files: ["src/components/browser-tile/browser-viewport-toolbar.tsx"],
    contracts: [
      { pattern: "^Button$", allow: ["color"] },
      { pattern: "^Input$", allow: ["color"] },
    ],
  },
  {
    // Fields whose VALUE is placeholder-grade: the font-size control shows the
    // inherited size in muted text when nothing is set, and the custom-provider
    // dialog mutes a row it is showing back rather than asking for. Both are
    // the STATE of that one field; a `read-only:` rule in `input.tsx` would
    // restyle every read-only input in the app, which is a design change and
    // not this ticket's.
    files: [
      "src/components/settings/controls/nullable-font-size-input.tsx",
      "src/components/settings/panels/provider-custom-model-provider-dialog.tsx",
    ],
    contracts: [{ pattern: "^Input$", allow: ["color"] }],
  },
  {
    // An input used as the TITLE of the thing being edited - it is the
    // heading, and it keeps the heading's type when it turns into a field.
    files: ["src/components/settings/panels/provider-skill-detail-dialog.tsx"],
    contracts: [
      { pattern: "^Input$", allow: ["typography", ...fontSizeTokens] },
      { pattern: "^Label$", allow: ["spacing"] },
    ],
  },
  {
    // The theme editor's own chrome, in fixed colours on purpose, as its
    // Button entry above already says.
    files: ["src/components/settings/themes/theme-editor-panel.tsx"],
    contracts: [
      { pattern: "^Button$", allow: ["color"] },
      { pattern: "^Input$", allow: ["color", "typography"] },
    ],
  },
  {
    // A dialog whose field sits directly on the popover plate, so its border
    // steps off THAT surface rather than the page; the paste well behind it is
    // the same decision one element down.
    files: ["src/components/settings/themes/theme-import-dialog.tsx"],
    contracts: [
      { pattern: "^Input$", allow: ["color"] },
      { pattern: "^Textarea$", allow: ["color"] },
      { pattern: "^SelectTrigger$", allow: ["color", "effects"] },
    ],
  },
  {
    // A script editor: a code well that fills its row, with its own gutter and
    // a focus ring drawn INSIDE the box because the box is flush with the
    // dialog's edge.
    //
    // And the FRAME around it: one box per OS, with the tab strip as that
    // box's header. The frame, its fill and the header's rule belong to the
    // panel being drawn rather than to the tabs, which is why they are on the
    // root and the list rather than reachable by a variant;
    // `focus-within:border-ring` lights the whole frame when the editor inside
    // it takes focus.
    files: ["src/components/workspaces/repo-scripts-fields.tsx"],
    contracts: [
      {
        pattern: "^Textarea$",
        allow: ["color", "spacing", "effects", "focus-visible:ring-inset"],
      },
      {
        pattern: "^Tabs$|^TabsContent$",
        allow: ["color", "shape", "focus-within:border-ring"],
      },
      { pattern: "^TabsList$", allow: ["color", "shape", "spacing"] },
    ],
  },
  {
    // A Button used as a full-width settings ROW, the same argument as the
    // mobile nav drawer's: the row is what has to stay clickable, so its
    // padding belongs on the clickable element rather than on a wrapper. The
    // named colour is the other half of a SOFT-disabled control - it stays
    // focusable (`aria-disabled`, not `disabled`) so a screen reader can reach
    // it and hear why, and a control that looks unavailable must not light up
    // under the pointer. Its four surface presentations - rail, panel header,
    // field, inline - come from a record in the file, which is the class-site
    // blind spot ticket 09 owns rather than a door opened here.
    files: ["src/components/settings/host-scope/host-switcher.tsx"],
    contracts: [
      {
        pattern: "^Button$",
        allow: ["spacing", "aria-disabled:hover:bg-transparent"],
      },
    ],
  },
  {
    // The tab colour swatch: an `asChild` context-menu item whose child IS the
    // control - a native `<input type="color">` stretched over the swatch it
    // recolours - so the row's own padding would inset the thing the row is.
    files: ["src/components/layout/tabs/tab-appearance-menu.tsx"],
    contracts: [
      {
        pattern:
          "^ContextMenuItem$|^ContextMenuCheckboxItem$|^ContextMenuRadioItem$|^ContextMenuSubTrigger$|^ContextMenuGroup$",
        allow: ["p-0"],
      },
    ],
  },
  {
    // The mobile tab switcher's strip, whose indicator cannot be the
    // primitive's. The mobile shell's coarse-pointer hit-slop stylesheet
    // claims every trigger's single `::after`, so on touch that pseudo is the
    // (transparent) slop rather than the underline - the trigger draws its own
    // `::before` one and cancels the default fill in the primitive's exact
    // spelling so `cn()` drops it rather than out-specifying it. The file says
    // all of this at the call site, at length. `no-scrollbar` is a hand-written
    // class in `index.css` for a strip that scrolls horizontally.
    files: ["src/components/epic-canvas/mobile/switcher-category-tabs.tsx"],
    contracts: [
      { pattern: "^TabsList$", allow: ["no-scrollbar", "spacing"] },
      {
        pattern: "^TabsTrigger$",
        allow: ["color", "effects", "motion", "shape"],
      },
    ],
  },
  {
    // Two doors in one file, because a file may appear here only once.
    //
    // The browser address bar: a field that is invisible until you approach
    // it, so the whole treatment is a hover/focus-within transition on the
    // GROUP. The control inside it renders a URL, which is a path, in the
    // group's own gutter.
    //
    // And the ZOOM BAND in its overflow menu: a bordered strip holding a label
    // and three square steppers, which is not a list of rows and does not want
    // the row rhythm. The steppers stay `DropdownMenuItem`s because that is
    // what puts them in the menu's arrow-key ring - a `<button>` inside the
    // menu would be unreachable from the keyboard - so the band's own chrome
    // has to live on the group and its buttons' box on the items. Named
    // classes rather than categories.
    files: ["src/components/epic-canvas/renderers/browser-tile-toolbar.tsx"],
    contracts: [
      { pattern: "^InputGroup$", allow: ["color", "effects", "motion"] },
      { pattern: "^InputGroupInput$", allow: ["spacing"] },
      {
        pattern:
          "^DropdownMenu(Item|CheckboxItem|RadioItem|SubTrigger|Group|RadioGroup)$",
        allow: ["border", "border-border", "border-y", "p-0", "px-2", "py-2"],
      },
    ],
  },
  {
    // The command palette's own search box and its keycaps: both are painted
    // for the POPOVER plate they sit on (`color-mix` against `--popover`,
    // because `--input` alone disappears there), and a selected command row
    // lifts its keycap with the row.
    files: ["src/components/ui/command.tsx"],
    contracts: [
      { pattern: "^InputGroup$", allow: ["color"] },
      { pattern: "^Kbd$", allow: ["color"] },
    ],
  },
  {
    // The required-field asterisk is a pseudo-element the FORM adds to a
    // label, so it is the form's mark rather than the label's colour.
    files: ["src/components/layout/dialogs/desktop/report-issue-dialog.tsx"],
    contracts: [{ pattern: "^Label$", allow: ["after:text-destructive"] }],
  },
  {
    // A hashed profile accent carried as a CSS custom property - ticket 02's
    // sanctioned form for a colour that is DATA - with the one fixed near-black
    // that is legible on every hue it can produce.
    files: ["src/components/providers/profile-avatar-badge.tsx"],
    contracts: [
      { pattern: "^AvatarFallback$", allow: ["color", "typography"] },
    ],
  },
  {
    // An avatar on the PR list's own plate: the ring cut-out has to be filled
    // with the page background or the overlap shows through.
    files: ["src/components/epic-canvas/pr/pr-detail-avatar.tsx"],
    contracts: [{ pattern: "^Avatar$", allow: ["color"] }],
  },
  {
    // Skeleton rows standing in for a DIFF: the added/removed counts keep
    // their status tint while loading, because the shape of the change is
    // known before its contents are.
    files: [
      "src/components/epic-canvas/git-diff/diff-bundle-loading-skeleton.tsx",
    ],
    contracts: [{ pattern: "^Skeleton$", allow: ["color"] }],
  },
  {
    // The reasoning-effort slider is a bespoke control built ON the primitive:
    // four hand-written classes in `index.css` (`reasoning-effort-*`) carry a
    // glow, a gradient range and a pill thumb that no variant of a generic
    // slider should have.
    files: ["src/components/home/pickers/harness-model-picker-footers.tsx"],
    contracts: [
      { pattern: "^Slider$", allow: ["spacing", "reasoning-effort-*"] },
      {
        pattern: "^SliderTrack$",
        allow: ["motion", "effects", "reasoning-effort-*"],
      },
      { pattern: "^SliderRange$", allow: ["color", "reasoning-effort-*"] },
      { pattern: "^SliderThumb$", allow: ["shape"] },
    ],
  },
  {
    // A filter list inside a popover is ONE dense block: its rows are 2px
    // apart, not the 8px a settings form uses.
    files: [
      "src/components/chat/composer/menu/github-mention-filter-popover.tsx",
    ],
    contracts: [{ pattern: "^RadioGroup$", allow: ["spacing"] }],
  },
  {
    // Radios on a tinted sub-panel, where `--input` is the panel's own fill
    // and the control would vanish into it.
    files: ["src/components/home/worktree/repo-branch-prefix-section.tsx"],
    contracts: [{ pattern: "^RadioGroupItem$", allow: ["color"] }],
  },
  {
    // The provider re-auth banner picks a MODEL: the options are ids the user
    // compares character by character, so they are set in the code face at the
    // banner's own compact step.
    files: ["src/components/chat/composer/provider-reauth-banner.tsx"],
    contracts: [
      { pattern: "^SelectTrigger$", allow: ["font-mono"] },
      { pattern: "^SelectItem$", allow: ["typography", ...fontSizeTokens] },
    ],
  },
  {
    // A Select rendered as a filter CHIP in a wizard's toolbar rather than as
    // a form field: pill-shaped, quiet at rest, and lifting on hover the way
    // the chips beside it do.
    files: ["src/components/session-import/session-import-wizard.tsx"],
    contracts: [
      {
        pattern: "^SelectTrigger$",
        allow: ["color", "shape", "spacing", "effects"],
      },
    ],
  },
  {
    // The discovery popover replaces Radix's default open/close animation and
    // the plate's ring with its own scale/opacity keyframes and box-shadow
    // (onboarding-diorama.css's sibling stylesheet, onboarding-agents.css),
    // driven by `data-motion`/`data-visible` rather than the `layout` prop -
    // no `layout` value expresses "cancel the ring for a hand-drawn shadow".
    files: ["src/components/onboarding/onboarding-provider-discovery.tsx"],
    contracts: [
      {
        pattern: "^PopoverContent$",
        allow: ["shape", "onboarding-discovery-popover"],
      },
    ],
  },
];

// ── App-wide host reads that are RIGHT where they are, exempted per FILE. ──
//
// `readPath` (D12) bans the app-wide reads across the Epic canvas subtree and
// `src/hooks/epic/**` (see the allowlist note in
// `traycer-host-selection-layer-rules.mjs`). Each file below carries a reason
// an app-wide read is the correct one THERE; a file without a reason does not
// belong here, and a reason that stops being true retires its line. Single
// files, never a directory: a directory glob would let the next file dropped
// in inherit the exemption unread.
const epicCanvasAppWideReadExemptions = [
  // The canvas host hook's own documented FALLBACK for a surface rendered
  // outside any Epic session (a Markdown reference outside a canvas); inside a
  // session the fallback is unreachable. It is the mechanism the rest of the
  // subtree resolves through, so it is the one place the read may live.
  "src/components/epic-canvas/hooks/use-canvas-host-id.ts",
  // Clone-not-migrate (D5/D7): the clone TARGET is, by design, the host the
  // app is now pointed at - a dead tile's chat is cloned onto the effective
  // host. Reading anything else here would clone onto a host nobody chose.
  "src/components/epic-canvas/renderers/use-chat-clone-on-host-switch.ts",
];

// `src/hooks/epic/**` hooks that resolve the app-wide client BY CALLER: each is
// mounted only from an app-wide surface (the epics list, the home page, the
// tab strip, the epic route above its session), never from inside an Epic
// session. A caller inside a session must use the session-scoped sibling or a
// `…ForClient` variant - never add a session-mounted call site to one of these.
const hooksEpicAppWideByCallerExemptions = [
  // Home page history (`hooks/home/use-history-query.ts`).
  "src/hooks/epic/use-epic-get-task-contexts-query.ts",
  // Epics list panel.
  "src/hooks/epic/use-task-delete-worktree-candidates-query.ts",
  "src/hooks/epic/use-epic-title-mutation.ts",
  "src/hooks/epic/use-epic-batch-delete-mutation.ts",
  // Epics list panel + tab strip.
  "src/hooks/epic/use-epic-set-pinned-mutation.ts",
  // Tab strip.
  "src/hooks/epic/use-epic-task-pinned-states-query.ts",
  // Sweep-worktrees dialog (app-wide).
  "src/hooks/epic/use-epic-sweep-worktree-candidates-query.ts",
  // Mounted by the epic ROUTE, above the session provider; its reader (the
  // home page's recents) is on the same app-wide client.
  "src/hooks/epic/use-epic-record-viewed-mutation.ts",
  // `useEpicCreateChat` is the composer PLACEMENT seam (ruled app-wide, with a
  // pre-flight host fence); every session-scoped hook in this file already
  // resolves `useEpicSessionHostClient` or takes a client.
  "src/hooks/epic/use-epic-chat-mutations.ts",
];

// The dead-tile "open in editor" opener is a FOLLOWING surface with no picker
// of its own (selection model §2), local-only by its own gate.
const followingSurfaceAppWideReadExemptions = [
  "src/components/worktree/open-in-editor-button.tsx",
];

// App chrome: mounted once above the shell split in `traycer-app.tsx`, so it is
// not inside any tab, Epic session, or picker surface whose host it could read
// instead. Session import runs against the host the app is pointed at, and the
// single subscription it owns outlives every wizard that watches it.
const appChromeAppWideReadExemptions = [
  "src/components/session-import/session-import-run-controller.tsx",
  // Mounted once at the app root, outside any `<TabHostProvider>`. `hostId`
  // null means follow the app-wide default (which may be remote) so auto-open
  // can match the picker's create-profile gate.
  "src/components/providers/provider-profile-add-flow-host.tsx",
  // The "Search chats" dialog: mounted once at the root route beside the
  // system-tab modal host, outside any tab, Epic session or picker. It
  // searches the host the app is pointed at and routes every result to a tab
  // bound to that same host, so the effective host is the only right read.
  "src/components/chat-search/chat-search-panel.tsx",
];

// Hook directories whose every RPC now takes the caller's client, because
// their surfaces are Epic-scoped (a tile's comments, a tile's snapshot
// blobs, a session's terminals) and the app-wide read they used to launder
// was invisible to `readPath`: the fence only sees a file's own imports, so
// a wrapper hook resolving `useHostClient()` on behalf of an Epic surface
// passed it. Re-impose `readPath` here so a new wrapper cannot re-open that
// channel (PR #1243 round 6, the hook-INDIRECTION half of the class).
const hookDirectoriesRepointedToCallerClients = [
  "src/hooks/comments/**/*.{ts,tsx}",
  "src/hooks/snapshots/**/*.{ts,tsx}",
  "src/hooks/terminal/**/*.{ts,tsx}",
  "src/hooks/editor/**/*.{ts,tsx}",
];

// `useEditorOpen`, the app-wide convenience wrapper kept for the following
// surface above (`open-in-editor-button.tsx`); every Epic-scoped caller uses
// `useEditorOpenForClient`.
const hookWrapperAppWideReadExemptions = [
  "src/hooks/editor/use-editor-open-mutation.ts",
];

const analyticsAdapterFiles = [
  "src/lib/analytics.ts",
  "src/lib/__tests__/analytics.test.ts",
];

// Do not subscribe to the entire Zustand store - reused across the base rules
// and the overrides that still need to ban it.
const noFullStoreSubscription = {
  selector:
    "CallExpression[callee.name=/^use[A-Z][a-zA-Z]*Store$/][arguments.length=0]",
  message:
    "Do not subscribe to the entire Zustand store. Pass a granular selector: useXxxStore((s) => s.specificField).",
};

// Named individually (rather than left inline in the base rule array) so
// per-file overrides can recompose the full set minus one entry, instead of
// silently dropping all of them the way a from-scratch override array would.
const jsxKeyNullishCoalesceLiteral = {
  selector:
    "JSXAttribute[name.name='key'] > JSXExpressionContainer > LogicalExpression[operator='??'][right.type='Literal']",
  message:
    "Do not add literal nullish-coalescing fallbacks to JSX keys. Let the key be undefined unless you need a real identity fallback.",
};
const jsxKeyNullishCoalesceTemplate = {
  selector:
    "JSXAttribute[name.name='key'] > JSXExpressionContainer > LogicalExpression[operator='??'][right.type='TemplateLiteral'][right.expressions.length=0]",
  message:
    "Do not add literal nullish-coalescing fallbacks to JSX keys. Let the key be undefined unless you need a real identity fallback.",
};
const forwardRefImportBan = {
  selector: "ImportSpecifier[imported.name='forwardRef']",
  message:
    "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of importing forwardRef.",
};
const forwardRefCallBan = {
  selector: "CallExpression[callee.name='forwardRef']",
  message:
    "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of wrapping the component in forwardRef.",
};
const reactForwardRefCallBan = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.object.name='React'][callee.property.name='forwardRef']",
  message:
    "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of wrapping the component in React.forwardRef.",
};
// Native `title=` is a browser tooltip: ~700ms delay we do not control, no
// styling, no touch support, invisible to most screen readers as anything more
// than a duplicate of the accessible name, and it clips at the OS window edge.
// `TooltipWrapper` is the app's one tooltip surface.
//
// SCOPE: lowercase names only, i.e. real DOM tags. `title` is an ordinary React
// prop on plenty of components here (`SettingsPanelShell`, `SectionHeading`,
// `ConfirmDestructiveDialog`, …) where it is a heading, not a tooltip - a
// blanket ban on the attribute name would flag ~65 of those. The exceptions
// below are the tags where `title` is SEMANTIC rather than a hover hint:
// `iframe` (its accessible name - `jsx-a11y/iframe-has-title` actively requires
// it), `abbr`/`dfn` (expansion of the term), and the metadata/option tags that
// never render a hoverable box at all.
//
// Components that merely forward `title` to a DOM node (`Button`, `Badge`, …)
// are covered by the companion ban below - they are native tooltips wearing a
// capital letter.
const nativeTitleTooltipDomBan = {
  selector:
    "JSXOpeningElement[name.name=/^(?!(iframe|abbr|dfn|optgroup|option|track|link|style|meta)$)[a-z][a-zA-Z0-9-]*$/] > JSXAttribute[name.name='title']",
  message:
    "Do not use the native `title` attribute as a tooltip. Wrap the element in <TooltipWrapper label={...}> (@/components/ui/tooltip-wrapper), and keep `aria-label` for the accessible name.",
};

// The shared primitives that spread their props onto a real DOM node, so a
// `title` passed to them lands as a native tooltip exactly as if it had been
// written on a `<button>`. Hand-maintained on purpose: it is the price of
// letting `title` stay a legitimate prop name elsewhere. Add a component here
// when it starts forwarding `title` to the DOM.
//
// The app's OWN wrappers are deliberately absent: rather than police a `title`
// prop on each of them, they were renamed to take `tooltip` and now own a
// `TooltipWrapper` internally (`StopButtonShell`, `RoleBadge`,
// `PillToggleButton`, `ReferenceChipButton`, `IndicatorSpan`). A prop literally
// named `tooltip` cannot be confused with the native attribute, so those need
// no rule at all.
const nativeTitleTooltipForwardingBan = {
  selector:
    "JSXOpeningElement[name.name=/^(Button|Badge|DropdownMenuItem|DropdownMenuTrigger|DialogTrigger|PopoverTrigger|SelectTrigger|Switch|ToolbarIconButton|ToolbarPillButton|StartTruncatedText|NodeViewWrapper|WorktreePickerTrigger)$/] > JSXAttribute[name.name='title']",
  message:
    "This component forwards `title` to a DOM node, making it a native tooltip. Wrap it in <TooltipWrapper label={...}> (@/components/ui/tooltip-wrapper) instead.",
};

const epicTabRouteConstructionBan = {
  selector: "CallExpression[callee.name='epicTabRoute']",
  message:
    "Do not construct epicTabRoute() at the call site - pass an `existingEpicTabIntent({...})` (or similar TabNavigationIntent) to navigateToTabIntent; the route shape is owned by lib/tab-navigation.ts and lib/routes.ts.",
};
const tabNavigationStoreActionBans = tabNavigationStoreActionRestrictions([]);

// Every general-purpose app file gets these regardless of the nested-focus-
// boundary allowlist below - overrides that scope out a boundary action must
// still spread this array back in, not drop it by writing a from-scratch
// `no-restricted-syntax` value.
const generalCustomSyntaxRestrictions = [
  jsxKeyNullishCoalesceLiteral,
  jsxKeyNullishCoalesceTemplate,
  nativeTitleTooltipDomBan,
  nativeTitleTooltipForwardingBan,
  forwardRefImportBan,
  forwardRefCallBan,
  reactForwardRefCallBan,
  ...tabNavigationStoreActionBans,
  epicTabRouteConstructionBan,
  ...selectByIdRestrictions,
  ...selectionAuthorityRestrictions,
  ...cloudBearerFenceRestrictions,
  ...LINK_EGRESS_RESTRICTIONS,
  ...TILE_OPEN_RESTRICTIONS,
];

// ── `no-restricted-syntax` IS COMPOSED FROM DIMENSIONS TOO. ──
//
// Same hazard as the import restrictions above and the same fix - finished here
// rather than designed. `no-restricted-imports` was converted to named
// dimensions (`importRestrictionDimensions`); this rule never followed, and
// every override below hand-rebuilt its array. That is the RESTATEMENT idiom
// the comment at the top of this file says had already deleted a boundary
// twice, and it went on to do it twice more: `src/lib/tab-navigation.ts` and
// the test-file block used to drop SIX custom-syntax families by rebuilding
// from the type-safety array alone. The current composition retains those
// custom dimensions and adds all seven shared type-safety rules to each block.
//
// A block now names what it is EXEMPT from. So a gap is a readable word in a
// list rather than an absence nobody can see, and closing one is deleting that
// word.
//
// The groups PARTITION `generalCustomSyntaxRestrictions` - every entry belongs
// to exactly one group. That is deliberate: it makes "exempt from all of it"
// expressible, so a block that genuinely carries almost nothing (the two above)
// still states its shape instead of opting out by omission.
//
// Identity is by REFERENCE, which is why these name the memoized consts rather
// than rebuilding them: `tabNavigationStoreActionRestrictions([])` called twice
// returns equal-looking objects that are not the same objects, and the filter
// below would silently stop matching.
const syntaxExemptions = {
  jsxKey: [jsxKeyNullishCoalesceLiteral, jsxKeyNullishCoalesceTemplate],
  nativeTitleTooltip: [
    nativeTitleTooltipDomBan,
    nativeTitleTooltipForwardingBan,
  ],
  forwardRef: [forwardRefImportBan, forwardRefCallBan, reactForwardRefCallBan],
  tabNavigation: tabNavigationStoreActionBans,
  epicTabRoute: [epicTabRouteConstructionBan],
  selectById: selectByIdRestrictions,
  selectionAuthority: selectionAuthorityRestrictions,
  cloudBearerFence: cloudBearerFenceRestrictions,
  // Two groups, not one: tests lift the bridge half (they stub
  // `{ openExternalLink: vi.fn() }` and assert on it) and keep the DOM half.
  linkEgressBridge: LINK_EGRESS_BRIDGE_RESTRICTIONS,
  linkEgressHook: LINK_EGRESS_HOOK_RESTRICTIONS,
  linkEgressDom: LINK_EGRESS_DOM_RESTRICTIONS,
  tileOpen: TILE_OPEN_RESTRICTIONS,
};

/**
 * The base every block carries, plus `general` minus the named exemptions,
 * plus the two allowanced families.
 *
 * All three options are REQUIRED. A caller states its whole shape rather than
 * inheriting a default, because a default is precisely how a block silently
 * stops carrying something. `null` means "this family does not apply here";
 * `[]` means "applies, with no allowances".
 *
 * Passing `tabNavigation` a list implies exemption from the un-allowanced
 * tabNavigation bans - re-adding an allowanced copy while the blanket ban is
 * still present would flag the very calls the allowance names. That coupling
 * was a hand-written `.filter` in four blocks and is now automatic, so it
 * cannot be forgotten in a fifth.
 */
function syntaxRestrictions({ exempt, nestedFocus, tabNavigation }) {
  for (const name of exempt) {
    if (syntaxExemptions[name] === undefined) {
      throw new Error(`Unknown no-restricted-syntax exemption: ${name}`);
    }
  }
  const lifted = new Set(exempt.flatMap((name) => syntaxExemptions[name]));
  if (tabNavigation !== null) {
    for (const ban of syntaxExemptions.tabNavigation) lifted.add(ban);
  }
  return [
    "error",
    ...traycerTypeSafetyRestrictions,
    noFullStoreSubscription,
    ...generalCustomSyntaxRestrictions.filter(
      (restriction) => !lifted.has(restriction),
    ),
    ...(nestedFocus === null
      ? []
      : nestedFocusBoundaryRestrictions(nestedFocus)),
    ...(tabNavigation === null
      ? []
      : tabNavigationStoreActionRestrictions(tabNavigation)),
  ];
}

export default tseslint.config(
  // `src/lib/cn-tables.ts` is `cn build` output (see `cn.config.mjs`): machine
  // shape, regenerated by `bun run cn:build`, never hand-edited.
  {
    ignores: [...commonIgnores, "src/routeTree.gen.ts", "src/lib/cn-tables.ts"],
  },
  linterOptionsConfig,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: {
      "react-refresh": reactRefresh,
      "@tanstack/query": pluginQuery,
      "@tanstack/router": pluginRouter,
      react,
    },
    rules: {
      // ── react-refresh ──────────────────────────────────────────────────────
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],

      // ── @typescript-eslint: base ────────────────────────────────────────────
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",

      // ── @typescript-eslint: strict additions ────────────────────────────────
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      "@typescript-eslint/unified-signatures": "error",
      "@typescript-eslint/prefer-as-const": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // ── TanStack Query ──────────────────────────────────────────────────────
      "@tanstack/query/exhaustive-deps": "error",
      "@tanstack/query/no-rest-destructuring": "warn",
      "@tanstack/query/stable-query-client": "error",
      "@tanstack/query/no-unstable-deps": "error",
      "@tanstack/query/no-void-query-fn": "error",
      "@tanstack/query/prefer-query-options": "warn",
      "@tanstack/query/infinite-query-property-order": "error",
      "@tanstack/query/mutation-property-order": "error",

      // ── TanStack Router ─────────────────────────────────────────────────────
      "@tanstack/router/create-route-property-order": "error",

      // ── React: correctness ──────────────────────────────────────────────────
      "react/no-array-index-key": "error",
      "react/jsx-no-leaked-render": "error",
      // A prop written twice is last-wins in every toolchain here, so it is
      // silent by construction: it does not change the render when both copies
      // carry the same expression, and no test can see it. A scripted edit that
      // applied its insertion twice shipped exactly that
      // (`hostKnowsAutoMode={hostKnowsAutoMode}` on two adjacent lines in
      // `composer-toolbar.tsx`) past oxlint, eslint AND oxfmt, all three of
      // which exited 0. This rule is the only gate that catches the class
      // before a type-check.
      //
      // ENFORCED FROM `.oxlintrc.json`, not from here. The
      // `oxlint.buildFromOxlintConfigFile` spread at the end of this file
      // switches off in ESLint every rule oxlint already owns, so this entry
      // resolves to `off` - exactly like its seven react neighbours below that
      // also appear in that file. Listing it here keeps the declaration where a
      // reader looks for it; deleting the `.oxlintrc.json` half would silently
      // disarm the rule in both.
      "react/jsx-no-duplicate-props": "error",
      "react/jsx-no-target-blank": "error",
      "react/no-danger": "error",
      "react/no-unstable-nested-components": "error",
      "react/jsx-key": ["error", { checkFragmentShorthand: true }],
      "react/no-deprecated": "error",
      "react/no-direct-mutation-state": "error",

      // ── React: style / redundancy ───────────────────────────────────────────
      "react/self-closing-comp": "warn",
      "react/jsx-boolean-value": ["warn", "never"],
      "react/jsx-no-useless-fragment": ["warn", { allowExpressions: true }],

      // ── Import boundaries + full-store Zustand selectors ────────────────────
      // Dimensions: boundary + kernel + overlayPortal. Both ride the BASE
      // block so neither ban has a hole outside `src` or at files the `src`
      // blocks exempt for unrelated reasons (the analytics adapter); the
      // blocks that lift one or the other - tests, the kernel owner, the
      // wrapper layer itself, and the reasoned pre-registration-seam raw
      // consumers - are narrow and explicit.
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "kernel",
        "overlayPortal",
      ),

      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [],
        tabNavigation: null,
      }),

      // ── ESLint core: code quality ───────────────────────────────────────────
      complexity: ["warn", { max: 16 }],
      "max-depth": ["warn", { max: 4 }],
      "max-params": ["warn", { max: 4 }],
      "no-nested-ternary": "error",
      "no-else-return": "warn",
      eqeqeq: ["error", "always"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // ── Per-directory overrides ─────────────────────────────────────────────────
  {
    // PostHog is reachable only through the typed adapter so every event and
    // property passes its allowlist sanitizer before leaving the app. The
    // adapter's own test is the one other legitimate consumer: it drives the
    // real SDK through the sanitizer to prove the payload boundary.
    files: ["src/**/*.{ts,tsx}"],
    ignores: analyticsAdapterFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // D12 read path: ban active-host / default-client hook imports outside the
    // allowlisted layer. The allowlisted files are NOT a subset of this set -
    // they carry boundary + posthog + kernel + overlayPortal from the block
    // above, and this block simply never matches them.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...analyticsAdapterFiles, ...hostSelectionReadAllowlist],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // `src/hooks/epic/**` is inside the read-path allowlist's `src/hooks/**`
    // (the wrapper-hook layer legitimately resolves default clients), but the
    // Epic hooks are mounted by Epic-session surfaces and were where three of
    // PR #1243's per-push findings lived. Re-impose `readPath` there - the
    // full partition, so nothing is dropped - minus the by-caller exemptions,
    // each of which names its app-wide caller above.
    files: ["src/hooks/epic/**/*.{ts,tsx}"],
    ignores: [...testFileGlobs, ...hooksEpicAppWideByCallerExemptions],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // Same re-imposition, for the wrapper-hook directories this round
    // repointed onto caller-supplied clients.
    files: hookDirectoriesRepointedToCallerClients,
    ignores: [...testFileGlobs, ...hookWrapperAppWideReadExemptions],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // The reasoned app-wide reads, per FILE: their partition (boundary +
    // posthog + kernel + overlayPortal) minus `readPath`.
    files: [
      ...epicCanvasAppWideReadExemptions,
      ...followingSurfaceAppWideReadExemptions,
      ...appChromeAppWideReadExemptions,
      ...hookWrapperAppWideReadExemptions,
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // The promotable-modal family builds custom dialog chrome the shadcn
    // Dialog wrapper does not support, so it constructs `DialogPrimitive`
    // directly.
    files: [
      "src/components/layout/dialogs/promotable-modal-frame.tsx",
      "src/components/layout/dialogs/window-host-modal.tsx",
      "src/components/layout/dialogs/migration-blocking-modal-host.tsx",
      "src/components/layout/dialogs/system-tab-modal-host.tsx",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
      ),
    },
  },
  {
    // TESTS LIFT `kernel`, AND ONLY `kernel`. A test may construct a kernel -
    // the StrictMode regression's control arm does exactly that, deliberately,
    // to pin the pre-F2 defect. Tests already sit inside
    // `hostSelectionReadAllowlist`, so their partition is boundary + posthog;
    // naming those two here reproduces it exactly, minus the one being lifted.
    files: testFileGlobs,
    // ...except the adapter's own test: the earlier blocks exempt it via
    // `ignores`, but flat config is last-block-wins, so WITHOUT this ignore
    // the tests block would re-impose `posthog` on the one test whose job is
    // to drive the real SDK through the sanitizer. (Caught by the PR's first
    // full-package lint - scoped runs never visit this file.)
    ignores: analyticsAdapterFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions("posthog"),
    },
  },
  {
    // The kernel's OWNER lifts `kernel` for itself alone. One file, per the
    // `markdown-anchor.tsx` idiom - a single-file `files` list cannot shadow a
    // broad block by accident, which a directory glob here could.
    files: selectionKernelOwner,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "overlayPortal",
      ),
    },
  },
  {
    // D12 write path, upper half: only Settings ▸ Activate and the bridge's
    // composition root may reach the preferred-write API.
    files: selectionAuthorityWriteAllowlist,
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["selectionAuthority"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // Rendered MARKDOWN, not app chrome. A Markdown link title is written by
    // the document author and belongs on the anchor as `title` - that is the
    // attribute the syntax maps to. Routing it through `TooltipWrapper` would
    // restyle author content as app UI and drop the attribute from the DOM.
    // The ban stays on for every other tooltip in this directory.
    files: ["src/markdown/components/markdown-anchor.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["nativeTitleTooltip"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // shadcn/ui generated primitives follow library conventions that
    // intentionally diverge from app-code rules. `src/components/ui/**` is
    // ALSO the `overlayPortal` allowance named in the ticket: it is the one
    // place allowed to import the raw portal primitives, since it is the
    // wrapper layer that registers them. Its natural partition (boundary +
    // posthog + readPath + kernel - it is not in `hostSelectionReadAllowlist`)
    // is restated here minus `overlayPortal`.
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
      "react-refresh/only-export-components": "off",
      "react-hooks/purity": "off",
      "@tanstack/query/no-rest-destructuring": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-noninteractive-element-interactions": "off",
    },
  },
  {
    // Two more raw-primitive consumers, restated here minus `overlayPortal`
    // rather than folded into the block above so neither file inherits the
    // shadcn-only rule turn-offs by accident.
    files: [
      "src/components/epic-canvas/dialogs/epic-migration-modal.tsx",
      "src/components/command-palette/palette-item-row.tsx",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
    },
  },
  {
    // The activation module owns raw tabActivate. Every other caller reaches
    // activateTabIntent, which binds the coordinated layout commit to the
    // history-entry envelope before navigating.
    //
    // The exemption this block exists for is tabActivate and NOTHING ELSE, so
    // the selection bans are restated. Rebuilding the value from
    // `traycerTypeSafetyRestrictions` alone had silently dropped them here:
    // adding the shared type-safety rules raises each block's count by seven;
    // that alone cannot repair the historical missing `selectById` entry - so
    // the one file allowed to name a tab-activation internal was also the one
    // file allowed to call `selectById`, which nothing intended and no test
    // would have noticed. That is the last-block-wins hazard this config warns
    // about at :30, fired rather than hypothetical.
    //
    // Restated individually rather than by spreading
    // `generalCustomSyntaxRestrictions`, because that array carries the
    // tabNavigation bans this block must not have. Measured: adding these two
    // families produces zero violations here - the file never names either.
    files: ["src/lib/tab-navigation.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [
          "jsxKey",
          "nativeTitleTooltip",
          "forwardRef",
          "tabNavigation",
          "epicTabRoute",
        ],
        nestedFocus: null,
        tabNavigation: null,
      }),
    },
  },
  {
    // Plan §2/§3 puts source activation inside this reservation-first command.
    // The coordinator may call the two legacy source selectors while its
    // ledger is installed; raw registry.tabActivate remains banned here.
    files: ["src/stores/tabs/tab-command-coordinator.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: null,
        tabNavigation: [
          "useEpicCanvasStore.setActiveTab",
          "useLandingDraftStore.setActiveDraft",
        ],
      }),
    },
  },
  {
    // These kind descriptors implement the source half of tab-navigation's
    // single activation boundary. Keep raw tabActivate restricted here while
    // allowing only the descriptor's own legacy projection action.
    files: ["src/stores/tabs/kinds/draft.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: null,
        tabNavigation: ["useLandingDraftStore.setActiveDraft"],
      }),
    },
  },
  {
    // The Epic descriptor owns its canonical route construction and source
    // projection; callers still cannot access raw tabActivate here.
    files: ["src/stores/tabs/kinds/epic.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["epicTabRoute"],
        nestedFocus: null,
        tabNavigation: ["useEpicCanvasStore.setActiveTab"],
      }),
    },
  },
  {
    // Test fixtures construct the full router interface and seed stores via
    // setActiveTab / setActiveDraft as part of arrange / act setup, so ONLY
    // those two legacy source actions are allowed here. Raw `tabActivate`
    // access stays banned - tests must activate through activateTabIntent like
    // production, so a raw `tabActivate` call can never lint clean in a test.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      // Each remaining exemption is here for a stated reason, and two that were
      // here only by accident are gone. `jsxKey` and `epicTabRoute` were
      // measured across all 1392 test files with the bans restored: ZERO
      // violations either way, so they were never a decision - just collateral
      // from rebuilding this array by hand.
      //
      // `selectById` / `selectionAuthority`: DELIBERATE and load-bearing. The
      // selectors are property-name matches with no call-site distinction, so
      // `expect(mocks.selectById).not.toHaveBeenCalled()` - which PROVES the
      // invariant - is indistinguishable from a violation. Restoring them would
      // redden the assertions that enforce the rule. See the characterization
      // test in `lint-rule-guards.test.ts`, which pins this and pairs
      // it against `tabActivate` presence so a wiped block cannot pass as
      // correct.
      //
      // `nativeTitleTooltip` / `forwardRef`: DELIBERATE. Both bans govern
      // SHIPPED PRODUCT SURFACES, and every occurrence in a test file is a test
      // double imitating a contract it does not own.
      //
      // Censused, not sampled: restoring both surfaces 19 occurrences across 14
      // files, and all 19 are mock scaffolding - 18 inside a `vi.mock` /
      // `vi.hoisted` factory, and the 19th is the `forwardRef` import that feeds
      // one of those factories in the same file.
      //
      // The `forwardRef` ban is React-19 migration debt about OUR components; a
      // double standing in for `react-zoom-pan-pinch` or a Radix item, both of
      // which really do forward a ref, is matching a contract rather than
      // carrying that debt. The `title` ban is about a tooltip a USER hovers,
      // and a mock forwarding `title` to a DOM node so a test can observe it is
      // instrumenting a tooltip, not shipping one.
      //
      // What makes it conclusive rather than arguable: several of those
      // `title={props.title}` lines ARE what the assertions read. Applying the
      // rule literally would edit away the observation the test exists to make.
      // A lint rule that deletes the mechanism of the tests it touches is being
      // applied outside its domain - that is the tell.
      //
      // Not per-line waivers, and the difference from
      // `muted-fill-on-raised-surface-lint.test.ts` is the point: that guard
      // takes waivers because its population is MIXED, so the waiver carries the
      // reason for THAT line. Here the population is uniformly clean, so a
      // waiver on all 19 would carry no information and would train readers to
      // skip waivers that do. Per-line waivers are for mixed populations; a
      // uniform population wants one stated exemption. A selector narrow enough
      // to mean "inside a `vi.mock` callback" is not expressible, and one that
      // tried would be the fails-by-passing shape this file keeps out.
      //
      // `tileOpen` / `linkEgressBridge`: DELIBERATE, and the same shape as
      // `selectById` above. A canvas test stubs the store it drives
      // (`{ prepareOpenTileInTabFocusTarget: vi.fn(), ... }`) and a
      // runner-host test stubs the bridge (`{ openExternalLink: vi.fn() }`);
      // in both, the property name IS the observation the assertion reads, so
      // applying the ban would edit away the mechanism of the test.
      // `linkEgressHook` too: the bridge hook's OWN test has to import it to
      // exercise the null-host and rejection paths.
      // `linkEgressDom` is NOT lifted: `window.open` and `target="_blank"`
      // are shipped-surface bans with no test-double reading, and a test that
      // opens one is asserting the app has a door it is not allowed to have.
      //
      // Residual, precisely: a component DEFINED in a test file and then
      // imported by product code would escape both bans. That is pathological,
      // would not survive review, and no rule in this file is the right place to
      // catch it. Everything short of it - a mock, a fixture, a harness
      // component - is scaffolding these two bans were never written about.
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [
          "nativeTitleTooltip",
          "forwardRef",
          "selectById",
          "selectionAuthority",
          "tileOpen",
          "linkEgressBridge",
          "linkEgressHook",
        ],
        nestedFocus: null,
        tabNavigation: [
          "useEpicCanvasStore.setActiveTab",
          "useLandingDraftStore.setActiveDraft",
        ],
      }),
    },
  },
  {
    // The cloud-bearer fence's one gui-app allowance. `auth-service.test.ts`
    // asserts what the service INSTALLS on the request context - that a sign-in
    // publishes the bearer, that a same-user rotation replaces it in place, that
    // a sign-out releases the lease - and reading it back through the context is
    // how those are observable at all. Same exemption class as the shared
    // lease-contract suites; see `traycer-cloud-bearer-fence-rules.mjs`.
    //
    // Scoped to this ONE file rather than added to the `__tests__` block's
    // `exempt` list: a test elsewhere reaching a raw bearer out of a context is
    // a real violation of the rule's intent, and a blanket test exemption would
    // erase exactly what the fence protects.
    //
    // MUST STAY BELOW THE `__tests__` BLOCK ABOVE. That block matches every test
    // file and supplies a from-scratch `no-restricted-syntax` value, so this
    // allowance placed anywhere earlier is silently overwritten and reads as
    // configured while doing nothing. That is not hypothetical - this block WAS
    // written higher up, lint stayed red on the five sites it names, and only
    // running it found out. It restates the same `nestedFocus` / `tabNavigation`
    // shape the test block sets so moving it down costs those files nothing -
    // and the three test-scaffolding exemptions too (`tileOpen` /
    // `linkEgressBridge` / `linkEgressHook`): `auth-service.test.ts` stubs
    // `runnerHost.openExternalLink` to observe the sign-in ordering, and a
    // from-scratch value here that dropped them re-banned exactly the
    // test-double reading the block above lifts. Same overwrite, other
    // direction.
    files: cloudBearerFenceGuiAllowlist,
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [
          "cloudBearerFence",
          "nativeTitleTooltip",
          "forwardRef",
          "selectById",
          "selectionAuthority",
          "tileOpen",
          "linkEgressBridge",
          "linkEgressHook",
        ],
        nestedFocus: null,
        tabNavigation: [
          "useEpicCanvasStore.setActiveTab",
          "useLandingDraftStore.setActiveDraft",
        ],
      }),
    },
  },
  {
    // These hooks build a remote host transport (Architecture §4 / S1's
    // shared `(hostId, userId)` session cache) inside a `useEffect`,
    // deliberately NOT a `useMemo`: only an effect's cleanup is guaranteed to
    // pair with exactly the committed acquire (a `useMemo` factory can run
    // more than once per commit - StrictMode dev double-invoke, or a
    // discarded concurrent render - silently orphaning a live reference on
    // the shared session). This is React's own documented "connecting to an
    // external system" pattern (react.dev/reference/react/useEffect), which
    // this rule's heuristic cannot distinguish from an avoidable
    // derived-state effect.
    files: [
      "src/hooks/host/use-host-client-for.ts",
      "src/hooks/host/use-host-stream-client-for.ts",
      "src/lib/host/stream-runtime.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // The park effect RETRACTS a session this window has already destroyed,
    // which is the one shape this rule's "cascading renders" reasoning does
    // not cover. The rule is about deriving state in an effect, where the
    // cure is to compute during render instead; here the effect is reacting
    // to an external system (the parking decider released the session and
    // disposed the handle) and the write is a retraction of a value that is
    // now a destroyed object.
    //
    // It was deferred to a microtask precisely to satisfy this rule, and that
    // deferral was the defect: an unpark landing inside the microtask window
    // runs the effect's cleanup, which cancelled the pending write, so the
    // render that observed `parked === false` republished the disposed handle
    // through `publishedSessionHandle` and consumers read a destroyed store.
    // The cascade the rule warns about is one extra render; the cost of
    // avoiding it here was handing consumers a destroyed Y.Doc.
    files: ["src/providers/epic-session-provider.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // The seeded-resend effect decides a WIRE SHAPE from live blob custody,
    // which is an external system in the same sense as the two above: the
    // confirmation memo in `lib/drafts/draft-blob-transport.ts` is a module
    // Map mutated by `drafts.putBlob` acks arriving off the socket, with no
    // subscription and no React identity. The rule's cure - compute it during
    // render instead - is the one thing that must not happen here. Render
    // would have to read that Map, which is neither pure nor reactive: React
    // has no way to know an ack changed it, so the value would look stable
    // exactly when it is not, and the hook's own contract ("recomputed, never
    // captured: a `putBlob` confirmed while this resolution runs should let
    // its node travel bare; a confirmation invalidated in that window must
    // not") would be unenforceable.
    //
    // Only the every-hash-is-host-held early return is synchronous; the
    // inlining path already writes from an async `commit`. Routing that early
    // return through the async path to satisfy the rule is the deferral the
    // block above records as having BEEN the defect, and here it would also
    // delay the common case for nothing: the hashes are already in the host's
    // custody, so there is no byte to fetch and nothing to wait for.
    files: ["src/hooks/chats/use-initial-chat-handoff-driver.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Router -> store synchronization direction for an already-committed epic
    // route. This is the inverse of navigateToTabIntent's entry-point seam,
    // so it may read the store action directly while the rest of the app may
    // not.
    files: ["src/routes/epic-tab-route-components.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [],
        tabNavigation: ["useEpicCanvasStore.setActiveTab"],
      }),
    },
  },

  {
    // Closed-tab recovery owns placement reconstruction and either commits one
    // nested navigation or deliberately preserves the current bulk-close focus.
    files: ["src/lib/tab-recovery/reopen.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["restoreCanvasForRecovery"],
        tabNavigation: null,
      }),
    },
  },
  // ── Nested-focus-opener boundary allowlist ──────────────────────────────────
  // See eslint/traycer-nested-focus-boundary-rules.mjs for the contract this
  // enforces. Every entry below is a verified, empirical exception (grep the
  // codebase for the two banned AST shapes before adding another) - not a
  // restatement of the original audit brief, which over-listed several files
  // that turned out to already be boundary-backed.
  {
    // Route -> store sync direction: applies an already-resolved/committed
    // route target into the canvas (the inverse of the boundary, which goes
    // store -> route), plus the legacy pre-nested-focus auto-open/cleanup
    // paths that only run when there is no nested route target yet.
    files: [
      "src/components/epic-canvas/hooks/use-epic-route-synchronization.ts",
    ],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [
          "openTileInTab",
          "closeCanvasTab",
          "applyNestedRouteFocus",
        ],
        tabNavigation: null,
      }),
    },
  },
  {
    // Blank-root bootstrap: seeds the first and only tile of a brand-new
    // empty canvas root. There is no prior focus to disambiguate, so there
    // is nothing meaningful to write to the route.
    files: ["src/components/epic-canvas/canvas/tile-canvas.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["openTileInTab"],
        tabNavigation: null,
      }),
    },
  },
  {
    // Registers a server-created terminal as a saved background tab without
    // activating it - prepareOpenTileInBackgroundTabFocusTarget always
    // returns a null focus delta, so this call never needs a route write.
    // Both the chat and terminal-agent tab-register drivers delegate their
    // registration effect to this single shared hook, so the exemption lives
    // here, at the one site that actually calls openTileInBackgroundTab.
    files: [
      "src/hooks/worktree/use-register-setup-terminal-tabs-from-binding.ts",
    ],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["openTileInBackgroundTab"],
        tabNavigation: null,
      }),
    },
  },
  {
    // Bulk-delete batches N raw closeCanvasTab calls inside a hand-rolled
    // `prepare` closure passed to navigateNested, then commits ONE aggregate
    // post-batch focus target - the same raw-then-diff shape the store's own
    // prepare*FocusTarget wrappers use internally, just batched. Owned by a
    // sibling agent's in-progress bulk-delete fixup; re-verify this
    // classification if that implementation changes shape.
    files: ["src/components/epic-canvas/sidebar/epic-sidebar.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["closeCanvasTab"],
        tabNavigation: null,
      }),
    },
  },
  // ── Link-egress boundary allowlist (A6) ─────────────────────────────────────
  // See eslint/traycer-tile-open-boundary-rules.mjs. Two files, both of which
  // are BELOW the `useOpenLink` seam rather than bypassing it.
  {
    // The desktop bridge itself - the one door out of the app, and the thing
    // `useOpenLink` calls once it has decided the link goes external.
    files: ["src/lib/links/open-external-link.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["linkEgressBridge"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // The only two files allowed to hold the bridge HOOK: `open-link.ts`
    // decides in-app vs external, and `open-browser-url.ts` owns the A5
    // failure toast's explicit "Open in browser" action.
    files: ["src/lib/links/open-link.ts", "src/lib/links/open-browser-url.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["linkEgressHook"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // Device-grant and provider-reauth verification URLs. Hard-external by A2
    // (an OAuth grant has no in-app meaning), and this module runs outside
    // React, so the hook form is not available to it.
    files: ["src/lib/auth/auth-service.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["linkEgressBridge"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },

  // ── Tile-open boundary allowlist (C1) ───────────────────────────────────────
  // The seam's own implementation, plus the store that defines the actions and
  // the two reasoned callers that sit below it. Test files lift this dimension
  // in the block above; these globs are single-level on purpose so they do not
  // shadow it for `tile-open/__tests__/`.
  {
    files: [
      "src/lib/canvas/tile-open/*.{ts,tsx}",
      "src/hooks/epic/use-epic-tile-navigation.ts",
    ],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["tileOpen"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // Defines every `prepare*FocusTarget` and calls its own actions through
    // `get()`; the store is what the seam is a boundary AROUND.
    files: ["src/stores/epics/canvas/store.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["tileOpen"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },

  // ── shadcn/lint ─────────────────────────────────────────────────────────────
  // The design-system linter. It reads `components.json` for the `@/components/ui`
  // alias and `src/index.css` for the theme, so every message names our real
  // variants, sizes and tokens. Rules are turned on one at a time as the code
  // reaches zero findings for them (`bun run lint` treats a warning as an
  // error, so there is no "warn while we clean up" lane).
  //
  // Tests are excluded: a test asserting on a class string is not a shipped
  // surface, and the rules' guidance is written for product code.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: testFileGlobs,
    plugins: { shadcn },
    settings: {
      shadcn: {
        note: "See the design rules in clients/gui-app/AGENTS.md before adding a class, a token or an exception.",
        // `vaul` exports its drawer as `Drawer`, and the rules resolve
        // `DrawerPrimitive.Content` back through that import to the name
        // `DrawerContent` - which is OUR component. So `ui/drawer.tsx`, the
        // file that DEFINES the drawer, was reported as if it were a call site
        // restyling it: 33 findings for the fill, the shadow, the per-direction
        // borders and every safe-area inset the wrapper exists to apply. Radix
        // primitives do not do this (`ui/dialog.tsx` writes the same kind of
        // thing and is clean), so the fix is to tell the rules that `vaul` is a
        // primitive library rather than a component source. Call sites are
        // unaffected: they import `DrawerContent` from
        // `@/components/ui/drawer`, which is still recognized.
        ignoreImports: ["^vaul$"],
      },
    },
    rules: {
      // Every allowed name below IS a real class. THE CAUSE: the plugin reads
      // exactly one stylesheet per project - the one `components.json` names
      // in `tailwind.css`, here `src/index.css` - and follows only the
      // `@import`s inside it. Every stylesheet listed below is imported by the
      // component that uses it instead, which is a path the plugin does not
      // walk, so the declaration is invisible to it while Tailwind compiles it
      // fine. A future reader deciding between this list and an `@import` from
      // `index.css` should know the import is the real fix and costs a bigger
      // shared stylesheet; the list costs a name that no longer gets
      // spellchecked. Nothing here is a typo waiver - a misspelling outside
      // these namespaces still fails.
      "shadcn/no-unknown-classes": [
        "error",
        {
          allow: [
            // Hand-written CSS in this app's own stylesheets. Each is a rule
            // with descendant selectors, media queries or custom properties,
            // which is what `@utility` cannot express - they are components in
            // CSS, not utilities.
            "auth-splash", // src/styles/auth-arrival.css
            "brand-entrance-*", // src/styles/auth-arrival.css
            "appearance-wallpaper-*", // src/components/home/appearance-wallpaper.css
            "landing-appearance-surface", // src/components/home/appearance-wallpaper.css
            "onboarding-*", // a <style> element inside onboarding-page.tsx
            "diorama-*", // src/components/onboarding/onboarding-diorama.css
            "session-import-*", // src/components/onboarding/onboarding-import.css
            // src/components/settings/panels/getting-started-settings.css -
            // a <progress>, whose fill and track are pseudo-elements.
            "settings-setup-meter",

            // Class names owned by a library, not by us.
            "not-prose", // @tailwindcss/typography, loaded via @plugin
            "pdfViewer", // pdf.js, styled by pdf-preview.css
            "toaster", // sonner's own root class
            "cn-toast", // the hook sonner's toastOptions.classNames targets

            // Markers with no CSS at all: a name a test's querySelector or a
            // sibling selector reaches for. Removing them would break the
            // thing that reads them, and declaring an empty @utility would
            // say less than this list does.
            "status-ping",
            "tc-*",
            "traycer-md-*",
            // Styled by first-task-guide.css, not by this component - the
            // plugin only walks index.css's @import chain, and that
            // stylesheet is imported from the guide's coachmark portal, not
            // from a component this rule can see.
            "first-task-coachmark",
            "first-task-coachmark-*",
          ],
        },
      ],
      "shadcn/no-raw-colors": [
        "error",
        {
          allow: [
            // UPSTREAM BUG, shadcn-ui/lint#8: for `text-<name>` the rule
            // consults only `--color-*` and reports everything else as an
            // undeclared color, so our 17 `--text-*` FONT SIZE tokens read as
            // colors. Reproduced in isolation with a two-line theme. Delete
            // this list when the issue closes - it is not a design decision,
            // and while it stands a genuinely undeclared `text-<color>` in
            // these namespaces goes unreported.
            ...fontSizeTokens,

            // A SECOND upstream bug, distinct from #8 and not yet filed: the
            // rule treats every `fill-*` / `stroke-*` as naming a color, but
            // `fill-none` and `stroke-none` are real Tailwind utilities for
            // the CSS keyword `none`. (`fill-current`, `stroke-current` and
            // `fill-transparent` are all recognized, so it is only the keyword
            // pair.) Nothing else in the codebase can express "no fill".
            "fill-none",
            "stroke-none",
          ],
        },
      ],
      "shadcn/no-inline-styles": [
        "error",
        {
          // THE LINE: a property is allowed when its VALUE is produced at
          // runtime by something a stylesheet cannot see - a rect measured off
          // the DOM, a drag, a resize, the animation clock, a tree's depth, a
          // media file's intrinsic ratio - or when CSS classes cannot express
          // it at all. Everything a designer would CHOOSE stays denied: color,
          // background, typography, border, radius, and spacing on the scale.
          // That is the half this rule exists to catch.
          //
          // The cost of drawing it per PROPERTY rather than per value is that
          // a hardcoded `paddingLeft: 24` now passes where `padding: 24` does
          // not. The rule has no way to say "only when dynamic", and the
          // alternative - rewriting 21 tree-indent sites into a custom
          // property that a class then reads - moves the same number into the
          // same element's style attribute under a different name.
          //
          // NOT listed, deliberately: `--*`. The rule already lets a custom
          // property through - the only thing it checks on one is that the
          // value is not a hardcoded color - so allowing `--*` would not
          // permit anything new, it would only switch that color check off.
          // Setting a dynamic value through a custom property and reading it
          // from a class stays the sanctioned escape hatch, and it stays
          // guarded.
          allow: [
            // Measured or dragged geometry.
            "width",
            "height",
            "minWidth",
            "maxWidth",
            "maxHeight",
            "left",
            "top",
            "right",
            "bottom",
            "inset",
            "transform",
            "anchorName",
            "positionAnchor",
            // `x` / `y` are framer-motion's names for the same transform, set
            // from a `MotionValue` a gesture drives. `transform` above is the
            // static spelling of exactly this.
            "x",
            "y",
            // Split-pane and sidebar sizes, written back from a resize drag.
            "flexGrow",
            "flexBasis",
            "flexShrink",
            // Tree-row indent: `depth * INDENT_PX`, unbounded in depth.
            "paddingLeft",
            "paddingInlineStart",
            // The soft-keyboard inset the mobile shell measures.
            "paddingBottom",
            // An image or video's intrinsic ratio, known only once it loads.
            "aspectRatio",
            // `lib/animation/status-animation-clock.ts` writes these frame by
            // frame, and `index.css` says at length why they must NOT be CSS
            // animations: Blink recalculates style for every running CSS
            // animation once per display frame, which against this stylesheet
            // cost ~2.5 MB/s of renderer heap per always-on indicator.
            "opacity",
            "animation",
            "transitionDuration",
            "strokeDasharray",
            // Properties with no class at all. `WebkitAppRegion` is the
            // Electron title-bar drag region; `colorScheme` is what the theme
            // editor's preview swatch flips to render a sample in the other
            // appearance; `containerType` and `imageRendering` have no
            // utility in our Tailwind build.
            "WebkitAppRegion",
            "colorScheme",
            "containerType",
            "imageRendering",
            "mixBlendMode",
            "filter",
            "backgroundImage",
            "backgroundPosition",
            // A font PREVIEW: the family and size are what the row is showing,
            // picked from the system font list or the terminal settings.
            "fontFamily",
            "fontSize",
            // dnd-kit hands a sortable its own transform and transition; the
            // pair arrives together and the transform half is already allowed.
            "transition",
            // The reasoning slider's travel, `((2 * position) / last - 1)rem`.
            "marginInlineEnd",
          ],
        },
      ],
      "shadcn/no-arbitrary-values": [
        "error",
        { allow: sanctionedArbitraryValues },
      ],
      // Button's entry comes LAST inside `noRestyle`: contracts are matched
      // from the end, so whatever is added above it can never shadow the one
      // family that is actually enforced.
      "shadcn/no-restyle": noRestyle([]),
    },
  },
  // Each `restyleExemptions` entry, as its own block. See that list for why.
  ...restyleExemptions.map((exemption) => ({
    files: exemption.files,
    ignores: testFileGlobs,
    rules: { "shadcn/no-restyle": noRestyle(exemption.contracts) },
  })),
  {
    // `no-inline-styles` off, for surfaces whose colour is the CONTENT rather
    // than a style choice, or whose palette is not the theme's:
    //
    //   - the theme editor and the theme inspector RENDER a theme. The sample
    //     card's literals and the `--background` / `--primary` / … it sets
    //     inline are the thing being previewed; a token there would preview
    //     the current theme instead of the one under the cursor.
    //   - the onboarding diorama is artwork on `StandaloneShell`'s fixed dark
    //     backdrop (see the full-bleed note in AGENTS.md), with its own node
    //     palette that is deliberately not the app's tokens.
    //   - the terminal output tile's find decorations are drawn in the
    //     TERMINAL's palette: the two literals are `--term-ansi-yellow` and
    //     `--term-ansi-bright-yellow` verbatim. Those ANSI roles are written
    //     by the theme applier for xterm and are deliberately not registered
    //     as `--color-*`, so no Tailwind class can name them.
    //   - the QR tile's ink is a scanner-contrast requirement, and the same
    //     literal has to reach the SVG `fill` beside it.
    files: [
      "src/components/settings/themes/theme-editor-panel.tsx",
      "src/components/settings/themes/theme-inspector.tsx",
      "src/components/onboarding/onboarding-diorama.tsx",
      "src/components/epic-canvas/renderers/managed-command-output-tile.tsx",
      "src/components/settings/panels/link-phone-qr-tile.tsx",
    ],
    rules: {
      "shadcn/no-inline-styles": "off",
    },
  },
  {
    // The onboarding page's one `<style>` element and its backdrop image.
    // The element carries the diorama's keyframes, which are written against
    // its own `--onboarding-*` custom properties and have no utility form.
    files: ["src/components/onboarding/onboarding-page.tsx"],
    rules: {
      "shadcn/no-inline-styles": "off",
    },
  },
  {
    // Geometry a SHARED HELPER builds: `frameStyle(paintedSize, origin)`,
    // `containBox(frameSize)`, `gitTreeStyle(...)`, `pipRootBox(geometry)`,
    // `surfaceStyle(placement)`, dnd-kit's `sortable.style`, a measured
    // `rect`, `useEpicNodeIconTone(type).style`. Every property inside is one
    // the allow list above already permits - `useEpicNodeIconTone` builds the
    // `--swatch` custom property and nothing else - and the rule simply cannot
    // follow a function call, the same single-file limit that keeps
    // `require-static-classes` off (ticket 09).
    // Inlining these helpers at 34 call sites to satisfy it would be a worse
    // codebase, so the rule is off where the helper is used and stays on
    // everywhere else in those files' directories.
    files: [
      "src/components/browser-tile/browser-viewport-frame.tsx",
      "src/components/chat/chat-progress-icon.tsx",
      "src/components/chat/context-usage-chip.tsx",
      "src/components/chat/queued-message-surface.tsx",
      "src/components/chat/segments/image-generation/image-generation.tsx",
      "src/components/epic-canvas/dnd/pane-drop-zone.tsx",
      "src/components/epic-canvas/epic-node-tab-icon.tsx",
      "src/components/epic-canvas/git-diff/file-tree.tsx",
      "src/components/epic-canvas/git-diff/selected-repo-changes.tsx",
      "src/components/epic-canvas/image-preview/image-diff-view.tsx",
      "src/components/epic-canvas/pip/agent-browser-pip.tsx",
      "src/components/epic-canvas/renderers/agent-cursor-overlay.tsx",
      "src/components/epic-canvas/sidebar/epic-sidebar-artifact-tree.tsx",
      "src/components/epic-canvas/sidebar/epic-sidebar-chat-tree.tsx",
      "src/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row.tsx",
      "src/components/epic-canvas/sidebar/epic-sidebar-file-tree.tsx",
      "src/components/home-focus/home-focus-rows.tsx",
      "src/components/home/pickers/harness-model-picker-footers.tsx",
      "src/components/home/terminal-panel/landing-terminal-panel.tsx",
      "src/components/layout/header/app-header.tsx",
      "src/components/layout/top-level-tab-host.tsx",
      "src/components/notifications/notification-indicator-icon.tsx",
      "src/components/notifications/notifications-popover.tsx",
      "src/components/resources/resource-monitor-popover.tsx",
      "src/components/settings/panels/appearance-settings-panel.tsx",
      "src/components/ui/shimmer.tsx",
      "src/components/ui/start-truncated-text.tsx",
    ],
    rules: {
      "shadcn/no-inline-styles": "off",
    },
  },
  {
    // Vendor artwork. These are other people's marks - VS Code's blues, the
    // Claude orange, the provider logos - reproduced at their real values
    // because that is what makes them recognizable. A theme token would be
    // wrong by definition, and `currentColor` would flatten a multi-colour
    // logo into one shade.
    files: [
      "src/components/icons/editor-icons.tsx",
      "src/components/home/pickers/harness-icons.tsx",
    ],
    rules: {
      "shadcn/no-raw-colors": "off",
    },
  },
  {
    // Surfaces whose colour does NOT come from the theme, so no theme token
    // can express them:
    //
    //   - the two sign-in surfaces paint on `StandaloneShell`'s fixed dark
    //     photo backdrop (see the full-bleed surface note in AGENTS.md). The
    //     Traycer mark is white on that artwork and the hero button is white
    //     with near-black label, in BOTH appearances - they are not following
    //     a theme and must not start.
    //   - the profile avatar's background is a hashed palette entry or a
    //     colour the user picked (`resolveProfileAccentColor`), never a token,
    //     so its initials need a fixed dark that reads on those values.
    //     `--foreground` would flip with the theme while the chip behind it
    //     did not.
    files: [
      "src/components/auth/cinematic-backdrop.tsx",
      "src/components/layout/header/sign-in/device-code-progress.tsx",
      "src/components/providers/profile-avatar-badge.tsx",
    ],
    rules: {
      "shadcn/no-raw-colors": "off",
    },
  },
  {
    files: fixedPaletteFiles,
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        { allow: [...sanctionedArbitraryValues, "*-[#*]"] },
      ],
    },
  },
  {
    // The mobile switcher's tab triggers need a REAL 44px, not a rem-based
    // one: that surface's root font is 15px, so `min-h-11` measures 41.25px
    // and the 44px hit-slop `::after` in `mobile-shell-touch-targets.css`
    // spills out of the list's exact fit. The file says so at the call site
    // and a test asserts the literal.
    files: ["src/components/epic-canvas/mobile/switcher-category-tabs.tsx"],
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        { allow: [...sanctionedArbitraryValues, "min-h-[44px]"] },
      ],
    },
  },
  {
    // The office directory's status glyph is a mark INSIDE a 12px pip - the
    // second channel beside its colour, not a piece of text. The ramp starts
    // at `text-micro` (10px), which does not fit a 12px box with the bold
    // weight the glyph needs to read at that size.
    files: [
      "src/components/epic-canvas/comm-graph/office/office-directory-panel.tsx",
    ],
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        { allow: [...sanctionedArbitraryValues, "text-[8px]"] },
      ],
    },
  },

  // Oxlint runs first and owns every compatible rule represented in its
  // generated config, including the type-aware rules. Keep this last so ESLint
  // retains the repository-specific boundaries and selector-based invariants
  // whose implementations and executable guard tests remain ESLint-specific.
  ...oxlint.buildFromOxlintConfigFile(".oxlintrc.json"),
);
