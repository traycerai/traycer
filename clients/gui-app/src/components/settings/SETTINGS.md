# Settings Architecture

## Overview

The settings UI lives in `src/components/settings/` and is mounted by the
TanStack Router `/settings/*` routes.

This surface is a **real local settings shell**:

- the routes, layout, sidebar, and panels are real
- settings values persist locally through Zustand
- every settings row is wired into runtime behavior. The previously-inert
  Language, Speed, Show in menu bar, and Default workspace mode rows (written
  but never read) were removed.

When changing the settings surface, update this file in the same change.

## Structure

```text
SettingsLayout
├── SettingsSidebar
└── Outlet
    └── settings panel route
        ├── GettingStartedSettingsPanel
        ├── GeneralSettingsPanel
        ├── AppearanceSettingsPanel
        ├── LayoutSettingsPanel
        ├── OpeningBehaviorPanel
        ├── ProvidersSettingsPanel
        ├── NotificationsSettingsPanel
        ├── AgentsSettingsPanel
        ├── FallbackSettingsPanel
        ├── KeybindingsSettingsPanel
        ├── ShellSettingsPanel
        ├── WorktreesSettingsPanel
        ├── HostSettingsPanel
        ├── AppDiagnosticsSettingsPanel
        ├── DiagnosticsSettingsPanel
        └── UsageSettingsPanel
```

Settings is also presented as a **modal** via `settings-modal-content.tsx`,
which maps each `SettingsSectionId` to its panel in a `switch`. A new section
must be added in BOTH places - the route file under `src/routes/` AND the modal
`switch` - or the modal renders a blank pane for that section.

Five other places enumerate section ids, and four of them fail loudly when one
is missed. `settings-modal-content.tsx`, `stores/tabs/kinds/settings.tsx`
and `report-issue-dialog.tsx`'s `ROUTE_TEMPLATE_LABELS` are exhaustive over a
union or over `FileRouteTypes["fullPaths"]`, so a compile error catches them.
`lib/analytics.ts` is exhaustive only because `ANALYTICS_SETTINGS_SECTIONS` is
built through `satisfies Record<AnalyticsSettingsSection, true>` - that
`satisfies` is doing real work, and without it a missing id silently drops the
navigation event. `SETTINGS_PATHS` (`stores/tabs/settings-paths.ts`, imported by both
`stores/tabs/store.ts` and `stores/tabs/desktop-tabs-persistence.ts`, which
used to hold a copy each) is a hand-written string set: a section absent from
it stops being recognised as a settings route for persistence. It cannot be
derived from the section table, because it also accepts the retired `service`
alias - so it is a superset, and three ids went missing before anyone noticed
(`devices` for its whole life, then `link-phone`, then `app-notifications`).
The gate now exists and is a test rather than the compiler:
`stores/tabs/__tests__/settings-kind.test.ts` asserts every section id is in
the set.

## Page shapes

A settings page takes one of two shapes, and which one is decided by its
content, not by taste.

- **Stacked groups** (`settings-group.tsx`) is the default: named groups of
  rows down one scroll, everything on the page visible at once. General,
  Browser, Sounds, Opening behavior and most others.
- **The rail** (`settings-master-detail.tsx`) is for a page that is a
  collection of like things (Providers) or too long to scan in one scroll
  (Layout, Appearance). It shows one area at a time, so it costs a click per
  area and a third column beside the settings sidebar. On a short page that is
  all cost: General on a rail would be a rail entry per row.

Two rules for a stacked page:

- **A group holds at least two rows.** A heading and a border around one row
  is a container, not a group, and a page of them reads as nested boxes with
  small titles. Danger Zone is the exception, because its tone is the point.
- **Detail appears when a setting is being changed.** A long choice is a
  dropdown with a sentence per option (General ▸ When you quit Traycer), not a
  permanent block of radios.

One rule for a rail page, and it has three callers. **Whatever points at a
control has to pick that control's area first**, because only the picked area
is on screen (`settings-master-detail-area.ts`):

- **A search result** picks the area of its anchor (`useSettingsAnchorArea`).
  A row with no anchor of its own contributes its name to its GROUP, never to
  the page: a page result opens the page on its first area, so the page's own
  keywords name only what that first area holds.
- **A setup guide step** picks the area that holds its target
  (`useSettingsGuideArea`), found through the `data-settings-area` each area's
  panel carries. Without it the coachmark has no visible target and the guide
  has no card to continue from. An armed reveal for a row of the page outranks
  it: a guide stays active while Settings is closed, so the page can mount
  with both, and the reveal is what the person asked for a moment ago.
- **A link from outside Settings** to something that is not in the first area
  arms the same reveal a search result does, with the group's anchor (the
  start page's "Customize start page" button).

## Getting started

`/settings/getting-started` is the persistent setup checklist for agent selection,
appearance and layout, and browser sign-ins.
Cards launch guides over the existing controls
through `SettingsSetupGuide`, shared by the modal and routed settings surfaces.
It uses the same nonmodal coachmark as the first-task guide: no overlay or
focus trap, and nested pickers pause it. In a modal it portals inside that modal.
A halo marks the target; there is no arrow. While the card has focus, Right/Enter
continues and Left goes back; Tab and Enter retain native button behavior.
Action-required steps press the real control when it is a button or link, and focus it when it is a field, instead of skipping it. Once focus
moves into a control, the coachmark does not take it back. Text fields and pickers
keep their own keys. Keyboard navigation reveals settings instantly.
Escape closes the guide before Settings can close and returns focus to its target, and it works from anywhere on the surface rather than only from the card or its target - unless a picker, menu or dialog is open, which answers its own Escape first.
Closing a guide is a skip, and a skip is done: Escape and the card's X both mark that guide complete, so a card the person has seen and declined never comes back asking again.
Closing the settings surface mid-guide is not a skip - `activeSetup` is session-local presence, so the guide simply resumes at its step when Settings reopens.

**Every step names its own section**, not the guide.
The guide draws only while the mounted section is the one the current step points at, Continue navigates to the next step's section when it differs, and Back navigates to the previous step's.
`setupGuideStepSection` is the same answer for a card: resuming lands on the section of the step it resumes at, not on a section hardcoded per guide.
The engine's mount point survives a section change (`SettingsPanelForSection` swaps the panel beneath it), so crossing sections does not pause the guide.

**The guides are a table, not four special cases.**
`stores/onboarding/setup-guides.ts` holds every step - its section, its selector, its copy - and is React-free, so the store, the coachmark and the product code a step waits on all read the same rows.
`SETUP_GUIDE_LENGTHS` is gone with it: `setupGuideLength(id)` is the step list's own length, never a number copied beside it.

The three guides: agent selection is three steps on Agents (the editor shell, its Edit/Preview toggle, the Revert button).
Appearance and layout is six, and it crosses surfaces: theme mode, wallpaper and interface font on Appearance, then the density preset, the region sections and the Customize layout entry on Layout.
Its final step is the one that SHOWS the editor instead of entering it (L-50): a step may carry `litChrome`, and while it is up `useLayoutLitMoment` puts `data-layout-lit` on the document element, which is the second selector on `layout-editor.css`'s passive-dim rules.
The real chrome around Settings dims exactly as it does on the canvas; closing the step ends the effect and completes the guide, and nothing is entered, leased or written.
The runner (`SettingsSetupGuide`) draws nothing while a layout-editor session is running - the editor owns the screen and its Escape - and resumes at the same step afterwards.
Browser sign-ins is two steps on Browser: the "Save website sessions" switch, then the "Choose source…" button, which is action-required and is where the guide waits.
It is also the one guide with a `requiresBrowserView` flag, because without the desktop browser bridge there is no way to finish it.

Progress is local in `onboarding-store`: -1 means not started, intermediate steps
resume, and the guide length means complete. Active guides are session-local;
replaying a completed guide does not clear completion. Agent selection and
appearance finish on Done, so keeping defaults is valid.

The store is persisted at version 2.
The migration settles a checklist nobody has touched for anyone who finished the tour before the checklist shipped: every guide is marked complete and the reminder is dismissed, because they have been using the app already and three open cards would be a nag rather than a checklist.
Someone part-way through a guide keeps their progress and is still offered the rest of it, and a user who has not finished the tour is left alone.

**A step the product finishes says so in the table, and the product reports an event rather than a guide id.**
A step carries `advanceOn` for an event that moves past it in place of Continue, and `completesOn` for the event that ends the guide from it.
`SettingsSetupGuide` reads those flags: a step with `completesOn` offers no Done and waits, and `advanceSetup` refuses to walk off it, so the guide can only end with the real thing having happened.
Both call sites go through `notifySetupEvent`: the "Save website sessions" switch reports `browser-save-enabled`, which auto-advances to the import step (the switch IS the step, so there is nothing to confirm), and the existing import mutation reports `browser-logins-imported` only when cookies were successfully imported.
Cancelled, blocked, and empty imports leave the card unfinished, and neither `browser-settings-section.tsx` nor the mutation hook names a guide.
Import is offered only when the desktop browser bridge and host binding are present.

A started, unfinished card reads "Step n of total" and draws a thin meter along its bottom edge; a finished one keeps the green check and "Complete".
The meter is a native `<progress>` filled with the steps already COMPLETED, styled through `getting-started-settings.css`: the last unfinished step draws a nearly-full bar, not a full one, and no table of width classes has to track the step counts.
The header count is "n of m complete" over the guides this shell can OFFER - the tour plus the available ones.
A guide gated out (`requiresBrowserView` on a build with no browser bridge) drops out of the numerator and the denominator alike, so the panel never reads one short for ever and the start page's reminder, which is that same difference, goes quiet once the reachable work is done.
The sidebar's progress ring counts the same way.

Each card's label and copy come from `getting-started-settings.definitions.ts`, like any other searchable setting.
Only the replay card owns a search ENTRY and an anchor - it inherited the removed General "Product tour" row, keywords included, so "walkthrough" and "first run" still land on it.
The three guide cards contribute their words to the page instead: each one names a settings page that already has an entry of its own, and a second result under the same label would outrank the page the person typing it wants.

On the mobile viewport the first-task guide has a second branch, for an account that already has tasks: the phone's landing page carries no task list, so the guide teaches where they went rather than how to start another one.
Step 1 points at the header hamburger, step 2 at the first row in the drawer's Recent tasks list, and both are DERIVED from the drawer's open state - opening it by any route advances, closing it without picking returns to step 1, and opening a task ends the guide.
The count comes from the drawer's own `useHistoryQuery`, so it is a cache read rather than a second fetch; while it is outstanding the guide draws nothing, and an empty list or an error falls through to the folder flow every desktop user sees.
Anchoring inside the drawer is what `guide-overlays.ts` is for: a modal surface seals every body-level sibling off, so the card is PORTALLED into it rather than floated beside it - the Sheet is already on that list by slot, and the installed app's hand-rolled panel says the same thing on `data-overlay-surface`.

Getting started leads the sidebar in its own unlabeled Guide group, above
Application. It uses the first settings leader digit; General uses the second.
The start page offers the checklist through a persistent, dismissible toast once
the first-task guide ends. Dismissing it is remembered locally across reloads;
the checklist remains available in Settings. Completed checklists hide the toast.

The Home tab draws the checklist itself, above its task sections
(`home-focus/home-getting-started-section.tsx`), from the same cards
(`onboarding/getting-started-cards.tsx`) and the same count
(`onboarding/getting-started-checklist.ts`) as this panel. The Home copy is
denser, steps between whole rows (4 / 2×2 / 1) off its own container width,
omits a guide the shell can never offer, and carries no search anchors, so the
reveal still lands on the Settings card when both are mounted. While anything
is left it is open; once every offered guide is complete it folds into one row,
closed by default each time Home mounts.

## Search

The rail's first control is a search box (`settings-search-box.tsx`), rendered
by `SettingsSidebar` and therefore present in BOTH surfaces and both rail
variants at no extra cost. While a query is non-empty the results REPLACE the
section list — two lists in one column would compete, and every result already
names the section it belongs to.

Six parts:

| Part         | File                                                                                                | Owns                                                            |
| ------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Definitions  | `components/settings/panels/*.definitions.ts`                                                       | One collection per section: every row, group and page           |
| Model        | `lib/settings-search/settings-definitions.ts`                                                       | `defineSettingsSection`, folding, the entry type                |
| Assembly     | `lib/settings-search/settings-search-entries.ts`                                                    | The list of collections, then the layout launch results         |
| Availability | `lib/settings/settings-availability.ts`                                                             | One predicate per row gate, shared with panels                  |
| Ranking      | `lib/settings-search/settings-search.ts`                                                            | Fuse pass, field weights, kind tie-break                        |
| Reveal       | `stores/settings/settings-search-store.ts`, `use-settings-anchor-reveal.ts` + `settings-search.css` | The pending "scroll here" handoff; finding, scrolling, flashing |

**A setting is written once.** Each section has one collection, in a
React-free `*.definitions.ts` module beside its panel, built by
`defineSettingsSection(sectionId, { page, ...members })` from a plain keyed
object. The function enumerates that object: every member becomes a definition
(`GENERAL.definitions.preventSleep`) and the page plus every entry-owning
member become the collection's search entries (`GENERAL.entries`). There is no
second value to keep in step with the first — `SettingsRow` and `SettingsGroup`
take a definition as their only content (`row=` / `group=`), so a row cannot
render without the value the index reads, and its label, static description
and anchor come from there. `settings-search-entries.ts` only lists the
collections. A collection module may import the model and the availability
predicates; it never imports the assembled index or the search consumer.

- `page` is a required member of every input - the section's own entry. Its
  `availableWhen` is required too and is the gate for the WHOLE page: it is the
  page entry's own gate and is composed (AND) into every member's, so a row can
  never be offered by search in a shell where its page is withheld. Every page is
  `alwaysAvailable`.
- `kind: "row" | "group"`. A row names its group by key (`group: "runningAgents"`,
  compile-checked to be a group-kind member) or `null` for a row that sits in
  no group.
- `search` is exactly one of `{ anchor: string | null }` — its own entry;
  `null` is a bespoke region with nothing stable to point at (Providers' seven
  concept groups), landing at the top of the page — or `{ contributesTo: key |
"page" }` — no entry; its label and keywords fold into the target's keywords
  (case-insensitive duplicates dropped, own keywords first, then contributors
  in input order). A target is an entry-owning member of the same collection
  or the page: `contributesTo` is typed to exactly those keys, so a dangling
  key, the member itself and another contributor are compile errors. A
  `search` naming both placements is a compile error on that member when it
  is written inline (a union alone would accept it); a value annotated with a
  widened placement type can slip past that conditional, so the index test's
  raw-input invariant — every member has exactly one placement — is the check
  that covers every shape. Row targets are allowed — the per-kind Link rows fold into **Open links**, the
  per-category Tile rows into **Open new tiles**.
- A group's `breadcrumb` is the group segment of its result's breadcrumb —
  `null` for a rendered card, `"Providers"` for that page's region groups.
- **Availability composes for containment only.** A row's effective
  `availableWhen` is its own AND its group's. The merged groups (General ▸
  Agents, Browser ▸ Agents, Sounds ▸ Notifications) are drawn in every shell,
  so each gated row in them carries its own predicate (Agent roles, OS
  notifications, Push notifications). A contribution target is not a
  container: contributing never changes the target's availability.
- **`status` replaces the static description.** `SettingsRow` takes
  an optional `status?: ReactNode`, selected by `!== undefined` — omitted and
  `undefined` are the same, never truthiness, never `status ?? description`,
  because `null` / `false` / `""` are a deliberate suppression. A status renders INSTEAD of the definition's
  description, in the same described-by region (a `div`, since it is arbitrary
  content) with the same muted style, and the `aria-describedby` id follows
  whichever region rendered. The definition's `description` stays the
  searchable copy. Agent roles keeps its static help and replaces it with the
  repair copy on a read error; rows whose only sentence is live — the narrow
  viewport notice on Open new tiles, the phone's push state, Import your work
  and Data migration progress, the host-named File edit snapshots and Remove
  from account copy, the saving state of Save website sessions, the start
  page's wallpaper name — have `description: null` and pass the whole
  sentence as `status`. Its label-line twin is `labelStatus`: a live badge the
  row renders after the definition's label, in the same label element and
  behind the row's own " · " separator, selected by `!== undefined` with
  `null` / `false` / `""` rendering the bare label. The theme slots pass
  `"Active"` there ("Light theme · Active"); the definition's label stays the
  searchable copy.
- **Hand-built regions read the definition too.** The branch-prefix row keeps
  its bespoke layout (the input and its live preview share a line) and writes
  `data-settings-anchor={GENERAL.definitions.branchPrefix.anchor}` and its
  label from the definition. The index test also scans the settings tree for
  the common literal form (`anchor="…"` / `data-settings-anchor="…"`) as a
  hygiene check; it cannot see an expression or a variable, so reachability
  and membership rest on the fixture executor and reverse membership, not on
  the scan.
- Shared rendering components take definitions through typed props:
  `LogDetailGroup` takes its page's `group` (anchored on App Diagnostics,
  folded into the page on host Diagnostics), each `LogLevelControl` carries
  its `row`, and the chime / severity / link-kind rows are keyed members of
  their owning collection.
- `MOD_ENTER_LABEL` lives in `general-settings.definitions.ts`: the steering
  row's label and description are built from it there, and the panel imports
  it for the switch's accessible name, so the result and the row print the
  same chord.

**Launch results (Layout regions).** A query for a piece of chrome offers one
result per layout REGION rather than per row: `components/layout-editor/layout-search.definitions.ts`
generates one `SettingsSearchEntry` from every entry of the region registry
(the region's name, where it lives and its keywords, `group` = its surface, so
the two "Usage limits" results are told apart) and `settings-search-entries.ts`
appends them after every collection's entries. The entry type carries `launch:
RegionId | null`; a launch entry has `anchor: null` and its result key is
`<section>:launch:<id>`. Generated rather than written out, because the
registry already IS the one description of a region - a second copy in a
`*.definitions.ts` collection could only drift from it, and a region added
without one would be unfindable. A launch entry is not an anchor, so the
exact-target invariant does not apply to it; `launch-placement.test.ts` asserts
instead that each one names an existing region. (There is deliberately no third
placement form on `defineSettingsSection`: nothing hand-writes a launch
member - the registry is already the one list.) The result row wears a
"Layout" badge.

Selecting one does not navigate: it calls `openLayoutEditor` with that region
as `target`, so the editor opens on that section (L-07, 5.3). The door owns
what a narrow window means - below its threshold it lands on `Settings ▸
Layout`, which is where an ordinary result would have gone. `entry` is
`"keyboard"` for Enter and `"pointer"` for a click, because it gates the entry
motion as well as being reported (L-30, L-54).

**What is guaranteed, and by what.**

| Claim                                                                                                                                                                    | Established by                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `SettingsRow` / `SettingsGroup` cannot render without a definition                                                                                                     | the type of its only content prop                                                                                                                                                                                                                                                                                     |
| Every definition belongs to its collection                                                                                                                               | `defineSettingsSection` creates every output by enumerating its input; the index test checks definitions against the input key for key                                                                                                                                                                                |
| Exactly one collection per section, each assembled once                                                                                                                  | assembly test against `SETTINGS_SECTIONS`, plus every `*.definitions.ts` export found by `import.meta.glob` must be in the assembly by identity                                                                                                                                                                       |
| Every anchored entry has exactly one unconcealed target in every registered shell where its gate is on, none where off, and at least one registered shell where it is on | the fixture executor (`__tests__/settings-search-fixtures.test.tsx`) mounts every `section × shell` in `__tests__/settings-search-fixture-registry.ts` and runs `assertSettingsSearchTargets`; the index test asserts every anchored section is registered and every anchored entry is available in one of its shells |
| Every rendered anchor is an indexed anchor of that section                                                                                                               | reverse membership inside `assertSettingsSearchTargets`                                                                                                                                                                                                                                                               |
| Every contributor's words reach an entry                                                                                                                                 | the coverage test: its label and keywords appear in its target entry's document; no dangling, self or contributor target                                                                                                                                                                                              |
| Every member has exactly one placement                                                                                                                                   | `CheckedSectionInput` rejects a `search` with both; the index test checks the input member by member                                                                                                                                                                                                                  |
| No host-GATED element carries an anchor                                                                                                                                  | an exhaustive index test: an anchor on a host-scoped section is legal only when that section is registered with `hostScope: "connecting"`, so the executor proves every anchor it indexes lands while the host has no usable client (today: Permissions' tab bar and its Modes row, and the host Overview's tab bar)  |

**Not guaranteed:**

- A bespoke `<div>` that uses no primitive and writes no anchor is invisible to
  all of this. Providers and Worktrees are indexed at page and region level
  for that reason, and the host Overview at page and TAB level: its tab
  triggers are destinations, and every card inside a tab body folds into the
  page.
- TypeScript is structural: the types enforce a definition's SHAPE; the
  collection, reference and DOM tests establish COVERAGE. Types are not
  provenance — nothing stops a panel rendering another section's definition.
  Reverse membership sees anchors only, so a foreign or null-anchor definition
  rendered in the wrong panel is not caught by it.
- The DOM tests run in jsdom: existence, uniqueness, count and the absence of a
  `[hidden]` ancestor — never CSS or layout visibility (a collapsed disclosure).
- State combinations no registered shell mounts (a bridge-present shell with no
  host runtime bound, an unreachable or vanished selected host), and a
  capability that vanishes between the search and the navigation.
- Whether a `contributesTo` target is the right PRODUCT destination: it is
  type-valid; a human still chooses it.
- Ranking for queries the ranking suite does not pin, after vocabulary folding.
  The ranking suite (`__tests__/settings-search.test.ts`) is the contract, not
  every query.

What stays human: keywords, the seventeen `page` blocks, a region group's
`breadcrumb`, and the `contributesTo` target of a row that cannot promise its
element.

**Keyboard.** The input keeps focus the whole time, so it is a `combobox`
whose `aria-activedescendant` names the highlighted `option` and whose
`aria-controls` names the `listbox` — an empty one when nothing matches, never a
paragraph in its place. The pointer never takes focus either: result options
are `tabIndex={-1}` and the options and the clear button cancel `mousedown`,
so after a click the arrows, typing and Escape still reach the input (clearing
unmounts the clear button, and focus taken by it would fall to the document). The query lives in
`stores/settings/settings-search-store.ts` rather than in the rail, because
the modal frame needs to know a search is running: the settings overlay's
`consumeEscape` (`stores/tabs/overlays/settings.tsx`) clears it from the
dialog's own capture-phase Escape handler, so the first Escape clears the
search and only the next one closes Settings. A `stopPropagation` inside the
rail cannot do that — Radix hears Escape on the document before the input
does. The rail clears the query when it unmounts, so it never greets the next
visit.

**Ranking.** One Fuse pass through the shared wrapper the composer menus
already use (`lib/composer/fuzzy-ranking.ts`) — same library, same tolerance,
so a typo behaves the same here as in the `@` menu. Fields are weighted label >
keywords > group > section > scope > description. Keywords are the point of the
index: they carry the words a label does not ("dark mode" → Theme, "proxy" →
the Shell page, "caffeinate" → Prevent sleep). A small per-kind factor breaks
near-ties toward the more specific hit, so typing "theme" lands on the ROW
rather than the page — and it is small enough that a page still wins on its own
name.

**Anchors.** `SettingsRow`, `SettingsGroup` and `SettingsSubgroup` take an
`anchor` prop and emit `data-settings-anchor`; a hand-built target writes the attribute directly (see
`OpenEditorAction` in `panels/layout-settings-panel.tsx`). `LogDetailGroup` takes its anchor as a
required `string | null` prop because the same card is the "Log detail" group
on two different pages, and only the app's is indexed — the host page passes
`null`.
Anchors are unique across the whole index — the lookup is a bare attribute
selector with no section in it.

A group anchors its **card**, not the `<section>` that also wraps its heading.
The heading sits outside the card by design, so a mark on the section drew the
ring around the label plus the empty gutter beneath it and made the group's
name read as part of its contents. `__tests__/settings-group.test.tsx` pins
this.

**A result must land somewhere.** Four kinds of conditional row, four
different answers:

- **Gated on a MODE** (the per-kind Link rows, the per-category Tile rows,
  which render only once their parent is switched off the default; the rows
  inside a `SettingsSubgroup`, which its title switch hides) — not indexed;
  the vocabulary rides on the parent row's, group's or subgroup's keywords.
  **A VIEWPORT is a mode, not a shell**, and that is the trap: a row gated on
  one can carry a perfectly good shell predicate and still resolve to nothing
  in a narrow window, because no predicate can see a width. Placement was
  anchored until it started hiding below `md`; searching it in a narrow
  desktop window then landed on an empty page. A row whose drawing condition
  mentions the viewport at all belongs here. Tab triggers - Permissions' and
  the host Overview's - are the one anchored element a viewport redraws, and
  they stay indexed because the landing never depends on the width: on a
  phone viewport the tab bar becomes one Select whose trigger carries the
  ACTIVE tab's anchor, and the panel switches to the landed tab (during
  render, from `pendingReveal`) before the reveal's first poll, so the anchor
  asked for is always the one drawn.
  A subgroup IS indexed, anchored on its inset card, so a result for one of
  its rows lands on the switch that reveals the row.
- **Gated on DATA** ("Detected dev origins" and its Browser card, which render
  only once a terminal has printed a local URL; the start page's Wallpaper
  effect, Effect strength and Tint rows, which render only once a wallpaper is
  chosen, and Tint only for the effect it adjusts; Layout's per-provider rows,
  which exist only for providers the watched host has reported) —
  `contributesTo: "page"`, or the row that stands in for the set. No shell can
  promise the row, so no shell offers it. "Detected dev origins" shipped as a
  result that navigated to General and lit nothing.
- **Gated on the SHELL** (Zoom, Agent roles and OS notifications need a
  desktop bridge; Push notifications needs `pushPermission`; Voice input and Prevent
  sleep hide in the mobile app, and Layout's "Show the status bar on small
  screens" row exists only there) - indexed, with
  the definition's
  `availableWhen` set to the gate's **named predicate** in
  `lib/settings/settings-availability.ts`. The panel gates the row (or group)
  on that definition's own `availableWhen` — the composed predicate the entry
  carries — so a gate is written in exactly one place and the index and the
  surface cannot disagree. The gate stays a component boundary: Zoom, This
  phone and System check it in an outer component and mount their hooks only
  once it passes. Both reach the context through
  `useSettingsAvailabilityContext()` (`hooks/settings/`), which reads the
  runner host, the desktop feature-settings bridge and `isMobileApp()` at
  render time — never a module constant, so a module evaluated before the
  Capacitor entry runs cannot freeze the wrong answer. The context is the
  whole truth: a predicate reads only its argument, never a global, so the
  predicates module has no React in it and tests call it with a literal
  context.
- **Gated on the SELECTED HOST** (which removal verb a host has — "Remove
  Traycer" for this computer, "Remove from account" for a registered remote;
  File edit snapshots behind a live route; Data & migration behind the host's
  stream and a negotiated import capability; host Diagnostics' Log detail and
  both Shell cards, Terminal shell · New terminals and Host environment ·
  After restart, which a host too old for the config RPC replaces with a
  notice; the bodies of Permissions' Judge, Rules and Activity tabs, which a
  host that predates `autoJudge.get` / `autoPolicy.get` /
  `autoJudge.listRecent` has no notion of at all; and
  every card inside the Overview's tab bodies - Installation and Danger zone
  among them - which come and go with the host's state and which the page
  drops for an unresolved or vanished host) — not indexed. A
  shell-level context cannot decide selected-host identity or a capability
  negotiated over host RPC, and a predicate that pretended to would be a
  second, wrong model of the panel. The rule is **stable destinations**: index
  an element that renders whatever state the selected host is in — the PAGE,
  or an element the page draws OUTSIDE its `HostScopeGate` — and let every
  definition inside the gate contribute to it, so its label folds into that
  entry's keywords. "log level", "startup flags" and "wsl" land on their
  page; "judge", "policy", "allow rule" and "activity" land on the
  Permissions tab trigger that opens them; "uninstall", "snapshots",
  "import", "installation" and "port forward" land on the Overview tab
  trigger that opens them. The invariant that follows: **no host-GATED
  element carries an anchor.** Two host-scoped pages anchor anything, and
  only what sits outside their gates. Permissions: the tab bar (a trigger is
  never gated — `HostScopeGate` wraps the three host-backed tab BODIES) and
  the Modes row, which is application-scoped. The Overview: its tab bar,
  which renders for every host in every state above bodies that each gate
  themselves; everything inside a body folds into the PAGE, whose own
  vocabulary is split across the five triggers. The index test enforces it mechanically: an
  anchored entry on a `group: "host"` section is legal only when that section
  is registered with `hostScope: "connecting"`, so the executor has proved the
  anchor lands while the host has no usable client.
- **Gated on the HOST RUNTIME** (Website sessions, which also needs a bound
  host runtime and a successful first read of the browser bridge; host
  Notifications' two groups, which the page's scope gate conceals while the
  host connects or is unreachable and drops for a vanished host; and every
  Fallback group, behind the same kind of scope gate and rendered only once
  the host answers the policy read) — not entries either: they contribute to
  the General, host Notifications and Fallback page entries.

Bespoke pages are indexed at page/region level for the same reason: their
content exists only once a host answers an RPC.

**DOM contract tests.** Types prove a definition is well-formed; they cannot
prove it renders. `__tests__/settings-search-targets.ts`
(`assertSettingsSearchTargets(section, context, container)`) closes that for a
mounted panel: every anchored entry for the section must resolve to exactly
ONE element outside any `[hidden]` ancestor when its `availableWhen(context)`
is true and to ZERO when false, and every anchor the panel renders must be one
of that section's indexed anchors. The always-included executor
(`__tests__/settings-search-fixtures.test.tsx`) iterates the registry
(`__tests__/settings-search-fixture-registry.ts` — `{ section, shells }`, data
only), mounts each section's panel in each shell, checks that the shell the
panel resolved through `useSettingsAvailabilityContext()` is the one the
registry describes, runs the contract, and finally asserts it mounted every
registered shell. Each shell turns on one gate at a time — every bridge
absent, each bridge alone, mobile and not. The zero half is the point: a
definition wrongly left `alwaysAvailable` while its panel gates it passes a
fully bridged mount and fails only the shell whose gate is off. The index test
closes the registry from the other side: every section with an anchored entry
must be registered, and every anchored entry must be available in at least one
of its shells — otherwise it is only ever asserted absent, which a row that
never renders passes too. A fixture's `hostScope` is `null` for an
application page and `"connecting"` for a host-scoped one: the executor mocks
`useHostScope` to a connecting scope for it, so every body behind
`HostScopeGate` is concealed and only the anchors outside the gate can be
found. Permissions and the host Overview are the host-scoped pages
registered; every other host page anchors nothing, so it has nothing to
prove.

**Reveal.** A click arms the store, then navigates through
`lib/settings-navigation.ts` (surface-agnostic — the modal deliberately uses no
router hooks). `useSettingsAnchorReveal`, mounted once inside
`SettingsPanelForSection` so both surfaces get exactly one watcher, polls on
`requestAnimationFrame` for the element until it is VISIBLE or a 3s deadline
passes, then scrolls it to CENTER (so the group heading above it stays visible)
and marks it for 1.8s. Visible, not merely present: a scope gate keeps its
content mounted inside a hidden `<Activity>` while the host connects, and an
element found there would spend the request on a scroll to nowhere
(`checkVisibility()`, falling back to `offsetParent`). A page result arms a
request too, with a `null` anchor: once the requested section is on screen its
pane scrolls to the top and nothing is marked — navigating to the section
already showing would otherwise move nothing. The pane is the
`[data-settings-panel-pane]` element each SURFACE (`settings-surface.tsx`,
`settings-modal-content.tsx`) wraps its panel in, not anything a panel renders,
so a bespoke panel cannot fall outside it.

The deadline is measured from the request's `requestedAt`, not from when a
watcher started looking, so a request that outlives its surface cannot fire
when Settings is next opened. Closing the surface also clears whatever request
is pending — deferred one tick and cancelled by the watcher's next mount.
React's development double-mount unmounts and remounts synchronously, so its
clear never runs and a request armed just before the panel existed (the
phone's section list navigating into it) survives; a real unmount has nothing
to cancel it. One close is not an abandonment: promoting the modal into the
settings tab. The modal surface calls the settings overlay's
`prepareForPromotion` first, which marks a handoff in the store; the closing
watcher then leaves the request alone, and the next watcher to mount — the
tab's, which mounts lazily, after any deferred clear would have run — ends the
handoff and reveals it.

An anchored row's scroll is done by hand on the row's **nearest scrolling
ancestor**, not on the surface's pane: a fill-height panel such as Agent
selection scrolls inside its own body, where moving the outer pane cannot
center anything. It is never `scrollIntoView`, which moves every scrollable
ancestor and in the modal dragged the whole dialog (header, rail and all) up
with the panel pane. The deadline covers a cold host RPC; giving up clears
the request, so a stale one never fires at a user who has since navigated
somewhere else. The flash is attribute-driven, not class-driven, because the
element is marked from outside React — and it is an alpha of `--foreground`,
never `var(--muted)`, which collapses into the card on most preset themes.

**The mark's lifetime is held in refs, deliberately.** Finding the element ends
the REQUEST — the watcher clears it immediately so a never-resolved one cannot
fire later — but the mark has to outlive that by most of two seconds. Those two
lifetimes shared one effect once, and because clearing the request mutates a
value that effect depends on, React tore the effect down the instant it
succeeded and the teardown stripped the attribute it had just set: the row
scrolled into view and never lit up. Nothing static caught it — the attribute
WAS being set — so `__tests__/settings-anchor-reveal.test.tsx` asserts the
settled state (is the mark still there after the request clears?) rather than
that `setAttribute` was called, which would pass against the broken version.
Do not move the flash back into the `pendingReveal`-keyed effect.

## Responsive Behavior (mobile)

The **route** presentation collapses to a drill-down below the 768px
`useIsMobileViewport()` breakpoint: `/settings` renders the section list full-screen
(`SettingsSidebar` with `variant="mobile-list"` - the index no longer
redirects on phones), tapping a section navigates to its existing route
full-screen, and `settings-layout.tsx` shows a back-to-list header instead of
the rail. Desktop keeps the exact two-pane shell; the **modal** presentation
is deliberately unchanged internally (it always renders the rail variant) and
simply never opens on phones: `openSettings` in
`src/stores/tabs/use-system-tab-modal.ts` - the single funnel for every modal
entry point (user menu, deep-links, the palette/keybinding bridge) - gates on
`isMobileViewport()` and navigates to the full-page route instead
(`/settings/<section>` when a section is requested, else `/settings`).
History keeps its modal on every viewport.

### Two different mobile questions

Everything above is VIEWPORT (`useIsMobileViewport()`) - it flips when a window
is resized, and a narrow desktop window gets all of it. A separate, smaller set
of rows is gated on the BUILD (`isMobileApp()`, the Capacitor bundle), because
what they need is either a capability the shell does not have at any width or a
product role that build does not play. Do not reach for the viewport hook for
these: a narrow desktop window still has a power bridge and a hardware
keyboard, and is still the end of a pairing that shows the code.

Ask which question a row's absence answers, not which list it would be shorter
to join.

- **Voice input** (`voice-settings-section.tsx`) - the build refuses dictation.
- **Prevent sleep while running** (`prevent-sleep-settings-section.tsx`) - the
  setting's only consumer, `PreventSleepController`, holds an OS power-save
  blocker through the desktop power bridge, and `resolveDesktopPowerBridge`
  returns null there. Extracted from `general-settings-panel.tsx` for exactly
  this reason. It is one row of General ▸ **Agents**: the component returns
  the row alone and gates it, and the panel draws the group. The panel gates
  nothing; the group holds the branch prefix in every shell, so it is never a
  heading over an empty card.
- **Layout rows the desktop layout alone draws** - the Tabs card's Placement, Tab overflow and Side tab view, the Sidebar's Side and Readings on agent rows, Chat's Reading width and Wide column width, a reading's Location, Model's Style and the Minimap (`isDesktopLayoutRowAvailable = !mobileApp`).
  The installed mobile app is the phone layout at every width, so nothing can make them apply there.
  A narrow BROWSER tab keeps them, live, with the note "Applies on wider windows." (the Minimap's: "Shows on wider windows with a mouse."), because widening the window is the way back - the layout form's shell rule (Layout, below).
- **The exception: Layout's "Status bar on small screens" ROW is keyed on the phone LAYOUT, not the build** (`isMobileFooterRowAvailable = phoneLayout`, L-51, U1).
  It is the switch the phone layout's footer mounts from (`useStatusBarVisible`), so it exists wherever that layout is drawn - the installed app, and a browser tab below 768px - and the desktop app (window floor 960px) never shows it.
  `SettingsAvailabilityContext.phoneLayout` is `useIsMobileViewport()`, so the row, its search entry and the footer read one predicate.
  It is available in both states, on and off: it is the control that flips the gate.
  It is the FIRST row of Usage and resources, and while it is off the area says once, under it, that the reading rows below do nothing ("Turn on Status bar on small screens to use these. Show still decides the header icons.").
  Every reading detail row and the Profiles list are then disabled and point `aria-describedby` at that line; both Show switches stay live, because they still decide the header's icons (`MobileAppHeader`).
  The `app.status-bar.toggle` ACTION still collapses in that build:
  `desktopOnly: true` in `ACTION_META` drops its palette row
  (`actions.source.ts`) and stops `StatusBarKeybindingBridge` registering its
  handler, because a command that mutates a placement with no surface is worse
  than a missing one.
  Both halves READ the flag; neither hard-codes the build, so the next
  `desktopOnly` action gets the same treatment for free.
- **The Keybindings SECTION** - chord capture is `window` `keydown` only
  (`chord-capture-core.tsx`): a tap arms the chip to "Press chord…" and nothing
  can commit it, and a binding clears only with Backspace.
- **The Link mobile app SECTION** - the one entry here that is a PRODUCT call
  rather than a capability limit, and the distinction is worth keeping. The
  panel DISPLAYS a QR and a one-time code for another device to read, and in
  the mobile app that device is the one holding the panel: the phone is the
  SCANNER (`layout/header/sign-in/link-code-sign-in.tsx` redeems a code this
  panel mints, and its own copy says "On your desktop, open Settings → Link
  mobile app"). A phone _could_ show the code to a second phone; linking that way is
  given up knowingly, because a pairing surface that names the wrong end of
  itself costs more than the case it serves.

Each returns `null` outright rather than rendering disabled with rewritten
copy: a control the build will never perform is worse than no control.

A whole section needs more than hiding its row, because a section id is
addressable. `visibleSettingsSections()` (`lib/settings-sections.ts`) is the
OFFERED list and `SETTINGS_SECTIONS` stays the whole RESOLVER table - ids are a
compatibility surface, so a route, a remembered tab path and a title must keep
resolving one that is not offered. Three surfaces present a choice and so read
the offered list: the sidebar, the palette's settings sub-page
(`navigation.source.ts`), and the leader digits (`keybindings/dispatch.ts`,
which indexes positionally and must walk the same list the sidebar badges).
Three more can arrive holding an id and each resolves it: the route (each
unoffered section's own `beforeLoad` redirects to `/settings/general` with
`replace` - `settings.keybindings.tsx`, `settings.link-phone.tsx`,
`settings.delete-account.tsx`), the modal (falls back to General for any
section the build does not offer, since its section is persisted across
launches), and the palette's `help:keybindings` row, which is dropped rather
than left as the one entry point that routes around the rest. Only Keybindings
needs that last one; nothing navigates directly to Link mobile app or Delete
account, so neither gets machinery it does not need.

**The list differs in both directions.** `MOBILE_APP_OMITTED_SECTION_IDS` names
what the phone drops; `MOBILE_APP_ONLY_SECTION_IDS` names what only the phone
has, which today is Delete account (see its entry under § Sections). Both lists
are applied once at module load, so each build's offered list keeps ONE identity
for the process's life - consumers memoize on it. That guarantee used to come
free from returning `SETTINGS_SECTIONS` itself on non-mobile builds; once both
builds dropped something, each needed a constant of its own.

The gate is by SHELL, not by attached hardware: an iPad running the mobile app
with a keyboard paired loses the section, which is the accepted cost of
matching the Voice precedent. A capability signal (`IRunnerHost` fields) is
what a finer rule would be built on.

Supporting pieces, all viewport-agnostic where possible:

- `settings-row-layout.ts` (`SETTINGS_ROW_STACK`) holds the narrow-width half
  of the label-beside-control geometry every row shares. It is a WIDTH FLOOR,
  not a stack: flex line-breaking reads an item's basis clamped by its own
  `min-width`, so raising the label's floor to `70%` below `md` pushes any
  control wider than the remaining third onto a line of its own before any
  shrinking happens. Wide controls (selects, inputs, chip rows, action
  clusters) therefore stack under the label at phone width, while a switch or
  an icon button stays beside it - a settings toggle reads as one line on a
  phone, the way it does natively. Every class carries `max-md:` bar the
  `flex-wrap` the mechanism depends on, so it layers onto the row that uses it
  (padding, borders and typography stay that row's own) and is inert from `md`
  up - the pointer-width rendering is unchanged.
  Rows that are two columns from their own markup rather than through
  `SettingsRow` - the Shell panel's program and startup-flags rows,
  Diagnostics' memory and log-detail rows, the host identity/updates rows, the
  worktree branch-prefix row, the Skills header and the notification-hook rows
  - apply it directly. Without a floor the control keeps its intrinsic width
    and the label takes what is left, which on a phone is a sliver: a two-word
    label breaks one word per line.
- `settings-row.tsx` uses `flex-wrap` + a label `basis` so small controls
  (switches) stay inline while wide controls wrap below the label on narrow
  containers; `SETTINGS_ROW_STACK` raises that floor below `md` so the split
  lands in the right place on a phone.
- `settings-panel-shell.tsx` (and the inline shells in the Keybindings and
  Shell panels) step padding down below `sm`; the shell header wraps.
- A row whose control wrapped still has to decide what to DO with its new
  line, and that is a per-control choice the floor cannot make - a button
  should not stretch, a text field should. `SETTINGS_ROW_STACK.controlLine`
  is the class that takes the line; what varies is only who opts in. A
  bespoke two-column row writes it on its own cluster, and a `SettingsRow`
  declares `controlSpansLine`, because there the flex item is the row's
  control wrapper and the control is one level down - a percentage width
  there has no definite containing block and shrink-wraps to the content it
  was meant to widen. Settings > Appearance's light and dark theme rows are
  the `SettingsRow` case: the picker is a share of the panel beside the
  label and the whole line once the row has stacked, so a theme's name
  reads instead of breaking one or two letters per line.
  The worktree branch-prefix
  row is the worked example of the bespoke case: below `md` its cluster spans
  the line, the input flexes into it, and its description drops to
  `md:truncate` so the sentence wraps once it owns the width instead of
  ellipsing. Its reserved reset slot keeps leading the field at every width,
  and the small inset that costs below `md` is deliberate - responsive
  `order-*` would close it by splitting visual order from DOM order, and the
  slot holds a labelled button, so focus and screen-reader order would then
  reach Reset before the field it acts on (WCAG 2.4.3 / 1.3.2). No `order-*`
  on interactive content: source order is the only order.
- The Providers rail collapses below `md` into a full-width provider `Select`
  above the detail pane, and the detail pane's own tab rail collapses into a
  second `Select` (`provider-section-select.tsx`) in the rail's slot - so
  picking a section is the same gesture as picking the provider one row above
  it, rather than a bespoke one. Both arms read the same `tabs` list and the
  same `providerTabLabel`; only the container differs, and `Tabs` stays
  controlled by the panel, so exactly one section body is mounted either way.
  Rows are icon + label only: the state a section is in belongs in its BODY,
  one tap away, and a two-line row inside a menu is a card in other clothes.
  The phone arm has no tab TRIGGERS, so it labels each pane with `aria-label`
  and clears the `aria-labelledby` Radix would otherwise point at a trigger
  that is not rendered. `EnvOverrideEditor` rows restack onto two lines below
  `sm` and hide the column header.
- `settings-touch-targets.css` (imported by `settings-layout.tsx`, scoped
  under `[data-settings-touch-scope]`) enlarges the _hit areas_ of
  switch/button/select-trigger primitives to >=44px on coarse-pointer devices
  without changing any visual size - settings-only, the shared primitives in
  `src/components/ui/` are untouched.
  - The scope reaches only what the settings subtree CONTAINS, so the rows
    inside an open menu are out of its range by construction: Radix portals
    popover content to the body. A control the scope enlarges can therefore
    open a list it cannot, which is how the Providers `Select` came to have a
    44px trigger over 28px rows. Anything living in a portal owns its own
    target instead, at the primitive: `pointer-coarse:min-h-11` on
    `ui/select.tsx`'s `SelectItem` and on all four of `ui/dropdown-menu.tsx`'s
    row types (item, checkbox, radio, sub-trigger - keep them in step). Reach
    for a scope rule only for a control that renders in place.

## Key Files

- `settings-layout.tsx` Owns the two-column shell for the settings route.
- `settings-sidebar.tsx` Renders navigation from `settings-sections.ts`.
- `settings-panel-shell.tsx` Shared width, header, and panel spacing - density-
  aware (see below).
- `settings-touch-targets.css` Coarse-pointer hit-area rules for the route
  shell (see below).
- `settings-row-description.ts` The `SettingsRow` description-id context and
  its `useSettingsRowDescriptionId()` reader - what lets a control name the
  description beside it through `aria-describedby`.
- `settings-row-layout.ts` The `max-md:` label floor shared by every
  label-beside-control row, `SettingsRow`'s and the bespoke ones alike - what
  decides, per row width, which controls stack and which stay inline, plus the
  `controlLine` class a stacked control takes to span the line it landed on.
- `settings-row.tsx` Shared label/description/control row, rendered from a
  `SettingsRowDefinition` (see Search) - also density-aware.
  The label owns the flexible width; controls stay pinned to the trailing edge.
  If a wide control wraps, it remains right-aligned on its new line instead of
  falling under the label at the leading edge, and `controlSpansLine` widens it
  to that whole line for a control whose content wants the room.
  The description `<p>` - or the `status` `<div>` shown in its place - carries a
  `useId()` id and a `max-w-[72ch] text-pretty` reading measure, and the row
  publishes that id to its control through
  `settings-row-description.ts`'s context - `useSettingsRowDescriptionId()`,
  passed straight into `aria-describedby`, so a screen reader gets the row's
  second line instead of a bare label. It reads `undefined` when the row
  renders neither, which DROPS the attribute rather than pointing it at
  nothing. A context and not a `control` render prop for two reasons: the
  control arrives already built, so the row cannot reach into it; and a
  function prop returning JSX reads as a component definition during render to
  `react/no-unstable-nested-components`. `control` therefore stays a plain
  `ReactNode` and no existing call site changed. The context lives in its own
  module so `settings-row.tsx` keeps exporting only a component (fast refresh
  / `react(only-export-components)`), the same split `settings-row-layout.ts`
  already makes.
- `settings-group.tsx` A named group of rows: a small, quiet label OUTSIDE a
  bordered card (never a row-shaped band inside one), rendered from a
  `SettingsGroupDefinition`; `showTitle={false}` drops the label where the page
  heading already names the card. `tone: "danger"` gives Danger Zone its
  restrained-red card without a separate component.
- `panels/*.definitions.ts` One section's search collection each - see Search.
- `panels/*.tsx` Route-mounted settings sections.
- `src/components/layout-editor/layout-search.definitions.ts` The layout launch results,
  generated from the region registry (see Search ▸ Launch results).
- `src/components/layout-editor/region-quick-verbs.tsx` The right-click menu on
  the app's own chrome (L-19) - a region's quick verbs with their Undo toast,
  plus the way in. `customize-layout-menu-item.tsx` is that last item alone,
  for a menu that wants no verbs; while another window holds the editor it
  is off, its reason as the item's description (T6). An off menu item that
  says why (this one, the rail's last shown panel) goes through
  `explained-menu-item.tsx`: `aria-disabled` rather than Radix `disabled`, so
  it stays in keyboard focus and its reason is heard, with the press refused.
  While Voice input is off, the sample scene's dimmed mic offers
  "Turn on Voice input" instead of Show or Hide (C4). That verb writes a
  General setting, not the layout, so the editor's Undo and Discard do not
  take it back; its own toast's Undo does.
- `controls/settings-select.tsx` Shared select wrapper used by settings rows.
- `src/stores/settings/settings-store.ts` Persisted local settings state.
- `src/providers/settings-density-context.ts` `SettingsDensityContext` /
  `useSettingsDensity()` - `"compact" | "relaxed"`, default `"relaxed"`.
  `settings-modal-content.tsx` provides `"compact"` for the modal overlay
  (`PromotableModalFrame` hard-caps its content at `80vh`); the promoted-tab
  route path never provides it, so it stays `"relaxed"` by default. A discrete
  signal from the two known entry points, not a measured container query -
  the overlay's height ceiling is architectural, not something that varies
  continuously with window size. `SettingsPanelShell` and `SettingsRow` read
  it directly (tighter header/row padding and a smaller title in `compact`);
  General and Worktrees additionally read it locally for their own bespoke
  multi-card gaps. Out of scope: the Worktrees toolbar/list rows, which stay
  unchanged regardless of density.

## Scope: the organising idea

Settings is grouped by WHAT A SETTING BELONGS TO, and the grouping is
load-bearing rather than cosmetic.

- **Application** - General, Appearance, Keybindings, Diagnostics.
- **Account** - Sessions, Usage.
- **Host** - headed by THE host picker (`host-scope/host-switcher.tsx`).
  Everything under it - Overview, Providers, Worktrees, Notifications,
  Permissions, Agent selection, Fallback, Shell, Diagnostics - is scoped by
  that one selection, with ONE named exception: Permissions ▸ Modes (below).

**Two sections are both called "Diagnostics"**, one per group, and the group
heading above each is what distinguishes them - the same way the rail already
distinguishes everything else. Their ids do not collide: the host one keeps
`diagnostics` (it is the one in existing bookmarks and remembered tab paths)
and the app one is `app-diagnostics`. The one surface with no group headings is
the command palette's settings sub-page, which is a flat list, so
`navigation.source.ts` gives every section row its group label as a
`statusBadge` rather than badging only the pair that collides - an absence of
badge would otherwise start meaning something, and the next duplicate label
would ship looking unambiguous.

Usage sits in **Account**, not Host (ticket 13). What it reports is the
ACCOUNT's token and cost spend, with the host as one filter INSIDE the page
that defaults to all of them - so it does not vary by host, which is the rule
the groups encode. Under the sidebar's picker it would have put two competing
host scopes on one screen, with the outer one unable to describe the number
the inner one produced. It still reads through a host CLIENT, as every RPC
does; that is a transport fact, not a scope one.

Application and Account lead because they are short, fixed and never re-shaped;
the host group goes last because it is the only one whose contents depend on a
selection.

**Scope is not a level.** Settings already spends its nesting budget inside
Providers, which is a rail plus a per-provider tab bar - so the sidebar gets
exactly one level and the host cannot become another one. Earlier attempts that
made the host a tier (tabs across the content, an accordion of host cards in
the rail) all pushed the deepest page four levels down. The picker is
navigation only.

**One place per host verb.** There is no Hosts page. A separate collection page
looks harmless but is a second lifecycle surface the moment it can change an
update policy, which is exactly what the old "My Hosts" list did - so adding,
comparing and updating hosts all resolve to: the picker lists them, the `+`
footer adds one, and everything else about a host lives on that host's Overview
(`host-scope/host-registry-updates.tsx` holds the registry half of Updates,
beside the local controller's own region in the SAME card).

**The picker inherits the composer's row anatomy**
(`components/home/host-workspace-selector/host-section.tsx`): kind glyph, name,
status dot, check. Two pickers over one concept must not each invent a
vocabulary. Search appears from six hosts up; below that it is one more thing
to skip past.

**Nothing in the host group is local-only any more.** Shell and Diagnostics
carried a `requiresLocalHost` flag (dimmed rail rows, a `RequiresLocalHostNotice`
in place of the page) for one reason: both read the on-disk config store through
the local CLI bridge, so they could only ever describe this computer. That was
always stated as a TRANSPORT limit rather than a scope one - shell config and
`hostLogLevel` are fields of the selected host's own config - and the
`config.*` / `diagnostics.*` RPCs removed the limit rather than the sections.
The flag, the dimming and the notice are all gone; every section under the
picker now reads whichever host the picker names. Overview followed the same
route one batch later, for the same reason and with the same shape: the
lifecycle verbs were bridge-only, `host.restart` / `host.doctor` /
`host.identity.*` / `host.update.*` / `host.getInstallationInfo` removed the
limit, and the bridge was demoted to a recovery console for the one state that
still has no host process to ask.

What replaced it is one predicate, `localConfigFallbackReason(host,
methodsSupported)` (`host-scope-model.ts`), answering "may this page read this
computer's disk instead, and why":

| Host                | Can't be dialled                 | Handshaked without the methods    | Answers fine |
| ------------------- | -------------------------------- | --------------------------------- | ------------ |
| **This computer's** | bridge, `reason: "host-stopped"` | bridge, `reason: "host-outdated"` | RPC          |
| **Remote**          | gate notice (unreachable)        | `HostConfigUnsupportedNotice`     | RPC          |

Three things about that table are load-bearing:

- **The local column falls back for BOTH failures.** RPC-only would take
  log-level raising and host-log tailing away exactly while someone is debugging
  a host that will not start - and would ALSO take shell editing away for the
  whole window in which the app has updated and the host it manages has not. The
  store the bridge reads is the same machine-user-global file the host loads, so
  the fallback describes the host it names; `LocalConfigFallbackNotice` says
  which of the two reasons applies, because one calls for starting the host and
  the other for updating it.
- **The remote column never falls back.** There is no local truth about another
  machine, and substituting this computer's values under its name is the exact
  failure the scope model exists to prevent. An old remote host gets
  `HostConfigUnsupportedNotice`, which self-heals when it updates and
  re-handshakes.
- **`methodsSupported` is the TRI-STATE `useHostMethodSupport`, not the
  boolean.** `null` means no handshake has completed yet, and the panel's own
  first RPC is what produces one - so treating `null` as absent would divert a
  perfectly capable host onto the bridge permanently, before its RPC path was
  ever tried.

This replaced a flat list in which "Appearance" (this app), "Sessions" (your
account) and "Providers" (one specific host) were indistinguishable peers,
and in which FOUR sections had each grown their own host `<Select>`: Providers
(header), Worktrees (toolbar), General -> File Edit Snapshots (a settings row,
directly above a destructive button) and Agent selection (floating above the
editor). They differed in width, placement and scoping mechanism while doing
one job.

All four are gone, and nothing replaced them: a panel states NOTHING about which
host it is scoped to. An interim pass put an inert `HostScopeLine` readout where
each dropdown had been, on the theory that content owes the reader the host name
at the point of use. It does not - the sidebar picker already carries the name,
the health dot and the "Viewing -" note, and the readout was that same fact
printed a second time in four places, which is the duplication this surface
exists to remove. So panels carry only the controls they own.

One caveat, stated because an earlier draft of this file got it wrong: the
picker is NOT permanently on screen. The rail is a single `overflow-y-auto`
`<aside>`, so at a short viewport the host group can scroll out of view like
anything else in it. The argument for removing the readout is
non-duplication, not permanent visibility. `settings-host-select.tsx` and `use-settings-host-scope.ts`
are deleted; `useHostScope` is the only host scope in Settings.
The composer uses the shared `HostSwitcher`; it does not keep a parallel
Settings label formatter.

**Two host relationships, kept apart by grammar.** Merging them is the defect
the whole surface guards against:

- **Viewing** (`stores/settings/settings-host-scope-store.ts`) - which host
  Settings is administering. Free, reversible, no effect outside Settings.
  Renders as neutral chrome; never accent-coloured.
- **Active for this window** (`HostDirectoryService.selectById`, read through
  `useAddressableHostId`) - which host this window talks to for ambient
  work: notification indicators, the bell, rate limits, the resource monitor,
  and where newly started work lands. Changed ONLY by a labelled verb that
  states its consequence ("Use in this window", in the Overview card's action
  bar, with the tabs-stay-put asymmetry on its tooltip), never as a dropdown
  side effect. Always wears the accent - on the Overview that is the `Active`
  tag beside the host name, which replaced a full-width row asserting the same
  boolean.

`useHostScope()` (`host-scope/use-host-scope.ts`) is the single hook every
host-scoped panel reads. Its status enum is the safety contract, because three
of its states look identical if you only check `client !== null`:

| Status        | `client` | The panel must                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `following`   | ambient  | render normally - the ambient client IS the scoped host's                                               |
| `connecting`  | `null`   | render its loading shape, NEVER the ambient client's data                                               |
| `unreachable` | `null`   | say so - terminal, not pending; never a spinner that cannot resolve                                     |
| `vanished`    | `null`   | say the host was deregistered and offer a way back - it must NOT silently re-resolve to the active host |
| `ready`       | scoped   | render normally                                                                                         |

The invariant every consumer owes: **a visible host name must always match the
client used by every read, stream and mutation beneath it.** Because the only
visible host name is the sidebar's, that reduces to one rule: a panel must
neither render content NOR issue a host read while the scope has no client
behind it.

Two mechanisms, and the split matters:

- `HostScopeGate` (`host-scope/host-scope-gate.tsx`) decides what is
  **rendered**, and it also stops its children ACTING. It guards its CHILDREN
  and nothing else - a control passed as a sibling prop (`headerAction`) is
  outside it, which is how Providers' Refresh button once re-probed the ambient
  host while the page named another. Inside, a non-usable scope holds the
  subtree in a hidden `<Activity>`: React tears its effects and subscriptions
  down, so a query hook under a dead scope genuinely cannot fire. Panels
  wrapped by the gate (Shell, Diagnostics, Providers' scoped content) therefore
  do NOT need a second `isHostScopeUsable` guard on the reads they own - and
  adding one is the cargo-cult this note exists to prevent.
- `isHostScopeUsable(status)` decides what is **mounted**, and is for host
  reads that live OUTSIDE the gate's children. Those still fire and cache their
  answer whatever the gate renders, so a panel that keeps such a read - as
  Diagnostics does for the `cli`/`host` log-level rows, whose hook is held at
  panel level - must ask this before mounting it.

Every section in the `host` group mounts the gate, and both Shell and
Diagnostics wrap their bodies in it whole. Diagnostics used to be the exception,
keeping its app-scoped rows outside the gate because their subject never changed
with the scope; splitting those onto Application -> Diagnostics removed the
exception rather than working around it. Both re-provide `HostRuntimeContext`
for an explicit pick through `useScopedHostBinding` - the same
`status === "ready"` guard Providers uses, so no hook beneath them can resolve
to the ambient host.

**Permissions is the one host page with an application-scoped region.** Three
of its four tabs are per machine - the judge is stored on the host, the
account's rules are read through it, and the decision log is the host's own -
so the page sits in the Host group and `HostScopeGate` wraps those three tab
BODIES. The Modes tab is not per machine: "New conversations start in" is one
preference for this app (`settingsStore.defaultPermission`), so it renders
outside the gate, works with no host in scope at all, and says so twice - an
"All machines" badge on the row and the line "The machine picker above doesn't
change anything on this tab." The tab bar sits above the gate too, which is
what lets each tab trigger carry a search anchor (see Search, "Gated on the
SELECTED HOST"). This amends, rather than contradicts, the rule above: the row
used to live on General precisely because it is application scope, and the
move onto a host page was a user decision (permissions redesign, 2026-09-23),
so the scope distinction the sidebar group can no longer carry is carried by
the badge and the note instead.

Overview does the same (`host-settings-panel.tsx`), and it mixes the two gate
styles on purpose because its regions sit on three different capability planes:

- the **whole-panel gate** covers only "the scope resolved to nothing" and
  `vanished`. The reason is the one that motivates the gate at all: a `null`
  scoped host that defaulted to "local" once put this computer's service
  console under a host that no longer exists.
- the **install record and OS service** (Installation tab) are pure host RPC,
  so without a route they are withheld and one line says they need a
  connection. The status card's ACTIONS (Restart / Run doctor / Use
  in this window), the rename pencil, and the host's own update check are
  withheld outright without a route rather than rendered disabled - "disabled"
  would read as a capability verdict when the fact is connectivity.
- the **account-backed** half - update policy, drain-gate force, About this
  host, and Remove from account - needs no route and keeps rendering for a host that cannot be
  reached, which is a common moment to want exactly those. The danger zone
  gates its own rows for the same reason. The version PIN used to sit here and
  no longer does: picking a version means picking one the host listed, so it
  moved to the RPC half and an unreachable host can no longer be pinned.

The recovery console is the one surface still on the CLI bridge, and it is NOT
gated on reachability: it exists for a host that is down, so gating it on
dialability removed Install and Start in precisely the state they serve.

**One host model.** The app carries two host lists that need not agree - the
runtime directory (what this client can dial; it alone knows `websocketUrl`)
and the cloud registry (what the account owns; it alone knows presence leases,
platform, update state). Every old picker was built on exactly one of them and
was therefore blind to a real class of host. `buildHostScopeOptions`
(`host-scope/host-scope-model.ts`) is their UNION keyed by `hostId`, recording
`connectable` / `registered` so a row present in only one list renders honestly
instead of being dropped or faked. NOTE: `HostDirectoryEntry.kind` is
`local|remote|mock` while `HostListItem.kind` is `personal|sandbox` - same
field name, disjoint values. The merged model deliberately exposes neither
directly.

**One health vocabulary.** `deriveHostHealth` (`host-scope/host-health.ts`)
replaced two disjoint dialects that described the same machine: the
registry-backed presence words and the local service words ("Running" /
"Stopped" / "Not installed"). It keeps a coarse `state` a person acts on plus a
`detail` fragment carrying the nuance the old design spent a row of pills on.
`stopped` and `not-installed` stay distinct from `offline` because they are the
two a person can act on. It DELEGATES to `deriveHostPresence`
(`panels/my-hosts-model.ts`) rather than re-deriving it.

The precedence across the two is one chain, and each step outranks the next for
a stated reason: **local process read** (a direct read of the service on this
box) -> **live session** (an open E2E connection is firsthand proof) ->
`status.connectivity` (the cloud's relay-attachment answer, and the only one
available for a host this client has never dialled).

`connectivity` is the ONE cloud liveness signal. It replaced a heartbeat lease
plus a separate relay-attach bit, and with them the states that existed only to
narrate those two disagreeing ("Reconnecting", "Not reporting"). Its remaining
invariants are tested and load-bearing: no green dot without live evidence, and
`unknown` (liveness unreadable) never renders as a false "Offline". The retired
`local-only` wire value, which no server emits, reads as `unknown`.

Two things a reader of this file will look for and not find in the DTO:
`busy` and `busySessionCount`. They describe a _right now_ the cloud's lease
cannot carry, so they come from `host.status@1.1` over a live connection (or
the notification room's `hostRuntimeStatus` awareness field). No live source
means the drain UI renders NOTHING - never a zero, which would offer to end
"0 sessions" on a host that never told us how many it had.

## Sections

- `General` App behavior, agent activity, and local data controls, divided
  into named groups via `settings-group.tsx`: a small, quiet `<h2>`
  label sits OUTSIDE its own bordered card, so orientation (the label) and
  action (the card's rows) read as different things - a group label never
  looks like another setting row. This replaced an earlier row-shaped
  section-header-band-inside-one-card layout (`settings-section-header.tsx`,
  now deleted) after user feedback that the bands blended into the options
  and ran too tall; a design pass (`general-settings-core-flows` artifact)
  settled the current shape. Groups are ordered by frequency and risk
  (most-touched first, destructive last), not alphabetized; row internals,
  controls, and confirmation flows are unchanged from before either reorg.
  - **Chat & composer**: Voice input (`voice-settings-section.tsx`), Quote
    reply on text selection, Steer with Cmd/Ctrl+Enter (toggles the fixed
    chord's mid-turn-steering semantics - stays out of Keybindings, which is
    for rebinding). `Pin context usage breakdown` used to sit here and now
    lives in **Layout › Chat** - it places a panel rather than changing what
    the composer does.
    - **Default permission mode** is no longer here: the row moved to
      Permissions ▸ Modes; its search vocabulary moved with it. General keeps
      no alias for it (nothing stores an anchor token, so there is nothing an
      alias would redirect).
  - **Agents** (anchor `general-agents`, `data-testid="settings-general-agents"`):
    Prevent sleep while running, When you quit Traycer, Worktree branch prefix,
    Agent roles and Archive idle agents automatically. These were four groups of one setting each (Running
    agents, When you quit Traycer, Worktrees, Experimental), which drew four
    headings and four borders around four settings. The rule now is the one
    under "Page shapes": a group holds at least two rows. Each row gates
    itself, and the branch prefix is drawn in every shell, so the card is never
    empty.
    - **Prevent sleep while running** (`prevent-sleep-settings-section.tsx`,
      hidden in the mobile app - see "Two different mobile questions"). The
      two resource-visibility toggles that used to sit beside it are gone. Both
      answers now come from ONE switch, Layout ▸ Status bar ▸ Resource monitor
      ▸ Shown (L-48, L-60): off means no status-bar segment, no header button,
      no sidebar or task-navigator chips, and no `resources.subscribe` stream
      at all. The sidebar chips have no control of their own and never moved
      to a Sidebar row.
    - **When you quit Traycer** (`HostLifecycleSettingsRow` in
      `host-lifecycle-settings-section.tsx`, anchor `general-host-lifecycle`,
      gated by `isHostLifecycleRowAvailable`: the desktop's
      `runnerHost.hostLifecycle` bridge and not the mobile app): the host
      lifecycle mode for THIS machine - Background (default), Ask, Stop if
      idle, Linked, No local host - as ONE row with a dropdown. It was a card
      of five radios with a sentence each, the tallest block on the page for
      one choice. The closed trigger shows the mode's short name (the one the
      "Set to X" line uses), each option in the list carries its full label
      and sentence, and the row's description is the chosen mode's own
      sentence, so what quitting will do is readable without opening anything.
      The copy is the host lifecycle UX artifact's, with the machine noun
      platform-substituted (Mac / PC / machine; never "device"). It is here,
      on the app-wide page, and not under a host scope, because it is a
      machine-local desktop preference read and written through desktop main
      (`hostLifecycle.get/set/onChange`), never a host RPC: it has to work
      before any host is installed, and in a launch with no local host, where
      it is the only way back. A CLI `traycer host lifecycle set` arrives
      through `onChange` and is reflected, never replayed. Under the
      description, while desired and applied differ: "Set to X · restart the
      host to apply" (an older supervisor is running; carries a Restart host
      button that opens `LocalHostRestartFlow`) or "Set to X · takes effect at
      next launch" (entering or leaving No local host). No local host is
      disabled in the list, with the reason after its sentence, while signed
      out (remote hosts are reached through the account), and choosing it
      while this launch runs a host confirms through the quit modal's
      stop-only form (`host-lifecycle-none-confirm-dialog.tsx`). The local
      host's Overview header carries the same mode promise the tray shows
      ("keeps running after quit") as a link back here
      (`host-scope/host-lifecycle-mode-line.tsx`).
      - **The radio card still exists, at `/when-you-quit`**
        (`HostLifecycleSettingsSection`, definition `hostLifecycleCard`, a
        contributor with no entry of its own). Signed out there is no settings
        shell, so that route renders the card alone, CLI footnote included.
        Both presentations read one model (`useHostLifecycleModel`): the
        query, the write, the signed-out and task-ownership holds and the None
        confirmation are written once.
    - **Worktree branch prefix** (`worktree-branch-prefix-section.tsx`): a
      plain `SettingsRow` now. Its sentence, with the live preview of the next
      branch name, is the row's `status`, and a validation error sits under it
      in the same described region. It used to draw a bordered card of its own
      inside the group's card. The label was "Default branch prefix" under a
      Worktrees heading; with the heading gone the label names worktrees
      itself.
    - **Agent roles**: gated by `isAgentRolesRowAvailable` (the desktop
      feature-settings bridge) and marked with the muted xs **Experimental**
      badge the permission modes use, in place of an Experimental heading over
      one row.
    - **Archive idle agents automatically** (`ChatAutoArchiveSettingsRow` in
      `panels/chat-auto-archive-settings-row.tsx`, definition
      `chatAutoArchive`): the ACCOUNT-wide chat auto-archive setting, read and
      written through the app-wide host (`chatAutoArchive.get` / `.set`,
      hooks under `hooks/chat-auto-archive/`), which proxies one cloud row
      every host the user runs applies. Rendered only when that host
      advertises BOTH methods (two `useHostMethodSupport` calls); otherwise
      absent. Gated on the selected host, so it has no search entry of its
      own: its label and keywords (archive, idle, inactive, auto, cleanup,
      timer) contribute to the Agents group. Controls: the main switch
      (`enabled`), a seconds field (whole number inside the host's `bounds`,
      committed on blur or Enter (not an Enter that confirms an IME
      composition), an inline error and no write otherwise,
      editable while the switch is off, 3600 clamped into the host's
      `bounds` for a never-saved account, which is also what the switches
      write), and
      under the description "Also archive chats I created"
      (`includeUserCreated`, off by default; terminal agents count as the
      user's). Every write sends all three fields. The status line is the
      threshold in words ("After 1 hour of inactivity, on all your hosts.
      Applied when a host next looks at the chat's task."), "Off on all your
      hosts." while disabled, and "Couldn't read the auto-archive setting from
      this host." on a failed read. Controls stay disabled with no error until
      the viewer id resolves and the read lands, and while a save is pending
      (with `AgentSpinningDots`). The client never schedules archiving: the
      host's sweep does, and a task nothing holds open is swept when a host
      next opens it, which is why the copy makes no wall-clock promise.
  - **Onboarding**: Product tour (replay onboarding), and nothing else. Import
    your work and Data migration used to share this group under the name
    "Setup & migration"; both moved to the scoped host's **Overview**, because
    each acts on ONE machine's local data and General is app-wide - the rows
    could only ever speak for whichever host the window happened to point at,
    while naming none. The tour stays because it is genuinely window-level:
    replaying it re-runs this app's onboarding, which no host owns. The group
    is named for its subject rather than for its single row.
  - **Danger Zone** (`DangerZoneSection`, `SettingsGroup` with `tone:
"danger"`, `data-testid="settings-danger-zone"`, kept last): **Local app state
    only** (reset tabs/layout/drafts/settings/view prefs + reload) - the one
    destructive action here that is genuinely about this APP rather than about
    a host. File Edit Snapshots and Remove Traycer both moved to
    `host-scope/host-danger-zone.tsx` on the scoped host's own Overview: each
    acts on ONE host's data, and a host-scoped destructive row sitting on an
    app-wide page is how a snapshot wipe could be aimed at a host the page
    never named. Their arm-time target capture lives there too, alongside the
    remote counterpart added with the Overview restructure, **Remove from
    account** - see the Host Overview section for its copy rule. The zone's
    distinct restrained-red card/label tone is unchanged from before the
    reorg, just carried by the shared group component instead of bespoke
    markup.
- `Browser` (`panels/browser-settings-panel.tsx`, `/settings/browser`, Application):
  default search engine, browser agent access and detected dev origins, browser tile
  placement, agent-opened tab surfacing, and saved website sessions. Search
  entries belong to this section, including conditional host/desktop controls.
  Host and desktop scope remain explicit in each control's copy.
  - **Three groups**: Browsing, Agents, Website sessions. Search, Browser
    placement, Browser and Agent-opened tabs used to be four groups holding
    five rows between them.
  - **Browsing** (anchor `browser-browsing`): the two choices about the
    person's own browsing.
    - **Default search engine** selects Google (default), DuckDuckGo, Bing, or
      Kagi. The shared address-bar normalizer navigates recognizable addresses
      and encodes other input as a query in native and streamed tabs. The
      preference is persisted and invalid or missing values fall back to
      Google.
    - **Open browser tabs** shows the effective browser destination. Selecting
      one enables per-category placement while preserving other categories'
      current effective values. No preference keys or defaults are migrated.
      The click-modifier legend sits directly under this group, because it is
      about where a tile opens.
  - **Agents** (anchor `browser-agents`, drawn by `BrowserSettingsSection`):
    what agents may do with the browser. **Agent-opened tabs** is drawn in
    every shell, so the group is never empty; the panel owns that row and
    hands it in. It keeps `agentTabSurfacing` and the existing canvas/PiP
    rules, and controls explicit REPL opens; page-created tabs keep their
    existing popup/link behavior. **Let agents use the in-app browser** sits
    above it when the active host advertises both `config.browser.*` methods,
    and **Detected dev origins** below it once a terminal has printed one.
  - **Website sessions** (`browser-settings-section.tsx`'s second group,
    `data-testid="settings-saved-logins"`): where session data from the in-app
    browser is kept, and the only place it can be turned off, removed, or
    inspected per site. Keychain-refactor spec §7.3; the group renders NOTHING
    without a `browserView` bridge (the web build), because every row is about
    a machine's jar - nor without a host runtime (`useHostBinding()`, the
    non-throwing accessor), since the list is a host's answer and both
    destructive actions travel to hosts. That gate is on what RENDERS: the rows
    live in their own component so the site-list query, which reaches
    `useHostClient()` and would THROW with no provider, is never mounted
    above it.
    Saving is silent and on by default, Chrome-style - there is no consent
    step and nothing to retry - so this group is passive: a toggle, a compact
    preview, and an import row.
    - **Save website sessions on this computer** is the desktop-local pref
      (`useBrowserSaveLogins()`), not a settings-store field and not a host
      value: it is a statement about THIS machine (decision #18), so it neither
      syncs nor follows the scoped host. Off switches new and live `primary`
      tiles onto a throwaway partition (they reload signed out) and leaves the
      `persist:` jar on disk untouched - that is what Remove all is for - so a
      confirm stands in front of it and turning it back on returns to the same
      logins. Nothing is copied in either direction.
    - **Bring in existing sessions** (`import-logins-dialog.tsx`) is the row
      after the saved-session preview. It opens a three-step dialog
      over four desktop bridge calls: `listLoginImportSources` (Pick: the
      browsers and profiles found on this machine, plus "Import from a
      file…", whose native picker runs in main so the renderer never names a
      path), `scanLoginImportSource` (Choose sites: a filterable checklist of
      registrable domains with cookie counts, read from METADATA only so no
      OS prompt fires yet), and `importLogins` (the one call that opens the
      keychain / keyring and writes the durable jar). Google rows are listed
      unchecked and disabled - Google binds sessions to the device (DBSC), so
      a copied cookie can stop being a login at Google's next check - behind
      an "Import Google logins anyway" switch that is off by default and
      never remembered; turning it on moves them into the checklist ticked,
      shows the warning beside the switch, and sends
      `includeDeviceBound: true`, which is the only way the desktop honours
      a Google domain. The dialog says which prompt the Import click will
      raise before it does ("Allow, not Always Allow" on macOS). Windows'
      app-bound (`v20`) cookies are reported under a banner
      as protected, never silently dropped; the cookie-file path is the way
      through there. The push to the hosts is MAIN's, like forget-all's
      frames and for the same reason - a jar frame speaks for the user's
      whole slice on a host, so a renderer may ask for one and may not send
      one. `importLogins` writes the jar and then calls
      `capturePrimaryProfileOnEveryHost()`, one whole-jar
      `primaryProfileCaptured` per host with a live browser stream, and rides
      the ack count back as `notifiedHosts`; `useLoginImportRun` is one call
      with nothing to chain. Done reports "sent to N hosts" from that count -
      never "saved", because a host acks a jar it may still drop. Zero live
      streams is the documented opportunistic outcome, not a failure. The
      capture is needed at all because the write mutes the delta observer, so
      the coalesced deltas that carry an ordinary sign-in never fire for an
      import. The row is disabled
      with a hint when saving is off, since the import writes the durable
      jar the tiles are not on then. Every failure is a result value with a
      closed reason and one explainer (Full Disk Access deep-links to the
      pane; "quit the browser fully" for a locked database); nothing retries
      on its own, because a retry after a denied Keychain prompt is a second
      prompt. The steps themselves are the headless `ImportLoginsFlow`
      (`import-logins-flow.tsx`), which the dialog wraps and the tour's
      login-import act renders on its stage; the surface supplies the
      FRAME (header / title / description / footer) because the dialog's
      are Radix parts that throw outside a `Dialog`. The dialog reads
      "an import is in flight" off the mutation cache (`useIsMutating` on
      `browserMutationKeys.importLogins()`), since the mutation is the
      flow's. The row also opens on a ONE-SHOT INTENT
      (`stores/settings/browser-focus-store.ts`, the `providers-focus-store`
      shape): the login-import announcement toast
      (`login-import-announcement-controller.tsx`, mounted beside the
      app-update toast) arms `openImportLogins` and navigates to General,
      the row derives `open` from its own state OR the intent, and closing
      - or mounting with saving off, when the row would refuse - consumes
        it. The toast shows once per install, for a user who has already
        finished onboarding (a fresh user meets the feature as a tour act
        instead); either surface consumes the `login-import` id in the
        persisted `feature-announcements` store, so exactly one of them ever
        shows. The toast CLAIMS the id rather than consuming it (`claim`
        re-reads localStorage before writing, synchronously), because the
        store is per renderer and two windows restored together would each
        hydrate it empty; the tour consumes it on the act's mount AND on the
        tour's finish unconditionally (the availability read is still pending
        on an immediate Skip, and an act the list held can be dropped again),
        so leaving the tour never resurrects the toast. The toast also holds
        until the system-tab modal API is published, since its action
        navigates through it and would otherwise no-op on a cold launch.
    - **Saved website sessions** reads `browser.savedLoginSites` from the
      surface's host (`useBrowserSavedLoginSitesQuery`) - registrable domains,
      never values. Settings shows the count and first three sites in
      alphabetical order; a non-empty preview opens a right-side sheet with
      search, every site, per-site Remove, and Remove all. A genuinely empty
      collection has no disclosure, while the sheet stays open after Remove
      all to offer import as the next step. The method is optional
      (non-floor), so the query is gated on `useHostSupportsMethod` and a host
      that never answered renders no list rather than an empty one. `sealed`
      is NOT "no sites": it says the logins exist but this host cannot open
      them until the desktop that wrapped its key connects, and it renders its
      own hint plus Remove all because deleting the jar does not require
      opening the collection. A preview or sheet row whose
      `contributedByHostId` names a host OTHER than this machine's carries one
      muted "Includes a sign-in from <host>" line
      (universal-sign-in decision 9) - weak copy on purpose, because the marker
      behind it is sticky and survives the user signing into that site here.
      The display name resolves through the host directory
      (`useHostDirectoryEntry`), falling back to the raw hostId when this client
      cannot currently list that host - the same last resort `resolveHostName`
      takes, and better than inventing "another machine". The local comparison
      goes through `useReactiveLocalHostId` (not the local directory ENTRY,
      which goes null while the local host restarts), and a login this desktop
      itself contributed says nothing at all - naming the user's own machine on
      every row would bury the lines that mean "this came from somewhere else".
      Two things about the id are worth knowing before reading a row: it is
      always the ANSWERING host's own, so a third machine is never named and a
      remote contribution that already reached this desktop's jar shows nothing
      in the local host's list (it arrives there as a desktop-origin echo); and
      the render guard is `typeof === "string"`, not `!== null`, because the
      same-minor RPC path returns the payload UNPARSED - a host predating the
      field sends no key at all, and the schema's `.default(null)` only runs on
      the version-gap decode. Per-row **Remove** sends
      the `clearSite { domain }` frame
      (`browserView.clearSavedLoginSite()`) and refetches; the row is hidden optimistically
      because the host merges asynchronously and the refetch behind the click
      can still read the pre-clear slice. That optimism RELEASES itself: a
      domain is hidden only while the latest response still names it (retired
      from state during render), so signing back into a cleared site shows it
      again instead of hiding it for the session. **Remove all** calls the
      bridge's `forgetLogins()` directly and therefore speaks for every host
      with a live browser stream; main owns both native destructive confirms.
- `Sounds` (`panels/app-notifications-settings-panel.tsx`,
  `/settings/app-notifications`): two groups.
  - **Chimes** (`panels/notification-chime-settings-section.tsx`): one
    dropdown per kind of alert. Untitled, because the page is already named
    for it.
  - **Notifications** (anchor `app-notifications-notifications`): where the
    alerts themselves are configured. **OS notifications** on a desktop with
    the system-settings bridge (`system-notification-settings-section.tsx`),
    **Push notifications on this phone** in the phone app
    (`push-permission-section.tsx`; "this phone", never "this device", which
    is the UI word for a host), and **Notification events**, a pointer to the
    selected host's Notifications page, in every shell. System, This phone
    and Events were three groups of one row each.
- `Opening behavior` (`panels/opening-behavior-panel.tsx`,
  `/settings/opening-behavior`): link routing (Open links and per-link-type
  choices), general tile placement and per-type overrides
  for files, conversations, and side chats. The global default still applies
  to all categories, including browsers; browser-specific controls live in
  Browser. `settings-enum-select.tsx` supplies the shared accessible select.
  Existing store keys and their legacy migrations remain unchanged.
- `Appearance` (`panels/appearance-settings-panel.tsx`): seven areas in the
  master-detail card Providers and Layout use (`settings-master-detail.tsx`):
  **Themes**, **Start page**, **Interface**, **Fonts and text**,
  **Terminal**, **Diff viewer** and **Tasks**. It was one scroll of nine
  titled groups; at thirty rows it is the long page of the Application group,
  which is what the rail is for (see "Page shapes").
  - **The rail.** A vertical Radix tab list beside the picked area from `md`
    up, a select above it below `md`. Each area has a pinned header (its
    group's label and one line) over a body that owns the scroll. Every area
    stays mounted, hidden while another is picked, so a search result that
    picks an area finds its row in the same commit. The pick and the
    scroll-to-top on a new area are the hooks Layout uses
    (`settings-master-detail-area.ts`).
  - **An area is a group of the definitions**, so its label and anchor come
    from there and a search result finds its area by the group its row sits
    in (`appearanceAreaForAnchor`). The area header names the group, so no
    group card draws its own `<h2>` (`showTitle={false}`).
  - **Interface** holds zoom, the pointer cursor, panel animations, animation
    duration and contrast. Motion and readability was a group of its own;
    both were app-wide chrome and neither was long.
  - **Tasks** holds the agent office default view and Color icons by type.
    Agent office and Icon colors were each a heading over one row.
    Settings apply immediately; the theme editor previews a draft until Save
    theme or Cancel. `themes/appearance-details.tsx` supplies the prompt font
    and ligature rows of Fonts and text, and the motion and contrast rows of
    Interface.
  - **Theme**: light/dark/system mode (`theme`/`setTheme`) plus the theme
    library - selection, editing, import/export - lives in `ThemeGallery`,
    backed by `stores/settings/theme-library-store.ts` and applied by
    `lib/theme-applier.ts`. `themePreset` remains the built-in-palette
    fallback the gallery clears on a custom selection. Anything that bakes
    theme colours into a non-CSS surface (a canvas, xterm, a worker)
    subscribes to `useThemeRevision()` (`providers/use-theme-revision.ts`)
    rather than to the mode/preset fields, because a custom theme repaints
    the cascade without changing either.
    Shared menu, dialog and composer surfaces use solid theme fills.
    Background opacity remains retired after reproduced renderer flickering;
    old saved opacity values are ignored when the theme library is read.
    Modal backdrops use shadcn Radix Nova's default blur without a setting;
    reduced-transparency preferences disable the filter. Theme mode and the
    light/dark selectors retain their settings search anchors.
  - **Start page** (`start-page-settings-section.tsx`): the personal landing
    backdrop. Plain rows only, like every other group here - the start page
    itself is the preview. Rows: Wallpaper (56x34 thumbnail + "Choose
    image..." + Remove; secondary text is the stored file name, "Custom image"
    when the image has no stored name, or "None" when no image is loaded),
    Traycer team curated wallpapers (the tile gallery, below), Wallpaper
    effect (segmented Photo / Dot pattern / Film grain, only once
    a wallpaper is set), Effect strength (0..100 range input with Subtle /
    Strong endpoints, for every effect: it sets the neutral veil behind the
    composer, and for dot pattern and film grain the texture as well), Tint wallpaper
    with theme accent color (`Switch`, dot pattern only; off dithers each RGB channel on its
    own so the image keeps its own colours), Greeting and
    Recent tasks (`showGreeting` / `showRecentHistory` switches). The style,
    intensity, tint, the chosen file's `name` and the `curatedId` all live in
    the settings store (`startPageWallpaper`); the bytes live only in the
    appearance blob store.
    `lib/appearance/start-page-wallpaper.ts` owns one entry point per user
    action (`chooseStartPageWallpaper` / `applyCuratedStartPageWallpaper` /
    `removeStartPageWallpaper`), and each
    writes BOTH stores - that is what keeps a name from outliving the bytes it
    describes, and is why the name can be an ordinary settings field rather
    than a `File` subclass smuggled through IndexedDB. The start
    page's own `Paintbrush` button opens this panel - there is no separate
    appearance editor.
    - **Curated wallpapers.** A small set we host, catalogued by a remote
      manifest (`lib/appearance/curated-wallpapers.ts`) so adding one needs no
      app release.
      The row's control is a fluid tile grid plus a `RefreshCw` ghost icon
      button; the manifest is a `useQuery` held at `staleTime: Infinity` and
      refetched only by that button, and nothing about it is persisted.
      Tiles show the manifest's thumbnails through a plain `<img>`; only an
      apply downloads the full image, verifies its SHA-256, and stores it in
      the same single blob slot a custom pick uses.
      Bytes already inside the stored budget (4 MiB, 2560 px edge) are kept
      verbatim - they were encoded for it when published - and anything over it
      goes through `processStartPageWallpaperImage`.
      Apply is a `useMutation` keyed by
      `appearanceMutationKeys.applyCuratedWallpaper()`, and the spinning tile is
      read back off that key with `useMutationState` rather than from component
      state: the abort controller for an apply lives at module scope in
      `start-page-wallpaper.ts`, so a download outlives the panel and a reopened
      panel has to be able to find it again.
      A second tile, a custom pick, or Remove aborts an apply in flight - last
      action wins, and an aborted apply writes no settings row and reports
      nothing.
      `curatedId` is what rings the applied tile; an id whose entry has since
      left the manifest simply rings nothing, and the Wallpaper row keeps
      showing the title it was applied under.
  - **Interface**: Zoom (`DesktopZoomSettingsRow` - desktop-only, renders
    nothing without a zoom bridge; backed by
    `useRunnerZoomPercentQuery`/`SetMutation`/`ResetMutation` against host/OS
    state, not a settings-store field) and Show a hand cursor over clickable controls
    (`pointerCursors` `Switch`, default on).
  - **Fonts and text.** Two structurally identical rows - `Interface font` and
    `Code font` - each pairing a font picker with its size input stacked
    directly below. `Terminal font` moved out to its own **Terminal** group
    below (it pairs with the cursor rows and the live preview, not with UI/Code
    sizing) - the three fonts still share one storage/resolution model, only
    the grouping changed. Backing state lives in `settings-store.ts`:
    `uiFontFamily` / `codeFontFamily` / `terminalFontFamily` (`string | null`)
    and `terminalFontSize` (`number | null`) - `null` means "use the default"
    (UI: Figtree, Code: the system mono stack) or, for the two terminal
    fields, "follow the Code font/size". `uiFontSize` is clamped 10-20 (it
    scales the root font-size and breaks layout above that); `codeFontSize`
    and `terminalFontSize` are clamped 10-24. `theme-provider.tsx` applies
    `uiFontFamily`/`codeFontFamily` as inline overrides of
    `--traycer-font-ui`/`--traycer-font-mono` (chosen font + the default
    stack as fallback), removing the override when `null`. The effective
    TERMINAL font (`terminalFontFamily ?? codeFontFamily`,
    `terminalFontSize ?? codeFontSize`) is resolved once by
    `useEffectiveTerminalFont` (`hooks/settings/`) and applied inline by its
    three consumers - the xterm host, this panel's `TerminalPreview`, and the
    managed-command output window (`managed-command-output-tile.tsx`, whose
    content is a program's stdout and so is terminal output too). None of
    them can read it from CSS: `--traycer-font-mono` carries the CODE font,
    so `font-mono` would silently ignore a Terminal override, and xterm
    measures glyph cells on a canvas where CSS variables do not resolve at
    all. `terminal-tile-xterm.tsx` additionally live-syncs both values into
    `term.options` (see `useTerminalAppearanceSync`). The
    `@pierre/diffs` diff viewer follows the code font via
    `--diffs-font-family` / `--diffs-font-size` set on `[data-diffs-host]` in
    `diff-tokens-css.ts`.
  - **Font picker (`controls/font-picker.tsx`).** Searchable Popover + cmdk
    combobox (modeled on `theme-preset-picker.tsx`). Its first entry is
    always the group's default label ("Figtree (Default)" / "System Default"
    / "Same as code font") and selecting it stores `null`; typing a name
    absent from the list offers a "Use `<typed>`" item so unlisted/misdetected
    fonts, and non-desktop hosts (no enumerated list at all), still work. Each
    option renders in its own typeface via inline `style={{ fontFamily }}`.
    When the value is `null` the trigger shows the default label muted; a
    ghost reset button (`RotateCcw`) occupies a permanently-reserved `size-7`
    gutter to the _left_ of the trigger and appears once a font is chosen. The
    reserved left gutter means the trigger's right edge stays flush with every
    other control in the panel and never shifts as the reset toggles. All three
    rows offer the full installed-font list - no monospace pre-filter, because
    the OS `monospace` trait misdetects many real mono fonts (e.g. Nerd Font
    builds) and the picker already lets you free-type any name.
  - **UI/Code size input (`controls/settings-number-input.tsx`).** Plain
    non-nullable number field. Takes a `defaultValue`
    (`DEFAULT_UI_FONT_SIZE` / `DEFAULT_CODE_FONT_SIZE`, the same constants the
    store initializes from) and shows a ghost `RotateCcw` reset button in the
    reserved `size-7` left gutter whenever the current size differs from it,
    restoring the default on click - mirroring the font picker's reset gutter
    so the two rows stay aligned.
  - **Terminal size input (`controls/nullable-font-size-input.tsx`).**
    `SettingsNumberInput`-alike but nullable: displays `terminalFontSize ??
codeFontSize` in muted styling while `null`; any tick/type pins an
    explicit value starting from what was displayed; a ghost reset button
    clears back to `null`. Kept as a separate component because its reset target
    is `null` (follow code) rather than a fixed default.
  - **Terminal** (group). `Terminal font` (font picker + the nullable size
    input, one row) plus `Terminal cursor` and `Blink cursor` sit in a
    `@container` split with the live preview: one column of rows on the left,
    `TerminalPreview` on the right (`grid-cols-1 @min-[32rem]:grid-cols-[7fr_5fr]`,
    a divider border between them above that width, stacked below it) - the
    preview is part of the group's card, not a separately labelled row (it
    used to be its own `SettingsRow` with a "Terminal preview" label; that
    label is gone since the group title and layout already say what it is).
    - **Terminal cursor
      (`controls/terminal-cursor-style-picker.tsx` + a `Switch`).**
      `Terminal cursor` is a segmented shape picker (iTerm2
      style - each option draws the actual glyph, block centered) backed by
      `terminalCursorStyle` (`"block" | "bar" | "underline"`, default `block`);
      `Blink cursor` is a `Switch` backed by `terminalCursorBlink` (default on).
      Both are captured in the host's `initialOptionsRef` for first paint and
      live-synced into `term.options` via `useTerminalAppearanceSync`. On blur the
      cursor stops blinking (xterm's inactive cursor never blinks) and
      `cursorInactiveStyle` mirrors the chosen shape via `inactiveCursorStyleFor`,
      except `block` falls back to a hollow `outline` so an unfocused pane stays
      visually distinct. `TerminalPreview` reflects the chosen shape/blink with a
      CSS-only cursor (reads the store directly, no xterm instance) so the effect
      is visible without spawning a real terminal.
  - **Agent office default view** (a row of the Tasks area; a `Select` over
    `agentOfficeDefaultView`, `"auto"` plus every id in `OFFICE_VIEW_IDS`,
    default `"auto"`) - which office view an epic's comm-graph tile opens on
    when nobody has picked one for that tile. The options are read from the
    office view REGISTRY rather than listed here, so a newly registered view
    appears in this row and in the tile's own picker together; `merge`
    re-derives the persisted value against that registry and falls back to
    Auto. A tile with its own `officeView` ignores this row.
  - **Artifact icons** (group). One row, `Artifact icon colors`
    (`EpicNodeIconColorPicker`, `controls/node-icon-color-picker.tsx`) - a "Use
    type colors" `Switch` (`artifactIconColorMode`, `"byType" | "none"`,
    **default `"byType"`** - the palette is visible out of the box, this is an
    opt-out toggle, not an opt-in-from-collapsed one) that reveals a 2-column
    swatch grid (one native color input per `EpicNodeKind`) plus a Reset only
    while enabled. Turning type colors off hides the grid but keeps
    `artifactIconColors` in the store untouched, so turning it back on restores
    the same custom colors instead of resetting them.
  - **Installed-font enumeration.** Desktop-only, following the same chain as
    `systemPreferencesAppearance`: `RunnerHostInvoke.fontsList` IPC channel →
    `listInstalledFonts()` (`electron-main/app/installed-fonts.ts`, backed by
    the `font-list` package's `getFonts2()`, deduped/sorted, empty array on
    enumeration failure) → registered in `platform-ipc.ts` → exposed as
    `platform.fonts.list()` on both `PlatformBridgeSurface` (preload) and
    `DesktopPlatformBridge` (renderer-shell). gui-app reads it through
    feature-detected `getInstalledFontsBridge()`
    (`lib/desktop-installed-fonts.ts`, mirrors `desktop-log-levels.ts`) via
    `useRunnerInstalledFontsQuery` (`staleTime: Infinity`; resolves `[]` on
    shells without the bridge instead of erroring).
- `Layout` (`panels/layout-settings-panel.tsx`, `/settings/layout`, seventh and
  last in the Application group, leader digit 7) Where the app's own chrome
  SITS and how much of it shows.
  - **The way into the editor (5.1)** is the page header's action, where
    Providers keeps its refresh (H2), and it is the only entry in Settings:
    this page is the editor's other half, and the place the door itself lands
    when the window is too narrow for a canvas (L-64). Below that threshold the
    button is withheld rather than disabled - pressing it would navigate to the
    page already on screen - and a line says why in its place, because it is
    the guide's final coachmark target (L-50). Everywhere else the entries are
    the palette's "Customize layout", the five chrome context menus and a
    Settings-search launch result.
  - **Master-detail, the Providers pattern (H2).** The page draws its areas -
    Presets, then one per SURFACE - in the same `SettingsMasterDetail` card
    Providers uses (`settings-master-detail.tsx`): a rail of areas beside the
    picked one from `md` up, a select above it below `md`. The rail is a
    vertical Radix tab list, so the arrow keys walk it. Each area has a pinned
    header (title and one line) over a body that owns the scroll, and a changed
    area (`regions/surface-diff.ts`) carries the same blue dot a changed row
    does. Every
    area stays mounted, hidden while another is picked, so a search result or
    a region landing that picks an area finds its row in the same commit.
  - **One form, two hosts, two levels (L-03; L-06/08/09 partly overturned).**
    Both hosts draw All settings - the Presets block and the areas - and one
    area's form, `SurfaceSection`, whose rows disclose their details in place.
    There is no third level. This page draws the areas as its rail and the
    picked one beside it; the editor inspector draws them as a list
    (`inspector/layout-form.tsx`, `LayoutAllSettings`) and opens one with an
    "All settings" back row (`LayoutAreaLevel`). The editor store's `area`,
    `openRows` and `openArea(area, row)` are that level; a canvas selection
    (`select`) opens its region's area with the row expanded and highlighted.
    Same registry, same lists, same row component (`SortableList`, and
    `rows/layout-form-row.tsx` for an area's own rows), same write seams.
  - **A region is a ROW** (L-95) with ONE state control (L-121,
    `RegionDisplayControl`): `Auto · Shown · Hidden` on Pull requests and
    Comments only, `Full row · Chip · Hidden` where the region has a size, and
    `Shown · Hidden` everywhere else. Location, Side, Style and the detail rows
    open behind the row's own disclosure, disabled but readable while the
    region is Hidden, under a hint ("Show <region> to change these
    settings.") that every greyed row points `aria-describedby` at; the
    Profiles list greys with them rather than leaving. Every row reserves its
    grip, revert, extra and chevron slots (L-122), so controls share one right
    edge and never shift. At the inspector's 320px the control wraps under the
    label.
  - **One way to say a row depends on something (P1, `layout-editor/regions/row-availability.ts`).**
    Every row that can depend on another row, the window or a runtime fact declares it beside itself in the registry - a region's detail rows in `regions/*-regions.ts`, a region's own row as `availability`, an area's own rows in `regions/area-rows.ts` - as `depends: { under, availability }`.
    `under` names the row it sits under, which nests it one level and places it right after that row.
    The order is the DECLARED order and nothing else, so a row never moves under the pointer when a value changes; the dependent that is live at the shipped default is declared first.
    `availability` is a pure rule over ONE context (`{ values, arrangement, shell, facts }`, built by `inspector/use-layout-form-context.ts`) answering a closed union.
    `live` may carry a NOTE for a runtime fact the form cannot know (effort levels, a harness that can compact), and never disables for one.
    `disabled` carries a REASON that names the controller and the value to pick ("Set Placement to Left or Right to use this.") and an optional link that lands on the controller where it is out of sight.
    `absent` means nothing on this device can ever make the row apply.
    For a region's own row that is never its rule's answer (`RegionRule` cannot say it): the region declares a `shellGate`, and the form's lists and settings search both read that one predicate, so the Microphone and the Minimap leave both together.
    A layout row keys on the PHONE LAYOUT (`shell.phoneLayout`, the renderer's own `useIsMobileViewport()`), never on the product alone - see Responsive Behavior above.
    ONE row shell draws the answer for every kind of row (`LayoutFormRow` for form rows, `SortableRowLine` for list rows, both through `inspector/rows/row-availability-line.tsx`): the reason or note in the description slot at the host's description size, the control in a `fieldset` that is really disabled and described by the reason, and the label greyed.
    A link to another Settings page (Microphone's "Open General settings") is drawn on this page only: from the editor it would end the session being edited, so there the reason's words name the page instead.
  - **Usage and resources is two sections, not two rows**
    (`ReadingSection`, `inspector/surface-section.tsx`). Usage limits and the
    Resource monitor each get a header with a **Show switch**, then their rows,
    always open. **Location** is ONE picker (`inspector/reading-location-picker.tsx`):
    a small window with three spots - Tab strip, Status bar left, Status bar
    right - drawn the way the app is for the stored tab strip placement. The
    tab strip has no end, so that spot writes the host alone and the old end is
    kept for the way back; a status bar spot writes the host and the end
    (`regions/reading-placement.ts`). **Density** is Auto / Compact / Detailed
    in every placement, and its description says what Auto resolves to at the
    current spot (`densityDescription`).
    The rows only the Detailed form reads sit under Density (U3) and stay in place, disabled with "Set Density to Detailed to use this." while the RESOLVED density is Compact: Reading style, Percent shows and Reset time under Usage limits, Metrics under the Resource monitor.
    All three Usage limits rows sit one level under Density, side by side, though Percent shows also reads Reading style: rows nest one level only (`orderedRows`), and a second level for one row would cost every list and the row shell a depth they never otherwise need. Percent shows says what Bar changes in its note instead (U4).
    "Percent shows" is `amount` and "Reset time" is the `reset` switch.
    **Reading style** (`readingStyle`: Bar, Percent, Bar and percent, Everything) is a pictured style row that applies in the status bar's Detailed form only, so it is also disabled while usage is in a tab strip ("Set Location to the status bar to use this.").
    Under Bar, Percent shows keeps working for the profiles running low and the tooltip, so it stays live with a note (U4).
    Metrics stays live under Compact while the readings on agent rows are on, with a note: the Compact monitor is CPU alone, but agent rows read the metrics picked here, all but RAM share (U2).
    While agent rows print, Metrics also stays live with the monitor Hidden: its rule answers `liveOutsideGate`, so the gate exception and the note come from one rule.
    The phone layout draws no agent rows, so there Metrics follows the monitor alone, and the footer gate and Hidden turn it off like every other row.
    In the phone layout the footer is the status bar wherever a reading names, so Location applies on wider windows only, and Density and its rows follow the status bar's rules.
    The **Profiles** list sits under Usage limits (`inspector/usage-profiles.tsx`):
    one row per provider, dragged to order (`usageProviders`), an eye on the
    provider (`hiddenProviders`) and, for a provider with several profiles, an
    eye on each profile (`shownProfiles` for the watched host, never emptied:
    the last drawn profile stays, and says "One profile stays shown. Hide the
    provider instead.").
    On Settings > Providers the provider's limits grey with a reason and an "Open Layout" link while Usage limits or that provider is hidden here (U5).
    The link lands on the controller itself: Usage limits' Show switch, or that provider's own row in the Profiles list (`navigateToLayoutRegionRow`).
  - **Presets and resets.** The Presets block (`inspector/presets-block.tsx`)
    applies a preset in one click, replacing visibility and style values and
    keeping placement, order and providers, with an Undo toast. Its status
    reads `<Preset> · Modified` only while a VALUE differs from the applied
    preset (`layoutModified`, T5), the one kind of change a preset puts back;
    the Presets area's dot reads the same flag. The View changes list is
    offered for any change, grouped Styles and Arrangement, each line with its
    own revert (`lib/layout/layout-diff.ts` builds it,
    `inspector/layout-change-lines.ts` words it). While Arrangement has lines,
    a note under the status says presets keep the arrangement, with the count
    of those lines, and the applied card is described by it. `Reset layout…`
    confirms in both hosts (L-108 overturned); on this page it is the Presets
    area's last card, `tone="danger"`. Every row and order list has its own
    revert. A row's dot and revert cover its own values, host and side, never
    its place in a list (T2): one drag moves the index of every row below it,
    so the order is the list header's dot and revert alone, for the rail, the
    dock, both toolbar lists and Profiles. Context usage's breakdown order is
    not a list's: it is a detail of that row, so the row's dot and revert
    cover it (C2). A value kept in one region's bag but set by an area row
    (`isOffRegionValue` in `regions/surface-diff.ts`: the readings on agent
    rows, Toolbar style) counts on that area's dot and is left out of the
    region row's dot and revert (T4).
  - **Landing on a region.** Below the editor's width threshold the door
    redirects here, and `navigateToLayoutRegion` (`lib/settings-navigation.ts`)
    carries the target through: the page takes the pending region, opens that
    row's disclosure, scrolls it to the middle of the pane and leaves the same
    flash a settings-search result leaves. The row is found by
    `layoutRegionRowSelector` - `[data-sortable-id="<regionId>"]`, scoped to
    this panel - and NOT by a `data-settings-anchor`, because a region's search
    result is a LAUNCH entry (below) rather than an anchor on this page.
  - **One store.** `stores/layout/layout-store.ts` holds
    `{ basePreset, overrides, arrangement }` - a density preset, the user's own
    per-region delta, and where things live - and every chrome surface reads it
    through the override seam (`lib/layout-overrides.ts`), never directly.
    **Choosing a preset changes `basePreset` alone** (L-133): the delta is what
    a person PICKED, so it survives a change of density and is theirs again the
    moment they switch back, and `Reset to <preset>` is what clears it. Which
    picks are CHANGES is asked of the current base and answered by difference
    in `lib/layout/layout-diff.ts` - the row's dot, its revert, the header
    count and the analytics snapshot all read it there, so a pick that the
    current preset already makes shows up nowhere.
    The four values that shipped before it (minimap side, the pinned context
    breakdown, the resource-monitor switch, the sidebar's panel groups) are
    carried into it once on first launch (L-49).
    `components/settings/panels/layout-settings.definitions.ts` carries only
    what search has to land on - the page, the presets block, one anchor per
    surface group, and the rows that belong to a surface rather than to a
    region. The per-region search results are generated from the region
    registry (`components/layout-editor/layout-search.definitions.ts`), so a region added
    without a hand-written entry is still findable.
  - **Surface rows.**
    Some rows belong to a SURFACE rather than to a region, because what they place is not a region; `regions/area-rows.ts` lists them in order with what each depends on, and `inspector/rows/surface-placement-rows.tsx` draws them.
    The Tabs card opens with **`Placement`** (`arrangement.tabStripPlacement`: Top, Left or Right; keywords "vertical tabs" and "side tabs"), and under it **`Tab overflow`** (`taskTabLayout`) then **`Side tab view`** (`arrangement.sideStripView`: Tabs only or Tabs and agents), in that order whatever Placement is (T1).
    `Side tab view` picks between two pictures of the strip drawn from the real rows and the sample agents, one with the open task's live agents under its tab and one without.
    It is disabled while the tabs are at the top - "Set Placement to Left or Right to use this.", which the canvas chip says too - and `Tab overflow` is disabled while they sit at a side - "Set Placement to Top to use this."; each stored value is kept.
    In the editor its canvas part is the live agents list under the sample tab: hovering or pressing the row lights or rings that list (ghosted while the value is Tabs only), a press on the list selects the row, and with no room for the list the canvas chip on the strip says why.
    The Sidebar card opens with **`Side`** (`arrangement.sidebarSide`: Left or Right) and ends with **`Readings on agent rows`**.
    Chat opens with **`Reading width`** and, under it, **`Wide column width`**, which stays in place while Comfortable, disabled with "Set Reading width to Wide to use this." (C5); the column is never wider than the pane it is in.
    Composer opens with **`Toolbar style`** (`model.toolbarStyle`, Flat or Bordered, drawn as the real buttons): it styles every toolbar button, so it is an area row rather than a detail of the Model region it is stored on (C3).
    Usage and resources opens with **`Status bar on small screens`** where the phone layout is drawn (see Responsive Behavior).
    The docked inspector draws the same rows; both write one recorded gesture and revert against the shipped arrangement.
    The page's filter and the dock's filter both match these rows by their own label and keywords, so "vertical tabs" finds `Placement` there as it does in Settings search.
    The installed mobile app withholds every desktop-layout row; a narrow browser tab keeps them with "Applies on wider windows.".
    The Tabs card was called "Top bar"; its id is still `topBar`, and search still finds it by "top bar" and "title bar".
    Wherever a label names the place, it is the tab strip: "Tab strip - left of the tabs", a reading's `Position` of Status bar or Tab strip, and "Tab strip, left" in the index.
  - **Composer, Chat and Sidebar details.**
    The phone layout's toolbar lists are what it draws, unordered: Attach image on the left, Model (Reasoning control; Style applies on wider windows) and the Microphone on the right; a list with no member is not drawn.
    Model's Style and Reasoning control say they matter only for models with several effort levels; the Compact conversation button says it shows only for harnesses that can compact.
    While General > Voice input is off, the Microphone row is dimmed and disabled with "Turn on Voice input in General settings to use this." (C4).
    Context usage opens with Pin breakdown, then under it Chip style (disabled while pinned) and Breakdown rows (disabled while not pinned); its state word is "Pinned" while pinned (C1).
    In the phone layout the Minimap row says "Shows on wider windows with a mouse.", once: its Side row adds nothing of its own. The installed app has no Minimap row.
    On the rail, the last panel shown cannot be hidden or set to Auto ("One panel always stays shown.", the rail menu's rule too), and a stack row is dimmed while fewer than two of its panels are shown (T3).

  The rules below describe the CHROME these controls configure. They live here
  because the chrome has no other doc, not because this page owns them.

  - **Which of a provider's limits the strip draws is a TWO-MODE pick**,
    edited on the provider's own page (Settings > Providers > Profiles &
    Limits, `panels/provider-usage-limits-section.tsx`), not in the Layout form
    (L-96, L-110): a `SegmentedControl` reading `Automatic (recommended)` /
    `Choose...`, and under `Choose...` one checkbox per limit the provider
    currently reports, labelled from the window catalog (`5h`, `wk`, `Fable`).
    There is no "automatic" checkbox and no union: **Automatic IS an empty pick
    list**, so the two modes are exclusive by construction and "switching back
    to Automatic clears the picks" is not a second rule to keep - it is the
    only way back. Automatic draws the tightest limit, which is why a provider
    connected later needs no visit here. At least one box stays ticked: the
    last ticked box on screen is `disabled`, because a provider that draws
    nothing is what the provider's own `Shown | Hidden` control is for. Store:
    `arrangement.providerLimits[providerId] = { limitKeys }`, where an EMPTY
    list is Automatic and the absent key means the same thing - returning to
    Automatic DELETES the key, and "changed" is measured by difference rather
    than by presence. Resolution happens in `useStatusBarRateLimitSegments`,
    not in the segment: the model carries `windows` (every live limit), `shown`
    (the selection filtered by the live windows, falling back to the tightest
    when every pick has gone stale so the provider never vanishes for a renamed
    model) and `tightest` (the tightest of `shown`).
    A pick the host no longer reports is KEPT, appended after the live ones:
    the form never fetches, so "no reading yet" is routine, and demoting the
    level to Automatic would throw a pick away on a reading the user never saw.
    With nothing reported at all the checklist is replaced by one muted line
    and the mode stays Automatic.
  - **A limit is NAMED on the strip only when the name disambiguates**
    (`windowLabelText`, `lib/rate-limits/status-bar-window-text.ts`). A
    provider with ONE visible limit reads `100% used 6d` - there is nothing to
    tell that reading apart from, so the countdown is the whole reading, and
    the short name (`5h`, `wk`, `Weekly`, `Fable`) returns only when there is
    no countdown to print. With TWO OR MORE visible limits every reading has a
    sibling: a pure duration name is still replaced by the countdown, while a
    name that carries identity (`Fable`, `Opus wk`, `Cursor models`, a named
    Codex limit) is kept and the countdown appended, since several of those
    share one reset instant and would otherwise print as one string. The count
    is the provider's LIVE limits, not the ones the selection draws. The
    form's checkbox list is not a caller: it lists every limit so each can be
    checked, so a name is the point even when there is one.
  - **Grok's period label never parses the wire token.** `periodType` is
    `z.string().nullable()`, so `grokPeriodLabel`
    (`lib/rate-limits/grok-period-label.ts`) names the window from its
    `durationMinutes` when that duration NAMES a cadence, then from an explicit
    table of known `USAGE_PERIOD_TYPE_*` values, then from the duration as a
    plain count (`14d`), then from a neutral word. The cadence gate is what
    keeps the table alive: a calendar month is 28-31 days, so a duration
    trusted unconditionally would render a monthly period as `31d` in January
    and `28d` in February. `namedCadenceForDuration`
    (`lib/rate-limits/window-duration-cadence.ts`) owns that range and BOTH
    duration formatters ask it, so the strip's `mo` and the provider page's
    `Monthly` are answers to one test. All three vocabularies are the
    caller's - duration formatter, period table and fallback word - and the
    module owns the ORDER, never the words.
  - **One mini bar per DRAWN limit**, immediately before the reading it
    measures (`[bar] 57% used 4h 15m · [bar] 82% used wk`), filled and coloured
    from that window's own severity - so a provider showing three limits shows
    three independent gauges. The switch governs them as ONE decision
    (`parts.bar` in `status-bar-provider-segment.tsx`): off takes every bar
    away at once rather than thinning them one at a time. Each bar carries
    `data-window-key`, since order is otherwise the only thing pairing a gauge
    with its number, and every one stays `aria-hidden`. The gauge is
    `StatusBarMiniBar` (`components/layout/status-bar/status-bar-mini-bar.tsx`).
  - **The strip draws everything that is switched on, at every width, and
    SCROLLS what does not fit.** The width of the window never shortens a
    reading or hides a provider: every account and every display switch is a
    choice the user made, and a strip that quietly dropped one to fit would be
    overriding a choice it was asked to show. When the usage cluster outgrows
    the room the resource readout leaves it, the cluster scrolls horizontally
    (`status-bar-usage-scroller.tsx`: a wrapper around the trigger, since a
    `<button>` is not a reliable scroll container; no scrollbar; a mouse wheel
    turned sideways by `useHorizontalWheelScroll`, touch and trackpad native)
    and a mask fades ONLY the edge that hides something
    (`useHorizontalScrollEdges` + `horizontalScrollFadeClass`). The scroll
    position resets to the start when the SET of segments changes (host switch,
    provider hidden or shown, account checked or unchecked) or the WATCHED HOST
    changes (`statusBarUsageScrollKey`) and never when a reading inside one
    moves, so a countdown tick does not throw away where the user scrolled to.
    The refresh `↻` sits after the scroller, outside it; each cluster is
    `shrink-0` and the row's single grower is the spacer between them, so a
    reading stays pinned to the end it named (L-156). The percentage is severity-coloured always,
    bar or no bar.
  - **Which ACCOUNTS a provider's segments describe is chosen in the usage
    panel and in the layout form's Profiles list** (`layout/header/rate-limit-popover.tsx`).
    Every profile card carries an eye toggle immediately left of its accent dot
    (`aria-pressed`), and the strip draws **one segment per checked account**
    for the host it is watching, with its own limits, mini bars and countdowns.
    Store: `arrangement.shownProfiles[hostId][providerId] = [profileId | null,
…]` (`null` is the ambient login), keyed by host because a profile id names a
    credential on ONE machine. The background poll refreshes every eligible
    account regardless of this selection. A checked id whose profile has since gone is
    skipped at read time, never pruned. It lives in the arrangement but is not
    a display preference: no density preset carries it. The Layout form's
    Profiles list edits it too, for the watched host.
    - **The eye exists only while the strip is on screen**, which is ONE
      predicate, `useStatusBarVisible` (`lib/layout-overrides.ts`): on a
      desktop viewport, a reading that names the status bar (L-156) and is
      shown, `mobileFooter` on a phone-layout one with a reading shown, and in
      a session anything hosted there - the read `AppShell` mounts the strip
      on and the task frame drops its bottom border on. A hidden provider
      hides the eye only.
    - **Nothing checked draws ONE account**, resolved by
      `resolveStatusBarProfileIds`
      (`hooks/rate-limits/use-rate-limit-profile-selection.ts`): the profile
      last picked in a composer on THAT host if the provider still has it, else
      the provider's first profile, else ambient. The card for the fallback
      account is highlighted (`aria-current`) with its eye off.
    - **A segment is a deep link.** Clicking one arms
      `rate-limit-popover-store.revealProfile` (session-only) and selects the
      provider's tab; the click is left to bubble to the cluster's
      `PopoverTrigger`, which is what opens the panel.
    - The header glyph has two slots and no room to name an account, so it
      draws the FIRST of the accounts the strip would draw per provider
      (`resolveRateLimitProfileId`) - while the strip is on screen. While it is
      not, the checks have no control, so the glyph resolves without them.
    - The dot and the name are drawn only for a provider with two or more
      profiles - the composer rail's rule, and for the same reason.
  - **The strip's right-click menu** (`status-bar-visibility-menu.tsx`) gives
    each reading the strip is drawing the same Show checkbox, Usage limits
    with its providers under it, then Move to tab strip and the editor door,
    with a rule only between groups that drew something.
  - **The strip's right-click menu deliberately has no per-limit items.** Its
    provider rows are `ContextMenuCheckboxItem`s - a one-click visibility
    toggle each - and a checkbox item cannot also host a sub-menu trigger, so
    offering the limit selection there would either demote the visibility
    toggle into a submenu or add a flat checkbox per limit per provider.
  - **The pinned context breakdown prints the selected fields in order.**
    `contextUsage.pinnedFields` is the SET (canonically ordered, never empty -
    a strip with no figures is what the `pinBreakdown` switch is for) and
    `arrangement.pinnedContextFieldOrder` is the COMPLETE order over every
    field, including the unselected ones, which is what makes a field's place
    survive being unchecked and checked again. Both are written by Context
    usage's Breakdown rows, a sortable check list: a check writes the set, a
    drag writes the order, and the row's revert puts both back in one step.
    The order is on the change list
    (`pinnedFieldOrder`) and on the Chat area's dot (C2). The leading `Context N% left` is
    not a field and always prints, so the strip is never blank. A selected
    field the current turn cannot produce simply does not print
    (`buildContextUsageRows` omits the cache rows until a harness reports
    cache).
  - **`contextUsage.style`** (`text` / `ring` / `ring-only`) shapes the
    UNPINNED chip: the sentence, a gauge with the percentage inside (`size-5`)
    or the gauge alone (`size-4`, percentage in the tooltip and the
    `aria-label`). The gauge is the same construction as `MicProgressRing` -
    20-unit viewBox, radius 8.5, round cap, `-rotate-90` - with the arc =
    context LEFT, and its number is an HTML element centred over the SVG rather
    than an SVG `<text>`: a user-unit `fontSize` is measured against the
    viewBox while the root font size IS the `uiFontSize` setting. The arc is
    floored at 5% so 0% left still draws a tick, and the trigger's resting
    `opacity-70` is dropped at the destructive threshold, so the chip is
    loudest when the window is nearly gone.
  - **Two option sets, and they are not interchangeable.** `Row / Chip` for
    anything that carries a verb with no other home - the four dock rows own
    Stop all / Review all / Undo all, and the Access pill reports the
    permission the next send runs under. `Chip` is their floor: a row folds to
    a pill in the row that sits above the composer, on its LEFT edge, as the
    first child of the stack that holds the pills, the joined frame and the
    composer (L-99; `chat/chat-dock-compact-strip.tsx`).
    The pills are a one-at-a-time switcher (L-141).
    Clicking one opens that section as a single panel attached above the
    composer, with no collapsible header of its own; clicking another REPLACES
    it, clicking the open one closes it, and the open pill reads as selected.
    In a mixed dock the members set to `Row` stay at the bottom of the joined
    frame with their normal headers, and the pill-opened panel is the topmost,
    replaceable one.
    That panel's own actions (Review all / Undo all, Stop all) sit at
    the RIGHT end of the pill row while it is open, so the panel below is pure
    content (L-142(1), `chat/chat-dock-attached-panel.tsx`).
    It is user-resizable from a handle on its top edge, starts at about a third
    of the CHAT PANE's height and is clamped to that pane (L-142(3), L-145).
    The pill folds to its icon with the name on hover. A
    chip always draws its own icon (`FileDiff`, `Bot`, for Background the
    section's own `MessageSquareClock`, and `ListChecks` for Todo), and activity shows ON that icon rather
    than replacing it: the glyph and the count turn `primary`, and the glyph
    shimmers on the shared status clock. A chip is `[icon] N` at every width;
    the sentence lives in the tooltip and the accessible name. **Nothing is
    drawn over the glyph** - a dot at its corner lands ON the icon at
    `size-3.5` and obscures the mark saying which section is running. The tone
    is what carries the state under `prefers-reduced-motion`. A chip prints
    what its row's own header prints - Files changed reads `3  +12 −4`
    (`DiffLineDeltas`, shared with the panel).
    `Shown / Hidden` only for a control whose job has a second route: paste and
    drag-drop attach images, the dictation chord starts voice input (`Hidden`
    here is NOT `voiceInputEnabled` off), and the palette and `/compact`
    compact a conversation.
  - **Which pill is open is per CHAT, and is never written back.** `Chip` says
    how a chat OPENS; one glance at a folded row must not redefine that for
    every chat, so what the user opened is a glance rather than a preference.
    It lives in `stores/chats/chat-dock-open-store.ts`, keyed by chat id,
    session-lifetime and never persisted (L-142(2)).
    Per chat rather than per tile because a same-pane chat switch is a full
    remount in this app, so component state would lose the open panel every
    time the user looked at a sibling chat and came back; the store survives
    that and a tab switch with it.
    Nothing ever auto-opens: a chat with no entry there has no panel attached,
    and a section that empties closes its own.
    The pill stays on screen while its panel is showing (`aria-pressed`)
    because it is the only way back, and a pill rings once when the thing it
    stands for arrives, never when it drains (L-150(6)).
  - **The Message queue is never a pill, and is not a region** (G1-G2).
    Queued messages are the user's own pending sends, so hiding them behind a
    pill hides a primary action. While the queue holds anything it is the
    joined frame's last member, directly on the composer, with its rows, their
    actions and Pause, under the pill row and every other row. It has no
    Size, no Shown and no dock position; stale stored values for it are
    dropped on rehydrate. It empties to nothing, leaving no gap.
  - **Received A2A queue rows follow the Running agents mode**, and fold into
    the same chip with their own count. That is also why the chip exists
    whenever those rows do, even with no sub-agent running: without it, folding
    would put them out of reach.
  - **`model.style`** (`text` / `bars` / `bars-text`) shows the thinking effort
    as its name, as a signal-bars glyph (`pickers/reasoning-bars-glyph.tsx`),
    or both. The picker derives the position (`reasoningStep` in
    `harness-model-picker-presentation.ts`) from the same option list its
    footer lists, so the chat composer and the terminal launcher cannot
    disagree.
    - **The glyph's slot per bar is fixed, and the box grows sideways**
      (`h-3.5 w-auto`, `viewBox` width = count × slot). Harnesses advertise
      anywhere from two graded levels to seven, and dividing a fixed width by
      the count would shave a seven-bar glyph into hairlines while a two-bar
      one drew slabs. Bars rise from a minimum height to full so the shortest
      is still a visible mark.
    - **A no-thinking level is OFF, not the bottom rung.** Ids in a small
      closed set (`off`, `none`) are excluded from the ladder the glyph counts,
      because the ids are a harness convention rather than an enum. So pi reads
      `1 of 6` at its lowest real effort, and selecting `off` lights nothing:
      every bar empty, named `Thinking: Off`. The same fallback covers a value
      that names no level the model exposes, and a model whose levels are ALL
      zero-effort has no ladder at all.
  - **The provider list reads the WATCHED host**, not the app-wide one, and
    every query behind it is a passive observer
    (`PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS`): opening the form, and toggling
    anything on it, must never spawn a provider read; a provider with nothing
    in the shared cache yet renders a "waiting for first reading" subtitle
    instead.
  - **Mobile app**: the section stays listed, and `app.status-bar.toggle`
    collapses - it is the one `desktopOnly: true` entry in `ACTION_META`, and
    both the palette filter and `StatusBarKeybindingBridge` READ that flag
    rather than testing the build, so the pair follows from the field.
  - **The rail is one flat list** (L-155, L-166): `arrangement.rail` is panels,
    dividers and stack links in order.
    The three are independent of each other.
    - A DIVIDER is a SPACER and nothing else.
      The user reads it as a "Divider", adds it, drags it and removes it, and
      the sidebar draws it as a gap at rest (L-140).
      The shipped rail carries none.
    - A STACK joins two or more ADJACENT panels (L-166, L-181): they share
      the sidebar body, top to bottom, with a resize handle between each two
      and a per-section collapse. The entry sits right after its first member
      and its id names every member in order (`stack:A+B+C`), so a stored pair
      is just the two-member case.
      The rail draws a stack as ONE view group the way VS Code draws a view
      container (G3, `left-panel-rail-stack.tsx`): the top member's icon,
      named and tooltipped for every member ("Agents · Artifacts"), lit while
      any member is showing, with no card or separator, and a member count
      only while the editor customizes the rail. Clicking it opens the stack
      on its top panel (or puts back a collapsed member section), and clicking
      it while the stack shows collapses the column.
      The shipped rail carries exactly one, Agents with Artifacts.
      `normalizeRail` keeps each stack as the runs of its members that still
      stand side by side, in any order and re-minted for that order: members
      trading places keeps the stack, a member taken away leaves it (a pair
      dissolves), a divider or another panel moved between members splits it
      there, and a panel belongs to one stack. Membership is explicit in the writers, so a member carried out of
      its stack leaves it even when it lands right beside it.
      A rail drag says what it CARRIES (`RailDragCarry`): the rail's icon
      carries its whole stack, a SECTION header carries one panel.
      A stack has no cap. It had one of four (each section keeping three rows
      at the 600px minimum height), but the sidebar's groups never had one, so
      a stack refusing a fifth panel was a regression. A deep stack shrinks
      each section toward its header, and a section's body scrolls.
      A HIDDEN panel drops out of its stack for display only - the rest stand
      as a smaller stack, or alone, on the rail and in the body, and showing the
      panel again puts it back.
      A member joining a stack opens with its section showing: the collapse
      flag outlives the stack, and a panel standing alone draws no chevron that
      could clear it (L-170).
      The last expanded member can never be collapsed, because a collapse hands
      its space to the members still open.
      `railDisplayEntries` (`lib/layout/rail.ts`) is what every rail SURFACE
      walks - the icon column, the sample scene's copy and the preset card's
      miniature - so the capsule rule and the hidden-member rule are written
      once; `visibleRailPanelIds` beside it is the one visibility filter for the
      body's choice of panel and the PR retention.
      At rest (`"spacing"`) it also drops a divider at either end and one right
      after another, since with the panels around it hidden it would space
      nothing; in a session (`"handles"`) every divider is drawn, as a handle.
      `isRailStackDrawn` says whether a stack still has two shown members.
      The last shown panel cannot leave `shown`, neither to Hidden nor to
      Auto: `isLastShownRailPanel` is the one rule, and the rail's menu and
      the layout form both ask it of the saved values
      (`railPanelShownByValue`, where an `auto` panel never counts, since the
      layout must hold in a task with no pull requests or comments). Both say
      "One panel always stays shown." (T3); the menu's item stays focusable
      with that reason as its description.
      So in the form the last shown panel cannot move to Auto either: every option but Shown is off.
      The menu needs no such lock, since its only write over a Shown panel is the uncheck it already refuses.
      Writes go through `applyRail` (`lib/layout/rail-view.ts`) for the app's own
      drag and through `moveRailEntry` / `insertRailDivider` /
      `removeRailDivider` / `stackRailPanelWithBelow` / `unstackRail` /
      `unstackRailPanel` (`lib/layout/layout-arrangement.ts`) for the editor's
      list, with `moveRailPanelBeside` / `moveRailPanelToEnd` /
      `stackRailPanels` the movers both drags place a panel by.
      A carried stack lands before or after the target's whole stack. A carried
      panel beside another member of its own stack changes place in it;
      anywhere else it leaves the stack and lands before or after the target's
      whole stack, never between another stack's members.
      On the rail a drop has three bands (L-168): the outer 30% at each end
      reorders, and the middle 40% appends what is carried to the target's
      stack (after its last member), or stacks them with a lone target.
      `railStackJoin` answers what the middle band would do - `join` or `same`
      (already stacked together) - and the rail draws the join ring on the
      target icon from that answer; a `same` drop commits nothing.
      A member leaves its stack by dragging its section header out of the
      body onto the rail, from the stack icon's menu ("Unstack 'Name'" per
      member), or from the Sidebar area's stack row, which lists every member
      with its own Unstack beside "Remove stack"; each is one write and one
      undo step, and the first or last member stays where it stands while a
      middle one steps out to just after the stack.
      A drop on the open sidebar BODY means INTO the stack it draws (L-182):
      the body is one droppable naming the stack's top panel, it resolves to
      the same middle-band join as that panel's rail icon, and it draws the
      same answer on its frame, the join ring.
      A member's own section HEADER is the one exception: joining its own
      stack means nothing, so inside its body it reorders the stack, landing
      at the section boundary nearest the pointer (a `left-panel-section`
      preview, drawn as a line on that boundary), as the sidebar's groups
      always did. The editor canvas has no join gesture
      (L-169), so the body there takes no drop.
      The split and the per-section collapse live in the PANEL store
      (`panelSectionWeightsByPanelId`, `panelSectionCollapsedByPanelId`), not in
      the arrangement: they are how a stack is drawn rather than whether it
      exists, and keeping the shipped key means an upgrading user's split comes
      back with no migration.
      A rail region's three-state `shown` maps onto the sparse show/hide map the
      sidebar already reads: `auto` leaves the panel absent from it and therefore
      on its own presence rule.
  - **Home tab behaviour** - NOT a group on this page, and Home now owns no
    Settings row on it at all (`Home tab` above is the switch that draws the
    tab, not a preference about what is on it). Recorded here because this is
    still where a reader goes looking for how the page reads
    (`components/home-focus/`, `lib/home-focus/`).
    - **Home is ONE reading, and it is the task list.** It offered two behind
      an in-page `Focus | Tasks` switch: a flat page of four sections with a
      task column, and the same activity grouped under its tasks. The flat one
      is gone, and so are the switch, `layout-store.home.view`, its setter and
      the `layout.home.view` analytics id. Two readings of one page is a choice
      the reader has to make before they can read anything, and the flat one
      lost: four sections plus a task column is more to hold than a list of
      tasks, and every row on it had to name its task because nothing above it
      did. The persisted `view` is READ PAST rather than migrated - one reading
      means there is nothing for the old value to select, and the next write to
      the slice drops the key.
    - **Two sections, and a task is in exactly one.** `NEEDS YOU · N` leads,
      then `RUNNING · N`. A task is in Needs you when it has an unresolved
      prompt row OR the host's `needsYou` indicator with no row paged in yet
      (`taskGroupNeedsYou`); everything else with a group is Running. There is
      no flat prompt list any more, and that is the same de-duplication the
      rest of this page is built on: a task waiting on an approval used to
      appear twice, once as a prompt row and once as a task row, in two
      vocabularies, with two counts that did not explain each other.
      `selectTaskSections` partitions BEFORE the host split, never after -
      `splitTaskGroupByHost` files a prompt under the machine it was raised on
      and drops it from the others, so a two-host task with one prompt would
      otherwise land in Needs you under one machine and Running under the
      other.
    - **Home has ONE spacing**, the comfortable one, and no setting that bends
      it. A `Home density` segment offered `Comfortable | Compact` here, where
      `Compact` tightened the desktop row (`p-3` → `p-2`, chip gap with it) and
      restored every tightened utility under `pointer-coarse:` so a phone kept
      the hit area sized for a thumb. The two read almost identically on
      screen (user ruling, 2026-09-12: "I can hardly see any difference in
      both. Remove it."), so the row went, and with it the whole
      `layout-store.home` slice, the `layout.home.density` analytics id, and
      the `data-density` attribute the rows carried. `ROW_CLASS` /
      `CHIP_ROW_CLASS` (`home-focus-row-style.ts`) are now plain constants -
      the same class strings Comfortable emitted. The `pointer-coarse:` touch
      chrome rode the base class throughout and is untouched. A persisted
      `home` slice is read past rather than migrated and the next write to any
      layout preference drops it, exactly as the older `home.view` was.
    - **Nesting is task → chat → the chat's own work, and stops there.** Level
      one under a task is its CHATS - chat agents and terminal agents alike,
      each with its own status cell. Level two is what that chat owns: the
      prompts raised in it, the background jobs whose `chatId` is it, and the
      browser tabs it is driving. A chat agent's id IS its chat id, which is
      what lets all three be looked up in one map of agent ids. The third level
      is the whole point of the change: a monitor listed BESIDE the chat
      running it had to name its parent to make sense - `10min heartbeat · in
Greeting and Introduction` - so the page read as a monitor name followed
      by the conversation it was in, and the conversation's name appeared
      twice, once as a row and once as a suffix. Under the chat, the structure
      says it and the row is just the job.
    - **Parentage does not take a level; work does.** An agent another listed
      agent started stays beside it and says `via <parent>`, because the indent
      under a chat is spoken for by that chat's own work. Anything whose owning
      chat is not a row here hangs off the TASK at level one and keeps the
      context that says where it lives: a job in a chat this window cannot
      place keeps `· in <chat>`, a browser hand-off (which names a session and
      a tab, never a conversation) keeps its tab title, an undriven tab keeps
      neither. A child row never says `· in <task>` - the row above it already
      did.
    - **`selectTaskGroupBody` runs LAST, at the render site, and that is a
      requirement rather than a convenience.** The chat set narrows twice after
      a group is built - the cold-task rule drops every chat, and the host
      split keeps one machine's - and every relationship in the body is a claim
      about the rows beside it. A `via` naming a parent that is not there, or a
      job nested under a chat that was filtered out, is worse than the flat
      list it replaced. Pairing them after both narrowings makes that
      impossible rather than merely fixed: there is no earlier value to go
      stale. `FocusTaskGroup` therefore carries flat `agents` / `jobs` /
      `browsers` / `prompts` and no parent links at all.
    - **A cold task is one summary row.** Agent titles only exist for epics
      mounted in this window, so a cold task contributes no chat rows: a list
      of rows all called `Agent` said nothing the count does not, and the user
      asked for the single row back. It reads `● n agents running · not open
in this window` (`○ … background` when none is mid-turn) beside its
      `Stop all`, keeps a disclosure only for prompts, jobs and pages this
      window can still see, and hangs those off the task at level one. A cold
      task that is in Needs you on the indicator alone shows the attention
      glyph and nests no prompt - there is no row to nest. Nested chat rows
      appear once the task is open here and names are known; the
      `CircleDashed` glyph is for the rarer MOUNTED agent whose projection has
      no surface yet.
    - **Badges count the WHOLE subtree** (`taskGroupCounts`): `N need you`
      (loaded prompt rows), `N active` (mid-turn agents), `N bg` (jobs at any
      level), `N browsers`. They are read off the group's flat lists rather
      than off the body, which is the same numbers by construction - the body
      only redistributes rows across levels, it never adds or drops one.
      Every badge is omitted at zero. `N bg` renders only where this window can
      SEE the task's background - the warm-chat set the jobs come from, never
      `mountedHere`, which is the wider "has a live Y.Doc projection here" and
      would read `0 bg` at a task whose chats were simply never opened. `N
browsers` is omitted at zero for a sharper reason still: that plane is
      mounted-only, so a zero would mean "no coordinator in this window", which
      is not a fact about the task.
    - **Stop, per level.** The task row keeps `Stop all` (`Stop all on <host>`
      under the host split), cascading over that task's - that host's - agent
      ROOTS, once each. A chat row that is a real agent run carries its own
      `Stop`, gated by `FocusAgentRow.stoppable` and routed to the agent's own
      host. A chat that is idle and merely PARENTS its jobs (`○ background`
      with jobs beneath) has no stop of its own: the work is those jobs, each
      of which carries one, and a stop on the conversation would be a bigger,
      vaguer version of the button one line down. A background-tier chat with
      NO job row here is a different thing - a run this window has no durable
      row for - and keeps its stop, or the page would offer no way to end it.
      Browser rows have none in any case.
    - **`selectTaskGroups` unions THREE sets**, and must: `model.tasks` covers
      epics with a running agent, `model.background` covers epics with a warm
      chat, `model.browsers` covers epics with a live page, and the three are
      not nested. There is no Background or Browsers section to catch a row
      whose epic is not a task row, so an intersection would drop it silently -
      and on an account whose only activity is a dev server, or a task left
      open at a page, the page would be blank. A durable shell in an idle chat
      is therefore a group of its own, with `N bg` and no `N active`.
    - **A prompt no group could carry stays in Needs you as its own row.** The
      flat list is gone, and three things can leave a prompt unplaced: an
      approval whose payload carried no epic id (they are optional on the
      wire), an epic with a pending prompt and no running agent, warm chat or
      open page to make a group out of, and the host split's own per-host
      prompt filter. The header bell counts these same prompts, so a prompt
      the page cannot show is a bell reading `1` over a page showing nothing. The
      leftovers are computed FROM the rendered slices rather than from a second
      guess at the same rule, which is what makes that impossible instead of
      merely unlikely; they render last, with `· in <task>` restored, since
      nothing above them says where they are.
    - **A section's heading counts the rows it lists at its TOP level** - task
      groups plus any unplaced prompt rows - and the summary segment reads the
      same number, so the two can never disagree. `NEEDS YOU · 2`, and any
      coverage caption is a block-level `<p>` on its own line beneath it. Two
      independent limits can bind Needs you - how far the notification feed
      reaches (`this host only`) and how far the window-local background plane
      does - so they get a line each rather than a separator between them.
    - **Disclosure is one store above both sections** (`useTaskDisclosure`),
      never row-local state, and the section split is why. Answering a task's
      last prompt moves it from Needs you to Running, which unmounts its `<li>`
      from one subtree and mounts a new one in the other - a React key is
      stable within a parent, not across two - so a row the user had just
      opened collapsed at the exact moment they acted on it. Entries are keyed
      by epic AND host, so two machines' shares of one task open
      independently; that key survives a section move, because prompts never
      open a host group of their own and answering one therefore cannot change
      which hosts a task is split across. Choices are pruned when their row
      leaves the page, which keeps the self-pruning the row-local state gave
      for free: a task that comes back comes back at the page's default.
    - **Every task starts collapsed, whatever the page holds.** There used to
      be a count-based default - three or fewer tasks in total opened
      themselves, latched on the first frame that had any - and it went for
      two reasons: the user asked for no auto-expand, and a default that
      depends on how many rows happen to be running is a page whose shape
      changes for reasons the reader cannot see. The section headings already
      say how much is there, and the twisty is one click. The only disclosure
      state is the rows the user has touched this session, pruned DURING
      render rather than from an effect - the supported shape for state
      derived from props, and idempotent, so the immediate re-run finds
      nothing stale left. Chat rows have no second disclosure: hiding a
      monitor behind another click would make finding it a two-gesture job on
      a page whose whole purpose is one glance.
    - **No row carries a trailing `Open`**: the row body already spans the card
      and opens the same thing, so the second control was one extra tab stop
      per row announcing a verb the row had already offered. Stop / Stop all
      stay.
    - **Icon vocabulary is row-level only; section headings stay text**, which
      is what keeps the screen-reader heading outline a list of names rather
      than of glyphs. Agents read off `EPIC_NODE_ICONS` (chat `MessageSquare`,
      terminal agent `Bot`) - a terminal agent is deliberately NOT `Terminal`,
      which means "a shell" everywhere else on the page. A managed command is
      `Terminal`; a background item uses the chat Background panel's own
      per-kind map, shared through `lib/chat/background-kind-icon.ts` rather
      than restated, so a sub-agent is a `Bot` in both places. Prompts keep the
      notification tone glyphs. Colour is derived state only - there is no
      colour setting here and no identity palette.
    - **One row grammar, everywhere**:
      `[kind icon] [item name] [· in <context>] … [status] [actions]`
      (`home-focus-row-parts.tsx`). The item name is what the row IS - the
      prompt's text, the agent's name, the job's name - in `text-foreground`;
      everything after it is muted CONTEXT, each part truncating on its own.
      Two names are never concatenated: the row that produced this rule read
      `General Conversation History 10min heartbeat`, a task and a monitor with
      a space between them and nothing saying which was which.
    - **One status column** (`focus-row-status.ts`): a `size-2` dot in the
      state tone, the state word, and `· <duration>` where the model has a
      timestamp. `needs you` is warning-toned, `turn` / `running` carry a
      primary dot, `background` / `waiting` a hollow muted one; every WORD is
      muted except needs-you, because a column of coloured words is a column
      nobody scans. The mid-turn tier PRINTS as `running` (`focusTierWord`,
      `focus-row-labels.ts`) everywhere Home spells it - the status cell, the
      cold-task summary, the Stop-all list - because `● turn` read as a noun
      with no verb; the `turn` state, the wire field and the `tier` union keep
      their names. `background` is unchanged: it matches the Background panel,
      the chip and the `N bg` badge. Agents have no start time on the activity plane, so their
      cell shows the word alone rather than an invented duration. `held` is a
      RESERVED slot in the registry - real in the vocabulary, unreachable from
      today's rows, because no field carries the flag and inventing one is new
      data.
    - **It is a column because the track is fixed**, not because each cell is
      right-aligned (`ROW_STATUS_CELL_CLASS` / `ROW_ACTIONS_CELL_CLASS` in
      `home-focus-row-style.ts`). Every row in a section reserves both
      right-hand tracks whether or not it has anything to put in them - the
      prompt row with nothing to stop still spends the width a `Stop all` takes
      two rows below it, and so does the idle chat row with no stop of its own.
      Without that, `Stop all` is wider than `Stop` is wider than nothing and
      the column staircases down a section of mixed rows, which is the one
      thing it exists not to do. Nested rows use the same tracks: a nested list
      is indented on its LEFT only, so its right edge is the parent's - which
      is what lets a third level exist without a third set of columns. These
      are deliberately fixed widths against the fluid-sizing rule, on the same
      argument as the status-bar preview's `w-[480px]` - a column track's whole
      job is to NOT adapt to its content, and a label that outgrows one
      truncates rather than moving the column. The cell's content is
      LEFT-aligned inside that track, which is what freezes the dot and the
      word: right-aligning pins only the cell's right edge, so a row carrying
      `· 41m` pushes its word left of a row carrying none. `tabular-nums` keeps
      a ticking duration from rewidthing itself; it was never what held the
      word still. The status cell is a DOM sibling of the body button so it
      stays out of that button's accessible name, but it is unpositioned and
      therefore still under its stretched overlay - by design, since everything
      that is not a control opens the row.
    - **The status cell's trailing slot has two clocks, and the row decides
      which.** A prompt row's `· 5m` is an AGE (`RowStatusDuration`:
      `formatCompactRelativeTime` on the shared 60s clock) - how long a
      question has sat unanswered, where nothing changes second to second. A
      running shell's `· 42h 47m 13s` is a CLOCK (`RowStatusElapsed`:
      `useElapsedSeconds` + `formatClockDuration`, a 1s tick confined to that
      leaf) - the same reading the chat's Background panel prints for the same
      shell, because a watcher that reads `42h 47m 13s` in the panel and `1d`
      on Home is one fact in two vocabularies. Agent rows and in-turn
      background items print neither: neither plane carries a start time.
    - **The duration hides on a narrow ROW, under Compact only.** An
      `@container` on the section and `@max-sm:hidden` on the duration, not a
      viewport breakpoint: a slim Home tile inside a wide window is exactly the
      case a viewport query gets backwards, and Comfortable's contract is that
      it never drops the duration at any width. The state word always survives.
    - **The disclosure twisty needs `z-10`, not `relative`.** `ROW_BODY_CLASS`
      carries `before:absolute before:inset-0` and the body button is
      unpositioned, so that overlay's containing block is the ROW and it
      stretches across the twisty too. Overlay and twisty would then both be
      `z-index: auto` positioned boxes painted in TREE ORDER, and the overlay
      belongs to the later sibling - so it paints last and swallows every click
      on the twisty. `RowActionsCell` gets away with bare `relative` only
      because it comes AFTER the body button. Any control placed before it
      needs the real stacking level.
    - **Summary line** above the sections, reading `2 need you · 4 running`.
      Each segment is a button that scrolls to its section and moves focus onto
      it (the sections are `tabIndex={-1}` regions with `scroll-mt-4`, so a
      screen reader hears the heading on arrival). Zero segments are omitted;
      all-zero is the empty state instead. Both counts come from the sections
      the page actually mounts, so a segment can never point at a region that
      is not there - the defect the old `background` segment had under the
      Tasks view, where the click found no element and did nothing at all.
    - **Sections render a list of row GROUPS** - one unlabelled group when the
      page names a single host, and one per machine when it names several. The
      unlabelled shape renders its `<ul>` directly under the section with no
      wrapper, so a single-host install's DOM is unchanged by host grouping
      existing; a labelled group brings its own box.
    - **Host grouping is automatic and has no setting**
      (`focus-host-groups.ts`, `use-home-host-groups.ts`). It turns on only
      when the model's rows name MORE THAN ONE host, counted across the whole
      page rather than per section - headings appearing in Running and not in
      Needs you would leave the reader working out why. A row with no host
      of its own RESOLVES to the active host before anything is counted, since
      that is where its stop would be sent; without that, one unresolved row
      would split a single-host page into two groups that are the same
      machine. Every task in the model is a group now, so the host set counts
      every task's agents - there is no presentation rule left that could hide
      a row and leave a heading with nothing to explain it.
    - **Ordering is active host, then registry order, then the rest by id.**
      The active host leads because it is what the user is working on and what
      an unnamed row resolved to; registry order follows because it is the
      order the same machines appear in everywhere else in the app, and a
      second ordering for this one page would make two lists of the same hosts
      disagree. An `<h3>` carries the host's label (its id when the registry
      has none - ugly and honest), its own count, and an `active` pill on the
      one; the section keeps its total above them. Rows under a heading DROP
      their origin-host pill, which would otherwise repeat the heading on every
      line - `HomeHostGroupedContext` and its `useHomeHostGrouped` hook carry
      that, because the answer belongs to the section and the pill is several
      components down. The context says "a heading above this row already names
      its machine", so the ONE group that has no heading - the unplaced-prompt
      tail - re-provides it as `false` and keeps its chips. Reading the page's
      grouping flag there instead left a remote orphan prompt with no host
      attribution at all, on the one row where nothing else could supply it.
    - **Grouping is by the ROW's own host, never by its task.** An epic is
      cloud-homed and can be worked from several machines at once, so a task has
      no single host to be filed under - asking for one answered `null` when its
      agents disagreed, and `null` resolved to whichever machine the user
      happened to be sitting at. So prompts group by origin host, agents by
      their own `hostId`, jobs by their chat's, tabs by their session's. A task
      worked from two machines appears once under EACH
      (`splitTaskGroupByHost`), holding only that host's agents, jobs, pages and
      prompts, with that host's counts; its `Stop all` reads `Stop all on
<host>` and cascades over that host's roots only, and the label is per
      TASK rather than per bucket - an A-only task beside an A/B one is not
      split and must not claim to be. `FocusAgentRow.stoppable` exists for the
      re-fold: the task's own flag is `every` over ALL agents, so a reachable
      host's row would otherwise inherit an unreachable sibling's refusal.
    - **A row is never dropped for having no host.** With no active host to
      resolve against it lands in `UNKNOWN_HOST_ID`, whose group sorts last and
      reads `Unknown host`, so a section's groups always sum to its heading. The
      bucket is not a machine, so it never turns grouping on by itself.
    - **A cold agent's host has a precedence, and a cloud slice is not in it.**
      Resolved identity first; then the cloud index (`coldEpicHostIds`, from
      `chatHostIds`); then the key of the slice that reported the agent, but
      ONLY when that slice is `servedBy: "local"`; otherwise unattributed. The
      restriction is the whole point: a slice's key is the host its STREAM was
      opened against, and a cloud-served slice is that host answering for the
      whole FLEET, so host A's slice carries host B's agents verbatim and its
      key names the wrong machine confidently. A `local` slice is one host
      answering about itself.
    - **Unattributed is a state, not a `null`.** `FocusAgentRow.hostUnattributed`
      exists because `hostId === null` has two causes: a chat this window
      RESOLVED that records no host (a legacy chat on an epic we are already
      talking to - the active host is where its stop goes, and where it belongs
      on the page), versus an agent nothing could place. Only the second groups
      under `Unknown host`; guessing it onto the active machine is the defect
      that has appeared twice, once through a task-level host and once through
      a cloud slice's key. **Stop stays disabled while a row is unattributed** -
      the same rule that greys out a named host this client cannot dial, since
      a stop aimed at a machine the model could not name is worse than one it
      declines. What grouping guarantees is narrower: the unknown bucket does
      not narrow a task's ROOT INPUTS the way the per-host split narrows a task
      that spans machines, so `Stop all` there is disabled-but-complete rather
      than enabled-but-partial.
    - **Coverage moves under the host that earned it.** `coverage.activity` is
      still the worst slice's verdict for the page, and
      `coverage.degradedHosts` is the per-host breakdown behind it, each host
      with the link that is down (`focusActivityDegradedReason`: this
      client's stream lost or reconnecting, or that host's cloud link down or
      reconnecting). The page-wide banner prints one line per host naming it
      and that reason, worst first. When the
      page is grouped and EVERY degraded host has a group to carry it, the
      notice renders under those subheadings and the page-wide banner stands
      down - saying "some activity may be missing" over a page that names WHICH
      host is missing is less information in a louder place. A degraded host
      with no visible rows has no subheading, so the banner returns rather than
      dropping the warning: that host is precisely the one whose rows are
      missing BECAUSE its stream is degraded. Suppression is derived from the
      LABELLED host groups the page actually renders, not from a second reading
      of the model - `hostRowGroups` puts the notice on a subheading and
      nowhere else, so the two can only agree if they are computed from the
      same thing. Asking the model instead counted a prompt's origin host as
      visible, and a degraded host present only as an unplaced prompt then
      silenced a banner nothing had replaced: that tail has no subheading.
      `unknown` is not a warning at all
      - it is what a client that has never heard from the activity plane
        reports at startup, and a notice on every cold open would train the user
        to ignore the one that matters.
    - **The summary line stays one glance.** Each segment's TOOLTIP carries the
      per-host breakdown (`Laptop 2 · Remote Box 1`); the visible text never
      names a machine. A background-only group follows the host of the chats its
      jobs run in, and it can split across them like any other.
    - **Browsers are their own plane, and the row is a TAB.** Sessions are
      deliberately NOT a level: a task running two browsers over four pages is
      four rows, each with its own title and site, because the ask this answers
      is "even if multiple browsers are running inside some task, I should be
      able to view and directly click to go there". A tab sits under the chat
      driving it, or under its task when nothing here is - which is also the
      reason a tab needs no `via` any more: placement says it, and a tab that
      reached task level did so precisely because no row here drives it. The
      row body routes through the browser-session deep link
      (`routeNotificationForHost`, `{kind: "browserSession", epicId, sessionId,
tabId}`), which focuses the parked tile where it is already open and
      opens the task on it otherwise - the same path the bell's own browser
      hand-off takes. It is the ONE action on this page that passes an origin
      host, because a session is host-local for life and a match without it
      would accept a same-id tile on another machine.
    - **The browser plane is read, never acquired.** Home subscribes to the
      coordinator REGISTRY (`subscribeToBrowserSessionsCoordinators` +
      `browserSessionsCoordinatorEntries`) and never calls
      `acquireBrowserSessionsCoordinator`: acquiring opens a `browser.sessions`
      stream and holds it, so a page that merely LISTS browsers would open one
      per task, on every host in the fleet, the moment the tab was opened. The
      consequence is the caption - `Background shown for tasks open in this
window`, recorded in the type as `coverage.browsersAreMountedOnly` -
      and closing the last canvas that owned a coordinator takes the rows with
      it, which is the honest reading of a window-local inventory.
    - **Three states, from six on the wire.** `provisioning`, `ready`,
      `navigating` and `closing` are moments in one tab's ordinary life and
      collapse into `live`; a page flickering between them would be reporting
      the host's bookkeeping. `dormant` and `crashed` survive because they
      change what a reader does next. `live` is deliberately not `running`:
      `running` means work in flight, and a page sits there until something
      touches it. `crashed` is the only word outside `needs-you` that is
      COLOURED, because a crashed tab is otherwise silent - no prompt, no
      notification - and the status column is the only place it can be found.
      The status cell's trailing slot carries `· driven by <agent>` where a
      chat is working the page, and it stays even on a tab nested under that
      chat: placement is navigation, `driven by` is attribution, it survives a
      driver on another machine that placement cannot follow, and a column with
      a hole in it stops being scannable.
    - **A browser prompt names its tab.** A `browser.human.needed` row reads
      `Needs you in the browser · <tab title>`, joined from the browser rows
      this same model carries (`focusBrowserTabTitles`) so a prompt can never
      name a page the rows below it are not showing. Absent for a prompt whose
      task is not open here.
    - **`in` is per context part, not "the first one".** `RowContextPart`
      carries its own `preposition`, because the two rules coincided for a job
      (`in <chat> · <task>`) and came apart on the browser prompt: a tab is not
      somewhere a prompt lives, it is the page the prompt is ABOUT, while a
      task after it still is a location. The positional rule silently produced
      `in Checkout · Storefront`, which reads as a prompt inside a page inside
      nothing. The one thing a part cannot answer alone is that a `null` title
      is DROPPED, so the next location becomes the first one rendered - which
      is how a row drops the context the page has already said above it while
      keeping the part that no parent can say.
    - **Host grouping applies to browsers.** A tab is filed under its session's
      host, and a browser on a second machine turns grouping on like any other
      row.
    - **No Stop on a browser row**, and the actions track is reserved anyway so
      the status column does not move. Closing a tab is a canvas action on the
      tile itself; a cross-task page offering to close pages it cannot show
      would be destroying state the reader cannot see.

- `Providers` Per-provider CLI binary selection (Codex / Claude Code / OpenCode
  / Traycer / Cursor). Left rail picks the provider (brand icons via
  `HarnessIcon`); the
  right pane shows an enable/disable `Switch` and a radio table of CLI
  candidates - the host-bundled binary, the binary auto-detected on PATH
  (shown by its real absolute path), and any custom paths the user added
  (deletable). The radio picks the active binary; "Add custom path" reveals an
  inline input with a live `--version` probe. For Antigravity that button is
  HELD (disabled, the reason as its tooltip): its agent runs as the ACP server
  its managed pack ships with a companion, and the `agy` CLI users reach for is
  a different program. `providerSupportsCustomCliPath` mirrors the host's id
  check of the same name, which refuses the write and reads a path saved
  earlier as absent. The rail + config area fills the
  settings scroll container's height (via the shell's `fillHeight`, capped by
  `bodyClassName` max-height) so switching providers never resizes it; the
  config pane - not the outer overlay - owns the scroll, and the height follows
  the viewport so a tall provider config never overflows the modal. The header
  also shows
  host-reported account metadata when the selected provider can expose it (for
  example Codex/Claude email and subscription label). Backed by the host
  `providers.*` RPC (`providers.list` / `providers.setSelection` /
  `providers.addCustomPath` / `providers.removeCustomPath` /
  `providers.setEnabled` / `providers.detectVersion` /
  `providers.setEnvOverride` / `providers.deleteEnvOverride`) through
  `useHostQuery` / `useHostScopedMutation`. The pane carries NO host picker of
  its own: the sidebar switcher scopes it, and the panel re-provides the
  runtime client for its subtree from `useHostScope` (transient
  `useHostClientFor`) only once the scope is `ready`. The list query and the
  Refresh control sit INSIDE `HostScopeGate` rather than in the panel header,
  because the header renders outside the gate and reached the ambient host
  there. Selection + custom paths + enabled flag + per-provider env persist
  host-side in `~/.traycer/host/config/provider-overrides.json` (per-device
  == per-host). Disabling a provider marks it unavailable in the new-agent
  picker. `providers.list` is cached for 15 min
  (no auto-refetch on remount/focus) to avoid re-running `--version` probes; a
  header refresh icon (`RefreshIconButton` → `useRefreshProviders`)
  force-refreshes the list and harness availability on demand.
  - **The detail pane is tabbed, and the tab RAIL is the only thing between the
    provider header and its config.** Order is `account` · `usage` · `general` ·
    `env` · `modelProviders` · `mcp` · `plugins` · `skills`, filtered per provider through
    `supportedTabsFor` (`provider-settings-tabs.ts` - pure, so the rule is
    tested without rendering the panel).
    - **The provider header and the rail are PINNED rows; only the active tab's
      body scrolls.** `ProvidersRailLayout`'s detail column used to carry
      `overflow-y-auto p-5` around the whole of `ProviderDetail`, so the rail
      scrolled away with its content and a seven-tab pane lost its navigation
      as soon as you moved. Scroll ownership now sits on `TabsContent`
      (`min-h-0 overflow-y-auto`), with `min-h-0 flex-1 flex-col` repeated down
      every level between the panel body and it - a flex item defaults to
      `min-height: auto` and refuses to shrink below its content, which pushes
      the overflow straight back up to the column and un-pins the rows above.
      - **Pinned as a SIBLING row, not `position: sticky`.** That is what makes
        it work without a background: nothing ever passes under the rail, so it
        needs no opaque fill - which the pane's translucent `bg-card/40` could
        not have supplied without a visible band.
      - Horizontal padding lives on the column so the rail's `border-b` keeps
        exactly the width it had when the column owned the scroll; the body
        cancels it with `-mx-5 px-5` so its scrollbar lands on the pane edge
        rather than 5 units inside it.
      - `Tabs` runs `gap-0` and the rail-to-body spacing is the body's own
        `pt-4`. With the gap on `Tabs`, the scroll box started below the rail's
        rule and content vanished in mid-air above itself; owned by the body,
        the clip edge and the rule are the same line.
      - Radix mounts only the ACTIVE `TabsContent`, so there is exactly one
        scroll box and switching tabs starts it at the top.
      - Guarded by `expectPinnedRailLayout` in
        `providers-settings-panel.test.tsx` - structurally (the rail and the
        enable switch must NOT be inside the tabpanel, and no ancestor of the
        tabpanel may carry `overflow-y-auto`) plus the one class that carries
        the mechanism, since jsdom has no layout engine and cannot be asked
        whether something scrolls.
    - **Ids are wire enum members; labels are display strings, and only labels
      are ever renamed.** `supportedTabs` rides `nativeCapabilities`, which a
      released client decodes through one
      `.catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES)` over the WHOLE object - an
      id an older client cannot parse fails the enum and drops that entire
      object, silently taking MCP/Plugins/Skills with it. So `general` displays
      as **"CLI & Args"** and `usage` as **"Profiles & Limits"** while both ids
      stay put. The old "General" named nothing about its contents, which is
      what the rename fixes.
      **`usage`'s label is PER-PROVIDER** (`providerTabLabel`): that tab holds
      managed profiles and usage limits, but managed profiles exist for
      `claude-code`, `codex`, `grok` and `antigravity` only — so on the other providers the fixed
      label promised a section that is not there. Elsewhere it reads
      **"Usage limits"**, which is the panel's own words for what remains (the
      section inside is headed exactly that). The ID never varies; this is
      presentation.
      The predicate is a deliberate MIRROR of the host's
      `providerSupportsManagedProfiles`, which is itself an id check — there is
      no capability on the wire to read instead, because the host answers this
      before it builds one. `profiles` cannot stand in for it: for an
      unsupported provider it is empty BY RULE
      (`resolveProfileWireEntries` returns `[]` without consulting the
      registry), and an unseeded `claude-code` is empty too, so a label keyed on
      the count would name the wrong tab and then change under the user. Adding
      a profile-capable provider means updating both sides; the cost of missing
      it is a tab that under-promises for a round.
    - **`account` is CLIENT-ONLY and deliberately not in the wire enum.** It is
      derived from `state.apiKey.supported` alone. The API key and the
      profile/limits surfaces answer different questions ("how does this
      provider authenticate?" vs "which account is running, and how much of it
      is left?"), and a provider can have either without the other - amp takes
      a key but advertises no `usage` tab at all, claude-code has profiles and
      limits but no key field - so one shared tab always showed a hole for
      whichever half a provider lacked. Nothing about "does this take a key?"
      needs the host to say so, and adding an id to the enum would risk the
      whole-object `.catch` above for zero gain.
    - **The visible set is the host's advertisement, PLUS client-derived
      `account`.** There is no per-provider subtraction left. `general` used to
      be dropped for cursor and amp by a `hidesCliCandidates` id check, on the
      premise that an SDK-driven provider has no CLI binary a user could pick.
      Both of them spawn the Traycer-resolved binary for their MCP write verbs
      (`runAmpCliCapture`, `runCursorMcpCli`), so that table was the only
      control over the binary those verbs use - and hiding it turned "no `amp`
      on PATH" into an MCP tab with Add/Delete/auth silently gone and no way to
      supply a path. The emptiness worry it encoded is answered upstream
      instead: the host's `baseBinaryName` is an exhaustive switch, and the
      candidates section renders a real "not found, here's how to install it"
      empty state rather than a bare table. `usage` is taken at the host's word:
      the contract
      registry already gates it on being able to POPULATE it (managed profiles,
      the Traycer subscription card, or rate limits - see
      `providerCanPopulateUsageTab`), so re-deriving that here would just be a
      second copy of the same rule.
    - **`variant="line"` (underline), not the filled default.** Seven unrelated
      panes is navigation; a filled track reads as a segmented control, which
      is for re-presenting one dataset and tops out around four options. The
      list keeps `w-full` for the `border-b` RAIL but the track itself is
      transparent, so the old "filled slab with dead space after the last tab"
      (`w-full` cancelling the primitive's `w-fit` while triggers stayed
      content-width) cannot recur. The nested Tools/Instructions tabs inside
      the MCP tab deliberately stay on the FILLED variant so the two nesting
      levels read as different tiers.
    - **No per-tab content dots.** The former `tabHasContent` dot could not
      tell the truth: `general` lit for every CLI-backed provider including the
      ones whose tab was empty, `usage` lit unconditionally for every
      rate-limit-capable provider, and mcp/plugins/skills were hardcoded to
      never light - so the three tabs that actually hold user-installed content
      were the three that looked empty. It also used `bg-primary` ("needs
      attention") for what was at most "is configured", reusing the same dot
      the provider rail spends on "disabled". A future signal must split those
      meanings: a muted count on the list tabs, a warning tone reserved for
      real attention.
  - **The Fallback cross-link sits at the foot of `usage`** (Profiles & Limits),
    which is where someone lands when a provider has stopped working for them
    and is therefore where "can it just carry on somewhere else?" gets asked.
    It is a POINTER, not a control: it reads no policy and prints no state, so
    the master toggle keeps exactly one readout and the two cannot disagree
    mid-save. Ungated - fallback answers a signed-out account and a billing
    failure as well as a limit, so it is relevant for every provider, not only
    the ones that report usage - and rendered outside the profile-switch inert
    block, since it is not profile-scoped. It navigates with
    `navigateToSettingsSection`, never a router `Link`; the Fallback panel's
    profile-step hint is the same crossing in the other direction.
  - **Provider environment variables.** Each provider detail pane (last, below
    the CLI picker and terminal-agent args) has an _Environment variables_ card
    holding the per-provider env applied when the host spawns that harness
    (`getProviderSpawnEnv` layers it over the host-process env). Rows set a
    value, explicitly unset a variable inherited from the user's shell, rename a
    key, or delete the override. New variables are staged behind an _Add
    environment variable_ button and applied only from the row check button.
    Backed by the per-host `providers.*` RPC
    (`providers.setEnvOverride` / `providers.deleteEnvOverride`, with the list
    carried in `providers.list`'s `envOverrides`), persisted host-side in
    `provider-overrides.json` so it follows the host picker. Rendered with the
    shared `EnvOverrideEditor` component (also used by Settings → Shell).
  - **Terminal interface CLI arguments.** A `TerminalAgentArgsSection` text input (saved
    on blur/Enter) captures extra CLI args spliced into the spawned argv when the
    provider is launched as a terminal agent. The field re-syncs to the saved
    value if it changes underneath (refetch / another window) and stays editable
    while a save is in flight (writes are serialized host-side). Shown only for
    terminal-agent-capable providers - it checks `useGuiHarnessesQuery` for the
    mapped harness (`HARNESS_ICON_ID`) advertising the `tui` `mode`, so GUI-only
    providers do not show it. Persisted as `terminalAgentArgs` in
    `provider-overrides.json` via `providers.setTerminalAgentArgs`
    (`useProvidersSetTerminalAgentArgs`, invalidates only `providers.list`). In
    `agent.tui.prepareLaunch` the host tokenizes the string and each harness
    adapter splices it where its CLI parses it as top-level flags (appended for
    Claude/OpenCode, but BEFORE Codex's `resume` subcommand). The launch picker
    pre-fills this value as a cosmetic default; an untouched pre-fill launches
    with `null` so the host resolves the current saved value itself.
  - **Who reviews &lt;provider&gt;'s commands**
    (`provider-auto-judge-section.tsx`), on the provider's own **Permissions**
    tab (icon `ShieldCheck`, since the Account tab already uses `KeyRound`,
    which is also the sidebar's Permissions icon). The tab is client-derived
    like `account` (`provider-settings-tabs.ts`: never on the wire enum), sits
    right after Env, and is drawn for EVERY provider once the selected host's
    negotiated `agent.gui.listHarnesses` line can spell `auto`
    (`catalogLineKnowsAutoMode`). A host that predates auto mode has no judge
    to name, so it shows no tab.
    Two earlier gates were retired here: `autoJudge.get`, which names the
    HOST-WIDE judge rather than this tab's per-provider classifier, and the
    catalog's mode UNION, which an unconstrained row contributes nothing to. After Env
    rather than after CLI & Args so it cannot become a provider's default tab:
    amp and cursor advertise `env` without `general`, and a tab every provider
    gets must not displace the one the provider asked for.
    The body is one card: the heading "Who reviews {provider}'s commands"
    with Auto mode's muted xs **Experimental** badge, then
    `ProviderJudgeSwitch` (`panels/permissions/provider-judge-switch.tsx`),
    then an "All permission settings" link to Permissions ▸ Judge. The link
    passes `hostId: null` because Settings is already scoped to the machine
    this tab shows. **This tab is the switch's only home.** Permissions ▸
    Judge used to mirror it in a "Providers with a built-in reviewer" card,
    so one setting had two places to change it; that card is gone, and the
    Judge tab keeps only a pointer line that links here (see Permissions ▸
    Judge). Only the switch is per provider. Which model Traycer's judge
    runs on, and the rules it follows, belong to one machine and one account,
    so they live on the Permissions page and this card only links there.
    Labelled by provider because THIS is the choice that wins
    (`isProviderJudgedExecution` reads the provider's own `autoJudge` alone);
    the provider name is interpolated, which renders "Who reviews Claude
    Code's commands" today and does not lie if a second provider ever reports
    `nativeAutoJudge`. The switch also carries what choosing the classifier
    costs, since no other surface says it any more (see the `Select` rendering
    below).
    Settings search reaches this tab through the Providers page's own
    keywords ("classifier", "who reviews commands", "built-in reviewer", "own
    classifier"), and lands at the top of that page like every per-provider
    concept, because the per-provider tabs exist only once a host answers.
    The Judge tab's pointer line is the direct route to one provider's tab.
    The switch has four renderings, each a line of its own:
    - A provider whose `useGuiHarnessesQuery` row does not report
      `nativeAutoJudge` gets "Reviewed by Traycer's judge. Change it under
      Permissions." A switch with one option is not a switch. **Claude Code is
      the only provider that reports it**, so it is the only switch drawn. The
      flag also stands in for a method gate, because it rides the same catalog
      minor as the setter.
    - `providers.list` older than the line that reports `autoJudge` gets the
      unreadable line. Such a host answers `"traycer"` for every provider
      whatever is stored, and printing that would state a guess as the
      current setting.
    - A host that answers the catalog but not `providers.setAutoJudge`
      (registered `degrade: unsupported`) gets "{current}. This machine's host
      can't change it; update it to choose." This avoids a live-looking
      selector whose every write fails.
    - Otherwise, a two-option `Select`: Traycer's judge, or this provider's
      classifier. It is written through `providers.setAutoJudge` and persisted
      as `autoJudge` in `provider-overrides.json`, beside `terminalAgentArgs`,
      so it takes that neighbour's scoping and invalidation (`providers.list`
      only; a judge choice cannot change availability).
      Under it, whatever is selected, one line says what the classifier costs:
      "Faster and free, but your rules don't apply to it, and it replaces
      Traycer's judge for this provider's conversations." Only this rendering
      has it, and only a `nativeAutoJudge` provider reaches this rendering.
      Nothing renders until the catalog and the setter's handshake have
      answered, so a read-only line never flashes at a provider about to get the
      switch. Drawing the switch is not the same as the provider judging: the
      host's own store answers `traycer` for a provider nobody has switched, and
      `resolveAutoJudgeForTurn` resolves anything that is not exactly `provider`
      to Traycer's judge.
      The stored value is read back through `ProviderCliState.autoJudge`, which is
      `.optional()` on the wire rather than defaulted (a host that predates auto
      mode omits the key, and absent must stay distinguishable at the protocol
      boundary), so `providerAutoJudgeFor`
      (`lib/providers/provider-auto-judge.ts`) is the one place that spells the
      `?? "traycer"` fallback - "never chosen" and "host too old to say" landing
      on Traycer's judge alike, the same direction every failure mode in the
      host's own reader takes.
      The switch holds a local echo of a fresh pick, so the control does not
      snap back for the width of the `providers.list` round-trip (nor
      permanently, on a host that never reports the field). The echo expires by
      derivation, never by an effect: as soon as the stored value moves, or the
      authoritative read completes a fetch, the host wins, which is what lets
      another window's edit through. The Select is disabled through that
      refresh, not just the write: a second pick while the first write's read
      is in flight would let that read retire the second echo and present the
      superseded choice as current. This is a two-value switch whose value is
      moving. The Judge tab's model controls hold no echo and never lock.
  - **API-key providers (Cursor).** Cursor authenticates with an API key rather
    than a CLI login, so it renders an `ApiKeySection` (masked input +
    Save/Clear) when `state.apiKey.supported` — **as the whole body of the
    client-derived `account` ("Account") tab**. It used to sit ABOVE the tab bar
    as its own pre-tab region, which put a provider's only real setting outside
    the tabs that were supposed to hold its settings (and hid the fact that
    Cursor's General tab rendered nothing). Nothing renders between the provider
    header and the tab rail now. Also a "Create an API key" link
    that opens the provider dashboard via `openLink(url, "docs")`
    (`API_KEY_DASHBOARD_URL`). The key is stored AES-256-GCM encrypted in
    `provider-overrides.json` and never returned over RPC - `state.apiKey` only
    reports `configured` + `source` (`stored` | `env`). When unset, the host
    falls back to `CURSOR_API_KEY` from the user's login shell. Cursor's account
    line is probed from that API key with `@cursor/sdk`'s
    `Cursor.me({ apiKey })` for the user email. The token and key-identifying
    metadata are never returned over RPC. Traycer does not run
    `cursor-agent about` for provider auth because GUI chats use `@cursor/sdk`,
    not the CLI login session. Backed by `providers.setApiKey` /
    `providers.clearApiKey` (`useProvidersSetApiKey` /
    `useProvidersClearApiKey`). Cursor is GUI-only, so its row hides the CLI
    candidates table and shows only the API-key section; the key drives the
    `@cursor/sdk` GUI chat surface.
  - **Traycer subscription + credits.** The Traycer provider detail leads with a
    `TraycerSubscriptionSection` card (always visible, not gated by the
    enable/disable toggle since it is account- not binary-level) showing the
    signed-in user's **Credit breakdown**: a consumed/total bar per bucket -
    **Plan**, **Bonus**, **Bundle** - matching the VS Code
    extension's wording (`getCreditBreakdown`; "Bundle" is what older copy called
    pay-as-you-go). There is no tier badge and no Trial badge (feedback: "badge
    is not needed, just show plan, bonus and credits"); the tier chip lives on
    the header popover's account cards instead. Each bar is shown only when that
    bucket's total > 0; amounts
    are `$`-denominated. Credit-based vs rate-limit-based is decided exactly like
    the extension (`isCreditBasedPricing` - V3 plans are credit-based); **legacy /
    v2 (usage-limit) plans** instead render a **Usage limit** section with the
    recharge rate ("New artifact every N minutes", from `rechargeRateSeconds`)
    plus the Bundle bar. The extension's live "Artifact Used" bar is omitted -
    `totalTokens`/`remainingTokens` come from the inference `GetRateLimitUsage`
    gRPC, which the gui-app/daemon stack doesn't expose. Also a "Manage
    subscription" link (opens the Billing page of the selected account via
    `resolvePlatformBillingUrl` - `/team/<slug>/billing` for a team,
    `/billing` otherwise - the same page `user-menu.tsx` opens), and a
    refresh icon. A global account-context selector
    (Personal / each Team, shown only when the user has `teamSubscriptions`)
    chooses which subscription is displayed - the selection persists in the
    `account-context-store` (localStorage), defaulting to Personal when nothing
    is stored or the persisted team is gone. Credits come from `useAuthUser`
    (TanStack Query against `AuthService.fetchAuthenticatedUser` →
    `/api/v3/user`, `refetchOnWindowFocus`); they live only in the query cache,
    never the auth store.
    - **Mobile-app variant (`isMobileApp()`).** App Store review guideline
      3.1.1 forbids an app from presenting or linking to a subscription that
      cannot be bought through Apple, and Traycer's is bought on the web - so
      the INSTALLED mobile app renders this card as a usage readout with
      nothing to buy. The heading is **Usage**, the "Manage subscription" link
      is gone (Refresh stays, labelled "Refresh usage"), and the card's own
      state lines say "usage" rather than "subscription". The account picker,
      the Plan/Bonus/Bundle bars and the legacy rate-limit view are all
      unchanged except for denomination: `creditMeterDetail`
      (`traycer-subscription-views.tsx`) drops the `$` there and states the
      same reading as `C / T credits` (no spelled-out percent - the bar
      directly below is already the ratio). Artifact rows are untouched -
      they were never money. The branch is the BUILD flag, never the viewport
      hook: a narrow desktop window is still a desktop and keeps its billing.
      The shared body is what the header popover's Traycer tab renders too, so
      the phone's popover gets the currency-free amounts for free; that
      popover's own plan-tier chip is hidden on the same flag
      (`rate-limit-popover.tsx`).
  - **Traycer OpenCode binary selection.** Traycer's built-in harness runs
    through OpenCode, so its row renders the same available OpenCode CLI paths
    and lets users choose the binary for Traycer separately from the standalone
    OpenCode provider. The table shows Traycer's own candidate list, falling
    back to OpenCode's displayed candidates when Traycer's is empty, while
    `providers.setSelection` / `providers.addCustomPath` /
    `providers.removeCustomPath` still target `providerId: "traycer"`.
    Traycer has no API key field. The enable toggle remains a real gate:
    disabling it hides the Traycer harness from the new-agent picker and blocks
    runs like any other provider.
  - **MCP scope is ONE picker that always names its destination**
    (`provider-mcp-scope-picker.tsx`, `McpScopePicker` - a Popover + cmdk list
    reached from `McpScopeHeader`). It replaced a `[Global | Project]` chip
    pair plus a separate folder `<Select>` that appeared only in Project.
    - **Why the split was wrong.** Global named nothing, so "where does this
      server go?" had no on-screen answer while a shadow project read ran
      against a folder the user could not see. Project silently adopted the
      single resolved folder (`hostPaths.length === 1`) and rendered it as
      STATIC TEXT, so the most common case never looked like a choice. And both
      labelled folders by basename only, which cannot distinguish two worktrees
      of one repo.
    - **Rows.** `Global` ("Every workspace on this host") sits above one row
      per target. Targets come from `useMcpScope`: the resolved workspace
      folders, PLUS every worktree the host reports for them
      (`useWorktreeListByWorkspacePathsForClient`), deduped by path since a repo
      open under two folders reports the same worktree set twice. Each row
      carries name + a `worktree` badge + branch + the full path, because the
      branch is what actually separates sibling worktrees. Selecting a row
      picks the folder AND the scope - they were never two decisions.
      `selectedByHostId` (`providers-workspace-selection-store.ts`) is validated
      against every offered target, not just the open workspaces, so a stored
      worktree selection survives a reload.
    - **The trigger is ONE line at `h-7`, matching `Button size="sm"`.** It
      shares a toolbar row with "Add MCP server", and a two-line control beside
      a one-line button reads as a layout mistake rather than as emphasis. The
      second line's content did not disappear: the subtitle (Global's promise,
      or the selected worktree's branch) rides inline as muted text, and the
      full absolute path - the part that disambiguates two worktrees - moved to
      the trigger's tooltip while staying on every row of the open list.
    - **An empty list is a state you can act on, not a dead end.** Targets are
      derived from the folders THIS client has opened
      (`useWorkspaceFoldersStore` → `useResolvedWorkspaceFolders`), which is
      legitimately empty on a fresh install or a host whose work happens
      elsewhere - and then the picker offered Global and nothing else, with no
      way to reach a project config at all. The list now says
      "No workspaces added on this host yet." and carries an **Add a workspace
      folder…** row driving the same `pickAndPrepareFolders` the Home workspace
      selector uses, bound to the SETTINGS-selected client so a folder picked
      while viewing host B is prepared on B. The added folder becomes the
      selection; a cancelled pick changes nothing.
    - **The selection is keyed by the BOUND host, not the active one.**
      `useMcpScope` reads `client.getActiveHostId()` and only subscribes to
      `useAddressableHostId()` for the re-render. Settings can target a
      non-active host through the transient `HostRuntimeContext` override, and
      keying by the active host filed a B-picked path under A - where it could
      never validate against the list it was picked from.
    - **The single-workspace default is kept but no longer invisible** - it
      renders as a selected control that can be changed, rather than a
      sentence. With more than one candidate there is still no auto-pick.
    - A provider advertising only one `list` scope gets a plain "Applies to
      every workspace on this host." line instead of a picker holding one dead
      option; the wording matches the Global row so the two never disagree.
      Plugins and Skills remain hardcoded global-scope and get no picker.
    - The OAuth resume key is `{providerId, scope, workspaceRoot, hostId}`
      (`useResumeOauthPolling`) - any change to how `workspaceRoot` is derived
      has to keep that tuple stable across navigation.
  - **A row shows the provider's OWN artwork or NOTHING**
    (`ProviderEntryIcon`). There is no fallback glyph anywhere:
    - Skill rows never had a source for one - a skill is a markdown directory
      and no provider's format carries artwork for it. They are distinguished
      by their source badge.
    - Plugin rows without artwork show nothing either. An earlier version drew
      a derived monogram (initials over a hashed tone); it asserted a visual
      identity the plugin never declared, and beside real vendor logos it read
      as a rendering fault rather than as "this one has no icon". Only Codex
      ships plugin artwork, so that fallback was the COMMON case, not the rare
      one. `provider-entry-monogram.ts` was deleted outright.

    A hand-written id-to-icon table remains refused - it would be wrong the
    first time anyone installs something unknown, the same reason this repo
    refuses static model catalogs.

    **Alignment is a list-level decision.** `reserveIconSpace` is true when ANY
    row in the list has artwork, and every row then holds the same footprint -
    empty where there is no icon - so the names keep one left edge. A provider
    that ships no plugin icons at all gets no column at all rather than a
    permanently blank one.

  - **Codex plugin metadata comes from `<version>/.codex-plugin/plugin.json`.**
    The host listing used to be synthesized from DIRECTORY NAMES alone (three
    `readdir` calls, no file opened), so rows read `pdf` and
    `pdf@openai-primary-runtime` where Codex's own UI reads "PDF" / "Read,
    create, and verify PDF files". All of it was in that manifest's `interface`
    block, unread. `listCodexPluginsFromHome` now reads it and fills
    `displayName`, `description`, and `hasIcon`. Three traps live here:
    - **The manifest is untrusted** - a plugin is an arbitrary user-installed
      directory, so `interface.composerIcon` may legally be
      `"../../../../etc/passwd.png"`. Asset paths are containment-checked with
      `path.relative` (not a `startsWith` prefix test, which would accept a
      sibling like `/plugins/foobar` under `/plugins/foo`) and restricted to an
      image extension allow-list. No MIME sniffing: the value ends up in a
      `data:` URI handed to `<img>`.
    - **The cache is not an installed-set, and a SYMLINK is the tell.** An
      installed plugin has a real versioned directory (`sites/0.1.33`); a
      merely-staged one has a bare `latest` symlink into the marketplace tree,
      which is what `openai-bundled/chrome/latest` is - and `codex plugin list`
      calls chrome "not installed". Following the symlink looks like an
      obvious improvement and is wrong: it surfaces a plugin the user does not
      have, with a name and artwork read out of staging. Plugins with no real
      version directory are skipped entirely (`isInstalledVersionDir`).
      Cross-checked against the CLI: excluding them yields 12 rows, matching
      the CLI's 9 installed plus the 3 remote-installed `openai-curated-remote`
      plugins it does not account for.
    - **Version choice is load-bearing now.** It used to be
      `versionDirs[versionDirs.length - 1]` - readdir order, under which
      `0.1.9` outranks `0.1.10`. That was cosmetic while only the version
      string came off it; the chosen directory is now also where the manifest
      and the artwork are read from.
  - **Icons travel on their own RPC arm, never on the plugin list.**
    `nativeListQuerySchema` gains a `pluginIcon` arm (modelled on
    `mcpDiscover`, the existing per-item detail query) returning a `data:` URI.
    Three constraints force that shape:
    - **A path or `file://` URL cannot work.** Desktop CSP is
      `img-src 'self' data: blob: https:` - no `file:` - the `app://` handler
      is sealed to the renderer bundle, and a host-local path renders nothing
      against a REMOTE host, which is a shipped paid mode. Bytes over the
      existing websocket behave identically local and remote.
    - **They cannot ride the list.** Icons are ~900 KB (~1.2 MB base64) for a
      typical Codex install - one 1024x1024 PNG is 451 KB - and
      `useProvidersPluginsList` runs `staleTime: 30_000`.
    - **`poll: false` on the icon query is load-bearing.** `providers.list` is
      condition-polled and condition queries join the table-owned poll BY
      DEFAULT; `refetchInterval` also fires regardless of `staleTime`, so the
      hook's `staleTime: Infinity` would not save it. Omitting `poll: false`
      puts every icon on a refetch timer.

    **Theme-aware artwork rides the same arm.** The request carries a `theme`,
    and two rules keep it honest:
    - **The pair must be coherent.** There is no `composerIconDark` in the
      format - only `logoDark`, whose light counterpart is `logo`. So a plugin
      declaring `logoDark` uses the `logo` / `logoDark` pair; everything else
      uses `composerIcon` for both themes, exactly as Codex renders it.
      Pairing `composerIcon` with `logoDark` would swap between two different
      assets on a flip: github declares an 853 B `github-small.svg` against a
      9.4 KB `github-dark.png`.
    - **`hasDarkIcon` gates whether the request varies by theme at all.** Only
      3 of 13 plugins ship a dark asset. The renderer pins the rest to
      `light`, so their query key is theme-independent; without that, a theme
      flip would miss the cache on every row and re-fetch the whole ~900 KB
      set to receive byte-identical images. A `dark` request for a plugin with
      no dark asset still answers with the light one rather than "no icon".

    The list's `hasIcon` flag is what keeps rows without artwork from each
    burning a round trip, so it is resolved host-side at LIST time (including
    a `stat`, so a declared-but-absent file reports `false` rather than
    promising an icon the fetch cannot deliver). The icon request addresses a
    plugin BY ID and the host re-walks to resolve the file - the renderer never
    hands the host a filesystem path, the same discipline as
    `assertRemovableSkill`. `readPluginIcon` is optional on
    `ProviderNativeBehavior`: only Codex's plugin format carries artwork, and a
    required method would mean seventeen stubs asserting nothing. Absent, or
    resolving to a null `dataUri`, both mean "render no tile".

  - **`enabled` comes from `codex plugin list --json`, with a known gap.**
    Enabled/disabled is Codex state, not a filesystem fact, so the directory
    walk could only hardcode `true`. The CLI read is injected
    (`CodexPluginEnabledLookup`) rather than called directly - the real binary
    is installed on a typical dev machine, so an un-injected test would
    exercise the live CLI locally and an empty result in CI, passing for two
    different reasons. It is enrichment, never a gate: the call is
    `.catch`-guarded at the CALL SITE (not merely inside the default lookup, or
    the invariant would hold by accident), on a 5 s budget versus the 60 s
    install budget, so a missing or slow CLI degrades to the default instead of
    emptying the tab.

    THE GAP: the id namespaces do not fully align. Ours is
    `<name>@<cache-dir>`, the CLI's is `<name>@<marketplace>`. They coincide for
    `openai-primary-runtime`, `openai-bundled` and `pr-completion`, but the
    cache directory `openai-curated-remote` has no CLI counterpart - the CLI
    lists those under `openai-curated` and calls them "not installed" even
    though they are installed through the remote-install path. So github /
    slack / openai-templates miss the map and keep `enabled: true`. They must
    NOT be matched by name alone: `github@openai-curated` is a catalog entry
    whose `enabled` says nothing about the installed copy.

  - **A skill row opens its full `SKILL.md`**
    (`ProviderSkillDetailDialog`). The row can only ever show frontmatter
    (name + description) - the instructions the agent actually follows live in
    the file body, which was unreadable from the app. The dialog mirrors the
    plan card's expand (`plan-segment.tsx`): the same three-row shape and a
    scrollable `TraycerMarkdown` body, so both "show me the whole document"
    surfaces behave alike.
    - Content is read on open via `workspace.readFile`, passing `skill.path`
      as the containment root and `SKILL.md` as the file, rather than carried
      on the list response: adding a body field would put every skill's full
      text on every `providers.skills.list`, paid on each poll, for something
      read only when opened.
    - **HOST DEPENDENCY:** that resolver treats `workspacePath` as the
      containment root and does NOT require it to be a bound workspace, which is
      the only reason a skill directory under `~/.agents/skills` can be read at
      all. Hardening it to accept known roots only would break this surface;
      `SKILL.md` would then need its own read verb.
    - `stripSkillFrontmatter` removes the leading `---` block before rendering
      (the header already shows those two fields, and a renderer with no
      frontmatter plugin prints them as a `<hr>`-delimited paragraph). It is
      deliberately narrow - only a block at byte 0 with a closing fence - so a
      body that legitimately opens with a horizontal rule keeps its first
      section.
    - The dialog is mounted only while a skill is open, so the Skills tab does
      not hold a disabled host query (and its QueryClient dependency) on every
      render.
    - **Remove lives in the dialog footer, behind TWO conditions**
      (`skillRemovability`). `actionScopes.remove` advertising a scope says the
      provider supports the verb; `skill.source` says whether this skill's files
      are ours to delete. The host's `assertRemovableSkill` accepts only
      `shared` / `provider` sources (and re-checks realpath containment in a
      writable root) and throws otherwise, so a `plugin` or `managed` skill
      under a remove-capable provider satisfies the first and fails the second.
      The client mirrors that rule ONLY to avoid offering a button guaranteed to
      fail - the host stays the enforcement, and a divergence surfaces as its
      error text rather than a silent deletion.
      - Three outcomes, not two: `hidden` (no remove scope advertised - a
        "can't remove" note on every row would be noise), `blocked` (supported,
        but not for this skill - worth a line, since the missing button would
        otherwise look broken beside removable siblings), `removable`.
      - Confirmed through `ConfirmDestructiveDialog`, stacked over the open
        skill dialog. The confirmation names the **path**: removal deletes a
        directory, and which of the four skill roots it sits in is what the name
        alone cannot say.
      - Removal has its own handler rather than reusing `runMutation`, because
        its outcomes land elsewhere: success closes BOTH dialogs (the open skill
        no longer exists, and its `readFile` would point at a deleted path) and
        must not touch the create/import draft fields; failure closes only the
        confirmation and renders inside the skill dialog, since the tab's own
        error banner sits behind it and would be invisible.
  - **Model Providers is the visual layer of `opencode auth login`**
    (`provider-model-providers-tab.tsx` +
    `provider-model-provider-connect-dialog.tsx`): the UPSTREAM LLM credentials
    a provider calls with, not a Traycer account and not a CLI binary. Backed by
    four dedicated RPCs on the optional-capability channel
    (`providers.listModelProviders` / `modelProviderAuth` /
    `awaitModelProviderAuth` / `cancelModelProviderAuth`) through
    `useHostQuery` / `useHostMutation`, with keys in
    `lib/query-keys/model-providers-query-keys.ts`.
    - **The tab exists only when the host says so.** It rides `supportedTabs`
      like every other wire tab, and only the `opencode` module advertises it -
      so an old host, an old CLI below the version gate, or any other provider
      simply has no tab. There is no client-side derivation that could disagree.
      It sits after `env` and before `mcp` in `PROVIDER_TAB_ORDER`: it is
      configuration (what this provider can reach) rather than an inventory of
      what is installed into it, and that position cannot move any provider's
      DEFAULT tab, since every provider advertising it also advertises the tabs
      ahead of it.
    - **NO scope picker**, unlike MCP. OpenCode's upstream auth is per-user;
      there are no project-scoped credentials for a `global`/`project` control
      to choose between. The sidebar host picker still scopes the tab.
    - **ONE list, connected first** (`sortModelProviderEntries`), not a
      "Connected" section above a searchable catalog. Search has to be able to
      find a connected provider, and the two-section shape is precisely the one
      where it cannot. ~180 rows flowing in the panel's own scroll (no internal
      height cap - an inner `overflow-y-auto` nested a second scrollbar inside
      the panel's); deliberately NOT virtualized
      (single-line rows, no per-row queries - and a virtualizer renders an empty
      viewport under jsdom's zero-height layout, which would put this list's
      behavior beyond test).
      - **One filter beside the search box**
        (`model-provider-filter.ts` + `model-provider-list-controls.tsx`):
        **All / Browser sign-in**, in the same `ListFilter` menu shape the
        provider rail uses (`provider-rail-controls.tsx`), down to the dot that
        marks an active filter and the trigger's accessible name carrying the
        current value. Per-row method badges were the other option and would
        have lit "API key" on ~170 of ~180 rows to say nothing — the failure the
        removed per-tab content dots had. The interesting answer is the rare
        one, so it lives one click away instead.
        There is deliberately **no "API key" option**, and it is the same
        argument one step further: the host synthesizes an `api` method for
        every provider whose `/provider/auth` advertises nothing, so that bucket
        measured **178 of ~180 rows** against a real host. A control that costs a
        click and returns the list you were already looking at is a dead option
        wearing a choice's clothes; "All" is the honest name for that set, and
        the two rows it would have excluded are exactly the ones **Browser
        sign-in** already isolates. The remaining bucket reads off `methods[]`,
        and an EMPTY method list means the host offered nothing at all.
        Filtering runs BEFORE the fuzzy search, so a query cannot quietly
        re-widen the bucket the user picked.
    - **`source` is badged only for a CONNECTED provider, and disconnect is
      gated on `canDisconnect` ALONE.** The host reports `source` as null unless
      connected, so a badge anywhere else would claim a credential origin the
      row does not have. `hasStoredCredential` answers a different question
      ("does Traycer hold a credential?") than `canDisconnect` ("may it be
      removed from here?"); a later host may answer them differently, and
      reading either for the other is how a button appears that the host will
      refuse. The host answers `source ∈ {api, custom, config}`. `api` and
      `custom` are auth-store removals (`api` for a key written through
      `auth.set`, `custom` for a provider whose loader is fed by that same
      store — `xai` signs in through OAuth and reports `custom`). **`config` is
      disconnectable too, and it is a CONFIG WRITE**: a config row has nothing
      for `auth.remove` to take, so the host suppresses it through
      `disabled_providers` — the same mechanism a declared custom uses, and for
      the same reason. That is true whether or not the row is a declared
      custom; an earlier version of this doc said config rows were read-only
      unless declared, which stopped being true when the host closed the
      key-only-config hole. **`env` stays read-only**: it is not ours to remove
      and no file write can suppress it. The control is a **text button reading "Disconnect"** —
      upstream's own word — with hover-only destructive tone (the pattern
      `provider-cli-candidates-section` and `env-override-editor` already use:
      quiet among neutral rows, red under the pointer). It was an unplug ICON
      with a tooltip until the user's manual pass, and it was the one control on
      the surface they could not read: a glyph in a row of quiet text names
      neither what it removes nor that it is the destructive one. The confirm
      dialog carries the nuance the tooltip used to — for an ordinary row it
      removes the stored key and the row may come back CONNECTED from an env var
      or config block underneath, so it promises removal and nothing more.
    - **A connected row shows ONE action.** Connected and disconnectable ⇒
      "Disconnect" alone, which is upstream's shape; replacing a stored key is
      disconnect-then-connect there too. The single exception is a connected row
      the host will NOT disconnect (an `env`-sourced one): it keeps "Connect",
      because parity's one-action rule would otherwise leave it with no action
      at all — a dead end that neither explains itself nor lets the user put a
      credential in place for when the variable is gone.
    - **Badges use upstream's vocabulary**: `env` → **Environment**, `api` →
      **API key**, `custom` → **Custom**, and `config` → **Config** or
      **Custom** depending on the entry's `configDeclaredCustom` flag. That flag
      is the host's copy of upstream's `T(id)` predicate (a `provider[id]` block
      whose `npm` is `@ai-sdk/openai-compatible` with a non-empty model map) and
      it is not recoverable from `source`, which lumps "the user declared this
      endpoint" together with "a config file supplies this key". The badge is
      now the row's ONLY origin marker; the trailing "Set by environment" /
      "Set in config file" line is gone, because a badge reading "Environment"
      beside a label reading "Set by environment" spent the row's last words
      saying one thing twice. The provenance sentence survives in the badge's
      tooltip, which is where a sentence belongs.
    - **The list is FLAT.** One `<ul>` with hairline separators, not a bordered
      card per provider: at ~180 rows a border around each turns the surface
      into a wall of boxes with the provider names as the smallest thing in it.
      The user's words were "boxy design is kinda bad, too many items", and the
      per-row status dot for a DISCONNECTED provider went in the same pass — an
      absent dot says the same thing as a muted one.
    - **`source` is a STATUS, not a permission.** An `env` / `config` / `custom`
      row shows where its current credential comes from and still offers Connect.
      An earlier pass blocked the write affordance on those rows, reasoning that
      OpenCode resolves env before its own auth store so a key saved here would
      be shadowed and the click would appear to work while changing nothing.
      The precedence is real — observed live, an account holding a stored
      `openai` OAuth credential still reports `source: "env"` while
      `OPENAI_API_KEY` is exported — but blocking was the wrong response to it.
      Setting a provider up and choosing which credential wins are different
      decisions: a user may want the OAuth sign-in in place for when the
      variable is not exported, or intend to unset it afterwards. OpenCode's own
      app configures any provider regardless of its current source, and ours
      refusing to was a restriction we invented. The connect dialog now leads
      with a warning naming what outranks it (`credentialPrecedenceNotice`,
      naming the actual variable) instead.
      `custom` gets its own wording rather than sharing the config-file line:
      that loader is frequently fed by the auth store — `xai` signs in through
      OAuth and still reports `custom` — so pointing at a file would send the
      user where the credential is not.
    - **Rows carry the provider's BRAND MARK**, from `@lobehub/icons` via a
      hand-owned `models.dev id → component` map
      (`home/pickers/model-provider-icons.tsx`, beside the harness map that uses
      the same package). Monochrome variants, so rows tint with the surrounding
      text; sizing follows the row (`size-4`).
      **Coverage is the popular head, and the tail falls back on purpose.** The
      fallback is **sparkles** — the mark users already read as "provider with
      no logo" in OpenCode, so the visual language carries over. What does NOT
      carry over is the reason it is broken there: upstream fetches
      `models.dev/logos/{id}.svg` at build time, that endpoint answers 200 for
      any id with a generic sparkles body, and the result is that 14 of their 98
      sprite entries are the fallback wearing a named provider's identity — and
      the fallback happens to be Synthetic's real logo, so an unknown provider
      renders as that company. A user-declared custom provider gets the same
      neutral mark, for the same reason: it has no brand, and borrowing one puts
      a real company's logo on someone's private gateway.
      **A DECLARED row never gets a brand mark, whatever its id.** The host's
      `isConfigDeclaredCustom` judges a block by its `npm` and model map, never
      its key, so a hand-written `provider.openai` block pointing at a private
      endpoint is a legal custom declaration under a mapped id — and painting
      OpenAI's logo on it is the same impersonation the neutral fallback exists
      to prevent, arriving through the one door the id cannot close. The mark
      takes `configDeclaredCustom` alongside the id for exactly that case.
      On the drift bug, precisely: a key MISSING from the map falls back (that
      is correct, and the expected fate of most of the catalog), while a
      reference to a component that does not exist fails to compile. Neither is
      a coverage guarantee — nothing here promises an id has a mark — but
      between them there is no state where a mark is claimed and nothing
      renders, which is what upstream's `llmgateway` does.
    - **A post-mutation refetch SAYS it is refreshing.** The host rotates its
      managed server on every write, so the next list pays a cold
      `opencode serve` boot — **measured ~3.7s, against ~0.24s warm**. For that
      whole window the rows on screen are the pre-mutation answer. The list
      keeps them (they are mostly right, and a skeleton would discard more than
      it protects) but dims them, sets `aria-busy`, and shows a "Refreshing
      providers" line. Without it a stale row reads as final, which is exactly
      what the user reported twice — "still needs manual refresh", then "it
      takes a little time to auto refresh".
      **No optimistic flip.** Disconnect does not reliably mean disconnected:
      an env variable or a config block underneath can keep the row connected,
      and the host decides that across five ordered passes. Guessing the outcome
      client-side would show a state the refetch contradicts seconds later — a
      visible flip-flop, and a re-run of the "client re-derives host truth"
      mistake this surface removed once already.
    - **The custom-provider dialog MIRRORS upstream's**, extracted field for
      field from OpenCode desktop 1.18.2 (`CustomProviderForm` /
      `validateCustomProvider`). An earlier pass mirrored their predicates and
      invented the form around them; the user's verdict was that this is not
      parity, and it was correct. Fields, in order: **Provider ID**
      (`myprovider`, "Lowercase letters, numbers, hyphens, or underscores"),
      **Display name** (`My AI Provider`), **Base URL**
      (`https://api.myprovider.com/v1`), **API key** (optional, "Leave empty if
      you manage auth via headers"), then **Models** — rows of `model-id` +
      `Display Name` with a trash per row and "Add model" — then **Headers
      (optional)** — `Header-Name` + `value`, same shape. Submit reads
      **Submit**. The intro links their own
      [provider config docs](https://opencode.ai/docs/providers/#custom-provider).
      `npm` is not a field: the host writes the one constant `T(id)` recognizes.
      Their rules, adopted verbatim including the loose edges — parity on a
      validation rule means taking its edges too, or "same form, same values"
      becomes a Traycer-only failure:
      - id `^[a-z0-9][a-z0-9-_]*$` — **underscores are legal**; ours banned them
      - base URL is a `^https?://` **prefix test**, not a URL parse
      - every model row needs an id AND a display name; ids compare
        case-sensitively (they are sent verbatim), header names
        case-insensitively (HTTP says so, and two rows differing only in case
        would collapse when written)
      - a wholly empty header row is skipped, not flagged — the list always
        carries one and the section is optional
      - the exists-check is SKIPPED for an id in `disabled_providers`: upstream
        re-enables a disabled custom provider by re-declaring it
      - **create stays a NAMING surface even then.** Re-declaring over a
        disabled id skips the exists-check, but not the minting pattern: the
        wire keeps the regex on `createCustom` and drops it only on
        `updateCustom`, and the client's two id policies match that split. So a
        disabled id we could never have minted - a dotted `wafer.ai`, say - is
        repaired through **Edit** or turned back on through **Connect**, not by
        retyping it into the create form. Imposing our naming style on an id
        already in someone's config is the thing that rule was never for.
      - `{env:VAR}` in the key field is a REFERENCE, not a secret — it becomes
        `env: ["VAR"]` and stores no credential
        **Submit stays live and validates on click**, which is upstream's shape
        and also the way out of the dead-button trap: a Submit disabled until
        valid is dead on a blank form for exactly the errors a blank form has, and
        nothing on screen says why. Nothing is red until asked.
        This REPLACES an earlier rule on this surface that disabled Submit while
        the draft was invalid. That rule was written before upstream's form had
        been read, and it was answered by marking every field pre-dirty on edit -
        a workaround for a problem the shape it was copying does not have. Both
        halves of the pair went together, so neither survives alone: reinstating
        the disabled button reinstates the invisible reasons.
    - **TWO DELIBERATE DIVERGENCES from upstream, both documented here because
      the extraction is the evidence for everything else on this surface.**
      1. **Edit exists; theirs does not.** `DialogCustomProvider` always mounts
         blank — upstream's only route back into a declaration is re-declaring
         it while disabled. Ours opens the form on the row's current values with
         the id locked, which is strictly more capable and is the only way to
         repair a hand-broken declaration. The id stays locked because it is the
         config key every stored model reference is built from; a rename would
         be a delete and a create wearing one button.
      2. **Write order is ours.** Upstream `auth.set`s the key and then writes
         the config, so a failed config write leaves a stored credential behind.
         The host does config first, key second — the same two operations
         failing in the direction where nothing is left over.
         **Edit opens with an EMPTY key field**, because the read side carries no
         key — credentials are write-only on this surface. Empty therefore means
         "leave the stored one alone", never "clear it", and the helper text says
         so in edit mode. An env REFERENCE is restored verbatim: it is not a secret,
         and blanking it would silently drop it on the next save.
    - **Edit can ADD and CHANGE; it cannot REMOVE.** The write is a deep merge,
      and removal is not something the provider's API can express — probed, not
      assumed. A null model entry is answered with a 400; a null header value is
      _accepted_ and stores the literal null, poisoning a file the provider's own
      CLI reads. Their own app never hit this because it has no Edit at all, so
      removal was never in the contract their API was written to.
      So a row already in the config is **locked**: no trash on it, and its KEY
      is read-only while the value beside it stays editable. The key lock is the
      non-obvious half and it is not fussiness — under a deep merge a key rename
      is **a removal wearing a rename**: the payload adds the new key and nothing
      deletes the old one, so one edit yields two entries plus an orphan the user
      can now never remove. Renaming a model's display name or changing a
      header's value carries no such risk, which is exactly why the row splits
      down the middle rather than locking whole.
      The trash is **gone, not disabled**, on those rows: a disabled control says
      "not right now", and this one can never enable. The section note carries the
      honest route instead — disable the provider and declare it again under a
      new id. Rows added during the session keep their trash until save, since
      nothing is stored under them yet, and **create mode is untouched**:
      everything is removable before it is written. A stored key is also left
      UNJUDGED by validation, for the same reason an existing provider id is —
      the field is read-only and the file is hand-editable, so a complaint there
      is one the user cannot act on; it still enters the duplicate set, so a NEW
      row colliding with it is flagged on the row that can change.
      The host refuses removal-shaped updates with `invalid_input` as a backstop
      for a stale client, and that detail renders **on the form**, which is the
      only surface that can say which key went missing.
      `env` is the one genuine exception, and it has **three** states rather than
      two: `null` leaves the declaration alone, `[]` CLEARS it, non-empty
      replaces it. The gap between the first two is the whole point — deleting
      the block's `env` key server-side needs an explicit signal, which forces
      `[]` to mean clear, so if ABSENT meant the same thing then every edit that
      touched only the display name would silently delete how the provider reads
      its key. An untouched form therefore sends `null`, which is also what
      retired the old `originalEnv` resend: that field existed only because
      "untouched" had no spelling of its own, and one field could never show
      several fallbacks anyway. An emptied field sends `[]`, and the edit-mode
      hint names both halves rather than promising an empty field is always
      harmless. **Re-enable sends `null` too** — it is not an env instruction,
      and echoing the read side's array back would be a replace-with-identical
      whose empty case arrives as CLEAR.
    - **`config_unreadable` is gone from both model-provider vocabularies** (it
      survives in `ProviderNativeErrorCode`, which is the MCP/plugins/skills
      config-write path and a different enum). A config the provider cannot
      parse is a server that never boots, so the condition was never separately
      observable here: it arrives as `server_unavailable` carrying the redacted
      parse error — file, line, column — and the detail-preferred rule renders
      that instead of the generic sentence. The fallback stays TRUE for a bare
      code rather than becoming a wrong-bug answer: a config the parser rejects
      is a server that failed to start.
    - **The global "All providers" status lives on the panel HEADING row**, and
      renders only when `isHostScopeUsable(scope.status)`.
      `latestProviderCheckedAt` is a max over every provider and Refresh
      re-probes all of them; at the card's top-right it sat inches from the
      selected provider's Enabled toggle and read as that provider's own.
      The safety argument is the boundary, not the location. `headerAction` is a
      SIBLING of the gate, so it is not gated — but `HostRuntimeContext.Provider`
      wraps this entire shell, header included, whenever the scope resolved a
      client, and `following` needs no override because the ambient client
      already IS the scoped host's. The two usable states are therefore both
      correct, for different reasons, and the three unusable ones
      (`connecting` / `unreachable` / `vanished`) mount nothing at all.
      The original bug was mounting these hooks in the header
      **unconditionally**: with no client, `useHostClient()` fell back to the
      ambient host and Refresh re-probed and rewrote the provider list of a host
      the page was not showing. An earlier fix over-corrected by banning the
      placement outright — and pinned "not in the header" as a test, which
      forbids the safe implementation rather than the unsafe state. The test now
      asserts the real invariant: no control and no request while the scope is
      unusable.
    - **Structure: ONE scroll context, plain search, Add as the first row.**
      The list no longer caps itself against the viewport or scrolls
      internally — that nested a second scrollbar inside the panel's own, so
      one list had two tracks and the outer one moved the tab while the inner
      moved the rows. The panel scrolls; the list just gets long.
      The search controls are an **ordinary control in the header area** that
      scrolls with the tab — the Skills tab's shape, where `ProviderListSearch`
      is a plain sibling above its list.
      **REVERSED, and worth the record.** Sticky was requested (the panel owns
      the only scroll context, so on ~180 rows the controls scroll away), built,
      and then retired on the user's live pass. Pinning requires a fill, since
      rows scroll underneath; this pane is `bg-card/40` composited over the
      settings background, so the sticky child had to repaint BOTH layers to
      look like the surface it covers. The first attempt (`bg-background/95` +
      backdrop blur) was a different colour and read as a lighter band. The
      second used the pane's own recipe and was correct in the middle, but the
      fill stopped at the padded container's edges, leaving a visible seam
      beside the input. Two failures with the same root: a pinned child cannot
      reproduce a composited translucent parent it does not own the bounds of.
      The accepted trade is scrolling back up to search a long catalog — one
      gesture, versus an artifact on every frame.
      **"Add custom provider" is the list's FIRST item** and scrolls with the
      content. It stays rendered whatever the search or filter says — including
      when they match nothing, which is why every empty state renders INSIDE the
      list shell rather than instead of it. It is an affordance, not a result:
      a query that hid it would remove the one row whose purpose is "what you
      want isn't in this list", exactly when someone is typing. (It sat above
      the search box for one round, for that same reason; the user's live pass
      overruled the placement, and the always-first-row form keeps the property
      without pinning it.)
    - **Disconnect on a declared custom row is a DISABLE**, and says so. There
      is no separate remove verb on the wire: upstream's disconnect for a
      config-declared custom disables the block rather than deleting a
      credential it may not have, so the confirm promises that the declaration
      stays in the config file and can be turned back on.
    - **ACCEPTED RESIDUAL: a `custom` row can have nothing to remove.** Upstream
      assigns `custom` from two different passes, and only one of them requires
      a stored credential: a plugin auth loader (guarded on an `auth.json` entry
      existing) and an AUTOLOADING provider loader (guarded on nothing). The
      wire's `source` cannot tell them apart, so `{api, custom}` shows Remove on
      the second kind too — the live example being OpenCode's own `opencode` row
      on a free plan, connected with no `auth.json` entry at all. The failure is
      the mild direction: `auth.remove` no-ops, the row re-lists as connected,
      and nothing is misreported. Being exact would mean reading `auth.json` key
      names, which the plan defers. Special-casing the `opencode` id was
      considered and rejected — that is the hardcoded-id rule the plan bans, and
      upstream's own version of that filter turns out to be a PAID-PLAN check
      (`m.id !== "opencode" || Object.values(m.models).find(v => v.cost?.input)`,
      the same predicate as their `paid()`), not a credential one, so mirroring
      it would import their monetisation rule and still not make us exact.
    - **Every provider gets the same plain masked key field**, unless it
      advertised a method list saying otherwise. There is no client-side notion
      of which providers "can" take a pasted key: `connect` sends
      `{ key, inputs }` where `key` is the SECRET VALUE (upstream's
      `ApiAuth.key`, which reads like an identifier and is not one) and `inputs`
      is the prompt answers keyed by prompt key.
      A `credentialKey` field used to ride the wire, derived host-side from
      models.dev `env[]`, and the dialog suppressed the key field wherever it
      came back null — Amazon Bedrock and both Vertex rows. The parity audit
      called it what it was: a ~130-line heuristic standing in for knowledge we
      do not have, for a requirement upstream does not have. OpenCode's
      `auth.set` stores whatever is pasted, and a credential that cannot work is
      the user's to discover. It is deleted across all three layers.
    - **The plain path is still suppressed when a provider advertises ANY
      method** — that rule is genuine upstream parity and stays. A provider with
      a method list has told us exhaustively how it can be authenticated, and
      every one that accepts a pasted key advertises that explicitly (`openai`,
      `xai`, `poe`, `gitlab`, `digitalocean`, `snowflake-cortex` all carry a
      "Manually enter API Key" arm). `github-copilot` advertises `['oauth']` and
      nothing else, so synthesizing a key field for it would invent a path
      upstream does not have. Verified against a live `/provider/auth`.
      Two consequences worth stating: the env-precedence warning no longer names
      the variable (that name came from `credentialKey`, and guessing it would
      be worse than the general statement), and the connect dialog's "this
      provider offers nothing" body is gone as unreachable — a provider
      advertising no methods now always has the synthesized key path.
    - **The prompts DSL is evaluated client-side**
      (`model-provider-prompts.ts` - pure, so it is tested without a form).
      Visibility resolves SEQUENTIALLY and only a visible prompt's answer feeds
      a later `when`: the form is a CLI prompt loop rendered at once, so a
      question never asked has no answer, and a field predicated on it must stay
      off screen. An unanswered key fails `neq` as well as `eq`. Hidden fields
      contribute nothing to the request - the host rejects any key the selected
      method did not ask for.
    - **OAuth attempt state lives in `model-provider-pending-auth-store.ts`**
      (mirrors `mcp-pending-auth-store.ts`), keyed
      `(hostId, providerId, modelProviderId)` and carrying the host-minted
      `attemptId`. `hostId` is in the key even though the HOST keys its own
      registry without it: the host only speaks for itself, while this store is
      one client-side map spanning every host Settings can point at — without it
      a sign-in started on host B overwrites host A's record, and A resumes
      against an `attemptId` that names nothing there. Removal is
      attempt-guarded for the same class of reason: every teardown resolves
      asynchronously, so a late cancel must not delete the record of the newer
      attempt that legitimately replaced it.
      - **Two lookups, deliberately not one.**
        `findModelProviderPendingAuth` answers "which row should re-open BY
        ITSELF" (newest on this host+provider); `getModelProviderPendingAuth`
        answers "does the row the user just clicked have an attempt" (exact
        full key). Two upstream providers can each hold a live attempt at once,
        so collapsing them made the OLDER of the two restart-only: its record
        sat in the store and the host held its server lease, but the only
        lookup available could never name it.

      `attemptId` is also what makes a resumed panel honest:
      attempts are single-flight per `(providerId, modelProviderId)` and a newer
      one supersedes the pending one, so a panel polling by key alone would be
      handed the newer attempt's status as its own. The tab adopts a stored
      attempt during RENDER, guarded on the entry map's identity - the same
      pattern as the MCP tab's `useResumeOauthPolling`, and what makes the panel
      re-openable across navigation yet still dismissible.

    - **Two OAuth arms, and neither is faked.** `code` shows the provider's own
      `instructions` verbatim plus a paste field; `auto` completes on the
      server's loopback and shows a waiting state with a bounded poll and a
      **Stop waiting** button - honest wording, because upstream has no
      OAuth-cancel endpoint.
      - **Only the START path opens a browser.** The host answers a
        still-pending poll with the STORED `authorizationUrl` rather than
        `{kind:"pending"}`, so a client re-attaching after a navigation can
        still show the provider's page. That is the right wire shape and the
        wrong thing to open a tab on, so the dialog carries an explicit policy
        (`applyStartResult` vs `applyPollResult`) instead of inferring one from
        the arm: a tick refreshes the panel and the resume record, and only a
        user action reaches `openLink`. Handling both in one place
        reopened the sign-in page every 1.5s, on a flow the user was already in.
      - **Polling is single-flight**, scheduled from the previous tick's
        settlement rather than on a `setInterval`: an interval keeps firing
        through a slow request, stacking concurrent polls on one attempt — each
        re-leasing the managed server this whole design exists to stop churning.
      - **A terminal failure REPORTED BY A POLL ends the attempt.** The same
        `report` disposition means opposite things depending on who asked: from
        a submit it is advice against an attempt the host is still holding, so
        the panel stays put and the user can try again; from a status read it is
        a post-mortem, because the host only answers that way once the
        background callback has already failed and released its lease. Applying
        it identically left the panel saying "Waiting" against a settled row
        forever, with nothing further to arrive and no live attempt for Stop
        waiting to cancel. `applyResult` therefore takes the call context, and a
        polled `report` clears the attempt (attempt-id guarded), stops the poll,
        and returns to a fresh start with the reason kept on screen.
      - **Stop waiting keeps the attempt until the host CONFIRMS.** An
        optimistic teardown left a live host attempt holding a server lease with
        no surface able to retry when the cancel failed in transport. A
        confirmed cancel (`{cancelled: true, result: done}`) is LOCAL teardown —
        `done` describes the cancel, not a credential, so it neither closes the
        dialog as a success nor invalidates any cache. Only the
        `cancelled: false` race (the browser callback landing while the click
        was in flight) actually wrote a credential, and that one does both.
    - **Typed failures map to four distinct moves**
      (`modelProviderAuthErrorDisposition` in
      `lib/providers/model-provider-error-copy.ts`): `attempt_superseded`
      stands down SILENTLY (a
      newer attempt owns the surface - reporting it accuses the user of breaking
      the flow they just restarted), `attempt_expired`/`attempt_not_found` offer
      a fresh start, `code_rejected` re-prompts and KEEPS the live attempt, and
      everything else is reported. That mapping is the enum's contract restated
      as behaviour in one place, instead of a switch per call site that handles
      half of it.
    - **A cold list can be a WAIT rather than a failure.** Reaching the catalog
      needs the managed server, so every reason it would not start arrives as
      one `server_unavailable` - including a provider pack still downloading.
      The tab is handed the provider row's `providerPackPreparingForProvider`
      state and renders that case as loading-with-reason.
      `capability_unavailable` gets no Retry button: the surface is not offered
      here at all, and a click that cannot work is the offered-then-failed shape
      the rest of this panel refuses.
    - **Mutations invalidate the model catalog, not the harness list.**
      `agent.gui.listModels` is `staleTime: Infinity` by design, so without the
      invalidation the model picker would serve the pre-connect list for the
      rest of the app session - the one place the user looks to confirm the
      connect worked. `agent.gui.listHarnesses` is left alone: an upstream
      credential does not change which CLIs are installed, and re-probing every
      harness is the fan-out `useRefreshHarnessCatalog` keeps behind an explicit
      user action.
- `Notifications` Two `SettingsGroup` cards. A design pass
  (`settings-related-panels-core-flows` artifact) replaced the old one-column
  severity×channel matrix with a compact policy card, and gave the hooks
  manager below it the remaining height.
  - **`"In-app notifications"`** (the `· Current host` qualifier is gone - the
    sidebar names the host now, and the old suffix qualified the one fact the
    screen refused to resolve): three rows, one per severity
    - `Needs action`, `Failure`, `Done` (`info` has no row) - each a single
      `Switch` gating durable host-row creation before anything reaches the bell
      feed, unread count, tab indicators, or notification hooks. Collaboration
      and app-local notifications stay independent. Backed by
      `host.notifications.getConfig` / `setConfig` through host-scoped TanStack
      Query hooks. The wire contract still carries a full severity×channel
      matrix (including an `email`/SMTP channel that is never surfaced here,
      round-tripped untouched via a `leaveUnchanged` password sentinel) - this
      panel only renders and toggles the `renderer` channel; a real multi-
      channel UI is deliberately deferred, not an oversight (the artifact notes
      a channel-by-severity matrix "is reserved for a future surface with
      multiple user-configurable channels").
  - **`"Notification hooks"`** (`notification-hooks-section.tsx`): a toolbar
    (hook count, a copy-config-path chip, Refresh, Add hook) over a row list
    that owns the remaining height (`fillHeight` on the shell +
    `min-h-0 flex-1` down the tree - only the row list scrolls, the toolbar
    stays pinned). The config-path chip consumes the toolbar width left after
    the count and actions, truncating only when that real remaining width is
    exhausted. The no-hooks state fills and centers within the list viewport.
    Each row shows name, a Script/HTTP type badge, destination,
    severity filter (or "Every severity"), latest test result, an inline
    enabled `Switch`, and inline **Test / Edit / Delete** buttons (not a row
    action menu) - Delete confirms via `ConfirmDestructiveDialog`. Edit/Add
    open the pre-existing hook editor dialog (`notification-hook-editor-
dialog.tsx` / `notification-hook-draft.ts`, unchanged by this pass).
    States: a loading spinner; a neutral "unavailable, reconnect" message when
    the host is unreachable; the query's own error message; an empty state
    with its own "Add hook" plus the toolbar's; and, when the hooks file
    itself fails to parse, the row list is replaced by the parse error with
    editing disabled while the config-path copy chip stays available (the
    invalid file is never overwritten). A running test spins only on the
    tested row, but the Test button on every OTHER row is also disabled while
    any one test is in flight (the mutation is global, not per-row) - worth
    knowing if this ever reads as a bug report.
- `Permissions` (section id `permissions`, route `/settings/permissions`,
  `panels/permissions-settings-panel.tsx`) How much an agent may do on its own,
  and who reviews the rest. Its own page, not rows on Agent selection: that
  page is about which agent gets CHOSEN for a task, and permissions are a
  different question, asked at a different time (a user decision, 2026-09-12).
  Four tabs, one per question, in this order: **Modes**, **Judge**, **Rules**,
  **Activity** (`panels/permissions/*-tab.tsx`). The definitions live in
  `permissions-settings.definitions.ts`: one group per tab, which anchors on
  that tab's TRIGGER, plus contributor groups for everything inside a tab (see
  § Search, "Gated on the SELECTED HOST").
  - **The page is laid out for the scope rule.** Modes is application-scoped and
    renders with no host at all. Judge, Rules and Activity are per machine, and
    `HostScopeGate` wraps each of their BODIES, never the page, so the tab bar
    is always drawn (see "Scope: the organising idea"). Inside the gate, each
    body sits behind `AutoModeHostGate` (`permissions/auto-mode-host-gate.tsx`),
    which asks about that tab's OWN method: `autoJudge.get`, `autoPolicy.get` or
    `autoJudge.listRecent`. They are negotiated independently, so one answering
    is not evidence about another.
    - Support is the tri-state `useHostMethodSupport`. `null` (no handshake
      yet) renders nothing rather than the "predates" line, because the
      unsupported verdict parks the very RPCs whose handshake would overturn
      it. `useHostCapabilityProbe` keeps a `false` refutable, re-asking when
      the host's version or dialability changes.
    - **A body is never unmounted because its scope stopped serving.** The
      gate first mounts a body only under a usable scope
      (`isHostScopeUsable`). Once mounted, it keeps rendering the body while
      the scope is `connecting` or `unreachable`, against the LAST usable
      binding (`useHeldBinding`).
      - The old rule unmounted it instead. Every blip cost the unsaved Rules
        text and any draft it had already taken, and a return to the same
        machine could not bring them back.
      - That rule guarded against a hidden body querying the wrong host.
        `HostScopeGate` removes that risk by holding the body in a hidden
        `<Activity>`, which tears down its effects and subscriptions, so the
        held binding serves no reads.
      - The held entry is the binding PLUS the machine the scope named when
        it was captured, and it is reused only while the scope still names
        that machine. The binding's own `hostId` cannot answer that: a
        `following` binding names no host (`hostId: null`), so the subtree
        tracks the effective host, and `following` is the default. A
        re-handshake, where support is briefly unknown again, holds the body
        the same way.
      - When the same host comes back, the body resumes as it was, whether
        Settings is pinned (`ready`) or `following`.
      - A `vanished` scope, or no host at all, still unmounts it.
        That is `HostScopeGate`'s own rule.
    - It re-provides the scoped binding, and keys the body by viewer AND host,
      so an in-flight judge pick never carries across an account switch or a
      host switch. The Rules edit is the exception by design: Settings holds
      it outside the page (`rules-edit-store.ts`, see Rules), because the
      policy belongs to the account, not the machine.
    - A tab whose host lacks the method says so in one line: "This machine's
      host predates Auto mode. Update it to choose a judge and write a policy."
      for Judge and Rules, and "This machine's host doesn't record Auto mode
      decisions yet. Update it to see them." for Activity.
  - **The open intent** (`stores/tabs/settings-open-intent-store.ts`) carries
    `tab`, `draft` and `hostId`. The panel applies it during render, so the
    first frame shows the requested tab. A `draft` always means Rules. The
    draft itself is queued in the layout effect that acknowledges the intent,
    before paint, through `enqueueIntentDraft`, which takes one draft per
    intent id. It cannot be queued during render: the edit lives in a store
    the page does not own, and a render may only adjust its own component's
    state. A
    `hostId` names the machine the caller had in mind: the composer's
    "Permission settings…" passes its run-target host
    (`useOpenPermissionSettings(hostId)`), and an approval card passes its
    tab's host, bound once in `chat-tile.tsx`. That is why the card's
    `onOpenSettings` takes `TabHostSettingsOpts`, the options without
    `hostId`. The page writes the host into the Settings scope
    (`carryViewedHostIntoSettingsScope`) in a LAYOUT effect before
    acknowledging the intent, and the gated bodies are held until the scope
    agrees. "Agrees" means the scope RESOLVES to that host (`scope.hostId`),
    not that the raw pin names it. An intent naming the machine Settings
    already follows therefore holds nothing and remounts nothing, so an
    unsaved edit there stays put. So "Permission settings…" from a chat on
    host B always lands on host B's judge, and never paints a frame of the
    machine it is leaving.
    Every other `openSettings` caller passes `hostId: null`: it opens on
    whatever Settings is already scoped to.
  - **Modes** (`modes-tab.tsx`) holds the row **New conversations start in**,
    which moved here from General (anchor
    `permissions-default-permission-mode`; General's search vocabulary came
    with it and General keeps no alias). It is the only writer of
    `settingsStore.defaultPermission`.
    - It renders the composer's own `PermissionsPicker` with
      `supportedPermissionModes={null}` and `harnessLabel={null}` (no harness
      scope, so every mode stays enabled), `hostKnowsAutoMode={null}` (no host
      was asked, which is not "a host that cannot spell `auto`"),
      `onOpenPermissionSettings={null}` (a Settings surface must not open
      Settings) and `closeFocus="trigger"`. That last prop exists because the
      picker's composer-focus return is app-global and can name an editor on a
      canvas BEHIND Settings.
    - The row carries an "All machines" badge, and the tab opens with the line
      "The machine picker above doesn't change anything on this tab."
    - A new chat does not read only this row: a composer prefers the last mode
      that HOST ran with (`composer-run-settings-store`, bucketed per host),
      and session import reads the same ladder (`newChatPermissionModeFor`).
      See `session-import-wizard.tsx` for why its gate reads
      `sessionImport.run`'s own negotiated line.
    - Below the row, one card per mode lists what it runs without asking, from
      `PERMISSION_MODE_DETAILS`, the same data as the picker's descriptions.
    - **Auto is experimental.** Its picker option, expanded selected control,
      and mode card carry a muted xs **Experimental** badge. A compact picker
      includes the status in its tooltip and accessible name. The mode card
      adds: "Auto mode is experimental. We’re still improving its reliability
      and speed."
    - Desktop and mobile pickers show **Supervised**, **Auto-accept edits**,
      **Full access**, then **Auto**, using `PERMISSION_PICKER_OPTIONS`. The
      safety order in `PERMISSION_OPTIONS` stays separate and unchanged, as do
      compatibility fallbacks. The Auto row has the same label-and-description
      shape as its peers; reviewer/model/billing metadata is shown in Judge
      settings, not the picker. Availability reasons and mid-turn notices stay.
  - **Judge** (`judge-tab.tsx`, with `judge-tile-state.ts`,
    `use-judge-toolbar-store.ts`, `judge-model-face.tsx` and
    `judge-status-lines.tsx`) - **Auto mode judge**: which model checks each
    command in Auto mode on this machine, over `autoJudge.get` /
    `autoJudge.set` (`~/.traycer/host/config/auto-judge.json`,
    `selection: null` = Automatic). The heading carries an **Experimental**
    badge. Two readers share one cache entry with the composer's mid-turn
    availability check, and the harness catalog invalidates it when the
    Traycer row's enabled / available / auth facts change (see
    `auto-judge-billing.ts`). The save invalidates it too, after writing its
    echo.
    - The SELECTION comes from `useAutoJudgeQuery`, at Settings' 60 s
      `staleTime`. It seeds the tiles and is what a pick hands off to, so an
      aged or invalidated copy still shows what is stored.
    - **The tab re-reads the machine whenever the window gains focus**, and
      each time it opens, even while its copy is fresh, so an open tab
      follows a judge changed in another window or on another device. It
      listens for the window's own `focus` event: TanStack's focus manager
      follows `visibilitychange`, which never fires when focus moves between
      two visible windows. It is a plain refetch, never an invalidation, so
      the verdict line stays up until the new answer replaces it. A pick made
      on the card still wins until its save settles: the tiles present it over
      the record, and the save cancels a read in flight before writing its
      echo. Only this tab does it; the composer's readers re-read on mount.
    - The VERDICT (`effective`, `blocked`) comes from `useAutoJudgeVerdict`,
      the composer's own rule (`useAutoJudgeVerdictForClient`, which
      `use-auto-judge-billing.ts` reads too). A record the host has
      invalidated, or one never answered, is withheld until a CURRENT read
      succeeds, and a failed re-read keeps it withheld. `staleTime: Infinity`,
      so age alone hides nothing. An availability transition, or a save whose
      echo the next read replaces, therefore shows no status line until the
      host has answered again. No line ever claims a verdict the host has
      since withdrawn.
    - **The card** opens with one lead line, the group's description
      ("Checks each command before it runs in Auto mode."), and a muted xs
      "This machine" `Badge`, the one the Modes tab uses for "All machines".
      The scope badge stays on the lead line; the **Experimental** badge sits
      beside the group's heading through `SettingsGroup.titleStatus`.
    - **Two tiles, one radio group**: "✦ Automatic" (with an outline
      "Recommended" badge) and "◎ A model you pick". They sit side by side
      while the card is at least `@lg` wide (a container query on the card)
      and stack, Automatic first, below that.
      - Each tile is a `ChoiceTile` (`components/ui/choice-tile.tsx`). Its
        chosen, focused and disabled looks are read off the `RadioGroupItem`
        it holds, so the tile can never say "chosen" while the radio does
        not. The radio is labelled by the tile's title and described by its
        description.
      - The tile body is a pointer convenience: clicking it does what
        choosing the tile does. Clicks on the radio (which answers through
        `onValueChange`), on a link, or on an ENABLED model control belong to
        those. Clicks from the picker's panel, which is portaled away but
        bubbles through React, are ignored.
      - Nothing interactive is nested inside the radio. The model control is
        its sibling.
    - **The model control is the composer's `HarnessModelPicker`**, minus its
      Fast footer (`withServiceTier` off). It is the composer's picker in
      behaviour: a click on a provider, an account or a model saves at once
      and keeps the panel open, and only an outside click or Esc closes it.
      The rail commits only a provider that can run here. One that cannot
      shows its sign-in or install steps and saves nothing.
      - **Its effort footer is the judge's Effort control** (`withReasoning`
        on while the host's negotiated `autoJudge.set` is `1.3` or later,
        `autoJudgeSetStoresReasoningEffort`, AND the seed is the pick on
        show, `judgeSelectionMarked`). It is hidden below that line, where
        the request upgrade would reset the effort anyway and every write
        then carries `reasoningEffort: null`; and it is hidden in the rows
        whose seed is not a pick - "Choose a model", a last pick that cannot
        run, a stored harness this build does not know - because a footer
        change saves the store's selection, and there that would save the
        placeholder, or a pick with an account the provider no longer has,
        as the judge. Once a pick made in the panel lands, the row is Picked
        and the footer appears. The footer shows the level the host RUNS:
        the stored effort while the model still advertises it, else the
        lowest the model advertises by the canonical ladder
        (`effectiveJudgeReasoningEffort`, the host's own rule, so the two
        cannot disagree). That is the store's `reasoningFallback: "lowest"`
        (`normalizeReasoningForModel`): a composer's store restores the
        vendor's default for an effort the model does not carry, and Grok's
        default is High, the level a stage-1 verdict measured 14.4 s at
        against 8 s at Low - the reason the judge has an effort at all. A
        model that advertises no efforts disables the footer, as in the
        composer, and its pick carries `null`. Changing the footer saves at
        once, like every other click in the panel. A fresh pick - another
        model, or a provider switch - saves the new model's lowest, as the
        spec rules for a pick with no effort of its own; the footer's level
        is kept only while the (provider, model) pair is unchanged: a
        re-click of the checked row, a same-provider rail click that keeps
        the model, an account change. That is the `"setting"` store's own
        rule in `applyComposerSelection`: it ignores the effort the picker's
        funnel (`commitSelection`) passes in, because that funnel reads
        composer memory, which the judge must not inherit. The catalog
        `hostId` is `null`, but the memory store's pre-host `legacy` tier
        still answers a `null` host, so an old composer effort for the same
        model would otherwise move the judge on a click that changed
        nothing. The stored value is explicit, so a later catalog change to
        the model's ladder is resolved by the host's rule above rather than
        by whatever the file happens to say.
      - The face names the effort after the model - "Grok 4.7 Build Fast ·
        Low" - and the Automatic tile's "Now:" line names it in parentheses,
        both only on a host whose `autoJudge.get` is `1.3` or later
        (`autoJudgeGetKnowsReasoningEffort`): an older host runs the model's
        own default, and no label may name an effort the host does not
        apply. The composer's Auto row follows the same rule.
      - It is hosted through the picker's `embedding` prop. The card draws
        the face, so the picker draws no chip and no tooltip. A provider
        switch (rail click, ⌘-digit, an account on another provider) commits
        `judgeSwitchModel`: the row's `judgeDefaultModel` (only Claude Code
        names one), else `""`, meaning that provider's first catalog model
        once it loads, as in the composer. A click on the provider already
        selected is not a switch: it keeps the model on show, as the
        composer's same click restores that provider's remembered model, so
        it saves nothing. It stops keeping it only once that provider's
        catalog has loaded without listing it (`selectionCatalogConfirmed`
        false on a loaded catalog): a model the machine no longer offers is
        not one to keep, and keeping it would save a judge that cannot run,
        so the click lands on the recommended model instead, as a real switch
        does. While the catalog is still loading, nothing yet says the model
        is gone, so the click keeps it and saves nothing; otherwise the
        store's `""` would resolve to the catalog's default on arrival and
        overwrite a listed pick. `selectionMarked` is true only while a pick this
        build can name is on screen (`judgeSelectionMarked`), so nothing is
        checked before a first pick, and a stored harness this build does not
        know - whose store holds the unpicked seed - checks no unrelated row.
        Closing returns focus to the face, never to a composer.
      - `runTargetHostId` and `createProfileHostId` are both the gate's
        `hostId`. It is concrete whenever Settings is scoped to a machine, so
        the catalog reads and "Create new profile" (which mounts outside the
        Settings binding) both reach that machine. It is `null` only while
        Settings follows the effective host, where the two are the same
        machine. `registerActivation` is false: the model-picker shortcut and
        the palette's "Change model…" belong to the chat behind Settings.
      - Its store (`useJudgeToolbarStore`) is built with
        `createComposerToolbarStore`, never `useComposerToolbarStore`, whose
        recording wrapper writes composer memory. `purpose: "setting"`: an
        unavailable provider stays selected and a delisted slug is held as
        stored, with the status line explaining it rather than a substitute,
        and a provider switch tracks no `HarnessChanged`. Its catalog
        `hostId` is `null`, so no composer-memory write lands and no host's
        memory bucket is read: a judge pick never becomes the next chat's
        model on that provider. It is fed the scoped host's harness list and
        the models of the STORE's own harness, read only while that harness
        is available. Its writer, installed through `setOnSettingsChange`,
        is `useJudgePick`'s `request`, and it never sends `model: ""`. It
        also sends nothing that names the pick already on show at the effort
        the host already runs for it, so a re-commit of the same selection
        is a no-op, as in the composer, whether or not the footer has been
        touched; a footer change on the pick on show is a write. The
        comparison is against the level the host RUNS, not the file's raw
        value: choosing Low in the footer while the file names a level the
        model no longer advertises (so the footer already shows Low) is the
        same no-op, and the file keeps its stale value, which the host
        resolves to Low by the same rule until that provider advertises the
        level again. Before the store's provider catalog has answered, the
        store emits the stored effort unclamped and the no-op compares
        against that same value, so a same-provider rail click while the
        catalog loads writes nothing.
      - The seed key is `[row, seed selection, stored effort]`, where the
        row is the tile state below. A re-seed from what is saved while the
        seed itself has not changed (dropping a switch, settling a close)
        applies a key of its own, since re-applying an unchanged key is a
        no-op.
    - **Tile states** (`judgeTileState`). The card is Loading until the
      machine has answered: the record, the harness list and the providers
      list, each with data or an error. Before then a last pick that cannot
      run would read as runnable, and a click would save it. `displayed` is
      the latest pick, else the record's selection. `last` is the pick being
      cleared while the latest pick is a switch to Automatic, as that switch
      recorded it when it was chosen - the pick on screen then, which may
      itself still be saving - so the cleared pick shows dimmed at once,
      instead of the cached `lastSelection` from before the save. Otherwise
      it is the record's `lastSelection`, where absent and `null` both mean
      none. `last` can run when `judgeWarningCause` over it, with
      `blocked: null`, finds nothing. Two findings that check cannot make
      before a save, and the save's echo corrects both in one round trip with
      its amber line: the host's own `unsupported-harness` verdict, which the
      host computes only for the stored selection; and a model the machine
      no longer offers, known only once that provider's models load, which
      the card does not wait on before it can be clicked.
      - A host that cannot store a selection (`autoJudge.set` unsupported,
        said in one line) shows its row's face at full opacity, inert, with
        the picker disabled.
      - The picker's own `disabled` is on in Loading, read-only and "last
        pick runs", so it can never open there. The two rows that open it
        keep it enabled, because a disabled picker force-closes.
      - An inert face is never natively `disabled`. The composer's chip is a
        plain `<button>`, which eats the click when disabled. It carries
        `aria-disabled`, `tabIndex={-1}` and a `pointer-events-none` wrapper,
        so a click on the dimmed chip lands on the tile and restores the last
        pick. The dimming is the wrapper's opacity, lifted while the picker
        is open from it.
      - The face for a pick is `HarnessModelTrigger`: the provider icon, the
        model's catalog label (else its slug), the effort the host runs it at
        (above), and the account (name and accent dot) only when that
        provider has more than one here, as the composer's chip. "Choose a model" is a `muted-outline` `Button` with
        a chevron. A harness id this build does not know has no icon, so its
        face is the text alone.
      - With no last pick, the store is seeded with Traycer on
        `effective.model` when `effective.source` is `default`, else the
        first provider that can run here with `""`. That only decides where
        the picker opens; nothing saves until a provider, account or model
        in it is clicked, and the effort footer is not drawn until then.

      The rows:

      | Row              | When                        | Selected            | Face                                | Clicking "A model you pick" |
      | ---------------- | --------------------------- | ------------------- | ----------------------------------- | --------------------------- |
      | Loading          | the machine hasn't answered | neither; both inert | none                                | nothing                     |
      | Picked           | `displayed` set             | ◎                   | the pick                            | nothing                     |
      | Last pick runs   | Automatic, `last` runs      | ✦                   | `last`, dimmed, inert               | restores `last`             |
      | Last pick broken | Automatic, `last` can't run | ✦                   | `last` + why ("Signed out"), dimmed | opens the picker            |
      | No last pick     | Automatic, no `last`        | ✦                   | "Choose a model", dimmed            | opens the picker            |

    - **The last pick lives on the machine** (`lastSelection` on
      `autoJudge.get` / `autoJudge.set@1.2`), beside the judge itself, so
      every device showing that machine dims the same model and account, and
      it survives closing Settings and restarting the app. A host older than
      `1.2` reports none, and Automatic's second tile then says "Choose a
      model"; everything else works.
    - **A pending provider switch.** A provider click whose model is not
      known yet (every provider but Claude Code, until its catalog answers)
      leaves the store holding the switch, unsaved. The second tile's foot
      reports it whichever tile is selected, because the pending pick belongs
      to it:
      - a spinner while that provider's models load. Closing the picker
        keeps the switch, and it saves the moment they land;
      - "{Provider} offers no models on this machine. Pick another provider."
        when they load empty, and "Couldn't load {Provider}'s models. Reopen
        Settings to try again, or pick another provider." when they fail.
      - A switch that can no longer save - its models came back empty or
        failed, or its provider stopped being available - is settled
        whenever the picker is closed: at the close, or later, when a switch
        left loading behind a closed picker stops loading. It re-seeds from
        what is saved, so the tile describes the machine's judge again and
        the next open starts from it.
      - Choosing a different outcome ends the switch first: Automatic,
        even one already on and wherever on its tile (the body, the checked
        circle, or Space on it), or bringing the last pick back, whether by
        click or by arrow. The latest click wins, so the switch cannot land
        after it. In Picked, the waiting switch is itself the second tile's
        choice (flow 1 has it land even after the panel closed), so a second
        click on that tile is not a new choice and the switch survives it,
        as it survives opening the picker.
      - A switch dropped for having no models, or failing to load them,
        leaves its sentence on the second tile as display state, above
        whatever the tile now describes, so the tile still says why nothing
        was saved. It no longer holds the store, and it clears when the
        picker next opens or a tile is chosen.
      - While the switch waits, a re-derived seed (a harness list or verdict
        settling on a cold host) does not replace it: it is a pick made on
        this card that has not settled.
      - Outside a pending switch, a close whose store differs from the seed
        re-seeds too, so the next open starts from the machine's judge.
    - **Keyboard.** The radio group is one Tab stop, and the model control is
      another whenever it is enabled (Picked, and the two rows that open the
      picker).
      - Arrow keys move between the tiles, and Radix checks the radio they
        land on. Arriving on ✦ switches to Automatic; arriving on ◎ in "last
        pick runs" restores the last pick, as a click does.
      - In the two rows that open the picker, arriving on ◎ only moves focus:
        the controlled value stays ✦, and ◎ is announced as not checked.
        Space or Enter there opens the picker through the item's `onKeyDown`
        (and the embedding's `openRef`). Arrow keys never open it: the tab
        tells an arrow's synthesized click from a real one by the same
        held-arrow signal Radix uses.
      - Esc closes the picker and returns focus to the face.
      - Each foot is an `aria-live="polite"` region, so a status line is
        announced when it changes.
    - **Status lines.** Only the selected tile shows one (the pending switch
      above is the exception).
      - ✦, from the current `effective`:
        - `default` → "Now: **{model} on Traycer** · uses Traycer credits",
          where the model is the catalog label for the slug when one exists;
        - `fallback` → "Now: **each conversation's own model** · on your
          account there";
        - `null` → "No judge can run here · Auto mode asks you";
        - a host too old to report `effective` gets no line.
        - While Copilot is enabled on this machine, the first two add
          "Copilot conversations use premium requests when Traycer can't
          answer: 60–350 per hour." The figure is
          `COPILOT_PREMIUM_REQUESTS_PER_HOUR`
          (`lib/auto-mode/auto-judge-billing.ts`), which the composer's meta
          line quotes too, so the two cannot drift.
      - ◎, when the stored pick can run: "Billed to your **{Provider}**
        account ({Account})", naming the account only when the provider has
        more than one. A Copilot pick adds "Uses premium requests: 60–350 per
        hour of Auto mode."
      - ◎, when it cannot: **one amber line**, the first thing wrong with the
        STORED record, one sentence, one fix. `judgeWarningCause`
        (`auto-judge-selection.ts`) decides. Nothing past the host's own
        `blocked` verdict is reported until the harness catalog answers: an
        unanswered read is never evidence that something is gone. The line
        also waits for a CURRENT verdict, since `blocked` is checked first.
        The checks run in this order:
        - `blocked.reason`
        - a harness this build does not know
        - an unusable provider (one sentence per blocker, with a Providers
          link, then "Until then, Auto mode asks you.")
        - a model no longer offered
        - a removed account
    - **Nothing is disabled while a write is in flight.**
      `autoJudgeWriteScope` orders the writes. The tiles present the latest
      pick until ITS write settles, and TanStack runs per-call callbacks only
      for the latest `mutate`, so an earlier write landing cannot snap them
      back. Meanwhile the selected tile's foot shows only a spinner, since
      any line would describe the choice being replaced. A refused write
      clears the pick, which is the rollback: the tiles snap back to what the
      machine holds, and the mutation's toast says it was not saved.
    - **A failed read says so, one line each**, above the tiles: "Couldn't
      read this machine's judge. Reopen Settings to try again." for the
      record, and "Couldn't load this machine's providers. Reopen Settings to
      try again." for the harness catalog. An errored query refetches on its
      next mount.
    - **The built-in reviewer pointer** (`built-in-reviewer-pointer.tsx`) is
      one line under the judge card. The tab has no reviewer switch of its
      own: the per-provider switch lives only on Providers ▸ {provider} ▸
      Permissions (see Providers), which also says what choosing it costs.
      - It names each provider set to review its own commands: catalog rows
        with `nativeAutoJudge` whose `providers.list` state reads
        `"provider"` through `providerAutoJudgeFor`, the switch's own read
        path and value.
      - It is gated like the switch and never states a guess. It renders
        nothing while either list is loading, and nothing while the negotiated
        `providers.list` line cannot report `autoJudge`
        (`providersListReportsAutoJudge` false), where every provider would
        read `"traycer"` whatever is stored.
      - One provider: "{Provider} conversations are checked by {owner}'s own
        reviewer, not this judge." The owner is "Claude" for Claude Code, else
        the provider's label. Two or more: "{A} and {B} conversations are
        checked by their own reviewers, not this judge."
      - Then one "Change in Providers ▸ {Provider}" link per provider. A link
        sets the providers focus store's `focusHarnessId` to that provider and
        its `focusTab` to `"permissions"`, then opens Providers with
        `hostId: null`, since Settings is already scoped to this machine. The
        Providers page consumes both once on mount, and has the Permissions
        tab whenever this line can render.
  - **Rules** (`rules-tab.tsx`) edits the ACCOUNT's Auto mode policy in place,
    over `autoPolicy.get` / `autoPolicy.set`. Its **Auto mode rules** heading
    carries the muted xs **Experimental** badge, including on direct navigation.
    It shows four sections in
    Traycer's order (Environment, Always allow, Ask first, Never allow), plus
    **Notes** for text under none of them. Each section has its tagline,
    description, a monospace textarea, and the built-in rules it extends.
    - **One document, split and joined.** `auto-policy-document.ts` splits the
      stored body with a line-for-line mirror of the host's
      `parseAutoPolicyDocument`: canonical heading synonyms; a deeper
      subheading stays in its section; any other heading at the same depth or
      shallower falls to notes. The join is canonical:
      - an all-empty document is `""`
      - Notes come first, then `## Environment` / `## Allow` / `## Soft deny` /
        `## Hard deny`, each followed by its body when it has one
      - one trailing newline
      - every marker escalates to `#` when any section body carries a heading
        of depth ≤2, so that heading stays inside its section on the host's
        next read
        A shared fixture pins the agreement in both repos:
        `panels/__tests__/__fixtures__/auto-policy-canonical-documents.json`,
        byte-identical to the host's copy under
        `domain/chat/auto-judge/__tests__/__fixtures__/`.
    - **A line the split would move is refused, never rewritten.**
      `unrepresentableSectionLine(section, text)`, beside the split and
      sharing its title map, finds the first such line. There are two causes:
      - a `#` heading in a section body, which no escalation keeps inside
        its section
      - in any body, a heading of any depth whose title normalises to a
        section name or alias, which opens that section
    - It reads the body as Save WRITES it. The join trims each body whole,
      which takes the indentation off the first non-blank line, so
      `   # Production` typed first becomes a heading on save although the
      textarea never showed one. Only the ends are trimmed: an indented `#`
      further down stays indented and is no heading to either parser, so it
      is accepted. The line number is still counted in the text as typed,
      blank leading lines included.
    - The section names the line and the fix in one sentence, for example
      "Line 3 starts a new section: use ## for a heading inside this
      section, and don't name it after a section." Its textarea is
      `aria-invalid` and described by that sentence, and Save stays off while
      any section holds such a line.
    - Notes are written first, so an unknown `#` heading there round-trips
      and is accepted: a stored document that opens with `# Title` stays
      saveable. The refused inputs are not in the shared fixture, because
      they are the GUI's refusal, not a document either side stores.
    - A stored body that is not already canonical shows "Saved in Traycer's
      section order." Saving writes the canonical form, which moves text but
      never drops it.
    - Save is explicit, never debounced. The record is ACCOUNT-wide and
      last-write-wins, so an auto-saved keystroke races another device.
    - The footer is sticky and carries three things:
      - the record summary: "Saved {relative}", "Set" (a cached copy invents
        no date), "Not set", or the warning lines for unreadable and stale
        copies
      - a UTF-8 byte pre-flight against the 64 KiB cap, a courtesy only,
        since the server enforces the cap
      - Discard and "Save rules"
    - **Save is held off** while the record is not `fresh`, while the host
      cannot write (`autoPolicy.set`), and until the opening read has settled.
      One banner joins the sentences that apply. It is also held off while a
      section holds a line the split would move. That section's own line says
      so (above).
      - `readState` is consulted before `body`: an unreadable read's
        `null` body is evidence of nothing, so the editor shows no text rather
        than an empty policy it could save over.
      - A host that predates the field resolves to `fresh`
        (`autoPolicyReadStateFor`).
    - **Every showing re-reads the record.** Becoming active fires a refetch.
      The stale-edit warning compares the `updatedAt` the edit started from
      against that answer. This includes null to a real stamp: a policy
      CREATED elsewhere while the editor was open. A generation guard stops an
      older read's late answer from unlocking Save.
    - **The tab mounts on its first visit** (`rulesVisited`). Opening
      Permissions on another tab starts no Rules read. A draft handed to
      Rules counts as a visit. From then on the tab stays force-mounted,
      hidden while another tab shows, so a save in flight, whose answer
      re-seeds the editor, survives a look elsewhere.
    - **The edit belongs to the account, and lives as long as this window's
      Settings.** A per-window store, not persisted
      (`panels/permissions/rules-edit-store.ts`), holds the editor's last
      committed state (text, drafted markers, the last draft taken) and the
      drafts not yet taken. The page reads it through `useRulesEdit`, and
      nothing outside Settings reads it. It is keyed by the signed-in viewer
      only: the partition applies on every read, so no frame shows one account
      another's edit, and on every write.
      - Settings is one instance per window, the modal or the Settings tab
        and never both. No component lives as long as it does, which is why
        the edit is a store. Everything below replaces the page and keeps the
        edit and the drafts already taken:
        - leaving Permissions for another section, as Judge's own "Open
          Providers" link does
        - the theme editor (Appearance ▸ Create theme), which flips the
          modal to non-modal, and Radix remounts the modal's content
        - "Open as tab", which replaces the modal's body with the tab's
        - the strip evicting a hidden Settings tab and rebuilding it
          (`durableState: reconstruct`)
      - Only an actual close resets it. `SystemTabModalHost`, always mounted,
        observes "Settings open": the modal shows Settings, or the Settings
        tab exists. The reset fires on the transition to closed
        (`useRulesEditLifetime`), so closing the modal, closing the tab, and
        switching the modal to History all reset it.
      - A promotion is not a close. The Settings overlay's
        `prepareForPromotion` sets a handoff flag, and no reset fires while
        it is set, even for a frame between the modal closing and the tab
        arriving. The flag clears when Settings next reads as open, in
        particular when the tab appears. Discard resets the text as before.
      - A switch of machine re-keys the editor under the gate. The new mount
        resumes from the stored copy and re-takes its opening read on the
        machine now showing. The unreadable and stale banners then govern
        Save exactly as for a fresh edit.
      - There is no warning dialog: the switch changes the reader, not the
        document.
      - A switch of ACCOUNT drops the edit. A viewer id resolving from
        unknown keeps it, and so does signing out and back in as the same
        account.
      - A resumed editor does not scroll again to a draft it already showed.
      - A save in flight when the machine switches loses the editor that
        would have taken its answer. When the new machine's read returns a
        newer record whose text equals the edit, it re-seeds the editor
        anyway, so the user's own save never reads as a change made
        elsewhere. The re-seed covers any newer FRESH record equal to the
        edit, since nothing is left to save. A `stale` copy equal to the edit
        does not count: it would mark the edit clean, and the next fresh
        record, the text the edit was changing, would replace it silently.
      - The editor stays authoritative while mounted and reports each
        committed state upward. If the store owned the state and the editor
        wrote it back from an effect, a queued write could overwrite fresh
        keystrokes or append a draft twice.
    - **Drafts.** A prepared rule, from an approval card's "Allow from now on…"
      or from Activity, reaches the store as a queued draft with an id that
      counts up for the life of the edit. The editor appends it to its section in render, whether or not the
      edit is already dirty, marks that section with "Applies to every
      repository on your account. Keep it specific.", scrolls to it, and
      reports the id consumed. So a remounted editor never applies a draft
      twice. A draft waits while a save is in flight (the save's own re-seed
      would swallow it) and while the record is unreadable.
    - **Built-in rules**: a "Built-in: N rules" disclosure per tier, from the
      host's `shippedDefaults`. It is open by default for Never allow, where it
      reads "Built-in: N rules, always on". Each rule is a chip that expands to
      its text (`parseShippedAutoPolicyRules`). Built-in rules come with each
      machine's Traycer version, and the tab says so once.
    - **The policy cache is partitioned by SIGNED-IN USER.** The record is
      account-owned while the query is host-shaped. `useAutoPolicyQuery` puts
      the viewer id in `cacheKeyIdentity`, and the save's write-through
      addresses that one partition (`hostQueryKeys.autoPolicyForViewer`), not
      the method-scope prefix. `autoJudge.get` takes neither: it answers from a
      file only this GUI writes on that machine.
  - **Activity** (`activity-tab.tsx`) is the host's recent judge decisions,
    newest first, from `autoJudge.listRecent` (the whole 200-entry ring,
    refetched on every mount).
    - **Five filters over four families:** All · Allowed · Asked you · Refused ·
      Couldn't decide.
      - A `block` that asked nobody (`unattended`) is **Refused**, not "Asked
        you".
      - Refused uses the warning recipe, and its Why adds the card's unattended
        sentence.
      - A filter that matches no row replaces the table with one line: "No
        decisions match this filter."
    - **Why** is the rule's display name plus the judge's reason. A Couldn't
      decide row gets the card's own human line for an `auto: ` reason, else
      its `failureKind` family. The kinds a Judge setting fixes
      (`no-judge-configured`, `judge-unavailable`, `adapter-failed`,
      `selection-unreadable`) add "Fix in Judge", which switches tabs.
    - **"Allow from now on…"** appears on an Asked you or Refused row with tier
      `soft` and a rule, the card's own rule. It drafts the same narrow text as
      the card (`autoModeRuleDraftText`, narrowed by the chat's workspace when
      this window holds the chat open) and hands it to Rules. A draft must
      name the action (`autoModeRuleDraftAction`), so an entry offers no draft
      when it has no input and no tool name, or only a generic tool name such
      as `Bash`, which would allow every command of that tool.
    - A conversation is named by its LIVE title when this window has it open
      (`hooks/chats/use-visible-chats.ts`), else by the title the host
      recorded, else "Untitled conversation".
  - **What the card says when the judge does not decide** is the other end of
    this page, and lives in the chat rather than in Settings
    (`chat/segments/approval-card-disclosure.ts`, rendered by
    `composer-slot-approval-queue.tsx`). The host's `auto: …` reason is printed
    verbatim and in mono - a screenshot of one is a diagnosis - with a human
    sentence BESIDE it, never in its place. There are three sentences, because
    the constants describe three situations and one sentence is false for two
    of them:
    - **did not run** (`auto: no judge configured`, `auto: judge unavailable
(…)`, `auto: judge failed`): `judgeCouldNotRunSentence` says "The judge
      couldn't run." or, when the machine string carries a cause in its
      parentheses, "The judge couldn't run: {cause}.", followed by the "Fix in
      Permissions ▸ Judge" link.
    - **ran without deciding** (`auto: judge returned no verdict`,
      `auto: unparseable verdict`): "The judge reviewed this but didn't reach a
      verdict, so it's asking you instead."
    - **ran out of time** (`auto: judge timed out`, `auto: judge exceeded <n>
min`): "The judge didn't finish in time, so it's asking you instead."

    The second family is the one a single sentence got wrong: the judge's own
    reasoning about the action sits directly above that line. The wire carries
    `{ rule, text }` and no outcome, so the family is read off the STRING. An
    `auto: ` constant this build does not know falls back to the "couldn't run"
    sentence. That includes the four the host emits outside the three families
    (`turn stopped`, `judge preflight timed out`, `judge tools unavailable`,
    `account policy could not be read`), all of which that sentence describes
    truthfully. Activity's Couldn't decide rows use the same three sentences:
    the card's own line for a recorded `auto: ` reason, otherwise the family its
    `failureKind` names; "Fix in Judge" there keys on the kind.

- `Agent selection` (section id `agents`, route `/settings/agents` - both kept as
  compatibility identifiers) Editor for the **global** agent selection guide
  (`~/.traycer/agent-selection-guide.md`) - the instructions Traycer agents read
  to choose harnesses, models, and reasoning effort when creating or
  reconfiguring Traycer agents. The guide does not automatically configure
  provider-native subagents, which follow the provider's configuration and have
  no separate Traycer agent IDs. OpenCode's native task uses the named agent's
  configured model, or inherits the parent model when none is configured. The
  panel description explains this scope; the shared guide output and host prompt
  carry the same distinction. The host prompt also describes the existing
  `traycer_list_harness_models` → `traycer_create_agent` (explicit `harnessId`
  and `model`) → `traycer_send_message` path for routing to a Traycer child.
  A full-height CodeMirror Markdown source editor provides syntax
  highlighting and line numbers, including for Mermaid and wireframe fences.
  It debounce-auto-saves (and flushes on blur) via
  `agent.selectionGuide.setGlobal`; a quiet "Saving… / Saved" status sits in the
  footer, no Save button. A **Revert to default** button (disabled while the
  content already equals the provider-based default) calls
  `agent.selectionGuide.resetGlobalToDefault` behind a `ConfirmDestructiveDialog`.
  The editor has NO host selector of its own - the sidebar switcher scopes it.
  It reaches non-active hosts with a transient `useHostClientFor` context
  override and remounts on `scope.hostId` so one host's file never carries into
  another; the whole subtree stays unmounted until `isHostScopeUsable`, so the
  guide query cannot fire against the ambient host. Backed by
  `agent.selectionGuide.getGlobal` (returns `{ content, generatedDefaultContent }`),
  `agent.selectionGuide.setGlobal`, and
  `agent.selectionGuide.resetGlobalToDefault` through the agent selection guide
  hooks. This settings panel edits only the global guide. A workspace can add
  `.traycer/agent-selection-guide.md` manually; agents layer that file over the
  global guide when they work in that workspace.
- `Fallback` (section id `fallback`, route `/settings/fallback`,
  `panels/fallback-settings-panel.tsx` plus `panels/fallback/`) The whole
  configuration surface for **automatic provider fallback**: what the host does
  when a turn dies on a provider error it cannot retry (rate limit, outage,
  billing, signed out). Backed by `providers.fallbackPolicy.get` / `.set`.
  - **Host-scoped like Agent selection**, and for the same reason: the policy
    lives in `provider-accounts.json`, which is machine-local, so it is one
    policy per Traycer user **per host**. The panel mounts `HostScopeGate`,
    re-provides `HostRuntimeContext` only at `status === "ready"`, and keys its
    editor on `scope.hostId` so one machine's draft can never be saved to
    another's row.
  - **It is the one panel that names its host in the description** -
    "Applies to your chat agents on `<host name>`" - which is a deliberate
    exception to the no-readout rule above. The sentence is not a second copy
    of the sidebar's label; it rules out the reading that this configures every
    agent on the machine. The policy covers that user's **chat** agents and
    never terminal agents, which cannot be reconfigured in place and get no
    fallback at all. The chat surfaces link in here from another host's chat
    (through `carryViewedHostIntoSettingsScope`), which is precisely when a
    panel that said nothing would be editing the wrong machine.
  - **Groups**: Fallback (the `Automatic fallback` master switch, off by
    default, and the `Try these in order` step editor), Behavior, Equivalent
    models, Advanced per-failure overrides, and a Danger Zone. Every policy
    field is compared by `fallbackPolicyValuesEqual`; a field missing from that
    function is equal to itself by omission, so an edit to it alone would
    compare equal to `persisted` and the notice would call an unsaved change
    stored.
  - **The step editor is the only drag surface in Settings**, so it carries ▲▼
    buttons as well: a pointer drag is unreachable from a keyboard and awkward
    on touch, and this list is the feature's whole configuration. Only
    `PointerSensor` is registered - the buttons are the keyboard and touch
    path, and two competing keyboard gestures over one list would be worse than
    one. `Notify me` has neither handle nor arrows.
    **The handle is therefore hidden from assistive technology, not merely
    silent (follow-up AX7).** dnd-kit's `attributes` put `role="button"`,
    `tabIndex={0}`, `aria-roledescription="sortable"` and an `aria-describedby`
    pointing at its own instructions - "press the space bar, use the arrow
    keys" - on the handle span, and with no `KeyboardSensor` nothing implements
    that gesture. So the handle was promising a gesture that does nothing, to
    exactly the users who cannot use the gesture it does have. Only `listeners`
    are spread now, which keeps the pointer drag and drops every promise, and
    the span is `aria-hidden` with no label: it is a grip affordance for a
    mouse. What replaces the promise is real - the `<ul>` is `aria-labelledby`
    the "Try these in order" heading and `aria-describedby` the instruction
    paragraph below it, whose first sentence names the Move up and Move down
    buttons as the way to reorder. One paragraph, the visible one, rather than a
    screen-reader copy that could drift from it. The alternative -
    registering a working `KeyboardSensor` - was available and rejected for the
    reason above: it would put two keyboard gestures on one list.
  - **`Notify me` has no switch either.** It used to carry the same `Switch` as
    every other row, beside copy saying "Always runs when nothing else worked" -
    two statements that cannot both be true, and the one a first-time user
    believes is the switch. They read it as a notification preference; it is
    nothing of the kind. Turning it off suppresses no notification (exhaustion
    ends in the same terminal consequences and the error card is always
    published). What it changes is narrower than the line that used to sit here
    ("whether a notify-only grace hold arms"), which is now false: a
    non-transient failure whose plan narrows to `notify` alone **does not arm at
    all**, so there is no countdown for the step to add or remove - the chat
    takes the terminal path and the user gets the error card's manual steps. The
    step still buys something for the two TRANSIENT reasons
    (`provider_unavailable`, `provider_connection_failed`): their plan narrows
    to `notify` alone, they arm for a short same-tuple retry series, and they
    settle at `notify` with no countdown at any point. Remove the step from
    their plan and nothing arms, so the retries are lost with it. Neither is a
    choice this page can explain on a switch. So the
    ordinary state renders a static `Always`, matching the reserved gutters the
    row already draws in place of a handle and arrows: absence says "this cannot
    be changed" once, where a disabled switch invites the reader to look for the
    state that enables it. A stored ladder that OMITS the step still renders
    honestly, with a one-way `Add this step back` link - there is deliberately
    no path from here to turning it off, so nothing implies the
    always-published error card is something the user switched on.
  - **Enablement is PRESENCE in the stored `ladder`**, which cannot represent
    where a turned-off step sat. The panel therefore holds the four-row display
    order in its draft and persists only the enabled subset; a step turned off
    and then reloaded loses its exact position, and the editor's own copy says
    so. The alternative was widening the wire shape to `{ kind, enabled }[]`,
    which would have reached the host's validation and the engine's ladder walk
    for a presentational fact.
    **A turned-off step goes as late as it can, which is NOT the end**: it is
    placed immediately before the `notify` slot. `notify` is the terminal step -
    the engine's ladder walk stops at the first one it reaches - so a row after
    it can never run, and a disabled row is exactly the one a user is about to
    turn back on. Appending past `notify` handed them a step that read as
    enabled and was unreachable, with nothing on screen saying so; the wire
    permits such a ladder (uniqueness and length are all it checks) and the host
    stores it verbatim, so nothing downstream repaired it either.
    **The display order also survives a save echo.** The echo carries back the
    ladder that was just SENT, which encodes enablement as presence and so
    cannot say where the turned-off steps sat - re-deriving from it moved them,
    which made "turn a step off, let the save land, turn it back on" write a
    ladder the user never arranged. `fallbackDisplayOrderFor` keeps the local
    order whenever the incoming ladder is what that order already produces for
    its enabled set, and derives afresh only when the incoming policy genuinely
    reorders (a restore, or a policy written elsewhere). An externally authored
    early `notify` still renders where it is stored.
    **Rendering an early `notify` honestly is not the same as letting rows cross
    it.** Holding the `notify` slot fixed stops `notify` moving and says nothing
    about the other rows: with `[profile, notify, tier]` hydrated, the movable
    list is `[profile, wait, tier]` around a fixed slot, so dragging `profile` to
    the end of that list writes `[wait, tier, notify, profile]` - an enabled step
    that ran a moment ago, now below the terminal one, from a gesture that
    mentioned neither. The same splice can do it to a row the user never touched:
    dragging `tier` to the top shifts an enabled `wait` down across the slot, so
    clamping only the moved row would not close it. `moveFallbackRung` therefore
    REFUSES a move whose two ends lie on opposite sides of the slot, and the ▲▼
    buttons are disabled at that boundary so a refused move is never offered as
    an active control. Neither can fire on a ladder this panel wrote, where
    `notify` is last and every movable row is above it.
  - **Overrides is a responsive list of problems with one inline editor open
    at a time.** Every row starts collapsed and shows its configured behavior
    and whether it follows the main plan or has a saved custom rule. Expansion
    is local UI state, never a policy write. Eligible actions are checkboxes;
    unavailable actions are explained in a disclosure, never disabled controls.
    Rows and eligibility are derived from the protocol taxonomy. Connection
    failures and excluded reasons have read-only summaries, with a per-reason
    reset when a stored override exists.
    The preview respects the stored order and stops at the first `notify`;
    selected actions after it are marked as unreachable. A transient retry is
    shown only when the narrowed sequence is nonempty. Explicit `"off"`, empty
    sequences and sequences with only ineligible actions do not promise retries.
    With automatic routing off, summaries describe what the settings would do
    when it is enabled. Billing's notification and confirmed-sign-out gating
    remain disclosed, and switch choices explain the fresh session.
    Writes still use the existing four-row display order, carry terminal
    `notify` through, and remove an override only when its FULL sequence equals
    the base plan. Disabled checkboxes keep their place when that order agrees
    with the saved sequence; viewing an older custom sequence never rewrites it.
    **Use main plan** removes one override; **Reset all to main plan** removes
    all overrides without touching other policy fields. Undo is an inverse of
    that reset, held by the parent editor so it survives a tab change. It waits
    for a confirmed current view, is unavailable for unknown/refused saves,
    preserves unrelated fields, and expires on the next policy edit, full reset,
    group restore, or device/editor remount.
    Save feedback sits above the collapsible list. Unknown request IDs retain
    their originating row so a collapsed row can say **Check save** without
    treating the most recently edited row as the failed request. Existing
    tab-level attention and the parent reducer's save/reconciliation rules
    remain authoritative. Quiet save confirmation requires the submitted policy
    to match the current confirmed view; a read-back that restores older values
    cannot claim the change was saved. Undo and read-only reset restore focus to
    stable labels. No new policy storage or recovery engine behavior.
  - **Equivalent models** is the user's statement about which models are
    interchangeable, and the only thing that makes the "equivalent model" step
    possible - the host will not move a chat between a standard and a frontier
    model on its own guess. The vocabulary is **tier**: the seed is three tiers,
    **Frontier**, **Flagship** and **Standard**, and each tier is a list of rows
    tried top to bottom. Each row is **provider + model or pattern + optional
    effort**, with a `#` rank in front of it.
    **The Model cell is a combobox over the provider's catalog**
    (`fallback-model-pattern-combobox.tsx`, composed from `command.tsx` and
    `popover.tsx`) on a host whose `providers.fallbackPolicy.get` line is 1.1 or
    later - read off the NEGOTIATED line (`useFallbackPolicyPatternLines`),
    never inferred from a preview response carrying `matches`, which the
    1.0 → 1.1 upgrade synthesises. What it saves depends on what was typed:
    an exact model id or label puts that model first and picking it stores its
    SLUG; three or more other characters make the first option **Any model
    containing "…"**, which saves `*text*`; and a typed `*` builds the pattern
    as written (`*` is the only wildcard, matched case-insensitively against
    slug and label by the protocol's `modelMatchesPattern`). A bare `*` is
    named **Any <provider> model** ("Any Codex model") in the option, the
    cell and its accessible name, beside the mono `*`, so the row says it
    claims the whole provider. The models the pattern reaches are numbered in
    the order they would be tried, and while a pattern is being typed the
    input row counts how many it reaches. A pattern row wears the `*` badge
    (text alternative "pattern") where the old "family" tag was, and the
    trigger's pill - "2 models", or "1 conflict" - is part of the trigger's
    accessible name. The trigger declares `aria-haspopup="dialog"`: what opens
    is the popover, which holds the list's own combobox input and listbox.
    A catalog that answers while the list is open re-seeds the highlight as a
    fresh open would, so Enter on an exact pick still picks the model.
    **A model can be in only one tier.** A model another tier already owns is
    listed as **in <tier>** and cannot be picked; a pattern that would reach
    one is offered disabled, with the reason ("GPT-6-Astra is in frontier and
    GPT-6-Sol is in flagship") as its description, and Enter on it announces
    that reason through the editor's `role="status"` region rather than
    saving; its hint suggests a narrower pattern that is free (for example
    `*gpt-6-luna*`). The keyboard reaches refused options - the list drives its
    own arrows, since cmdk's skip `aria-disabled` items - so a refusal can be
    heard. A stored policy that breaks the rule anyway (written by an older
    client, or by an edit elsewhere) is RENDERED, never refused: both rows get a
    red **conflict block** naming the other tier, saying the first tier
    handles the model because it is listed first, with **Edit pattern** (or
    **Change model** on an exact-pick row) and **Go to the <tier> row**. The
    block is `role="alert"` only on the conflict's FIRST appearance in the
    panel (`fallback-conflict-announcements.tsx`, keyed by harness, model slug
    and the set of tier ids, and held for the policy editor's lifetime): the
    Equivalent models tab unmounts when left, and a permanent alert re-read
    every conflict on every visit. **Go to the <tier> row** moves focus to that
    row's Model cell, addressed by the row's draft key like the removal
    handoff below. Conflicts are computed draft state
    (`fallbackTierConflicts` over `findTierConflicts` and the catalogs the
    editor already holds), never a validation error: **there is no save gate
    anywhere** - the master switch, the timings and every other tier still
    commit while a conflict stands, and an Undo that brings one back is not
    refused.
    **Each row's status line** comes from the preview's `matches[]`, falling
    back to `resolvedModel`: "Tries A → B → …" in try order, a match the walk
    would skip struck through with an amber `warning` pill, "No <provider>
    model matches <pattern>" in red for a pattern that matches nothing, and
    "Can't check right now: …" in neutral when the check itself was skipped
    for an environmental reason. An exact pick that resolves to itself says
    nothing - the line appears only when it adds something.
    Effort offers the picked model's own `supportedReasoningEfforts` for an
    exact pick, the UNION over the pattern's matches for a pattern, and the
    union across the harness's models when the pattern matches nothing yet
    (the effort applies to whichever model the hop takes); the catalogs come
    from `agent.gui.listModels`, read once per DISTINCT harness in the draft
    through the same cache-only slots the model pickers use and gated on
    availability (`fallback-catalog-options.ts`). Changing a row's provider
    clears its model and effort, since both are one catalog's vocabulary.
    **On a 1.0 host the Model cell is the old select**, unchanged: it lists
    the catalog by label and stores the slug, a stored value that is not a
    catalog slug is pinned as the first option and tagged "family", and no
    conflict is drawn - "one model, one tier" is a pattern-era rule a 1.0
    host's word matcher does not apply. The try line renders on both.
    **The preview** is asked only for the tiers on screen. On a
    `previewTierGroups` 1.1 line a blank draft row travels in the request and
    comes back as a skipped row, so adding a row no longer blanks every other
    row's line; on 1.0 a blank row still closes the gate, since the 1.0
    request cannot encode one.
    **The default tier** ("For a model not in any tier", one select above the
    list, a `Default` pill on the card) is the tier the step uses for a model
    in NO tier. The seed sets it to **flagship**, so an unlisted light model
    (a Haiku, a mini) is now tried against Flagship models rather than skipped;
    "None - skip this step" keeps the old behaviour. The editor carries the
    marker through a rename, clears it on a delete and restores it on that
    delete's Undo; the schema refuses a default naming no tier. The Ladder
    tab's step hint asks the same question the error card's verdict does
    (`tierGroupsNameDestinationFor`), over the DRAFT and the editor's cached
    catalog for the last-run harness. On a 1.0 host it asks the released
    rule instead (`fallback-legacy-family-routing.ts`), because that host
    reads a row as a family word: a whole word in the model's ID (never its
    name), the longest family deciding the tier, then the default tier. The
    pattern answer there would tell a user whose `gpt` row routes
    `gpt-6-sol` to a Claude model that nothing is set up. The per-row preview cannot supply
    effort normalisation: with no failed tuple the engine's walk stops at the
    resolved slug and never reaches it, so it returns no effort information.
    A stored effort outside the offered set keeps an option of its own and
    stays selected, marked as not offered - the same range-render rule the
    provider select and the timings use. Effort is ALWAYS a select - there is
    no free-text effort input. When nothing is offered (an older host, a
    harness the user no longer has, a cold slot) it still renders: disabled
    on "Any effort" when that is the stored value, since there is nothing to
    pick, and enabled when a value IS stored, so the one edit still possible -
    clearing it back to "Any effort" - stays possible. The provider select offers the GUI-capable
    harnesses only - the rung skips anything else with `harness-not-gui` - and
    a stored id outside that set still gets an option of its own.
    **Test a model** (`fallback-test-model-panel.tsx`, pure half in
    `fallback-test-model.ts`) is a button in the section header that opens an
    INLINE panel under it - not a dialog, so the tiers it tests stay on screen.
    It reads "If <provider> <model> is blocked by <a rate limit | another
    error> …", with the account (that provider's last-used, checked against its
    live accounts, else the first account listed - never a disabled Terminal
    account; no control for a provider with none) and the permission mode (the
    user's default, clamped to what the provider honours) beneath. This picker
    uses the shared presentation order, with Auto last and its **Experimental**
    badge on both the option and selected value. Agent mode
    and fast mode are carried from the defaults, as the new-conversation modal
    seeds them. A model catalog that fails to load says so in the Model picker
    and offers "Try again". It answers for the DRAFT, blank rows and an unsaved
    default tier included. The tier comes from the protocol's
    `routeTierGroupForFailedTuple` with the editor's cached catalog - the
    readable-catalog answer - as "Traycer uses the <tier> tier · <model> is in
    it through <pattern> (row n)"; the "(row n)" lookup uses the router's own
    identity (`failedModelRoutingIdentity`). Every row of that tier follows
    with each match in try order, from `previewTierGroups`@1.1 called with
    `blocked` set to the tuple, so the host runs the live walk (same-as-failed,
    permission-mode fit, the sibling rule after a rate limit): **switches
    here** (`success`), **then**, and **skipped · …** - neutral for the blocked
    model itself and a blank row ("blank, skipped"), amber `warning` for the
    world, red for a pattern that matches nothing. The wireframe's own words
    where it names one ("the blocked model"), the host's label otherwise. At
    phone width a pill drops under its model and wraps inside itself (`Badge
wrap`). Each row names the account its first usable match runs on, the
    Terminal account included. The walk is asked about the tiers as last
    COMMITTED (the draft reducer's `committedTiers`), so a tier rename typed
    into the name field sends nothing until it commits on blur, while the
    header follows the live draft at once. When the walk comes back without
    the routed tier's rows - the host read the model's name from its own
    catalog and routed it elsewhere - one line says which tier the host would
    use, never a named tier over empty rows. Below the rows, "If none of these
    work: …" is the draft's steps after the equivalent-model step for that
    failure. "Another error" stands for every failure other than a rate limit
    that can reach the equivalent-model step (auth, billing, model
    unavailable, provider unavailable), each on its own effective ladder (its
    override, else the main order, narrowed to the steps that failure can
    take): when they agree the line says so, and when they differ it says
    "depends on the error; see Overrides". Three footers cover what the header
    alone would hide: a model in no tier goes to the default tier; with the
    default set to None there is no equivalent-model step and it goes straight
    to the next step; a model in two tiers is handled by the first-listed, with
    a red **fix** that moves focus to that tier's row (the conflict block's
    go-to-row). A failure whose steps leave out the equivalent-model step (or
    turn them all off) says so in one line, naming the step it goes straight
    to, instead of a tier that never runs. With **Route automatically** off the
    host arms nothing, so the verdict leads with "Route automatically is off,
    so nothing switches on its own. With it on:" and still shows the dry run.
    Escape and ✕ close the panel and return focus to the button. The verdict
    is announced as ONE sentence through a visually hidden polite status
    mounted with the panel (the tier, and where the chat switches to); the
    visible rows and pills are not a live region. It is offered only on a
    `get`@1.1 host, since its router reads rows as patterns, and the dry run is
    asked only on a host whose negotiated `previewTierGroups` line is 1.1 or
    later - gated in the hook itself, and read off the line, never off whether
    `matches` is present. Below it the walk cannot be asked for, so the panel
    shows the tier verdict and each row's first match from the editor's own
    preview, with "This host can't simulate the walk; showing what your tiers
    say."
    Row ORDER inside a tier is load-bearing (the rung walks it and takes the
    first usable target) so rows carry ▲▼. TIER order is not a routing
    control: a model belongs to one tier, and when a draft breaks that rule the
    fix is the pattern, not the order - so there is deliberately no tier
    reordering, and the conflict block's "listed first" is a description of
    what happens until the fix, not an invitation to reorder. There is
    deliberately **no drag surface here**: the step editor stays the only one,
    because a row list is unbounded and nested inside a scrolling pane, which is
    where drag is worst, and ▲▼ is the keyboard and touch path either way.
    **Narrow panes stack each row** (the editor is an `@container`; below
    `@2xl` a row is rank · provider · effort on one line, then the Model cell,
    the status line and the row actions), with fluid sizing only.
    Empty is a state a user can REACH, and it is not the same as never having
    had tiers: the host seeds on first read and marks the user, so the empty
    state offers **Restore the default tiers**, which calls the RESTORE op
    rather than saving a client-built list - only the host can build the seed a
    first read would have produced - and on a `get`@1.1 host the restore also
    writes the default tier (`flagship`). On a `get`@1.1 host the same control
    also sits in the footer beside **Add tier** while tiers exist, behind the
    shared destructive confirm ("Replace your N tiers with the default
    Frontier, Flagship and Standard tiers? This also sets the default tier to
    flagship."), since there it replaces work and has no Undo; focus returns
    to the button once the restore settles. A 1.0 host gets no footer
    restore, as in the released editor: its restore writes its own older
    seed and keeps the current default, so that confirm would be untrue, and
    it refuses the restore outright when the default names a tier of the
    user's own. The empty state's button restores directly on every host -
    there is nothing to lose, and no tier is left for a default to name. Deleting a
    tier or a row offers **Undo**,
    and undo dispatches the INVERSE of that one removal into the current draft -
    not the policy as it stood when the toast was raised. A toast outlives its
    render, so a captured snapshot also reverted every unrelated setting changed
    since it appeared (the maximum wait adjusted while the toast was still up),
    and an older toast's Undo resurrected a row deleted after it. The inverse
    carries the removed tier or row WITH its identity and its index, so undo
    brings back the same row rather than a lookalike, at the position it held -
    position being the one thing a user cannot retype - and answers "already
    back" or "its tier is gone" by doing nothing.
    **Removal hands the keyboard on.** Filtering out the focused button's own
    subtree left focus on `document.body`: a keyboard user was returned to the
    top of the page and a screen-reader user was told nothing, after a gesture
    they made deliberately. `useRemovalFocus` takes an ordered list of selectors
    and focuses the first that exists once the removal has rendered - the row
    that takes the removed one's place, its neighbour if it was last, then the
    `Add` control. Rows are addressed by their draft key, never by a tier's
    editable name. A new row's model or pattern starts
    EMPTY (invalid until chosen, so an invented default is never saved as a
    choice) while its provider is SEEDED - a closed union with a control right
    there is a starting point, not a fabricated answer.
    **Candidate rows carry a client-side identity** (`fallback-tier-group-keys.ts`),
    minted once when a row enters the draft - at hydration from the stored
    policy, or when the user adds one - held in the draft reducer beside
    `displayOrder`, and stripped before anything is sent. The wire shape cannot
    supply the key: `TierCandidate` is `{harnessId, modelFamily, reasoningEffort}`
    with no id, so a content-derived key collides the moment two rows hold the
    same values (two fresh rows are both empty, and nothing dedupes two identical
    fully-specified ones), and an index key makes React reuse the node at a
    POSITION rather than follow the row - which these rows reorder. A policy that
    arrives from somewhere other than the editor (a host echo, a revert) keeps the
    existing identities when it is structurally the list already on screen and
    re-seeds otherwise; mapping an unfamiliar list positionally would be index
    keying by another name.
    **Groups carry one too** (`draftKey`), and the argument that they did not is
    the one this reversed. `fallbackPolicySchema` refines group ids unique, but
    the id is the group's editable NAME: keying the card on it changed the key
    on every keystroke of a rename, so React destroyed the focused input after
    the first character and blur/Enter never committed the whole name - and the
    intermediate values a rename passes through are allowed to be duplicate or
    empty, which a key has to survive and a unique-id argument does not cover.
    **A REVERT keeps identities where a re-seed would not.** A refused save
    returns the draft to `persisted`, and a rejected value edit differs from
    what is on screen BY DEFINITION - so the structural comparison above always
    failed, every candidate row remounted, and the field the user was still
    typing in was destroyed by the code path whose job was to put their value
    back. `revertKeyedGroups` asks the weaker question - same number of groups,
    each with the same number of rows - and keeps every key when the SHAPE is
    unchanged, because both its callers (the revert, and the read-back below)
    restore a list this editor already held identities for. A shape change (a
    rejected removal) has no correspondence left and re-seeds. The echo path
    still uses the strict comparison: a restore replaces the rows wholesale and
    is not a list this editor produced.
    **A re-seed INVALIDATES a removal's Undo, and that needs a generation
    rather than an address (follow-up #10).** A removal toast carries the
    inverse of its own operation, addressed by `draftKey` - and a re-seed
    replaces every one of those keys, so afterwards the inverse holds an address
    that names nothing, which is indistinguishable from "the row really is still
    missing". Delete `g1` from `[g1, g2]`, let the save be REFUSED (the revert's
    shape mismatch re-seeds every group), rename the restored group to `g3`,
    then press the still-open toast's Undo: neither the stale `draftKey` nor the
    id matches, `g1` is inserted, and one gesture undoes the deletion twice. The
    id check alone got the un-renamed case only, and only because two groups
    with one name is not a valid policy - it answers "would this produce a
    policy the schema rejects", not "is this inverse still applicable".
    `toKeyedGroups` - the single re-seed site, reached by hydration,
    `reconcileKeyedGroups`' foreign list and `revertKeyedGroups`' shape change -
    bumps a module generation, each inverse is stamped with the generation it
    was minted AT (read before the commit that removes the row, never inside the
    Undo callback, where it would sample the generation at Undo time and always
    compare equal), and `applyGroupsInverse` refuses a stamp that has moved. One
    guard for both arms: the candidate arm already failed SAFE for the same
    underlying reason, so the guard makes its reason explicit instead of
    incidental.
  - **When an edit is SAVED depends on the control kind.** Switches, selects,
    ▲▼, buttons and the Model combobox (a value is saved only when an option is
    picked - typing into its search saves nothing) produce a complete value per
    interaction and commit immediately. **The one text field, the tier name,
    commits on BLUR or Enter**, because its intermediate states are not
    values anyone means:
    "fast" passes through "f", "fa", "fas", and a save per character persists
    three tier names nobody chose and spends a catalog read per candidate
    previewing each. Local validation still runs per keystroke, so the inline
    message under a blank tier name appears as it goes blank rather than when
    the field is left. Enter does not also blur - the field is not a form.
  - **A save's echo cannot overwrite a newer draft, and TWO saves cannot be
    confused.** Every edit bumps a `revision`; every dispatched save gets a
    request id minted at the call site (the reducer has not run yet, so the
    revision the request carries is not observable from there) and the reducer
    records the pair in `pendingSaves`. A reply names its request, so it is
    matched to the revision IT carried: the response is applied to the draft
    only when that revision is still current, and otherwise only records that
    the host stored what was sent.
    `pendingSaves` is a LIST because one slot was the defect: every control here
    can commit while another save is in flight, so start A at revision 1 and B
    at revision 2, and B's start overwrote A's marker - when A's reply arrived
    the reducer compared revision 2 with revision 2, decided the echo answered
    the draft on screen, and wrote A's older policy over B's. A third edit then
    started from that stale value and could permanently undo B. `persistedRevision`
    guards the other direction: replies are FIFO in practice, but nothing here
    depends on it, and an out-of-order pair would otherwise leave the OLDER
    value in `persisted` as what the next refusal reverts to.
    Correlating rather than serialising is deliberate: serialising would delay
    the second request until the first settled, which changes when a commit is
    dispatched, and the commit-on-blur/Enter rule is pinned on that being
    synchronous with the gesture.
  - **A failed save says only what it knows about the host's row.** Three
    outcomes, because "your last saved settings are back on screen and still in
    force" is a claim about the host that most failures cannot support:
    - **refused, reverted** - the host answered and rejected the value and
      nothing newer is on screen. Both halves of that sentence are true.
    - **refused, kept** - the host answered and rejected an OLDER draft while
      the user has since changed the same page. The refusal is reported; the
      revert is not applied, because it would throw away typing the host never
      judged, and that edit carries itself to the host through its own commit.
    - **unknown** - the request went out and no answer came back. The host may
      have committed and lost the reply, so nothing may be claimed. The draft
      stands and a **read-back** settles it.
      The line is drawn on the transport's own error classes, not on
      `isTransientHostRpcFailure` - which merges the first and third (and folds in
      a host-ANSWERED fatal marked `retryable`, so it used to print "couldn't
      reach this host" about a host that had just answered).
      `RetryableTransportError` carries an explicit "the host never dispatched
      this request" guarantee, so "nothing was saved" is true and the revert is
      right; any other `HostTransportFailureError` is the ambiguous post-send
      case. At its worst the old copy told a user automatic fallback was off while
      the host had it on.
      The read-back is the **only** action that installs a policy this editor did
      not send, and it is gated twice: it must name the request that went
      unanswered, and it replaces what is on screen only while the user has not
      edited since - so the standing rule that a later read never yanks a control
      out from under someone mid-edit still holds. A read-back that fails leaves
      the notice standing with its own **Check again**. The ticket is superseded
      only by a newer save that SUCCEEDS - a newer save's start, and its refusal,
      both preserve it, because starting is not an answer and "B was not written"
      says nothing about A - or by a confirmed reset **that went out after the
      unanswered save**, which voids the question rather than answering it. Both
      discharges are the same request-ORDER test, and the reset needs it for the
      same reason the success does: a reset is no evidence about a write
      dispatched later than itself, and voiding that write's ticket left the
      uncertainty notice on screen with nothing behind its retry. A late answer
      to a ticket that really was superseded is dropped.
  - **The per-row "resolves to" preview is an RPC, not a computation.**
    Resolving a family to a slug needs the live catalog, the provider's enabled
    and runnable state, and which account would run it - none of which the
    renderer has. `providers.fallbackPolicy.previewTierGroups` runs the engine's
    own `enumerateTierCandidates` walk, so the editor cannot offer a target the
    engine would skip. It renders the host's `skipLabel` rather than decoding
    `skipReason`, so a reason a released client has never heard of still prints
    a sentence instead of blanking the row, and `null` preview data renders no
    verdict line at all - the honest absence on a host too old to answer.
    The read is gated on two separate questions: the host must ADVERTISE the
    method (it is optional rather than floor, and `useHostSupportsMethod` fails
    closed), and the draft must be VALID - the request schema requires a
    non-empty `modelFamily`, so the empty row "Add a model" creates on every
    click cannot be encoded, and an ungated preview would turn ordinary editing
    into a malformed-request error. Both gates render the same `null`. There is
    no `placeholderData` carrying the previous answer across a key change:
    verdicts pair to rows by `candidateIndex`, which is sound only while the
    list they were computed for is the list on screen.
    The "on &lt;account&gt;" clause names the **account, never its id**. The
    wire `profileId` is a managed-profile uuid, so rendering it produced
    "resolves to gpt-5.6-sol on 3f2a9c1e-…" - the defect D118 fixed host-side,
    on the one surface whose job is to say what a row will do (D190). The label
    comes from the `providers.list` read this panel already makes, and the RULE
    is shared with the chat cards (`buildFallbackProfileLabels` /
    `resolveFallbackProfileLabel`) rather than restated: two implementations
    would be two ways to name one account, and two truncations of one id read
    as two accounts. Duplicate labels get a bracketed id prefix; an id that
    cannot be resolved degrades to its 8-character prefix rather than vanishing,
    because a row describing an account still has to name it. `profileId: null`
    omits the clause entirely - distinct from the chat cards, where `null` is a
    terminal agent and is NAMED "Terminal account".
    **A FAILED preview is not an absent one, and the editor now says which
    (follow-up FC9).** `preview` is data-or-null and a null renders no line, so a
    failed check looked exactly like a host that had never been asked: no
    answer, no explanation, no way to ask again. D159 accepts the null OMISSION
    as a fidelity rule - never guess a verdict in the client - and this is the
    usability half on top of it, not a reversal. ONE editor-level line beside
    "Add a group", never one per row, because the failure is one request
    covering every row: "Couldn't check what these models resolve to." with a
    **Try again**. It is `role="status"`, not `role="alert"` - the rows stay
    editable and savable, and a verdict is an advisory the page works without.
    Keyed on the query's `isError` and nothing else, which is exactly "we asked
    and it failed": both reasons this query deliberately answers nothing leave
    it false, since a closed gate leaves the query disabled and `pending`, and a
    host that does not ADVERTISE the method never runs it. That last case
    therefore still renders nothing and offers no retry, which is the stated
    limit: that host will never answer, and a Try again for it would be a
    control with nothing behind it. Pending wins over unavailable by the
    `!previewPending` term in the footer's `failed` - a retry in flight is an
    answer on its way - so this remains the single pending indicator D159 asks
    for. The `role="status"` region is **mounted on every path, empty
    included**, and only its TEXT swaps: a live region inserted into the tree
    together with its content is announced unreliably, and for this row the
    announcement IS the difference between a failed check and an absent one, so
    a screen-reader user who is never told would be back to the two being
    indistinguishable. That is why the exclusion is a condition rather than the
    early return it used to be - an early return cannot keep the region
    mounted. Stale
    verdicts against an edited row need nothing new: the request's own groups
    are the query key, so a changed list is a different cache entry and there is
    no `placeholderData`.
  - **Danger Zone** holds one action, `Reset all fallback settings`, and its
    confirm body names its scope because every part of that scope is guessable
    wrong: what it touches (steps, both timings, model groups, overrides - not
    just the master switch), whose and where (one Traycer user on one host, not
    the machine), and what it does not touch. On that last point the copy stops
    at the true half: an armed traversal froze its ladder, grace window, max
    wait and return-to-preferred into a snapshot, so a policy write cannot move
    them - but the tier rung re-reads the model groups LIVE, so a reset does
    change where an armed traversal can hop to. It says "keep the steps and
    timings they started with" and claims nothing more.
  - **Reset re-reads and remounts; restore writes in place.** The asymmetry is
    the seed marker. `reset` clears it, so the default policy it returns is
    stale the moment the next read re-seeds - writing that response into the
    cache would show an empty model-group list while the engine resolves against
    a full seeded set. So the panel performs its own `refetchPolicy()` after the
    reset and remounts the editor (a `resetGeneration` in its key) onto what
    came back, which matters because the reducer is seeded ONCE and deliberately
    ignores later reads. `restoreTierGroups` does not clear the marker, so its
    response IS what a later read would produce and `save-succeeded` takes it
    directly.
    **Confirmed reset and successful refresh are reported separately**, and the
    panel remounts only on the second. The hook's `invalidateQueries` is
    `refetchType: "none"` and starts no fetch, because an invalidation could not
    have reported one anyway: `refetchQueries` swallows a failed fetch
    (`if (!fetchOptions.throwOnError) promise = promise.catch(noop)`) and its
    `Promise.all(...).then(noop)` resolves either way, so awaiting it from
    `onSuccess` - which this used to do, and describe as waiting for fresh data
    - remounted the editor onto the pre-reset cache and presented it as the
      result of the reset. When the read fails now, the reset is NOT called
      refused: the editor stays as it is under a panel-wide banner saying the
      reset went through and these values are out of date, with a **Try again**
      that re-reads and remounts on success.
      That banner is panel state of its own, not a fourth save-notice outcome:
      a save notice describes ONE request and is correctly cleared by the next
      edit and the next save start, whereas this describes the HOST'S ROW, which
      no keystroke here can change. It carries the revision as of the reset's
      **dispatch**, because its strongest sentence is about where the values on
      screen came from and that sentence expires the moment they change - after
      an edit the display is the user's own draft, which a save since may well
      have stored, so the banner keeps a weaker second sentence ("what the reset
      left has not been read yet") rather than a false first one. Dispatch and
      not the moment the read failed: the read is a round trip during which every
      control except Reset and Restore stays live, so a save submitted inside
      that window had already moved the revision, and the banner called a
      post-reset policy the settings from before the reset. It is cleared by a read that
      succeeds, by a save that succeeds ON THE DRAFT BEING SHOWN, and by an
      old-revision success that is ADOPTED into the view to correct a refusal
      rollback - but not by an old-revision success the user has typed past,
      where the host's row still is not what is displayed. It is also not RAISED
      by a reset's failed read that a later write has already answered for: the
      same request-order test the ticket uses, or the page would claim staleness
      about a policy confirmed into it a moment earlier.
  - **The confirmation returns the keyboard, in two halves.** `ConfirmDestructiveDialog`
    is opened by setting `open` from a button rendered outside the dialog's own
    root - no caller renders a `DialogTrigger` - so Radix's modal content was
    focusing a null trigger on close, and because its handler prevents the
    default first, the FocusScope's generic "restore what was focused before"
    was skipped too: Escape and Cancel dropped focus on `document.body`. The
    shared dialog now captures the opener in `onOpenAutoFocus` (the one moment
    it is still the active element - the FocusScope dispatches that after
    reading `document.activeElement` and before moving focus in) and restores it
    in `onCloseAutoFocus`. That is a fix for every caller of the shared dialog,
    not just this one.
    It cannot cover a CONFIRMED reset, because the remount above detaches the
    Reset button before the dialog closes - so the opener is checked for
    `isConnected` and the surface owns that case: the panel remembers that the
    replacement was a reset and the new Danger Zone takes focus onto its Reset
    button as it mounts, then clears the intent so a later remount for another
    reason (a host switch) does not steal focus onto a button nobody pressed.
    A REFUSED reset has a third path and it restores focus **only from an
    unclaimed one** (OSS review P2 / R-OSS-2). Confirming closes the dialog and
    starts the request in one gesture, so by the time Radix runs its deferred
    `onCloseAutoFocus` the opener is mounted but `disabled={isPending}` - the
    dialog takes the live-opener branch, prevents Radix's own restoration, calls
    `.focus()` on a disabled button, and focus lands on `document.body` and
    stays there. The Danger Zone repairs that when `isPending` falls. It used to
    do so unconditionally, and the rest of the editor stays interactive while a
    reset is pending, so a user who had moved to a Model family field was pulled
    off it - and the forced blur ran `CandidateRow`'s commit-on-leave, SAVING a
    half-typed family and replacing the reset's own refusal notice with an
    unintended save. So the restoration is gated on `document.activeElement`
    being `document.body` (or null), which is exactly the state it exists to
    repair; anything else holding focus is a deliberate move and outranks a
    deferred restoration. Checked at settle time rather than by subscribing to
    focus changes: there is no window between the two where the answer differs.
  - **Form RELATIONSHIPS, not just names (follow-up AX8).** Every control on
    this page already had an accessible name; what was missing was what each
    name belongs to, and the names are the problem - "Provider", "Model
    family", "Effort", "Move up" repeat across every candidate row of every
    group, so with two groups on screen the names alone cannot say which group
    is being changed, and with two rows in one group they cannot say which row.
    Four fixes, and the first one is why the others are small:
    - **Named CONTAINERS rather than qualified labels.** Each group card is a
      `role="group"` labelled `Model group <name>` (or `Unnamed model group`,
      a state the user can reach and hold), and each candidate row is a nested
      `role="group"` labelled `Model <n>`. Group context is announced on entry
      and then stays out of the way, where "Model family, row 2, group fast"
      would be read on every field - and it leaves every existing
      accessible-name query in the tree working. `aria-label` and not
      `aria-labelledby` pointing at the name field, because the group's name is
      an editable INPUT and an input is not a label; computed from the current
      value, so it follows a rename.
    - **The master switch consumes its row's description.** `SettingsRow`
      publishes its description id through `SettingsRowDescriptionContext`, and
      only something rendered inside the `control` slot is below that provider -
      which an inline `<Switch>` built one component up was not. So the
      paragraph explaining what turning fallback off does, including the live
      "N in progress right now" count that is the fact the decision turns on,
      had no programmatic relationship to the control it explains. It is a
      component now (`MasterFallbackToggle`), which is what the two Behavior
      timings already were.
    - **The return-to-preferred radios get a group name and per-option
      descriptions.** That row is hand-built rather than a `SettingsRow`, which
      is exactly why it had neither: the `radiogroup` is `aria-labelledby` the
      "When the original provider's limit resets" heading and
      `aria-describedby` its caveat, and the `auto` option is
      `aria-describedby` its own consequence paragraph - the fresh session and
      the queued messages moving back, which is the whole reason this row is
      radios instead of a select. Options with no consequence get no
      description rather than a dangling id.
    - **Verdicts describe their field, and the validation error names its
      row.** A row's preview line is the Model family field's
      `aria-describedby` (dropped when there is no verdict, since the absence is
      itself meaningful under D159), a blank family carries `aria-invalid`
      because the wire schema rejects it and it blocks every commit on the page,
      and `draftIssueMessage` now says `Model 2 in “fast” needs a family name.`
      rather than `A model needs a family name.` Validation is whole-policy, so
      one blank field holds the master switch too - and the one error line a
      user gets has to say which of a dozen rows is holding it. The row is
      identifiable visually by where the message sits; it was not identifiable
      at all by anything read aloud. The container label and the message use the
      same words for a row (`Model <n>`, and the group by name) so the two agree
      about what to call it.
  - **The failure outcomes are decided once** in
    `fallback/fallback-policy-draft.ts` rather than per control. A **local
    validation failure** keeps the draft in the control, shows the error and
    **sends nothing**. A **host rejection** prints the host's reason, and
    reverts the control to the last persisted value only when that revert is
    supportable: not when the user has edited since (the refusal judged an
    older draft, so reverting would throw away typing the host never saw), and
    not while an earlier save's outcome is still unknown (the persisted value
    may already be stale, so "still in force" would be a claim about the host
    that nothing has established). A **lost reply** claims nothing at all: the
    draft stands, the notice says the value may or may not have been saved, and
    an authoritative read-back - automatic, with a "Check again" retry - is
    what settles it. Only a successful save (dispatched after the unanswered
    one) or that read-back discharges the uncertainty - a newer request's START
    is not an answer at all, and its REFUSAL answers for itself alone: "B was
    not written" says nothing about whether A was. A confirmed reset discharges
    it too, by voiding the question rather than answering it - but only when the
    reset went out AFTER the unanswered save, for the reason above.
    A save FAILURE has two outcomes on the wire and the NOTICE has four, which
    is not an accounting error: a refusal arriving while an earlier reply is
    still missing is both a rejection and an open question, so it is its own
    notice (`refused-unverified`) rather than borrowing the plain unknown one.
    The difference is invisible until a later success discharges the ticket -
    the uncertainty expires there and the refusal does not, so that notice
    DOWNGRADES to the ordinary "the host turned this down" rather than
    disappearing with the ticket. Discharging a ticket also takes its
    **Check again** with it, which is gated on the ticket and not on the notice
    beside it: a button that re-reads for a request nobody is waiting on looks
    like recovery and does nothing.
    Every message states which value is on screen and what is known about what
    is in force, because "couldn't save" alone leaves the control ambiguous.
    **Two** of those sentences claim a setting is in force, and each needs its
    own evidence. A refusal that reverts claims the restored policy is in
    force - true unless that policy predates an unread reset, and it stops
    predating one as soon as any write lands after the reset, so the test is
    whether the confirmed write outranks the reset's own request, not whether
    the banner is up. A refusal that KEEPS the draft claims the displayed
    values are stored, and that takes **two** independent facts. Comparing the
    values against `persisted` establishes only SAMENESS - never
    `revision === persistedRevision`, an ordering watermark that parts company
    with the values on both adoption paths (a moved-on read-back stamps it
    while keeping a draft the host never saw; a correcting rollback adopts a
    confirmed policy without moving the revision at all). **Authority** of
    `persisted` is the second fact and a separate condition (**D330**): after a
    reset whose read failed, `persisted` is the PRE-reset policy and the host's
    row is unknown, so sameness with it proves only that the display equals an
    invalidated baseline. Two refusals with no success since land exactly
    there. Both facts, or no in-force claim.
    The same rule bounds what may be said about the HOST's values at all. A
    reset that succeeded proves the host wrote something; it does not prove the
    result differs from what is on screen - resetting an already-default policy
    yields identical values back, and the follow-up read that would have shown
    that is the request that failed. So the copy hedges ("may not be what this
    host is using now") instead of asserting an inequality no client can know.
    And a claim about DISPATCH comes from the request's own state - pending,
    confirmed, rolled back, or uncommitted - never from "this revision differs
    from the unanswered one", which covers all four.
    Dispatch is a property of the displayed VALUES, and it travels with them
    (**D339**). The revision names an EDIT, and adoption changes the values
    without changing the revision - `adoptPolicyIntoView` replaces the draft and
    leaves `revision` alone - so after a read-back adopts, or a correcting
    rollback adopts, the revision still names an edit that is no longer what
    anyone is looking at. That is why confirmation is recorded against the
    revision the confirmed values are DISPLAYED at rather than the one the
    request carried, and why "hasn't been sent" now needs positive evidence: a
    display above every revision this editor has ever dispatched
    (`lastDispatchedRevision`, stamped only where a draft is actually sent - a
    reset dispatches DEFAULTS, not the screen). Reached by elimination instead,
    that sentence was told to three sequences whose values the host had already
    received, and where nothing at all is known the copy says so - "sent, but we
    don't know what the host did with it" - rather than picking one of the two
    verdicts it cannot support.
    Two corollaries the eighth pass added (**D347**), both the same rule as
    D339 applied to the SENTENCE rather than to the classification. A
    confirmation records that the display equals the host's row; it does not
    record who authored those values or when, so the sentence describes that
    relation ("what's on screen is what this host has saved") and never a
    history - a read-back can adopt the ORIGINAL policy while two saves are
    outstanding, and "a change you made since has been saved" is then false
    twice, since no change of theirs was stored and the controls show what was
    always there. And an unanswered request is described as the request it
    was: `reset` and `restore` move no revision, so their own lost replies
    create uncertainty stamped at the display's revision, and the notice must
    name the operation rather than borrow the draft's sentence - which is why
    the dispatch discriminator distinguishes the two operations instead of
    lumping them as "not a draft".
    None of these sentences says which request was newer, deliberately: a
    refusal can name a request older than the one that succeeded OR newer than
    one a correcting rollback displaced, so any ordering word is wrong half the
    time. For the same reason the uncertainty sentence names the DRAFT it is
    about - "what's on screen" is the unanswered request's draft only while the
    user has not typed past it.
    A failure also leaves alone the validation error belonging to a draft it
    never judged, so a group emptied while an older save was in flight keeps
    its error rather than reading as accepted. That is the one case where the
    panel's status place carries two messages at once - the validation error
    and the host notice are statements about different things, and an early
    return for the first used to take the second's Check again off the page
    while its ticket was still open.
    Validity is decided by `fallbackPolicySchema.safeParse` - the wire schema
    itself, so the local check cannot drift from the host's - and this module
    only turns the failing path into a sentence.
  - **`storedPolicyUnreadable`** is surfaced, never swallowed. The host answers
    a corrupt row with the default policy plus that flag instead of throwing,
    so that this page still renders and a save can replace the bad row; the
    notice says what is on screen is not what is stored.
  - **`inFlightCount`** is rendered as a plain number in the master toggle's
    helper with **no link**: every holding or waiting chat already shows its own
    card with its own stop action. "Right now" is a claim about the present,
    so the number is POLLED while the page is open:
    `useFallbackInFlightCountQuery` reads `providers.fallbackPolicy.get` on
    the table's fixed 5 s cadence, under its own cache entry. It used to come
    off the policy read, which is read once, and a live run showed "1 in
    progress right now" for minutes after the only hold had switched. That
    entry holds the whole response, not just the number, because `set` and
    `restoreTierGroups` update every entry under the method's scope with a
    response-shaped updater - a bare number there would come back from the
    first save as an object, printed on the page.
    The policy read itself does not poll: those same two writers put their
    responses into its entry in place, and a poll landing after one of those
    writes would put the pre-save policy back for the next mount to seed from.
    Nothing AMBIENT re-reads it either (`refetchOnWindowFocus` and
    `refetchOnReconnect` are off app-wide), but that is not "nothing refetches
    it": the host-scope sweep (`lib/host/query-invalidator.ts`) refetches every
    active host query on availability recovery and key rotation, and `reset`
    invalidates with `refetchType: "none"` because its own caller does the
    read. So the policy's re-reads are the panel's own two - the read-back
    after a save whose reply was lost, and the read after a reset - plus a
    sweep.
  - **No per-chat and no per-task control exists anywhere in the app**, by
    decision. The harness/model picker and the composer gain nothing from this
    feature; per-chat intervention is the actions on the cards themselves.
- `Keybindings` Keyboard shortcut customization.
- `Shell` Shell binary + args used for every terminal PTY
  (`TerminalSessionManager` reads the effective config per spawn, file-watched,
  so new terminals pick up changes immediately) and for provider-CLI PATH
  discovery. The host process itself is launched directly (its bundle
  executable, `host-start.ts` spawns it with `args: []`), NOT through the
  user's shell - so shell path/args do **not** affect the host bootstrap.
  Environment-variable overrides ARE merged into the host process env at
  `traycer host start` and therefore take effect on the host's next restart.
  Backed by the SELECTED host's own `config.shell.*` / `config.env.*` RPCs -
  local and remote alike, one code path - and by the local `traycer config`
  CLI (`IRunnerHost.traycerCli`) in the one fallback case below. Both transports
  implement `ShellConfigController` (`panels/shell/shell-config-controller.ts`)
  and the editor is written against that interface, so the two paths cannot
  drift into two different editors:

  - **RPC** whenever the scope resolves to a client. An unresolved scope still
    renders the gate, and a host that predates the methods renders
    `HostConfigUnsupportedNotice` - never this computer's values under another
    host's name.
  - **CLI bridge** only for `localConfigFallbackReason` (this computer's host,
    stopped or predating the methods), under `LocalConfigFallbackNotice`. Same
    on-disk store, so the values are still that host's.

  Two affordances are inherently local and degrade rather than lie: the native
  **Browse…** file dialog is offered only when the target machine is this one
  (`ShellProbeSource.pickProgramFile`; every other target types a path), and
  the "Add a shell" existence/executable probe runs on the TARGET host
  (`config.shell.probe`), not on this computer.
  - **Flags belong to a shell, not the panel.** Each program carries its own
    startup flags: `shell.entries` is a list of `{ path, args }` launch specs,
    and `shell.path`/`shell.args` are the selected command MATERIALISED for an
    EXPLICIT selection (the mirror invariant - see `protocol/config`). `args` is
    a DEVIATION: `null` means "runs the family default", so presence (an entry
    exists) and flag-deviation (`args !== null`) are independent - an added
    program on factory flags is `{ path, args: null }`. The store's write path
    canonicalises any args equal to `defaultShellArgs(path)` (`-i -l` for a login
    shell, none otherwise) down to `null`, which makes "the visible flags differ
    from the family default" exactly equal to "a non-null deviation is on disk".
    Picking a program swaps the flags row to that program's resolved flags.
    Picking is not remembering - only adding a program or editing its flags
    creates an entry. **"System default" is an alias for the login shell and
    INHERITS its entry flags**: in the pure-auto state (`path`/`args` both null)
    resolution reads the login shell's entry, and editing the flags row while on
    it configures that entry while staying auto (the mirror stays null/null so
    the System default row stays checked). **Nothing is forgotten by changing
    selection** - only the ✕ removes an entry; **Restore default flags** clears a
    shell's deviation (`args: null`) while keeping the entry.
  - **UI (Direction B - live-preview cards).** Two `SettingsGroup` cards under
    `panels/shell/`, each with an external scope label instead of an in-card
    title (a `settings-related-panels-core-flows` design pass; the underlying
    combobox/chips/editor components below are byte-for-byte unchanged): a
    **`"Terminal shell · New terminals"`** card with an `EffectiveCommandPreview`
    (terminal-styled `❯ <path> <args>`, reusing `--term-ansi-*`), a
    `ShellProgramCombobox`, and `ShellFlagChips` (labelled _Startup flags for
    &lt;shell&gt;_, with the "`-i -l` loads your full shell profile" helper only
    when the selected program is a login shell, and a quiet _Restore default
    flags_ action shown only while the visible flags deviate from the family
    default - reverting the SELECTED shell via `config.shell.revertArgs`). **On Windows hosts with WSL
    selected** (classified by binary via `windowsShellCaptionFamily`, shared
    with the host resolver) a single quiet line sits directly under the picker
    in its column - "WSL applies to terminal tabs only", amber dot + `Info`
    glyph - with the shell/host boundary and an "Install Traycer in WSL" WSLg
    remedy link (docs.traycer.ai/install#windows-via-wsl) in a
    `HoverCard`; the glyph is itself a focusable anchor to that docs page so
    keyboard users reach the remedy the hover card keeps out of tab order. Only
    WSL earns a caption: PowerShell / Git Bash profile loading and cmd's plain
    Windows environment are expected behavior, so those selections (and all
    non-Windows hosts) render nothing, and the picker row top-aligns only
    while the caption is shown. There is also a **`"Host environment ·
After restart"`** card with the shared inline `EnvOverrideEditor`
    (host-process scope only - set/unset mode, value edit, key rename, and
    staged add/remove; per-harness env lives in Settings → Providers). Existing
    env rows **auto-save on commit** (env blur/Enter); new env rows apply only
    when their check button is pressed. Other controls still auto-save on
    commit (row select, add, chip add/remove) - what changed is the feedback:
    the old permanently-visible "Saving… / ✓ Saved" text footer is gone,
    replaced by the same transient icon-only spinner/flash-check pattern as
    Worktrees' branch-prefix strip (`TransientSaveLiveStatus` /
    `TransientSaveIndicator`, ~1.6s flash, `sr-only role="status"
aria-live="polite"` carrying the equivalent text for
    assistive tech) - three independent instances (shell program, flags, env),
    each sitting inline in its own row/block rather than one shared card
    footer, since the old single shared footer is gone along with the in-card
    titles. **Restore default flags** is still the only reset-like control
    (relocated into the flags row); there is still no other reset button.
  - **The "system default" concept lives in exactly one place: the picker's
    first row.** It is not repeated as a preview badge, a trigger chip, or a
    footer button (all removed). `EffectiveCommandPreview` shows only the
    effective `❯ <path> <args>`.
  - **Shell picker (`ShellProgramCombobox`).** The trigger shows either
    **"System default"** + `{defaultName} · {path}` (when `config.synthesised`)
    or the stored shell's name + start-truncated path (otherwise) - no chip. The
    popover leads with a **System default** row, then one alphabetical list of
    concrete shells, then a labelled _Add a shell_ section:
    - **System default row** (first, present whenever the list has an OS-default
      entry, carrying `data-testid="settings-shell-reset"` migrated from the old
      footer button). Its check shows when `config.synthesised`; clicking it
      clears ONLY the selection via the controller's `resetShell`
      (`config.shell.reset`, or the CLI's reset in the fallback). The RPC path
      invalidates the detected-shell list alongside the config read - harmless
      and deliberate, since a reset can change which row is checked; the CLI
      path invalidates only the config read. Remembered shells and their flags are
      kept - the login shell's own entry is inherited - so the row stays checked
      even when the login shell has customised flags, and editing the flags row
      while checked persists to that entry without un-checking it.
    - **The concrete list** is `detectShells()` ∪ the user's `shell.entries`
      paths, resolved ON THE TARGET HOST (`config.shell.listDetected`, or
      `ITraycerCli.shellListDetected()` in the fallback; cached for the
      session), sorted purely
      alphabetically (the System default row owns the auto concept, so no
      default-first ordering or per-row "default" tag). A concrete row is checked
      only when a shell is explicitly stored (`!synthesised`) and its path
      matches; a hover/focus ✕ removes rows whose `source` is `"added"` (detected
      rows are never removable). An entry-derived row whose file has since
      vanished lists with `missing: true` - its path takes the amber
      (`--term-ansi-yellow`) validation tone with a quiet "not found" hint, and
      it stays selectable and removable (that ✕ is the cleanup path). A selection
      that is neither detected nor an entry (set by hand via the CLI) renders as a
      transient checked row without ✕. Clicking a row auto-saves via the set
      mutation, materialising that program's flags.
    - **Add a shell** is an always-visible path input with a live status line
      driven by a debounced probe of the TARGET machine (`ShellProbeSource`:
      `config.shell.probe`, or `ITraycerCli.shellProbe` in the fallback):
      non-absolute → "an absolute path is required"; found+executable → green
      "✓ found · executable"; the amber states ("found, but not executable" /
      "not found on this machine") **block the add**. Enter adds only from the
      green state (remember + select via `config.shell.add`, which invalidates
      both the config and list reads). A **Browse…** row runs a chosen file
      through the same probe gate - executable files are added outright, a
      non-executable pick is left in the input with its amber status - and is
      shown only when the target machine is THIS one (a native dialog can only
      name local paths); every other target types a path instead. The ✕ removes
      via `config.shell.remove`; the backend falls back to the OS default when
      the removed shell was current.
  - **Detection** (`protocol/config` `detectShells()`) unions `/etc/shells`, a
    probe set, `$SHELL`, and a scan of every `PATH` directory for known shell
    names; on Windows it scans `PATH` plus env-var-derived well-known locations
    (WSL, Git Bash, Store PowerShell) and `%COMSPEC%`, giving WSL/Git Bash
    friendly names. All candidates pass the same `X_OK` filter, realpath
    duplicates collapse (preferring the OS default), and detection never throws.
    Added/customised shells persist as `shell.entries` (additive config field,
    replacing the never-shipped `shell.added`) and are listed even when their
    file no longer exists (flagged `missing`). Env **rename** is client-sequenced
    (`envOverrideSet` new → `envOverrideDelete` old) with an inline unique-key +
    `/^[A-Za-z_][A-Za-z0-9_]*$/` guard.

- `Worktrees` Two stacked cards, no section headings: a compact **branch-
  prefix strip** (client-wide creation default) directly under the page
  header, then the **worktree inventory** (the pre-existing host-scoped
  management list, unchanged) taking all remaining height. Earlier this was
  two `settings-section-header.tsx`-banded sections labelled "New worktrees" /
  "Existing worktrees" inside one continuous card; a design pass
  (`general-settings-core-flows` artifact, following user feedback that the
  worktree list was starved of space in the modal overlay) replaced both
  headings with a genuinely compact strip and let the inventory own the rest
  of the pane - each card's own content (the strip's label + "All hosts" tag,
  the inventory's host/search/filter toolbar) already says what it is, so a
  redundant heading above either would just repeat that.
  - **Branch-prefix strip** (`worktree-branch-prefix-section.tsx`, backed by
    `worktreeBranchPrefix` in `settings-store.ts`, default `"traycer/"`).
    One control line: a **Branch prefix** label + a quiet **All hosts** scope
    tag, a live example line below it ("New branches start like
    **traycer/quiet-otter**"), then reset + a plain text `Input` + inline
    save feedback, all on the same row. The example previews
    `${draft.trim()}${suffix}` (an unprefixed suffix when the trimmed draft
    is empty) using a friendly two-word suffix
    (`random-friendly-name.ts#pickFriendlyBranchSuffix`) generated ONCE per
    mount and held stable while typing - only the prefix part changes as the
    user types, so the suffix itself isn't distracting noise. The input is
    used verbatim as the prefix for the branch name pre-filled when creating
    a new worktree - no separator is auto-appended, so the user types it
    (`traycer/`, `anurag/`, `feat-`); an empty value means no prefix,
    mirroring `composeDefaultNewBranch`'s existing "empty means skip"
    precedent. Accessible name is `"Branch prefix"` (renamed from the older
    `"Worktree branch prefix"` to match the new visible label - the page
    title already says "Worktrees", so repeating it in every control's name
    read as redundant under the new design).
    - **Debounced autosave, mechanics unchanged, presentation reworked.** A
      valid, changed draft still persists ~500ms after the last keystroke;
      Enter and blur still flush a pending save immediately. The draft is
      still the single source of truth while a local edit is in flight -
      tracked by an explicit flag (not string comparison, which breaks once
      a trimmed commit can make the raw draft and the saved value diverge by
      whitespace alone) - and still adopts an idle external write (another
      window, rehydration) once no local edit is in flight, normalizing to
      the trimmed value the same way a local commit does. What changed is
      purely the feedback surface: the old permanently-reserved "Saving… /
      Saved" status line is gone. A compact `AgentSpinningDots` spinner
      appears beside the input while a valid save is pending; on a
      successful write it becomes a brief `Check` (~1.6s, mirrors
      `SegmentCopyButton`'s `COPIED_RESET_MS` flash convention) then returns
      to quiet chrome with nothing reserved - the flash fires only for the
      current user's own resolved edit or the reset button, never for an
      adopted external write. An invalid draft shows a concise error on a
      persistent line BELOW the control instead, and only then does the
      strip's card grow a row to hold it; correcting the value removes the
      error and resumes autosave. The error text carries a stable id wired to
      the input's `aria-describedby` (only while an error is showing) and
      renders with `role="alert"`, so the failure state reaches assistive tech
      the same instant it reaches the eye. A ghost `RotateCcw` reset button
      occupies the same reserved `size-7` left gutter as the font-size rows in
      Appearance, appears whenever the ACTIVE DRAFT differs from the default -
      not just the saved value, so it stays available to cancel a pending or
      invalid in-progress edit even before anything has been committed - and
      on click cancels any pending debounce, writes the default immediately,
      flashes the same brief success check, and moves focus to the (still
      mounted) Input so it doesn't drop to `<body>` when the button itself
      unmounts. The spinner/check pair is
      visual-only (icon, `aria-hidden` where applicable), so a visually
      hidden `sr-only` `role="status" aria-live="polite"` span sits alongside
      it carrying the same "Saving…" / "Saved" text for assistive tech -
      mirrors the existing `PrimaryChangeLiveRegion` convention
      (`host-workspace-selector/primary-change-live-region.tsx`). Both the
      visual indicator and the live-region text are driven by the same
      explicit "local edit in flight" flag mentioned above, not by comparing
      draft/saved values - so a resolved edit that normalizes back to the
      already-saved value (pure whitespace) still flashes success, while an
      idle external write or an already-clean field's blur stays quiet.
    - **Next-use-only** (unchanged): changing the setting does not retrofit a
      branch name already pre-filled in an open composer/picker - it applies
      to worktrees configured after the change (newly resolved folders,
      freshly opened composers, submit-time composition), matching the app's
      seed-time-snapshot norm elsewhere (`composerMode` draft seeding,
      `applySeed`). Light client-side validation
      (`worktree-branch-prefix-validation.ts`) rejects an illegal git ref
      (spaces, ASCII control characters, `~ ^ : ? * [ \`, `..`, `@{`, a
      leading `-` or `/`, consecutive `//`), anything over 40 characters, and
      any slash-separated component that starts with `.` or ends with
      `.lock`, with an inline error instead of saving - git remains the final
      authority at branch-creation time. Re-validated again at the single
      composition choke point (`composeDefaultNewBranch`) and during store
      rehydration, so a hand-edited or corrupted persisted value falls back to
      the default instead of flowing verbatim into a branch name. The 40-char
      cap keeps the composed name's `.slice(0, 80)` truncation landing inside
      material that is always `[a-z0-9-]` - the random suffix, or (for
      multi-workspace names) the repo slug, which is ALSO capped at 40 chars
      and can itself be reached by the cut once prefix + slug exceed 80 - so
      truncation can never produce an illegal or empty ref and needs no
      post-composition repair. Threaded into `composeDefaultNewBranch`
      (`lib/worktree/default-branch-name.ts`) from the two worktree-picker
      call sites in `host-workspace-selector.tsx` and the cached-default path
      in `use-landing-composer-actions.ts`; entirely client-local, no host
      RPC or protocol change.
  - **Agent worktrees** (`worktree-agent-create-chip.tsx`) — the second chip in
    the toolbar's leading slot (now `policies`, not `cleanup`), right of
    Automatic cleanup: what an agent's `traycer_create_worktree` call does on
    this host. `Allow` (default) / `Ask first` / `Never`, stored in the
    `worktrees.agentCreate` block of `~/.traycer/cli/config.json` on that
    machine and read over `config.worktrees.get` / `set`. The host enforces it
    on every call (`traycer-host/src/domain/agent/agent-worktree-policy.ts`),
    so a change governs the next request of an agent already running.
    - **Same gate as the cleanup chip**, reusing `resolveAutoCleanupGate` with
      `supported` = both methods advertised (they negotiate independently, and
      a readable-but-unwritable policy would render a menu whose every choice
      fails). Non-`ready` states render the same `aria-disabled` inert chip
      with its sentence in a Tooltip.
    - **A radio menu, not a popover**: `DropdownMenuRadioGroup` with one line
      of meaning under each value and a footer naming the host the policy
      governs ("agents running on {host}"). Items stay disabled until the read
      lands, so no choice is made against an unknown current value. A failed
      read (malformed config file) replaces the items with the repair
      sentence the Browser row uses. Chip label: `Agent worktrees · <value>`,
      bare `Agent worktrees` until the read lands.
  - **Automatic cleanup** (`worktree-auto-cleanup-chip.tsx`) — ONE chip in the
    inventory toolbar's leading slot, opening a popover that holds the opt-in
    letting this host delete proven-safe, long-idle worktrees unattended.
    **Default off**, per HOST identity (not per signed-in user), and backed
    entirely by the host: `worktree.getAutoCleanupPolicy` /
    `setAutoCleanupPolicy` through `useHostQuery` / `useHostMutation`. Nothing
    here schedules, retries, or simulates cleanup client-side — deletion
    authority is the host's, and a local fallback would be a second scheduler
    nobody asked for.
    - **Why a chip.** This was a card above the inventory (a two-line summary
      over a `Collapsible` threshold). The panel is a fixed height, so every
      row that card spent was a worktree the list below could not show — and it
      spent them unconditionally, for a policy consulted rarely and changed
      almost never. A chip costs the list nothing: it rides in a toolbar row
      that already exists. The panel header's subtitle went with it, so the
      list card is the only child of the fill-height column in BOTH views
      (inventory and cleanup history).
    - **Five states, decided by one pure function** (`resolveAutoCleanupGate`,
      exported for its own test): `absent` (no resolved host — the inventory's
      own `HostScopeGate` names that state, and a second copy of it in the
      toolbar would be two answers to one question, so the chip renders
      nothing), `checking`, `offline`, `unsupported`, `ready`. The ladder fails
      OPEN into `checking` on `useHostMethodSupport`'s `null`: telling someone
      their host is too old because no handshake has completed yet is a claim
      about a fact not in evidence. In the standalone-toolbar path the chip
      sits ABOVE the gate, so it makes the gate's two checks — scope usability
      and reachability — itself before mounting any host read. The three
      non-`ready`, non-`absent` states render the chip INERT with their
      sentence in a Tooltip and no popover; `offline` and `unsupported` stay
      deliberately different sentences, one calling for starting a machine and
      the other for updating it. Inertness is `aria-disabled`, not the
      `disabled` attribute: a disabled button takes neither pointer events nor
      focus, which would make the one sentence the chip exists to deliver
      unreachable by mouse AND by keyboard.
    - **The chip states the policy at a glance**: `Cleanup · On · 7d` with a
      green dot, `Cleanup off` with a grey one, and a bare `Cleanup` with NO
      dot until the read lands — an unknown policy must not paint "off", which
      is a real state. So the policy read is mounted eagerly with the chip
      rather than on open, and a read that FAILS leaves the chip live (the
      error is a line inside the popover, not a reason to withhold the
      control). Accessible name is `Automatic cleanup settings`, and
      `aria-expanded` comes from the Radix trigger.
    - **Writes carry the revision they read.** `expectedRevision` is required by
      the contract, so the toggle stays disabled until the policy read lands.
      A mismatch comes back as `AUTO_CLEANUP_POLICY_REVISION_CONFLICT`, which
      is NOT toasted as a transport error: the hook re-reads the policy and the
      popover explains inline that the setting moved somewhere else. The
      success response IS the fresh policy state, so it is written straight
      into the read query's slot and no second round trip is needed.
    - **The popover** (Radix `Popover`, `align="start"`, `w-[min(88vw,20rem)]`)
      is: the title + the switch on one row (plus the pending-write spinner);
      then, enabled only, the safety sentence, the threshold, and a footer
      carrying the schedule and a **History** link. Switched off it collapses
      to one muted line, "Nothing is deleted automatically." — a policy that
      deletes nothing has nothing to configure, so the threshold and the
      footer are ABSENT rather than disabled controls over an inert setting.
      Toggling the switch does not close the popover. Open state is
      component-local (`useState(false)`) and never persisted, and the chip is
      keyed by host: a remount, a host switch or a re-entry into Settings
      starts closed.
    - **Threshold** (in the popover, under the safety explanation): presets
      7 / 14 / 30 / 60 / 90 days plus a free value validated against the host's
      own `bounds` (`autoCleanupDaysError`), never a constant here — a host
      that moves its bounds needs no client release, and the control can never
      offer a value the host is about to refuse. The presets wrap to two rows
      inside the popover; that is the intended shape, not an overflow.
    - **Arriving from a Sweep.** The per-Task **Sweep worktrees** dialog
      (`components/epics/sweep-worktrees-dialog.tsx`) shows one muted line in
      its Choose state — "Proven-safe worktrees can be removed automatically."
      plus a link-styled **Set up automatic cleanup** button — only while the
      census settled with at least one `defaultChecked` row AND that dialog's
      latched host both advertises `worktree.getAutoCleanupPolicy` and reads
      back `enabled: false`. A loading, failed, unsupported or enabled policy
      renders nothing, and the capability is checked BEFORE the read is
      mounted, so nothing about the sweep ever waits on it. Enabling the policy
      is the whole frequency cap: no dismissal, nothing persisted. The link
      goes through `lib/worktree/open-auto-cleanup-settings.ts`, which reuses
      the notification router's three seams in the same order —
      `carryViewedHostIntoSettingsScope` (the policy is per host),
      `selectWorktreeCleanupView("settings", null)` (the inventory, never
      history), and then `ensureSettingsTab` — plus a third hint of its own,
      `requestAutoCleanupFocus(hostId)`. That request is one-shot exactly like
      `focusedRunId`, and it NAMES ITS HOST (`autoCleanupFocusHostId`, not a
      bare boolean): the policy is per host and the chip administers exactly
      one, so a request whose host never mounts a chip — offline, too old, or
      Settings never opened — must not be spent on whichever host is scoped
      next. The chip consumes it only while `scope.hostId` matches, by OPENING
      its popover (Radix's mount autofocus then puts the caret on the switch,
      the first tabbable inside), and clears it immediately after. The open is
      applied during RENDER rather than in an effect — `react-hooks/
set-state-in-effect` forbids the effect form, and an effect would also
      arrive a commit too late for the mount autofocus — while the store clear
      stays in an effect, where an external write belongs. `openHistory` drops
      the request because a chip-focus request is stale the moment the panel
      leaves the inventory, and a caller with no host to name asks for no focus
      at all.
      The line's own `useNavigate` lives in the innermost component, which
      mounts only once the capability is proven AND the policy came back off —
      so a Sweep dialog rendered without a `RouterProvider` never reaches the
      router hook, rather than relying on TanStack warning and carrying on.
    - **Paused** states render the reason in plain English
      (`AUTO_CLEANUP_PAUSED_COPY`, a `Record` over the closed wire enum so a new
      arm fails to compile rather than rendering as silence) and offer NO repair
      affordance: every arm clears without the user acting. `nextEvaluationAt`
      is `null` while paused, and reads as "Next check: paused" — a real state,
      not a missing timestamp. That line is why the pause copy exists at all: a
      stale "last checked" must never be the only evidence nothing is happening.
  - **Cleanup history** (`worktree-cleanup-history.tsx`) — a SUB-VIEW, not a
    second card: it replaces the panel body and carries a back control. Reached
    from the cleanup popover's **History** link (which closes the popover on
    the way, since history is the full-panel view), or arrived at directly from
    an automatic-cleanup notification. Cursor-paginated newest-first over
    `worktree.listAutoCleanupRuns` with an explicit **Load more** (no
    auto-advance: history holds up to 200 runs and the user asked for the newest
    ones); expanding a run fetches its targets through
    `worktree.getAutoCleanupRun`, so a page costs one request rather than one
    per row.
    - **The presentation rule is a product decision, not styling**
      (`worktree-auto-cleanup-copy.ts`). A `skipped` target is the safety engine
      WORKING — it lost eligibility between selection and deletion — so it reads
      "No longer eligible" in neutral styling. An `interrupted` one is honestly
      unconfirmed ("Unconfirmed — Host stopped during cleanup"): the row may not
      claim a deletion just because the directory is gone now, nor a failure
      that never happened. **Only `failed` wears failure styling.** Putting the
      other two in red trains people to ignore the one state that means Traycer
      could not do something it was authorized to do.
    - The host's `displayMessage` wins wherever it exists: `reasonCode` is an
      OPEN string by contract, so a code this build has never heard of still
      renders host-composed prose.
    - **Every target row stands alone.** A later re-selection of the same path is
      an ordinary new row, never folded into the attempt before it.
      `worktreePath` renders verbatim — it names a directory on the very host
      the panel is already talking to, which is why history never leaves it.
    - **Arriving from a notification.** A `worktree_auto_cleanup` row routes
      through the `hostSurface` family with `view: "cleanupHistory"`, the run id
      as its focus hint, AND the run's `hostId`.
      `routeHostSurfaceNotification` applies both BEFORE navigating, so the
      panel reads them on its first render rather than flashing the wrong host
      or the wrong sub-view: `carryViewedHostIntoSettingsScope` (history is
      host-local, so the destination is only well defined once Settings is
      administering the host the run happened on) and `selectWorktreeCleanupView`
      (`stores/settings/worktree-cleanup-view-store` — not persisted, mirroring
      `settings-host-scope-store`). The focus hint is consumed ONCE, on arrival,
      so re-entering history later never silently re-expands a run the user
      closed. Manual `worktree_deletion` rows carry NEITHER field, which is
      exactly why their behavior is unchanged: they select the inventory for
      whichever host is already being administered.
    - `run: null` from `getAutoCleanupRun` is an ordinary outcome, not an error:
      retention GC bounds history, so a notification can outlive the run it
      names and the honest answer is "this run is no longer in this host's
      history".
  - **Worktree inventory.** Host-wide management of the git worktrees Traycer
    creates under `~/.traycer/worktrees/`, presented as a calm
    inspection-and-cleanup list, not a delete console - own bordered card,
    no heading above it. The sidebar switcher scopes it - the toolbar holds no
    host control and no host readout - and the SCOPE's verdict outranks
    `useHostReachability`, which is the tab-binding check and can call a host
    reachable that this scope cannot dial. A disk-truth list -
    so orphaned worktrees whose owning agent was deleted still appear -
    grouped by repo under quiet, collapsible headers (`WorktreeRepoHeader`)
    that stay visually secondary to row status. The selected host is reached
    through a **transient per-host client** (`useHostClientFor`) so picking a
    host never swaps the app-wide active host or reloads the Epic list (and
    never affects the branch-prefix default above). Backed by the host
    `worktree.listAllForHost` RPC through `useHostQuery` / `useHostMutation`,
    and by the `worktree.deleteBatchByPath` stream for deletion: a single or
    bulk delete is ONE host-owned command that keeps running if this panel
    unmounts and writes one completion notification when every target settles.
    Against a host too old to know that method, the panel falls back to the
    released per-target `worktree.deleteByPath` stream, metered two at a time
    client-side. Setup/teardown script editing is NOT here - the create-
    worktree flow owns it, and scripts otherwise live in the committed
    `.traycer/environment.json`.
  - **Evidence tiers, not a safety verdict.** Each row leads with exactly one
    loud status pill (`WorktreeTierPill`, classification shared with the
    Task-delete dialog and the `traycer-housekeeping` skill via
    `classify-worktree.ts`) naming a PROVEN fact, never a generic "Safe"
    label. **Merged**, **At base commit**, and **Unreferenced** are the three
    green tiers - each requires positive, host-validated proof (a merged PR at
    the live HEAD, local ancestry into the default branch, or authored owned-
    submodule work proven landed from an otherwise at-base superproject; never
    advanced from the worktree's birth commit with no landed authored submodule
    work; or clean, fully pushed, and unreferenced by any Task) - and are
    deliberately kept distinct rather than collapsed into one badge. **Review**
    is the amber catch-all for anything unproven or
    with would-be-lost state (dirty, unpushed/local-only commits, a detached
    HEAD, an unmerged owned-submodule branch, or unverified branch status).
    **Orphaned** means git can't remove the worktree normally (missing/broken
    metadata) and its delete routes through a forced host-side `fs.rm`
    cleanup. **In use** means an active agent or terminal references it - both
    selection and delete are disabled, not just delete. Hovering any pill
    shows the concrete proof or reason (`WORKTREE_TIER_TOOLTIP`), and the
    risk-bearing facts behind a tier (uncommitted count, ahead/behind,
    detached HEAD, unmerged submodule) render inline on the row
    (`WorktreeSecondaryFacts`) without hover or expansion.
  - **`Checking` and `Unknown` are enrichment states layered on top of a
    tier, not tiers themselves.** A row's tier depends on host-probed
    branch/PR activity that resolves after the base list loads. While that
    probe is in flight the pill reads **Checking…** - dashed border, animated,
    full-contrast text, never the muted/green treatment a resolved-safe pill
    uses, because pending status must never look safe - and delete is
    disabled with an explicit "status is still being checked" reason; the row
    stays visible under an active status filter instead of silently matching
    or disappearing. If the probe settles to an error (host unreachable,
    git/gh probe timed out) the pill reads a static **Unknown** (amber,
    dashed, a distinct icon from Review so it never reads as a confirmed risk
    finding) - it remains deletable, but only through an explicit
    unknown-risk confirmation (`unknownRiskDeleteDialogCopy`) that names the
    branch/activity status as unverified, never the generic confirmation a
    proven tier gets.
  - **Delete is reached through a persistent row overflow**
    (`WorktreeRowActions`: copy path, manage scripts, delete, in that order)
    rather than a hover-only icon, so a resting row never shows a destructive
    affordance. Confirmation copy escalates with what the row actually risks -
    discard-N-uncommitted-changes, unpushed/local-only commits, the
    unknown-risk copy above, forced cleanup for orphaned rows, or a plain
    confirmation for a proven-green row (`deleteDialogCopy` /
    `singleWorktreeDeleteDialogCopy`). On confirm the row is re-checked
    against current state; if it became ineligible in the interim the delete
    is skipped and the user is told why instead of proceeding on stale
    information.
  - **Selection and bulk delete** use always-keyboard-reachable checkboxes
    plus a tri-state toolbar select-all toggle (`WorktreeSelectAllToggle`,
    scoped to currently-visible selectable rows) instead of a permanent
    header row. Selecting rows never inserts chrome above the list; a
    contextual selection bar (`WorktreeSelectionActionBar`) floats over the
    bottom of the list, out of flow, so entering or leaving selection never
    shifts rows under the cursor. If any selected row is still `Checking`,
    bulk delete is disabled with a count of how many are still pending. The
    bulk confirmation (`WorktreeBulkDeleteDialog` /
    `summarizeBulkWorktreeDelete`) aggregates the selected rows by class
    (never one warning per row), names concrete dirty-loss counts, adds a
    neutral unverified-branch-status caveat and a separate unknown-risk
    caveat for rows whose enrichment failed, and lists what was excluded from
    the selection (in-use, still-checking, or otherwise not selected).
    Confirm re-checks every selected row and skips/names any that became
    ineligible; in-use rows can never be selected or deleted, and explain why
    inline.
  - Background delete progress renders as a non-intrusive strip
    (`WorktreeDeleteProgressStrip`) that stays visible through partial
    failures until dismissed. A quiet `Task {label}` caption
    (`TaskMergeRollupBadge`) beside a resolved Task chip reports that Task's
    aggregate merge progress across every worktree it owns - deliberately
    plain muted text, not a colored badge, so it never competes with or is
    mistaken for the row's own tier pill.
- `Host` **Overview**: ONE page about one host - the scoped one - and the same
  page whether that host is on this desk or in a datacenter. The cross-device
  **My Hosts** list and the separate **This machine** section are both gone; the
  sidebar switcher is the collection, and every lifecycle verb lives on the
  Overview of the host it describes.

  **A pinned host header, a notices strip, and four tabs**
  (`host-overview-tabs.tsx`; core flows: the `host-overview-tabs` epic
  artifact). The header is the identity part of `HostIdentityCard` - name and
  rename, the Local/Remote tag, Activate, the `⋯` menu, the health line, the
  working chip - and it never moves, so switching tabs never hides Restart or
  Activate. Under it, the notices strip (below), then in this order:
  **Installation · Updates · Data · Ports**, a `TabsList variant="line"`.
  There is no Status tab any more: it repeated the header's facts and stated
  one update three times (the update card, the version card's tag, and its
  answer), so its update card, wait and offline notice moved into the strip,
  where they are on every tab, and its update answer leads Updates (now the
  answer card, drawn only when there is news or an action).
  - **Frame.** The header, the notices strip, the tab bar and the active body
    share one card. On desktop the page takes `SettingsPanelShell`'s
    `fillHeight` (the Providers model) with a transparent body card: the
    header, the strip and the bar are pinned, only the active tab's body
    scrolls, and the card is only as tall as its content up to the pane. The
    `md:` classes on the tab frame are that whole model. On a phone
    (`useIsMobileViewport`) nothing is a scroll container and the page
    scrolls as one, header and strip included; the bar becomes a section
    `Select` (built like `PermissionsTabSelect`) whose trigger carries the
    ACTIVE tab's search anchor, and Activate moves into the `⋯` menu as its
    first item (with its reason written under it). The phone's name row never
    wraps (`HostIdentityCard`'s `nameRowWraps`): the name truncates, and the
    pencil, the tag and the `⋯` keep their space.
  - **Every tab, every state.** All four render for every host in every
    state - connecting, restarting to finish an update, unreachable,
    stopped, not installed, update required - so the header, the strip and
    the bar sit outside anything that withholds a body, and each body decides
    what it can show (the per-region `usable` gates it carried before the
    split). While the host connects, Updates shows the version list's loading
    shape (`HostScopeConnecting`) with no answer card above it: the answer
    needs the host, and a retained update is the strip's to describe. The
    header's own states
    are unchanged: this computer's host down gets Run doctor (and Reinstall
    Traycer after a removal), an unreachable host gets no Activate or `⋯`.
    The two page states with NO header and no tabs are unchanged too - a host
    removed from the account while you look at it, and an account with no
    host but Traycer installed (`LocalRecoveryDangerZone`).
  - **Tab state.** The page opens on Installation
    (`DEFAULT_HOST_OVERVIEW_TAB`, the first of `HOST_OVERVIEW_TABS`).
    `OpenSettingsModalOpts.tab` opens the named tab (read through
    `useSettingsOpenIntent("host")`, acknowledged with
    `acknowledgeSettingsOpenIntent`, and its `hostId` carried into the
    Settings scope before paint, as Permissions does); a tab this page does
    not have is ignored, except a RETIRED name, which selects its replacement
    (`hostOverviewTabForIntent`: `"status"` opens Updates). The four links
    into `section: "host"` (the resource monitor's and the rate-limit
    popover's Manage hosts, the composer's host section, the chat tile's host
    update) name `tab: "updates"`, so an Overview already open on another tab
    comes back to the version and the update answer, on the same host or a
    new one - a link with no tab arms no intent and would leave the tab where
    it was. A settings-search landing on a tab's anchor switches to it during
    render (`hostOverviewTabForAnchor`); a page result moves nothing. Nothing
    switches tabs by itself, and nothing inside the page selects a tab: the
    strip is on every tab, and the version list is directly under the version
    card. The selected tab is held by `HostSettingsPanel`
    (`useHostOverviewTabSelection`, in `host-overview-tab-state.ts` beside
    the components' `host-overview-tabs.tsx`, so both keep Fast Refresh)
    ABOVE its per-host remount (`key={scopeKey}`), so a switch of host in
    the sidebar picker keeps the tab while the remount still closes an open
    confirmation, the rename field and the Doctor panel of the previous
    host. A VISITED tab stays mounted, hidden while inactive (the Rules-tab
    rule), so a half-typed retention limit survives a look at Updates; an
    unvisited one is never mounted, and visited tabs reset when the page
    closes or the host changes.
  - **The notices strip, top to bottom, drawing only what applies**
    (`host-overview-notices.tsx`, between the header and the tab bar; its
    decisions are in `host-overview-status-model.ts`, and the panel resolves
    each piece). At rest - a reachable host with no update in flight and no
    wait - it draws nothing, and the header sits directly on the tab bar.
    1. **The offline notice**, while the host can't be reached for a reason
       other than a restart (`!usable`, not connecting, the health word not
       "Restarting…"): "Can't reach build-box — last seen 3h ago, while
       downloading update to v1.5.1. Auto-update settings still apply at its
       next check-in; everything else here needs a connection."
       (`describeHostOfflineNotice`). The phase clause comes from
       `describeLastSeenUpdateClause` and drops when no update was in flight;
       the last-seen half drops when the account holds no check-in; the
       auto-update half drops for a host the account does not know. It is the
       strip's ONLY unreachable wording, so the update card is withheld under
       it and its retained "Last seen: …" rides in the clause instead.
    2. **The update card** (`HostOverviewOperationCard`), the host's own
       report: progress with measured bytes, the restart phases, a wait on
       work, failure, success. Info while it runs, warning while it waits on
       someone, destructive on failure, success when done, neutral for a view
       the page can no longer vouch for (a retained failure stays red). Its one
       control is Restart, Force update… or Force restart…. Success reads
       "Updated to v1.5.1" and collapses after 8 s or on dismiss; a failure
       stays until dismissed by hand, and dismissing hides the card only (the
       record stays on the host, the Doctor card still reports it, and the
       next attempt arrives undismissed because dismissals are keyed by
       attempt id and shared with the landing banner). The acknowledgement
       (`useHostUpdateCompletion`) runs at PANEL level, so the card's own
       mount and unmount never restart its timer. It is the page's
       ONLY report of an update in flight: the header carries no update pill,
       and the answer card and Check now go quiet while it shows.
    3. **The account's wait** (`HostUpdateDrainGateRow`: "Waiting for 2
       agents", Apply now — ends 2 agents), a warning callout. **One wait on
       screen**: it is withheld once the host's update view is
       `waiting-for-work` (retained phase included), where the update card
       says it with Force update…, and while the host can't be reached,
       because it names live work. Its confirm and its refusal when the work
       changes under the open dialog are unchanged.
  - **The destructive rule.** Force update…, Force restart… and Apply now end
    running work, so they are destructive-styled wherever they appear: the
    update card, the drain-gate row, and the busy dialogs
    (`HostBusyForceDeferDialog`'s required `forceDestructive`, true at every
    caller but the bound activation offer, whose button is "Restart host").
    Restart and Update now stay ordinary buttons. Every confirmation still
    names the count.
  - **Updates ▸ Answer card** (`HostOverviewAnswerCard` in
    `host-overview-updates.tsx`), first on Updates, and ONLY when the update
    answer has news or an action. There is no version heading and no tag: the
    running version is the header health line's, and "latest" is the version
    list's installed row (`latest` beside `installed`). So a current host,
    the FIRST check (no answer in hand yet; the version list says it is
    asking), a host that can't be reached or is still connecting (the offline
    notice and the list's loading shape speak then), and an update in flight
    all draw no card. A RE-CHECK is not one of them: `describeCheckState`
    answers "checking" only with no catalog and no settled failure, so Check
    now, the release-candidate checkbox and the error lane's own retry all
    leave the card already on screen in place (Check now spins and Update now
    is disabled for that span) instead of removing it and jumping the rows
    under it. For the same reason `unreachable` is "the last settled word,
    for this host, was a transport failure and nothing has answered since"
    (`useCheckSettledUnreachable`), not bare `isError`. That drops in three
    ways before anything answers: a no-data retry returns `status` to
    `pending` (held by `errorUpdateCount`); the release-candidate checkbox
    switches to a fresh query key whose count is zero; and the same switch
    over a retained catalog shows the OLD key's catalog as placeholder with
    no error (both held by the errored host id, which only data of the key's
    own clears, and which a scoped-host swap stops matching). Otherwise the card is an icon tile, a title, the
    answer's own sentence, and the answer's one control on the right (stacked
    under the text at full width below the `@lg` container width). Tone and title come from `ANSWER_CARD_LOOK`,
    keyed by `answerKind`:

    | Answer              | Tone    | Title                                 | Line                                            | Control                                                                              |
    | ------------------- | ------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
    | `available`         | info    | Update available                      | `v1.4.0 → v1.5.1` (sentence sr-only)            | Update now                                                                           |
    | `needs-cli`         | warning | Needs newer CLI tools                 | the remedy sentence                             | the command-line-tools fix                                                           |
    | `restart-to-finish` | warning | Restart to finish                     | "v1.5.1 is installed — restart host to finish." | none, or Update now when the catalog offers something newer than the installed bytes |
    | `stranded`          | info    | Newer version on another release line | the stranded sentence                           | none                                                                                 |
    | `not-installable`   | neutral | Update unavailable for this host      | the not-installable sentence                    | none                                                                                 |
    | `unreachable`       | neutral | Update check failed                   | "Couldn't ask … which versions …"               | none                                                                                 |
    | `check-failed`      | neutral | Update check failed                   | "Couldn't check for updates on …"               | none                                                                                 |
    | degrade             | neutral | Updates aren't managed here           | `describeOverviewDegrade`                       | none                                                                                 |

    The neutral tone is `bg-foreground/5`, never `bg-muted` (raised surface).
    - **One standing live region.** The check runs on its own, so the answer
      changes with no user action to anchor it. `HostOverviewAnswerCard`'s
      wrapper is an `aria-live="polite"` region mounted for as long as the
      host can be asked: empty and `sr-only` while the answer is quiet (out
      of the tab's column, still in the accessibility tree), and holding the
      card otherwise. A polite region is announced when its content changes,
      not when it is inserted already filled, and the card is inserted at
      exactly the moments worth announcing (an update arrived, a check
      failed), so the region has to exist first. Nothing inside the card
      carries a live role of its own - not the sentence, the failure footer
      or the failed-attempt card - because a region nested in a region is
      announced twice.
    - **In flight, quiet.** While an update runs, waits or restarts
      (`inFlightUpdateKind`, retained phase included) the card is withheld
      and Check now is HIDDEN, not disabled; both come back when the update
      finishes or fails. The update card in the strip is on screen for
      exactly that span (an in-flight kind is never a quiet view), so it is
      the one place that describes the update: the catalog's "v1.5.1 is
      available." mid-download would contradict it, and activation debt's
      "v1.5.1 is installed — restart host to finish." would repeat it.
      Outside flight the answer still draws, so a pre-@1.3 host's activation
      debt, which has no update card, keeps its Restart to finish card.
    - **The command-line-tools fix** (Copy command, Show installation help,
      or the Desktop steps) replaces Update now here and nowhere else, and is
      NOT held to the in-flight rule - it keeps its card and sentence too: it
      is a fix for the tools rather than a control over the update, a work
      park can be waiting on exactly it (the update card's floor sentence
      points at its Show installation help), and the page's 30 s floor
      recheck runs for as long as a floor applies, which is only honest while
      the fix it is for is on screen.
    - **A refused or failed attempt** (`failureDescription`, clearing on the
      next try) is a red footer under whichever answer shows, or - under a
      quiet answer or in flight - a destructive card of its own
      (`data-answer="failed-attempt"`). It is not the
      answer too: `describeCheckState` lost its failure-first arm, so the
      answer beside it is what the catalog still says. It is not held to the
      in-flight rule: a refused Force update… is answered during the very
      park that counts as in flight, and its dialog closes on the refusal
      expecting this card to say why.
    - **A check that settled with no catalog** (the host's CLI failed, or
      answered in a format this app can't read) is "Update check failed" over
      "Couldn't check for updates on build-box.", with the reason in the
      footer like any other failure. The footer is never promoted to the
      card's line: `failureDescription` is the last ATTEMPT's failure
      (`installFailure ?? check.transient`, or a store-format refusal), so an
      earlier install's error would read as what the check reported. It never
      falls through to "Checking for updates…", which is the first load's
      alone and draws no card.
    - **The stranded answer** ends "…Pick it from the versions below to
      move.", plain text: the version list it points at is on the same tab,
      under the card.
    - **Not manageable here** (too old, no Traycer CLI, managed outside
      Traycer): the degrade card, with no control. The version list under it
      is withheld (so is Check now) and does not repeat the sentence.
    - **No auto-update caption.** The switch is the next row on the same tab
      and states the policy itself.

  - **Updates ▸ Traycer Desktop row** (`HostOverviewDesktopAppRow` in
    `host-overview-desktop-app-row.tsx`), under the answer card and above the
    auto-update row. It is the APP's update, not the host's: the two are
    separate artifacts that update separately, and this is the page where a
    host update happens, so a host that just moved to a new version would
    otherwise sit above an app still on the old one with nothing saying the
    app has an update of its own.
    - **Gate.** `host.isLocalMachine` and a desktop updater bridge
      (`useDesktopAppUpdates().bridge !== null`), decided in the panel. A
      remote host's page says nothing about the app in this window, and a
      browser has no app to update. It needs no route to the host, so it
      stays while the host cannot be reached. Nothing is drawn until the
      updater's first snapshot names a version.
    - **One snapshot, no machinery.** It reads the snapshot the header's
      update button and the update toast read, and runs the same download
      (`bridge.downloadUpdate()`) and the same guarded restart
      (`requestAppUpdateInstall`), so the three cannot disagree.

      | Updater state                                         | State line            | Control                             |
      | ----------------------------------------------------- | --------------------- | ----------------------------------- |
      | a finished check found nothing                        | `Up to date (vX)`     | none                                |
      | `available`                                           | `vY available`        | Download                            |
      | `downloading`                                         | `Downloading N%`      | Download, waiting, with a spinner   |
      | `ready`                                               | `vY ready`            | Restart                             |
      | `ready` with `installGuidance`                        | `vY ready`            | Finish update (the guidance dialog) |
      | `error` with `installGuidance`                        | `Update not finished` | Finish update (the guidance dialog) |
      | anything else (checking, a plain error, no check yet) | `vX`                  | none                                |

    - **"Up to date" is a claim about a check.** The updater publishes
      `up-to-date` only for a check the user asked for; an automatic check
      that finds nothing returns to `idle` with the check time and the feed's
      latest version set. Both read "Up to date". An `idle` without them, and
      every other state, shows the version and claims nothing.
    - **An `error` carrying `installGuidance` keeps Finish update, and
      names no version.** A Linux deb/rpm install whose privilege prompt
      failed reports the failure AND the steps that finish the downloaded
      file by hand, so the row keeps Finish update, as the update toast keeps
      View instructions. Its state line is "Update not finished", never
      "vY ready": the updater holds that guidance until the staged update is
      discarded, so it can outlive the install it came from (a newer version
      found later replaces `latestVersion`, and if that download fails the
      guidance is for the older file). The snapshot does not tell the two
      apart, so the row claims neither. `ready` does name its version. A
      blocked install (`installBlockedReason`) keeps its control disabled
      with the reason as the row's line.
    - **One button, and one standing live region.** Download, Download
      waiting, and Restart are the same button, so the focus of whoever
      pressed it is not dropped when the download starts. While it waits
      (the download, the restart) it is `aria-disabled` with its press
      ignored, NOT natively `disabled`: Chromium moves the focus to the
      document the moment a focused button becomes `disabled` and does not
      return it (measured in the app's engine; jsdom keeps it, so no Vitest
      case can see the difference). Native `disabled` is only the blocked
      install. When the control does go (a failed download, a withdrawn
      candidate) while it holds the focus, the row itself takes it. The
      row's `role="status"` region is always mounted and empty when quiet,
      for the reason the answer card's is; it says the download began (never
      its percentage), that the update is ready (and, when it is, that
      finishing needs a manual step), and that the restart began. A failure
      is the update toast's to report, here as everywhere.
  - **The restart offer** that opens by itself (`deriveActivationAutoOpen`)
    stays at panel level, so it opens over whichever tab is showing.
  - **One component per tab**, each drawing what the panel hands it; the
    queries, the mutations and every dialog stay in `host-overview-panel.tsx`,
    so the update card in the strip, the answer card and the version list
    on Updates are still one `useHostOverviewUpdates` instance. The dialogs
    open over whichever tab is showing: the restart confirm, the three "Host
    is busy" force-or-defer dialogs (restart, staged-update force, bound
    dispatch), the restart offer that opens by itself after an update started
    here has installed, and the Doctor sheet. The trigger and phone-`Select`
    badges (the Ports count, the Installation dot) hang on `HostOverviewTabs`'
    `badges`.

    | Tab          | File                                 | What lives there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
    | ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | Installation | `host-overview-installation-tab.tsx` | About this host (`host-overview-about-this-host.tsx`, from the account's record, so it reads offline), the Install record shown open (`host-settings-installation-details.tsx`), OS service (`host-overview-os-service-section.tsx`) - both replaced by one needs-a-connection line when unreachable - then Command-line tools (this computer only, `host-settings-package-manager-upgrade-hint.tsx`, which also draws the trigger's dot), the Danger zone last                                                                                      |
    | Updates      | `host-overview-updates-tab.tsx`      | The answer card, only when the answer has news or an action (`host-overview-updates.tsx`: icon, title, the update answer, Update now or the command-line-tools fix, the failed-attempt footer), the Traycer Desktop row (`host-overview-desktop-app-row.tsx`: the app's own update, desktop app and this machine's host only), a single-row auto-update group without a drawn label, then Pick a different version (`host-overview-version-picker.tsx`) with Check now on its heading, its release-candidate choice, version list and inline refusal |
    | Data         | `host-overview-data-tab.tsx`         | Import & migration (`HostImportMigrationSection`), Version history (`ArtifactVersionSettingsSection`), then an unlabeled File edit snapshots group (`HostFileEditSnapshotsSection`); one disk connection line replaces all groups when unreachable                                                                                                                                                                                                                                                                                                   |
    | Ports        | `host-overview-ports-tab.tsx`        | `HostPortForwardsCard`, on every host: one sentence when there is no list (connecting, unreachable, older host, failed read, nothing forwarded), else Forwards on this host and Ports other machines hold here, then Refresh; the trigger's count                                                                                                                                                                                                                                                                                                    |

  - **Ports is on every host, in every state.** There used to be a card that
    was absent whenever nothing was forwarded and on hosts without port
    forwarding. That rule is gone: the tab always has a body, and it says what
    it can't show. `useHostPortForwards` (`host-port-forwards-state.ts`)
    resolves one view in this order: the scope is connecting or the host is
    restarting → the loading shape (`HostScopeConnecting`); the host can't be
    reached → "Port forwards run on build-box, so they need a connection to
    it."; the handshake lacks `portForward.listForHost` → the page's standard
    `describeOverviewDegrade("unsupported")` sentence; the last settled read
    failed → "Couldn't read build-box's port forwards." with Refresh below it;
    nothing is forwarded or held → "Nothing is forwarded through build-box.
    When an agent forwards a port on this host, or another machine holds one
    of its ports, it shows up here so you can stop or cut it."; otherwise two
    groups. **Forwards on this host** (`owned`) lists description, port, state
    and route with the counters: Forwarding or Binding → Stop, Interrupted or
    Stopped → Clear. **Ports other machines hold here** (`held`) shows
    "Listening for laptop" or "Reached by laptop", the open connections and
    Cut, confirmed with the same dialog as before. A group with no rows isn't
    drawn. **Refresh** sits below the lists and re-reads them at once. The
    Stop and Cut mutations and the Cut confirm stay in the card, where they
    were before: the Cut confirm is modal, so no tab switch can happen under
    it.
    - **The count.** The Ports trigger and the phone dropdown's Ports item
      carry owned plus held (`HostOverviewPortsCount`) when there is at least
      one. There is no count at zero, on a host too old for port forwarding,
      or while the list can't be read (connecting, restarting, unreachable, a
      failed read).
    - **One read, re-read every 15 seconds.** The panel reads
      `portForward.listForHost` ONCE, for both the body and the count, so the
      read starts with the page rather than at the tab's first visit. The read
      keeps today's gates: nothing while the host is unusable or before its
      handshake names the method. The host has no change signal for port
      forwards, so the count would go stale without polling. The cadence is
      the method's `HOST_METHOD_POLL_TABLE` entry (`fixed`, 15 s; the user's
      call), which `usePortForwardListFor`'s required `poll` opts into. It
      runs only while the window is visible, never in the background. A
      forward that stops therefore drops out of the count within 15 seconds.
      Window focus, Refresh and a Stop, Clear or Cut still re-read it
      immediately.

  **The page reads the scoped host's OWN RPC** (`host-overview-panel.tsx`):
  `host.status` for what it is running, `host.identity.get` for what it is
  called, `host.getInstallationInfo` for how it was installed; buttons are
  `host.restart`, `host.doctor`, `host.identity.set` and `host.update.*`. Local
  and remote render the SAME components from the SAME answers - that equivalence
  is the deliverable, and `host-overview-parity.test.tsx` pins it by rendering
  both variants against one set of RPC fixtures. Before this, the local CLI
  bridge (`runnerHost.hostManagement`) was the primary source, which is why a
  remote host got a thinner page describing it in a different dialect.
  - **Per-button degrade, never a page-level gate.** Each control asks
    `useHostMethodSupport` for its OWN method: an old host can have `host.status`
    and not `host.restart`; a current host on a box with no Traycer CLI can
    restart but cannot run doctor or update itself. The tri-state is load-bearing
    - `null` ("no handshake yet") must NOT degrade, because this page's own first
      RPC is what produces a handshake. A degraded button carries
      `data-degraded="<reason>"` and a tooltip naming the remedy, which differs by
      reason (`unsupported` → update the host; `cli-unavailable` → install the CLI;
      `externally-managed` → use the cloud pin). `useHostCapabilityProbe` keeps one
      bounded released-floor read mounted while any answer is a stale `false`, so a
      host upgraded in place under the same id can overturn it.
  - **Status card** = `HostIdentityCard`, the same component the remote path
    already used, now carrying a `nameAction` slot, a `sessionCount`, a verb bar
    plus a `displayName` and a `version` the caller decides. Both names follow
    the SAME two-layer rule: the host's own answer (`host.status`'s
    `hostVersion`) when there is a route, the registry/directory copy when there
    is not. Version is single-sourced to that identity line on purpose - it used
    to also appear in the endpoint line from a different source, so one card
    could show v1.4.2 (the registry row) above v1.5.0 (the RPC) at the same
    time, which reads as broken rather than stale.
    - **Layout.** Name, rename pencil and tags on one line; presence dot, health
      label, the lifecycle mode line (this machine's own host only - the
      `lifecycleLine` slot, "keeps running after quit", linking to General ▸
      When you quit Traycer), platform/arch/version and the sessions chip on
      the next; then a
      footer verb bar; then Host ID. Rename is a pencil ON the name rather than
      a third word beside Restart and Run doctor - it was the only one of the
      three whose object is the name, and as a peer button it read as an equally
      weighted maintenance verb. Its accessible name is still literally
      `Edit name`. The verb bar is a footer strip rather than a right-aligned
      header cluster because the header already carries a name, a pencil and up
      to two tags, and the two competed for one row at every settings width
      below full screen.
    - **The `ws://…`/pid meta row (`host-overview-endpoint`) is GONE**, and with
      it the page's one deliberate local/remote difference. It showed the
      loopback endpoint and pid locally, `via <relay host>` remotely; neither
      half is actionable from Settings - the pid names a process this page can
      only reach through the Restart button beside it, and the relay origin is
      infrastructure the account picked. What it carried that anyone acts on is
      whether the host is busy, which is now a chip on the identity line from
      `host.status.busyBreakdown` (via `describeHostBusy`): "2 agents · 1
      terminal working" / "1 terminal agent working" / "Idle". Emerald and
      pulsing only when `busy`; muted when idle; ABSENT while the host has not
      answered, because "Idle" is a claim and silence is not. A @1.1 host
      (`busyBreakdown: null`) falls back to "N sessions"; a host that is busy
      with no count at all says "Busy". `host-overview-parity.test.tsx`
      is correspondingly stricter - `endpointText` is no longer a named
      exception, so the two variants now differ on the "This computer" tag and
      the danger zone's removal plane and nothing else.
    - **"Active for this window" is no longer a row.** A full-width bar with its
      own background asserted one boolean about the WINDOW on the page about a
      HOST. The binding is an `Active` tag beside the name; when this window is
      pointed elsewhere, `Use in this window` joins the verb bar and carries the
      asymmetry sentence ("Tabs you already have open stay on the host they
      started on") as its tooltip, where it is read at the moment of deciding.
      `ThisWindowCard` survives for the recovery console, which has no verb bar.
  - **Name precedence, in two layers.** Reachable → `host.identity.get`'s
    `effectiveName`; unreachable → the registry `displayName` the scope row
    already carries (`resolveHostName`, whose local-machine special case was
    REMOVED - see the host-scope model). Both are the same string on a healthy
    fleet, because the registry's copy follows the host's `effectiveName` over
    the presence heartbeat, so the hand-off is a settle onto the fresher of two
    agreeing sources rather than a blank being filled. The RPC path's draft rule
    differs from the bridge's on one case and deliberately: typing the machine's
    own name does NOT clear the override, because `effectiveName` folds a
    registration label that need not be the hostname. Dirtiness is measured
    against the SEED the input opened with, not against `customName` - on a
    labelled host (`{customName: null, effectiveName: "Build Box"}`) the form
    opens showing the label, and comparing that to `customName` made an
    UNTOUCHED form read as dirty: Save was live on open and one click froze the
    label into an explicit override nobody asked for. A no-op draft now neither
    enables Save nor issues a write.
  - **Restart** is claim-gated. The client mints a `transitionId` when the action
    is ARMED and reuses it for that action's retries - the host adopts a claim it
    already granted only on a matching id, which is what makes a retry after a
    lost ack idempotent instead of a busy refusal. `{outcome:"busy"}` is NOT an
    error: the host closed session admission, found work in flight and reopened
    it, so it renders as an amber notice with a Try again, never a red toast.
  - **Updates**: one hook, two places. The drain-gate force sits in the
    notices strip above the tab bar; the host's own answer (`host.update.*`)
    in the answer card, the VERSION LIST with Check now on its heading, and
    the account
    registry's auto-update policy sit on Updates
    (`HostAutoUpdateRow`, keyed by `hostId`, controls capture their target when
    armed). The auto-update switch is a single-row group with no group label:
    its row title says Auto-update, and the Updates search entry remains on the
    tab trigger. Its pending tag says only "Update pending", with no version.
    The row works while the host is unreachable because it writes the account,
    and says the setting is applied at the host's next check-in (within about
    10 minutes, when no sessions are running).
    - **Pick a different version** is a separate group. Its introduction says
      it can install a release candidate, hotfix or earlier release; the
      Include release candidates checkbox re-asks the host and explains when
      the host chose inclusion from its installed release-candidate line.
      Above older rows that cannot open newer chat stores, it warns about the
      access lost until this host updates again. The list can say it is asking,
      say no versions are available, or say the host returned no list; Check
      now on the group's heading (a ghost button with a refresh glyph that
      becomes the spinner while it runs, hidden while an update is in flight)
      is the page's only one, so the no-list state carries no second copy.
    - **The version list replaced a free-text pin.** `host.update.check` returns
      the whole manifest, not just `latest`, so the Overview renders the same
      per-row-Install list the local recovery console has always had - for a
      remote host too. Rows are `HostVersionRows`, shared with the bridge-backed
      `AvailableVersionsList`; each surface projects its own payload to
      `HostVersionRow` rather than one faking the other's shape (the RPC
      manifest has no `platformKey`/`manifestUrl`, and inventing them was the
      first attempt). An install in flight freezes EVERY row, which is where the
      old `showUpdateNowInput` guard went - it existed so a second
      `desiredVersion` write could not retarget a draining update.
    - **Explicit downgrades are supported.** The picker permits any available,
      non-yanked version with different SemVer precedence from the installed
      version (build metadata alone is not a distinct target). Hosts must
      negotiate `host.update.install@1.2` before older rows are enabled; earlier
      hosts show guidance to update first. The summary and automatic updater
      still offer only newer versions. A downgrade dispatch
      opts into `host update --allow-downgrade` after checking the host's CLI
      supports it; the CLI uses a private verified install source while keeping
      update progress, busy-host refusal, and the post-swap health check. An
      older CLI that cannot honor a downgrade is refused before dispatch.
      This installs a version once; it does not pin it against future updates.
      Desktop launch reconciliation may install a newer resolved release, and
      the host reconciler still enforces the channel's minimum supported version.
    - The asset lookup takes a SOLE `platforms` key as authoritative: the host's
      CLI projects each entry to `currentHostPlatformKey()` before emitting it,
      so re-deriving a key here would get win32-arm64 wrong (it resolves to the
      emulated `win32-x64` build, which the registry row does not know). More
      than one key means an older CLI that emitted the whole map, and only then
      is the registry's platform string used - a miss reports "no asset" rather
      than guessing.
    - **What this gives up, stated:** the pin was applied by the host's own
      reconciler on its next check-in and so needed no route. Choosing from what
      the host reports does need one, so an OFFLINE host can no longer be
      pinned; the auto-update policy beside it still works without a route.
      `isValidHostVersion` (the client mirror of authn-v3's server-side regex)
      went with the input it validated.
    - Check is one shared query for the answer card and the version list. It
      populates on its own; Check now forces a refetch of both.
    - The RPC half degrades away WHOLE - Check-now and the list with it,
      leaving the auto-update policy as the only update control, plus one line
      saying why - without the methods, without a
      CLI (`cli-unavailable`, from the check side or the install side), or on an
      `externally-managed` refusal. The last two are knowable only from an
      ATTEMPT, so they are discovered rather than negotiated, and once seen they
      are STICKY for the mounting: both are facts about how the host is set up,
      not about that attempt, and leaving Check-now behind would keep offering
      the one action the host has just said can never lead anywhere.
      `cli-failed` / `invalid-output` are deliberately NOT sticky - one attempt
      going wrong with the mechanism intact - so the controls stay and an inline
      `host-overview-update-attempt-failed` notice clears on the next try. A
      transient refused Install appears under the list and on the answer
      card, both on Updates, from that one failure state; the version rows
      unfreeze and the page stays on Updates. A structural refusal (for
      example, a CLI that disappeared after the list was read) withdraws the
      list and the inline refusal with it; the answer card above states the
      not-manageable reason once.
      Connecting or restarting shows a loading shape in the list's place.
      An unreachable host keeps the auto-update row and says "Connect to
      <host name> to choose a version." A structurally unmanageable host
      (too old, no CLI, or managed outside Traycer) also keeps the auto-update
      row and shows its reason in the list's place.
      Progress after an accepted install comes from `host.status.updateProgress`,
      not from the install response, because the swap is detached and outlives
      it.
    - **The operation card renders an OPERATION, never a quiet host.** The
      shared projection (`projectFleetUpdateView`) consults the coarse
      `updateProgress` marker BEFORE concluding `idle` from
      `updateOperation: {kind:"none"}`, because the shipped legacy updater
      (`traycer host update`, every host while the executor cohort is
      shadow-disabled) writes no attempt record at all - a @1.3 host on that
      path says "no attempt" and "updating" in the same reply, and reading the
      attempt alone rendered a live download → swap → restart as "Host is up to
      date" on the Overview whose own Update now had just started it. The
      coarse marker projects `updating` (generic sentence, indeterminate bar)
      or `failed` with the updater's own cause. Both are INFORMATIONAL: the
      marker is a file with no liveness (a crashed updater leaves a host
      serving `updating` forever), so `updating` neither holds the lifecycle
      gate nor earns the fast poll - Restart, Diagnostics and the service
      verbs stay usable under it, and the 10s `host.status` baseline is what
      refreshes it. A view `isQuietUpdateView` accepts (`idle`, or
      `unknown` with no retained phase) renders NO card: "Host is up to date"
      was a sentence about the catalog from a projection that knows only the
      attempt record, and it sat directly above the updates region saying
      "v1.3.0-rc.2 is available." about the same host. The landing banner hides
      on the same predicate, so the two cannot drift on where quiet begins.
    - **The two parks the marker cannot carry come from the RECORDS.** A busy
      host makes the legacy updater stop, and it stops by WITHDRAWING its
      marker (a refusal on policy is not a failure), leaving either bytes
      installed under a host still running the old version, or a newer host
      staged and waiting. `legacy-update-facts.ts` derives both from
      `host.getInstallationInfo` beside the same `host.status` read - debt by
      the CLI's own `readActivationState` rule (runtime-stamp equality when
      the record has a stamp, else comparable-and-unequal SemVer), staged wait
      as a stage at a different version than the install while `busy` - and
      the Overview hands them to the projector as
      `FleetUpdateWireObservation.legacyFacts`. They project the existing
      `waiting-to-activate` ("Update installed — restart host to finish") and
      `waiting-for-work` ("Update waits for N sessions to finish")
      kinds, AFTER the coarse marker and before `idle`, and like every park
      they hold no lifecycle gate and earn no fast poll.
      **A CLI-floored `waiting-for-work` park says so instead of naming a
      count** ("Update waits for Traycer's command-line tools to be updated —
      see installation help"). Observed on real hardware: an rc-era CLI in the
      slot, a host sitting `Online · Idle`, and the card reading "Update waits
      for 0 sessions to finish" while the host's reconciler refused the resume
      every tick. The floor outranks the count at ANY count, including a
      positive one - finishing the work resumes nothing while no CLI on that
      machine can carry the release - and it points at the remedy row's
      existing `Show installation help` rather than restating it, the same
      shape as "Update status unavailable — see Diagnostics". The WORK park
      only: `waiting-to-activate` names a restart into bytes already placed,
      which no CLI upgrade unblocks. The landing banner passes `false` and
      keeps the count, because it has no floor lane and so no affordance for
      the substituted sentence to point at.
      **THREE conditions, and the first shipped version had none of them
      right** (it asked only whether the summary walk found a floor):
      (1) the remedy row is actually RENDERED - the region short-circuits to
      its degraded notice on `degrade` and the whole region sits behind
      `usable`, neither of which gates the card, so a floor read while healthy
      could leave the sentence pointing at a button that had since gone;
      (2) the floor is the PARK's version, read by the same `readCliFloor` on
      that version rather than on the walk's candidate - a manifest carrying a
      floored rc.4 above an installable rc.3 must not make a park on rc.3 claim
      a floor; (3) this card is offering no working force control for the park.
      That last one is why the withheld-Force claim is the CALLER's finding and
      not a property of the floor: it holds for the record-derived staged wait,
      whose Force the floor gate withholds (a floored stage is not
      `stagedEntryOfferable`), and NOT for a bound attempt, whose Force
      dispatches `host.update.continue` against the host's own bound-intent
      floor - a different floor from the catalog's per-version requirement,
      answered by the host itself with `cli-failed {cli-too-old}`, and
      deliberately not folded into this gate. `offersForceRestart` is half of
      that test because it decides whether the button RENDERS at all: at a zero
      count it does not, which is the observed case and still substitutes.
      **A TERMINAL attempt that is not `failed` yields the operation slot to
      BOTH of these parks** (D-49): `complete` and `superseded` let the
      records answer first, so "another actor delivered the version and this
      host is not running it" - which the executor ends as `superseded` with
      no error - still renders the debt sentence and its Restart, and a stage
      that is still waiting still renders its own park and its Force. A
      terminal attempt does not make a stage stop waiting any more than it
      makes an install stop needing a restart: the records describe what is
      still owed, the attempt describes what is over. Reaching that is NOT
      left to the host: whether `projectUpdateOperation` withholds terminal
      records from `host.status` is a projection detail that can change under
      us, and a sentence derived from the RECORDS must be reachable whenever
      the records say a park. `failed` is excluded, because its cause is the
      one thing a terminal attempt can say that the records cannot say for it.
      It is a fall-BACK rather than a substitution: with no park the attempt
      arm still answers, so `superseded` keeps projecting `idle` and
      `complete` keeps projecting `complete` - the landing banner's completion
      acknowledgement is rendered off that kind, and its leg passes
      `legacyFacts: null`, so a blanket substitution would have deleted that
      surface rather than reordering it. A park outranking a `complete` whose
      records disagree with the running version is deliberate: that IS
      "delivered, not running it". The yield sits ABOVE the attempt arm's
      staleness decay and is not a bypass of it - the park itself decays, so a
      status read that aged while the installation read stayed healthy renders
      the park as "last seen", never as live. The card offers
      **Restart** on the debt FACT rather than on the view kind, so a retained
      `failed` marker beside real debt keeps its failure text and still shows
      the way forward, and **Force update…** on a staged wait with a positive
      count, which confirms through `HostBusyForceDeferDialog` and dispatches
      `host.update.install {version: staged, force: true}` through the page's
      one install mutation. The offer and the dispatch share ONE catalog
      predicate (`stagedEntryOfferable`, the refusal
      `describeForceUpdateRefusal` derives for the staged version): the
      catalog must still list it, not withdrawn, with an asset this page can
      resolve (a host whose record carries no platform is not offered Force
      against a multi-platform entry - a deliberate narrowing; the CLI's own
      `host update --force` still works there) and no CLI floor. The
      store-format floor adds a second gate on both: a staged DOWNGRADE whose
      row would show "Install anyway" (a blocked, unknown or failed chat-store
      survey) is still offered, its dialog carries that row's loss sentence as
      a separate paragraph (`stagedStoreFormatConfirmation`), and confirming
      dispatches `acceptStoreFormatLoss: true` as the row's Install anyway
      would; a stage whose restriction has no confirmation (survey pending, or
      a peer that cannot honour consent) is withheld, and `prepareInstall`
      re-reads the row's evidence at dispatch either way. A
      withdrawn stage is neither offered nor dispatched (the CLI would purge
      the parked stage and then refuse the version) and carries no floor
      remedy, since no CLI version installs a yanked release; an asset the
      catalog has since marked unavailable does NOT refuse, because the
      bytes are already staged and the CLI installs them without resolving
      the asset again. Under debt the updates sentence reads "v{installed}
      is installed — restart host to finish." and the catalog is compared
      against the INSTALLED version, so Update now stays only for something
      newer than what is already on disk. Because the facts live in records
      that change under a mounted page, `host.getInstallationInfo` polls at the
      `host.status` cadence (10s) and an accepted install invalidates it beside
      `host.status`. The record leg is held to the SAME liveness rule the
      status leg is projected under (`canonicalReadIsLive`: not errored, not
      paused, not aged past its staleness while not fetching, and the query
      itself enabled) - not "has not failed" alone, and not a second
      staleness rule with its own timestamp arithmetic: a read that is not
      live yields NO facts, so the two record-derived rows and every offer
      keyed on them (Restart on the debt fact, the installed-version
      comparison under debt, Force update… and the confirm it opens) are
      withdrawn until the next live read, and the projector falls through
      to the status leg. The withdrawal is scoped to the record leg on
      purpose: expiring the whole observation would demote a live attempt
      the status leg is reporting (progress bar, lifecycle gate, fast poll)
      on one failed `host.getInstallationInfo` poll - likeliest exactly
      during a swap. An unusable scope, by contrast, demotes through the
      status leg and keeps the record-derived sentence qualified ("Last
      seen: …"). An in-flight refetch is live (still looking); a request
      whose response never arrives ends as an error - each attempt bounded
      by the transport's 30 s response timeout, one query retry - never as
      an indefinitely retained payload. And a record leg that is not live is
      not "gone": the facts as read keep the catalog's comparison baseline
      (an activation debt read from the record still names the installed
      version, and the region's sentence says "(last known)" - whenever
      EITHER leg is not live, since the debt is the record's installed
      version read against the status read's running version - rather than
      re-offering that version as available), while every offer and the
      projector's park take the live facts only. An open Force confirm
      closes only when a live leg no longer carries its stage (the running version moving re-keys the
      query, and the `usable` rule closes the confirm there), and an attempt
      park's Restart is offered only when a live leg vouches that no stage
      waits (Restart cannot activate a stage). The offers need a live STATUS
      read as well (`statusLive`: the same `canonicalReadIsLive` over the
      status read's health, `usable` included). The retained status payload
      stays in the facts so a park renders qualified ("Last seen: …"), but
      Restart on the debt fact, Force update… and an attempt park's Force
      restart are withdrawn while the status read has failed or aged - a
      Restart pressed off an old `hostVersion` would restart a host that may
      already have activated; the evidence stays, the dispatch does not. An
      open restart confirm is closed by the `!usable` rule only when it was
      armed for the cooperative `host.restart`; one armed for the bridge
      respawn (`restartViaForceFallback`, captured at open) survives the
      scope going unusable - the respawn needs no client and is the recovery
      an unreachable local host needs most - and closes on its own
      settlement or when this page's host stops being this machine's. The Overview is the only leg that derives: the landing
      banner keeps its desktop-status debt arm, and the fleet legs pass
      `legacyFacts: null`, which the projector reads as "not observed".
    - **An ATTEMPT's park is resumed through a BOUND METHOD, not a version.**
      `host.update.activate {attemptId, force}` and
      `host.update.continue {attemptId, force}` name the attempt the record
      already describes; the operation comes from its continuation, so no
      version crosses the wire and nothing here consults the release catalog
      (`describeForceUpdateRefusal` is deliberately not applied: `activate`
      places no bytes, and `continue` resumes bytes the attempt was authorized
      to fetch when it was created — a downgrade park re-downloads the same
      version it was created for, which is the case a staged-version force
      cannot even express). The same holds for the store-format floor's
      consent: neither bound request carries `acceptStoreFormatLoss`, because
      the CLI records the consent an attempt was created under on the
      attempt's claim (`HostUpdateAttemptClaimBaseline.acceptStoreFormatLoss`,
      beside `allowDowngrade`) and a resume acts on that recorded authority,
      so a downgrade dispatched from a row's Install anyway that parks on a
      busy host finishes through Force update without a second consent — and
      its dialog names no loss, for the same reason it does not re-ask the
      downgrade. They are METHODS rather than an intent field
      precisely so an older host, which has neither, is refused at dispatch by
      the transport: `useHostSupportsMethod` withholds the control per method
      and the page keeps today's `host.restart` / `installForce` routes. Each
      control is gated on its OWN method — two authorizations, and a host may
      advertise one without the other, and both sit behind the region's own
      gates beside the two legacy controls (`updates.degrade`, `anyPending`,
      and a live status read) — see the recheck bullet below. All three
      update dispatches share
      `hostMaintenanceMutationKeys.updateInstall()` and one pending flag, so a
      second dispatch is never offered beside one already in flight.
      Outcomes (D18): `dispatch-indeterminate` maps `nothing-to-do` →
      "already up to date", `recovered-complete` / `recovered-failed` → what
      the last run did, every `refused-attempt-gone` /
      `refused-unverifiable` / `refused-install-changed` → "the host changed
      while the update was being prepared", anything else → today's
      "couldn't confirm" WITH the reason; `cli-failed {cli-too-old}` → "this
      computer's Traycer CLI is too old to resume the update". All of them
      release the accepted latch; only the indeterminate arm re-reads.
    - **The card's controls come from the ATTEMPT when there is one.**
      `waiting-to-activate` renders **Restart**, which opens the activation
      dialog and dispatches `activate {force: true}` — locally AND remotely,
      where the legacy busy verdict could only ever be answered on a
      Desktop-local host and toasted "declined" elsewhere. `waiting-for-work`
      renders **Force update…**, which dispatches `continue {force: true}`;
      `force` is the user's consent to end the live work the dialog counted,
      and it is what gets the CLI past its own busy gate. **Force update… —
      and only it — still requires the host to have REPORTED a positive session
      count** (`offersForceRestart` is unchanged by this cutover): a
      `waiting-for-work` park with a null or zero count renders no control.
      Restart has no such condition; it renders whenever the card has an
      `onRestart`, which is what lets an idle host that has finished installing
      be restarted. Both fall back to the record-derived controls above on a
      host without the methods — and the fallback is not a second chance: a
      bound control withheld by the gates below leaves the card without that
      control rather than routing the attempt through `host.restart`.
      `holdsLifecycleGate` is untouched; the withdrawal is the one the two
      legacy controls take (`statusLive`, `updates.degrade`, `anyPending`),
      because a control whose confirm the render-time rules would close in
      the same commit is not a control.
    - **The activation dialog opens ITSELF, once, for a dispatch this page
      made.** A per-host slot in the write-latch store records
      `{attemptId, dispatchedAt, incarnation, seen}` on an `accepted` answer
      with an attempt id, from any of the three dispatches. `incarnation` is a
      token minted per `HostOverviewPanel` mount: an install's settle
      deliberately outlives the mount (that is how the latch settles and the
      reads are invalidated for a swap the user navigated away from), and the
      ownership write is the one part of it that must not, because its only
      consumer is a modal a mount opens. `seen` flips on the first
      `host.status` frame naming that attempt, which is what stops the cache
      still serving the PREVIOUS attempt from being read as this dispatch's
      answer. The dialog then opens on the first `waiting-to-activate` view for
      that attempt — never for another window's dispatch, never for a park that
      was already there, never for `waiting-for-work`, never on an unusable
      scope, never without `host.update.activate` — and exactly once
      (`autoOpenedFor`): Defer, Escape and a scope change all close it and none
      re-opens it, because a modal that returned on the next poll would be one
      a person cannot dismiss for as long as the park lasts. An open offer is
      closed by the same render-time rules the staged-wait Force confirm
      takes — the page-wide gate arming for anything but its own dispatch,
      the region retiring, an unusable scope — plus one of its own: the
      attempt it names no longer being the one on screen. The auto-open WAITS
      on the first two rather than firing into them: a shot fired while either
      holds is closed in the same render pass, before anyone saw it, with
      `autoOpenedFor` already recorded. Both are transient — the page-wide
      gate is the accepted dispatch's own latch, and `updates.degrade` is a
      RECOVERABLE retirement (`check.sticky` is read off the latest answer,
      `installDiscovered` is cleared by refutation, and the CLI-recovery poll
      lane re-asks at 5 s so a reinstalled CLI revives the region unprompted).
      Waiting costs a poll; firing into them costs the shot for the life of
      the park. Its confirmation is
      the shared `HostBusyForceDeferDialog` with `purpose="update"` on both
      legs, because Force here dispatches a bound UPDATE method even when the
      activation leg's effect is a restart, and with its own heading (an
      activation park is typically an idle host waiting to be restarted, so
      "Host is busy" would contradict the sentence under it). The slot clears on
      a terminal frame for its id, on a frame naming a different id once `seen`
      is true, 60 s after a dispatch no frame ever named, and on an ACCEPTED
      `host.service.deregister` for that host — the service the dispatch was
      made about is being removed, and keeping the slot would let a
      re-register under the same `hostId` inherit its activation offer. That
      last one fires on the accepted ANSWER, not beside the pessimistic
      dispatch-time arm of `deregisterAcceptedAt`: over-locking controls for a
      bounded moment is safe, discarding ownership is not, and a refused
      deregister leaves a dispatch that is still good. A scope flip is
      deliberately NOT one of them: that flip releases the latches, which guard
      a window of time, while ownership is a fact about who asked.
    - **A local record can show `restarting`, and the proof EXPIRES.** For the
      Desktop-local host the Overview reads the same durable-record leg the
      landing banner does (`useLocalAttemptRecordObservation` →
      `projectLocalUpdate`, one shared precedence-plus-projection; a remote
      host keeps the status-only observation). A record observation carries
      Desktop's own probed `liveness` and the clock at that probe, and phase
      `restarting` with `liveness: "live"` projects the LIVE `restarting` kind
      — bar, lifecycle gate — only while
      `0 - one tick ≤ nowMs - livenessObservedAtMs ≤ 5 s`
      (`LOCAL_LIVENESS_PROOF_MS`; the slack absorbs the tick's own
      quantisation, and a real backward clock step is still refused). Every
      other record read keeps `unknown` + last-known, outside the gate. That
      deadline is measured against a one-second renderer tick and NOT any
      query's `dataUpdatedAt`: the host being down is exactly when
      `host.status` stops advancing, and Desktop's broadcaster keeps its idle
      loop running through a failing `publish()` — so nothing new lands in a
      controller query with `staleTime: Infinity` and a deadline measured
      against either timestamp would never arrive. Expiry therefore lands on
      the first tick after the deadline rather than at an exact five-second
      wall, and releases the gate while keeping the last-seen sentence.
      **The tick is the RECORD leg's clock alone** (`LocalUpdateClock`, two
      named instants). The WIRE leg keeps the instant its own read was taken
      at, because `observationFromCanonicalRead` already folded the query's
      health into `freshUntilMs` — so a healthy read is fresh until health says
      otherwise, never until the round trip runs long. Feeding the tick to both
      made one `host.status` slower than the fresh window (2.5 × the poll
      delay, so 5 s while the accelerator holds the poll at 2 s) demote a live
      attempt to "Last seen", drop the page-wide gate and disengage the poll
      accelerator, once per cycle. Precedence between the two legs
      (`preferLiveOverRecord`): a healthy wire read always wins; once it is
      stale, the same attempt is ordered by `(generation, sequence)` — so a
      repeated read of one unchanged record can never outrank a live frame —
      and a different attempt falls back to the record's own `updatedAt` as a
      sanity bound, with an unparseable or future stamp losing. No query's read
      time is an input. This is a THIRD leg beside the status and installation
      reads, and it keeps their rule rather than restating it: the wire leg's
      liveness is `canonicalReadIsLive` over the status read's health
      (`statusLive`), the installation leg's is its own (`installationLive`),
      and the record leg's is Desktop's probe with the expiry above. The
      support flip is what decides whether the record leg is CONSULTED —
      `usable` is not, because the whole point of the leg is the window in
      which the scope cannot reach the host — while the proof deadline
      decides whether what it says is live. `activationDebt.live` joins the
      two READ legs (`installationLive && statusLive`) and is untouched by
      the record leg, which carries no installation record.
    - **A CLI requirement has a remedy in the card.** The best target's
      projected unavailable asset is the executing CLI's verdict, recognized
      by `HOST_CLIENT_FLOOR_REASON_PREFIX` from the shared
      `host-version/client-floor-reason` module (the one authored reason a
      client acts on; it lives in `clients/shared` because both endpoints are
      OSS clients, and becomes protocol the day a host authors it). A floor
      that is not a version - the pre-repair projector put the prefix on an
      unreadable floor too - is not repairable: every route shows
      installation help, and the recheck below does not run.
      A stored CLI version that already satisfies the requirement does not
      clear it: the host can still be executing an older copy. A retained hash
      on a withdrawn platform build is not evidence of a CLI requirement.
      `describeCliFloorRemedy` owns the sentence and actions together:

      | Installation and update state                                                                               | Card action                                                                                                                                                                                                                               |
      | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
      | Any source, floor that is not a version                                                                     | Show installation help; no command, no recheck                                                                                                                                                                                            |
      | Local Desktop, feed's latest (or the installed build, when up to date) below or incomparable with the floor | The Desktop floor fallback, decided before the available, downloading, ready and up-to-date rows below (never for a missing floor): a sentence naming the shortfall plus the copy-command route for the bundled CLI and installation help |
      | Local Desktop, update available                                                                             | Download update, respecting the Desktop block reason                                                                                                                                                                                      |
      | Local Desktop, downloading                                                                                  | Disabled download progress                                                                                                                                                                                                                |
      | Local Desktop, ready                                                                                        | Restart to update through the shared install flow, or Finish update for manual guidance; block reason and in-flight state still win                                                                                                       |
      | Local Desktop, up to date                                                                                   | Hint to restart Desktop to finish updating the host tools                                                                                                                                                                                 |
      | Local Desktop, check failed or updater unavailable                                                          | The bridge's error message (or a fallback sentence), Check again, and installation help                                                                                                                                                   |
      | Local Desktop, idle or checking                                                                             | Checking: the checking sentence. Idle: an invitation to check, one guarded automatic bridge check per mount (the authoritative snapshot, only an updater never asked, `automatic` intent) and a Check for updates button                  |
      | npm, local or remote                                                                                        | Copy `npm install -g @traycerai/cli@<required version>` - the exact floor when the payload names one, RCs included; the table's stable `@latest` only when it names none                                                                  |
      | Homebrew, winget, Scoop, apt, rpm; stable floor                                                             | Copy that manager's command from `PACKAGE_MANAGER_UPGRADE_COMMAND`                                                                                                                                                                        |
      | Homebrew, winget, Scoop, apt, rpm; prerelease floor                                                         | Show installation help: those feeds carry stable releases (Homebrew's formula takes a prerelease only by manual dispatch), so the rolling command would report nothing newer                                                              |
      | Manual, remote Desktop, or local Desktop without a bridge; known POSIX platform                             | Copy the recorded absolute CLI path as one single-quoted shell token plus `cli upgrade`; otherwise copy `traycer cli upgrade`                                                                                                             |
      | The same sources on Windows with a recorded absolute path                                                   | Copy `& '<path>' cli upgrade` and `& '<path>' host restart` for PowerShell; explicitly run outside Traycer on that machine                                                                                                                |
      | The same sources on Windows without a usable path, or an unknown platform                                   | Copy `traycer cli upgrade` and `traycer host restart`; explicitly run outside Traycer on that machine                                                                                                                                     |
      | Installation manifest unreadable                                                                            | Show installation help, opening the Doctor sheet                                                                                                                                                                                          |

      The copy rows explain an older executing copy when the stored version
      already clears the requirement. No row opens an in-app terminal: the
      1.2.0 hosts needing this remedy cannot run a supplied command on ordinary
      terminal creation. Check now stays; the remedy replaces Update now until
      the host accepts the candidate, and its copy says the page rechecks on
      its own rather than asking for a click (the recheck below is what
      restores Update now). Two pinned npm commands can be on screen in one
      Settings dialog and disagree on purpose: the Desktop sidecar's hint
      (`host-settings-package-manager-upgrade-hint.tsx`) pins the version
      Desktop bundles, the answer to "your npm CLI is older than Desktop's";
      this remedy pins the host's required floor, the answer to "this host
      refuses the CLI it has". Version rows on Updates retain their reasons.
      Sentence precedence preserves the record-derived parks: **activation
      debt → CLI remedy → unreachable → check failed → no manifest (the first
      load, "checking") → stranded on its release line / up to date →
      unavailable / available**. A check in flight is not a step: a re-check
      leaves the standing answer in place. A failed or refused attempt is not in this chain: it is the
      one line under the answer (`failureDescription`), so the answer beside
      it stays what the catalog says instead of repeating the failure. "Check
      failed" is the chain's one step about a failure, and only as a fact
      about the catalog: the check settled with none, so the step says so and
      leaves the reason to that line.
      A failed catalog read drops the remedy along with the actionable catalog.

    - **Repair rechecks while the Overview is open.** The Overview re-asks
      `host.update.check` every 30 seconds while it renders a CLI-floor
      remedy (`useHostOverviewUpdates`, invalidating the shared key the way
      the active-update accelerator does), and the first answer that clears
      the floor ends the recheck and restores Update now. Keyed on the
      rendered remedy, not on the response: which floored row the remedy
      names is the summary walk's answer (the installed line's matching
      stable and later RCs, strictly newer than what runs), and the response
      carries no installed version - a table lane over the response alone
      kept polling on floored rows of an `installed-rc` catalog that no
      remedy named, a release on another line included. The recheck stops
      with the remedy: a retired region (externally managed, unsupported
      install) shows a notice in its place and is not re-asked; so does a
      floor that is not a version (`repairable` false - no upgrade can clear
      it; a help-only remedy over a READABLE floor, such as a prerelease on
      a manager that publishes none, keeps rechecking, because an install
      made another way is what it waits for), and the page's own gate
      (`enabled`) holds it as it holds the region. It is a flat 30 s, hotter
      than the 5 s → 60 s lane it replaced but bounded by the remedy being on
      screen; each tick refetches, so Check now briefly reads busy on its
      own. The table keeps the `cli-unavailable` lane and the two error lanes
      for this method, nothing data-driven beyond that. The existing
      10-second installation-info poll refreshes the stored CLI facts beside
      it. A floored staged version, or one absent from the actionable
      manifest, offers neither Force update nor Force restart: restarting
      cannot activate a stage. The Force gate reads the catalog ENTRY's own
      floor too, apart from the asset's authored reason - staged bytes
      install whatever the asset's availability says - so an entry whose
      floor is not a version is refused even when the projector never
      prefixed the asset. A readable floor stays the asset's verdict: the
      stored CLI manifest is no substitute for the executing copy's own
      comparison in either direction. An open
      Force confirmation rechecks its exact version at click time, settles
      synchronously on refusal, and shows the reason inline. The card's
      Restart, Force update… and Force restart sit behind the same
      capability and page-wide gates as the header's Restart and the region
      (`restartDegrade`, `updates.degrade`, `anyPending`) - withheld rather
      than disabled, since the card reports the park and the header's menu
      item carries the reason - and an open confirm closes when its method
      is withdrawn or its region retires.
  - **Installation**, top to bottom: About this host, Install record, OS
    service, Command-line tools, Danger zone.
    - **About this host** (`host-overview-about-this-host.tsx`) reads the
      ACCOUNT's host record - the `HostListItem` the panel already holds
      (`scope.host.item`), never a host RPC - so it reads the same while the
      host connects or cannot be reached, which is when people come for the
      host id. Rows: Host ID (shortened, with copy; Copy host ID stays in the
      `⋯` menu too), Added to account (`createdAt`), Last seen, Last reported
      version (`status.appVersion`) and Platform (`formatPlatform` plus the
      architecture, as the header words it). Last seen reads "Online now"
      while the header's live evidence holds (`health.live`); otherwise
      `status.lastSeenAt` on the header's own ladder and clock
      (`formatElapsed`, `scope.nowMs`), so the two never disagree on one
      screen. A host the account has no record of gets no group, as it gets
      no Danger zone.
    - **Install record** (`host-settings-installation-details.tsx`) is shown
      open - it was a collapsed "Installation details" disclosure - and reads
      `host.getInstallationInfo`: Version, Build (only when it differs),
      Source, Installed, Verification, SHA-256 (shortened, with copy),
      Platform. `unmanaged` is a real state, not an error - a host run from a
      checkout has no install record - and it says so rather than claiming
      nothing is installed; a failed read and an unsupported host each keep
      their own sentence.
    - **OS service** (`host-overview-os-service-section.tsx`) is its own
      group: the registration sentence and manifest line, Re-register and
      Deregister with their confirms. A host that cannot report its service
      gets the standard unsupported sentence in place of the group's
      contents, under its label.
    - Those two are the tab's host reads. While the host connects they are
      the loading shape; when it cannot be reached one line replaces both -
      "The install record and OS service are read from <host>, so they need
      a connection." - and About this host, Command-line tools and the Danger
      zone stay.
    - **Command-line tools** (this computer only, behind the panel's
      `hasLocalBridge`) is the package-manager upgrade hint with its command
      and a copy button. The tab trigger and the phone Select's Installation
      item carry a warning dot (`LocalPackageManagerUpgradeDot`, hung on
      `badges`) that reads the SAME query as the hint -
      `useRunnerHostCliManifestQuery` (`runnerQueryKeys.hostCliManifest`) -
      under the same gate, so the dot and the group appear together and clear
      together, on the read that finds the tools current.
  - **Import & migration** (`panels/host-import-migration-section.tsx`), on the
    Data tab above Version history: **Import your work** (opens the session
    import wizard for the sessions on THIS host's disk) and **Data migration**
    (retry moving this host's local SQLite tasks and epics to cloud). Both came
    off General for the reason that section now states - they move one
    machine's data, and this page is the only one that names the machine. It
    stays out of Diagnostics for the older reason: that page is support
    capture, not user data recovery.
    - Both rows ride the STREAM transport, not the unary one, so the Overview
      re-provides `StreamRuntimeContext` from `useScopedStreamBinding` beside
      the unary `HostRuntimeContext` it already re-provided - the fourth stream
      re-provider, and safe for the same positional reason as the other three
      (no composer below it, so no path to the microphone; see the roster in
      `use-scoped-host-binding.ts`).
    - The group is WITHHELD, not emptied, until the stream beneath it names the
      host the page names. `useScopedStreamBinding` is null for a commit or two
      after an explicit pick, and null by design while `following`, so the
      provider falls back to the ambient stream - which is still dialing the
      effective host. Running an import or a migration through it would move
      one machine's data under another machine's name. Availability is read
      from that same client (`useSessionImportAvailableFor`) rather than from
      context, so the row cannot offer an import host A negotiated and submit
      it to host B. An empty titled card reads as a page that failed to load,
      which is why the whole group goes rather than its contents.
  - **File edit snapshots** (`panels/host-file-edit-snapshots-section.tsx`) is
    the single-row group after Version history, without a repeated group
    label. Its host RPC reads the stored size and clears snapshots behind the
    existing confirmation. While the host connects or restarts, Data shows
    `HostScopeConnecting`; if it cannot be reached, the tab replaces all three
    groups with "These live on <host name>'s disk, so they need a connection to
    it."
  - **Doctor** (`host-doctor-rpc-card.tsx`) has the host shell its own CLI. Two
    things make the report trustworthy over a connection, and both come from the
    host: the structured failure arms (`cli-unavailable` / `cli-failed` /
    `invalid-output` are ANSWERS - only a transport failure is an error, a 500
    means transport and nothing else), and the **transport vantage**. The host
    reports which issue codes its own vantage already disproves; over a local
    WebSocket `SERVICE_STOPPED` / `PORT_UNREACHABLE` / `PORT_CONFLICT` describe
    the listener that just answered us, so they move into a collapsed "checks
    this connection already answers" section and out of the count. Over a relay
    that set is EMPTY on purpose - a relay proves the relay, not the daemon's
    loopback listener - so the same code stays a real issue for a remote host.
    Fix routing: `host-restart`/`host-start` → `host.restart`, `host-logs` →
    `diagnostics.logs.tail` (tail rendered inline); `service-install`,
    `free-port-and-restart` and `host-install-latest` stay local-only and degrade
    to the copy-command affordance for a remote host. That is not a missing RPC:
    they repair a host that is typically not answering RPCs at all, so remote
    verbs for them were dropped from the plan on purpose.
  - **Danger zone** (`host-scope/host-danger-zone.tsx`) contains only removal:
    Remove Traycer (local CLI bridge, local host only, never gated on
    reachability), or **Remove from account** (an account write, remote +
    registered only). Without an available removal action, the group is absent.
    The account removal action is NEVER called "deregister" in copy - this app
    already uses that word for OS-SERVICE deregistration on the same tab,
    and two destructive controls sharing a verb is how someone reaches for the
    wrong one. Its confirmation is written against what the route actually does:
    `POST /api/v3/hosts/:id/deregister` stamps `deregisteredAt` and clears the
    presence lease, does NOT revoke, and keeps the `hostId` - so nothing is
    uninstalled and no data is deleted. What it does NOT do was got wrong here
    once, in the reassuring direction: a running host does NOT re-enrol itself.
    Its next heartbeat 404s and it reads that as `not-registered`, but
    `reconcile()` then finds the on-box device credential still present and
    still matching, takes `adoptActiveCredential()` and RETURNS - before either
    enrollment source, and `registerHost()` is the only caller that clears
    `deregisteredAt`. So it loops instead of recovering, and signing in again on
    that machine does not help either, because the interactive login path sits
    below that same early return. The dialog states both negatives explicitly,
    and the test pins the refuted claim as ABSENT - a dialog that quietly
    promises self-recovery is worse than one that says nothing, since it is the
    reason someone would leave a host removed and expect it back. The
    deregistered-host re-enrollment gap itself is a recorded product follow-up,
    not a client-side fix. A successful removal returns Settings to the active
    host (`scope.returnToActive`): left pinned to the removed id, the page fell
    to the `vanished` notice ("<uuid> is no longer registered") as soon as the
    lists refreshed. `vanished` stays the answer for a host that disappears
    out from under the page (removed from another window or device); following
    the active host after a removal the user just confirmed is not the silent
    retarget that row forbids.

  **The recovery console is GONE.** `host-recovery-console.tsx` was what
  remained of the old CLI-bridge page and the last `IHostManagement` consumer
  here; it rendered for THIS COMPUTER only, and only when there was no host
  process to ask. Folding host settings into the Overview removed it along with
  the `emptyAccountLocalRecovery` carve-out, so Settings no longer has a
  bridge-backed surface at all and every pane on this page describes its host by
  asking that host. Getting a machine that has no host process back into a
  usable state is the host-readiness gate's job, upstream of Settings — the gate
  a person passes before they can reach this page, with the window narrator
  explaining the wait.
  - The legacy `/settings/service` redirect (so any bookmark, remembered tab
    path, or tray command lands on this same pane) is unchanged. Shells without
    the Traycer CLI (web, mobile) never got a reduced page and still do not:
    with the console gone, every shell renders the same RPC Overview.

- **Diagnostics is TWO panels**, split 2026-08-14. Both render a **Log detail**
  `SettingsGroup` and a **Recent logs** viewer that may use the remaining height
  - a design pass (`settings-related-panels-core-flows` artifact) separated
    capture controls from the evidence viewer and added a reset reminder.

  The split is about REPETITION, not about per-row honesty. The single page was
  deliberately mixed-scope and said so per row: `App log level`, the heap
  capture and this window's own log tail described the app, while `CLI log
level`, `Host log level` and the host's log tails described the selected host.
  Each row was accurate. But the app half does not vary by host, so an account
  with four hosts drew four copies of it - four `App log level` selects and four
  `Capture heap snapshot` buttons writing the same single value, under four
  different host names. The rule the groups encode ("if it varies by host it
  sits under the picker") already said where the app half belonged.

  What did NOT split is the presentation. `diagnostics-log-entries.tsx` holds
  the frame, the tail view and the bridge-backed entry; `LogDetailGroup`
  (`diagnostics-log-detail-group.tsx`) renders whatever `LogLevelControl[]` its
  caller passes, so both pages get identical rows and one **Reset all to Info**
  sweep. With no controls AND a `null` empty state it renders nothing at all -
  that null case is what keeps the host page from titling an empty "Log detail"
  card when the logs region below is already stating the host's version. Note it
  is a `ReactNode` VALUE: passing `<HostLogDetailEmptyReason />` would be truthy
  however it rendered, so the reason is a function the panel calls.

- `Diagnostics` (Application, `app-diagnostics-settings-panel.tsx`) The app's
  own `App log level` row, the **Memory** heap capture, and the **Desktop Log**
  entry. Takes no host scope, mounts no `HostScopeGate`, and stands up no
  `HostClient` - if any of that becomes necessary to render it, something
  host-varying has moved back on. Its two bridges are independent
  (`platform.logLevels` and `platform.diagnostics`), so each states its own
  unavailability and a shell missing one still gets the other.

- `Diagnostics` (Host, `diagnostics-settings-panel.tsx`) `CLI log level`,
  `Host log level` and that host's own log files, over its
  `config.logLevels.*` / `diagnostics.logs.*` RPCs. Each row arrives as a
  `LogLevelControl` carrying its row definition and with its transport already
  resolved
  (`log-level-controls.ts`), so `LogLevelRow` stays presentational and the sweep
  walks RPC and bridge rows without knowing which is which.
  - **Log detail.** Two rows (`LogLevelRow`, a `Select` over the full
    `trace/debug/info/warn/error` scale, `info` labelled "Info (default)") - all
    default Info and apply immediately. The CLI/host thresholds are
    machine-user-global (`~/.traycer/cli/config.json`), which the row copy says:
    they apply to every Traycer host environment on that machine, not to one
    host instance. When any level differs from Info, the group grows a further
    row: a quiet reminder plus a **Reset all to Info** button that resets only
    the non-default scopes (any level different from Info, not just Warn/Error -
    Trace/Debug count too; sequentially, not in parallel).
  - **Recent logs · Last N lines**: the card is content-sized while its entries
    are collapsed, grows only as rows/expanded output require, and caps at the
    remaining panel height; only then does it become the page's primary scroll
    region. An expanded entry's tail text gets its own small bounded/internal
    scroll instead of growing the list. Per entry: expand/collapse, **Copy**
    (only once expanded), and one path action. That action is **Reveal** for a
    bridge-owned file and **Copy path** for a host-owned one:
    `shell.showItemInFolder` opens a path on THIS machine, so it is meaningless
    for a remote host - and even locally it would resolve the path itself rather
    than the one the host just named, which is a different file the moment two
    host slots share a machine. The list is the scoped host's own logs from
    `diagnostics.logs.list`; this app's log used to lead it and now lives once,
    on the Application page. On the local-bridge fallback path the snapshot
    still carries `desktop` alongside `host` (the bridge answers one question
    for both pages), so this page filters it out and the app page takes it.
    `diagnostics.logs.tail`
    answers a discriminated union, so a file that vanished between list and tail
    reads "This log file is no longer there." rather than an empty tail.
    Both failures - a tail read and the top-level list load - show inline error
    text plus a report-issue action. They were asymmetric until 2026-08-12,
    which made the panel harder to report from the worse the failure was: one
    log that would not open could be filed, while the read that lists every log
    failing left the user with text and nothing to do.
  - **Each unavailable state stays inside the group it affects**, and each page
    now says the thing that is actually true of it. The old shared empty copy
    ("Log level controls are only available on the desktop app") was a claim
    about the SHELL, and after the split it would have been the host page's only
    empty state - telling someone whose host is merely too old to install an app
    they are already running. The app page keeps that copy, because there it is
    the real reason; the host page states the host's version instead, or renders
    no card when the logs region is already stating it. A zero-log response is
    likewise explicit ("No log files on &lt;host&gt;.") rather than an empty card.
- `Usage` (`usage-settings-panel.tsx`, in the **Account** group beside
  Sessions - see "Scope: the organising idea" above for why it is not under
  the host picker. Groups must stay contiguous in `settings-sections.ts`, so
  landing it there pushed Shell past `SINGLE_DIGIT_LEADER_INDEX_LIMIT` into the
  digit-less tail. Adding Application -> Diagnostics later pushed **Agent
  selection** out too, which runs against the rule that support surfaces are the
  ones to lose digits - it is forced by position, since an Application entry
  lands in the first four whatever it is. See that file's own note). All reading
  `host.usage.summary` through `UsageSummaryPanel`
  (`components/usage-analytics/`), placement-agnostic. `host.usage.summary`
  is an OPTIONAL RPC (`degrade: { kind: "unsupported" }` in the protocol
  registry), so this section stays in the static list either way and instead
  swaps its BODY for a capability notice (same anatomy as `HostScopeGate`'s
  internal notices - an idle host-capability gap, not an error) on a host
  that predates the capability. Every priced figure carries its own asterisk
  plus a five-word footnote below it, "* if billed at full API rate"
  (`describeCostHeadline` in `cost-format.ts`) - the ONE standing exception is
  a "· N turns not counted" suffix while unpriced turns exist. Everything
  else - the estimate-at-list-prices framing, that a subscription bills
  separately, the exact-vs-estimate split with amounts, the not-counted
  detail - lives in a tooltip on the figure (`usageCostTooltip`), never as
  standing text (fixup-01, user ruling 2026-08-10: match t3code's density;
  the words "provenance"/"modeled"/"unpriced" never appear in UI - the wire
  still carries the full split for the tooltip). `servedBy: "local"` states
  the this-machine-only scope; a cloud-unavailable read renders a retryable
  error card rather than silently falling back to local-looking data (the
  host resolver's cloud-unavailable path is a plain `RPC_ERROR` on this
  transport, so `isTransientHostRpcFailure` cannot classify it - the card
  offers Retry unconditionally instead).
  - **Ticket 11 dashboard build-out (t3code shape).** Window picker
    (7/30/90 days) + a date-range label beside it + cost/token toggle;
    per-harness cost split under the headline (share bar, % of cost, token
    total - colors keyed off the same series scale as the chart's legend);
    a per-day stacked chart (harness breakdown, custom SVG/CSS per the
    `dataviz` skill) whose legend chips now double as a series FILTER
    (`applyUsageSeriesVisibility` zeroes a hidden series' segments without
    reassigning colors - "color follows the entity, never its rank"); a
    5-tile stat row (processed tokens, cached input, uncached input, output,
    cache savings - `usage-stat-tiles.ts` owns every "absent, not zero"
    computation, e.g. reasoning tokens/cache-savings multiple render only
    when the known sum is actually positive); and a Model/Day toggle on the
    harness/model breakdown table (`buildUsageDayBreakdownRows` folds the
    same buckets by day instead). A window-wide note ("Excludes N turns with
    no usage reported") appears under the stat tiles whenever
    `usageCompletenessBreakdown.absent > 0` - those turns still contribute
    silent zeros to every token sum, which would otherwise misread as "no
    caching happened" rather than "nothing was reported". Fixup-01 (below)
    removed the standing cost-quality panel and the breakdown tables'
    Provenance column entirely - neither is a "layout" element this bullet
    still describes.
  - **Ticket 12 removed the ambient epic-canvas cost badge** (this panel's
    former `UsageSummaryPanel` reuse target,
    `epic-canvas/panels/epic-cost-badge.tsx`) per the user ruling that no
    dollar figure belongs ambient anywhere. The epic canvas status row now
    carries a numberless `EpicUsageEntryPoint` instead, opening
    `EpicUsageDialog` (headline, small trend chart, by-chat/agent breakdown,
    window options including "entire epic") on click - see that panel's own
    doc comments, not this file, since it is not a Settings surface.
  - **Ticket 13 made this ONE cross-host dashboard, not a per-host page.**
    The cloud plane was already per-user and cross-host (its reader filters by
    user + time); what was missing was the host DIMENSION, not another view.
    So `host.usage.summary` gained an optional `hostId` filter and a
    `hostBuckets` grouping alongside `chatBuckets`, and the page gained:
    - a **host filter defaulting to "All hosts"** (`usage-host-filter.tsx`).
      On `servedBy: "local"` it is not a disabled dropdown but a plain
      readout naming this machine - that plane can only ever see the machine
      it runs on, so there is nothing to choose BETWEEN, and a greyed-out
      picker would say "you may not choose" instead. A foreign `hostId`
      against the local plane returns an EMPTY summary, never an error,
      mirroring the zero-rows shape a foreign `epicId`/`chatId` already has.
    - a **by-host breakdown** (`usage-host-split.tsx`), shown only once there
      is more than one host, with the same column anatomy as the harness
      split. Deliberately NOT keyed to the daily chart's series scale: that
      scale colors harnesses, and reusing it would paint a host and a harness
      the same hue in one view.
    - **names joined client-side** from `useHostScope().hosts` (the merged
      directory + registry model - see "One host model"). No host name rides
      the wire: a name is directory state that changes without the fact
      changing, and only the client knows a host it can no longer reach. An
      id nothing can name renders as a TRUNCATED ID, never a blank cell.
    - **scope copy that follows the filter** - `servedByScopeNote` now takes
      the picked host's name and qualifies the headline whenever the figure
      covers less than the account.
  - **Fixup-01 (tickets 11/12) rewrote cost presentation to t3code's density**
    (user ruling 2026-08-10, three rounds, final - superseded the ticket 11
    "priced subtotal + N unpriced turns" phrasing and deleted ticket 11's
    cost-quality panel and both breakdown tables' Provenance column, plus
    ticket 12's equivalents in the scoped dialogs). `UsageCostFigure`
    (`components/usage-analytics/usage-cost-figure.tsx`) stays the single
    owner of the presentation across the dashboard AND both ticket-12 scoped
    dialogs (epic + chat) - see that file's own doc comment for the current
    rule, not this one, so the rule can't fragment across two descriptions.

- `Delete account` (`panels/delete-account-settings-panel.tsx`,
  `/settings/delete-account`, last in the **Account** group) **Installed mobile
  app only** - listed in `MOBILE_APP_ONLY_SECTION_IDS`, so it is the one entry
  that inverts the mobile-omission mechanism above; on every other build the
  row is absent and the route redirects to General. It exists because App Store
  review guideline 5.1.1(v) requires an app that creates accounts to let
  someone start deleting theirs from inside the app. Desktop and the web GUI
  are not under that rule and manage the account on the web, so a second,
  slower route there would answer a question they can already answer.

  There is no deletion RPC: the request goes to a Google Form that notifies
  support, and the team performs the deletion by hand. What the panel owes the
  reader is therefore honesty about that shape - what is removed, that it
  cannot be undone, that a PERSON does it within 30 days, and that a
  confirmation email follows - and it never claims the account is gone when the
  button is pressed. Two deliberate shapes:

  - **A confirm in front of the button** (`ConfirmDestructiveDialog`, action
    label `Continue`). Not because the tap destroys anything - it opens a form -
    but because it leaves the app for the browser, and a destructive-sounding
    control that silently backgrounds the app reads as "it already happened".
    The confirm is where "your account stays active until our team completes the
    deletion" lands, which is the one sentence a reader needs BEFORE the handoff.
  - **The account's address, shown** under the button (`Signed in as <email>.`),
    from `useAuthUser()`. The form is pre-filled from it, so this line is what
    lets someone notice they are about to request deletion of the wrong account
    before they submit. Omitted rather than faked when the address has not
    resolved (`User.email` is nullable on the wire); the form still opens with
    its address questions blank, because it is the only deletion route the app
    has.

  The URL is built in `lib/account/account-deletion-form.ts` -
  `buildAccountDeletionFormUrl(email)`, a pure function with its own unit test.
  It lives apart from the panel because a wrong `entry.*` id or a mangled
  address still produces a perfectly valid URL, so neither failure is visible in
  a render test. It composes through `URL`/`URLSearchParams` and never by
  concatenation: `+`, `&` and `#` are all legal in the local part of an address
  and each one truncates or rewrites a concatenated query, which would open the
  form pre-filled with an address that is not the user's. The open goes through
  `useOpenLink()` with kind `account`, the same hard-external kind every other
  identity/billing destination uses, so the runner-error mapping turns a shell
  that cannot open links into a visible failure rather than a dead tap. On the
  phone that lands in the external browser, which is accepted for this flow.

The default editor (`defaultEditor` in the settings store) has no dedicated
panel - the Open split button on the Epic header doubles as its picker: clicking
an editor in its dropdown sets it as the default and persists across reloads.

## The fallback save-notice matrix (D353)

Eight audit passes fixed this surface one cell at a time, and each fix exposed the next
composition. That is the signature of copy derived per-case instead of from a model, so
this section IS the model: every sentence the notice can render is derived here, and the
code implements the derivation rather than the cases.

**The composition space is 8 × 3 × 4 = 96 cells** — DISPLAY state × OPERATION reported ×
OUTCOME. (Eight, not the six this section first claimed: the tenth pass added
`refused-on-screen` and wrote down `unanswered`, which the classifier had all along.) But
the notice is TWO sentences answering two independent questions, and that is why the space
factorises:

- the **REQUEST account** — what is known about the operation whose outcome is being
  reported — depends on OPERATION × OUTCOME only: **12 derivations**;
- the **DISPLAY account** — what is known about the values on screen — depends on DISPLAY
  state × whether display authority is intact: **9 derivations**. Not 16: only SEVEN of the
  eight states produce a display account at all (`unanswered` is answered by the combined
  sentence instead), and only two carry a second account — `confirmed` under
  `unverifiedHostRow`, `rollback` under `persistedUnverified`. Those are two DIFFERENT
  inputs, which is why the second column below is headed by the condition rather than by a
  single "authority" flag. Follow-up #17 was the discovery that a THIRD consumer — the
  off-axis refusal consequences — read only one of the two; it is fixed, and both are now
  read through `persistedUnverified || unverifiedHostRow !== null` wherever a sentence
  claims what the host holds.

**21 derivations cover all 96 cells** — of the notice's two sentences. Composing them
per-case is what produced eight passes of whack-a-mole; a cell is now wrong only if one of
the 21 is wrong.

**Count re-stated after the follow-up wave (#16, #17). The 21 is unchanged, and what
changed underneath it is worth writing down, because "unchanged" is the answer that hides
things:**

- **#16 did not move the count and did make three of the 12 real.** The REQUEST axis was
  always 3 × 4, but its `refused` row held ONE string served to all three operations, so
  three of the twelve derivations were nominal — the same sentence counted three times. They
  are now distinct. A count over a factorisation says how many INDEPENDENT answers the
  space needs, not how many have been written, and the gap between those two is exactly
  where an audit finds copy that names the wrong thing.
- **#17 did not touch the axes at all**, and that is the whole finding. The refusal
  consequences are an OFF-AXIS sentence (the P3 table above), so widening their inputs
  changes nothing here — which is precisely how they came to be the third consumer of
  display authority while only the other two knew the rule. Their own derivation count went
  from **6 to 8**: `refused-reverted` 2 → 3, `refused-kept`'s `draftConfirmed` branch 2 → 3
  (its non-confirmed branch stays 1), `refused-unverified` 1. The two new arms are the
  `unverifiedHostRow` case, which `persistedUnverified` does not cover because a reset whose
  own reply was LOST never confirms anything, so `unrefreshedReset` stays null while the
  host's row is every bit as unknown.

The lesson the count carries: **being off-axis is not the same as being out of scope.** The
P3 table lists four sentences the 21 do not govern, and each of them still reads state this
matrix has an opinion about. #17 was the second of the four to be audited; the other two
(the staleness banner, the validation alert) make no host claim, which is why they are
safe — not because they are listed.

**What the 21 govern, stated exactly (P3).** They govern the notice's TWO sentences — the
request account and the display account — and nothing else. The status place renders four
further strings, each deriving from a field this matrix has no axis for. They are LISTED
rather than swallowed into it, because widening the axes to fit them would turn the
factorisation into a claim about a bigger space than anything has tested:

| Other sentence                                                                        | Derives from                                                                         | Why it is not on an axis                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| the `unknown` arm's COMBINED sentence                                                 | `unknownCarries` and `displayDispatch` together                                      | the one place the two accounts are composed rather than concatenated, so it is a single 3 × 8 cell and not a pair of independent ones |
| the refusal consequences (`refused-reverted` / `refused-kept` / `refused-unverified`) | `hostError.outcome` × `persistedUnverified` × `unverifiedHostRow` × `draftConfirmed` | the notice outcome is FINER than the operation axis: one wire refusal becomes three outcomes, decided by what else was outstanding    |
| the staleness banner                                                                  | `unrefreshedReset` + `unrefreshedResetSubject`                                       | a different surface with a different owner (D327): the banner owns the reset's unread state, the notice owns display provenance       |
| the validation alert                                                                  | `localError`                                                                         | about the draft's SHAPE, and rendered whether or not any request exists                                                               |

### Axis 1 — the DISPLAY account (8 states × authority)

Display authority is the right to say what the HOST holds. It is intact unless an
operation that does not carry the display has an unanswered outcome — a `reset` or
`restore` whose own reply was lost. Those two are the only operations that can invalidate
it while the display still looks confirmed, because they are the only ones that do not
move the revision: a draft save dispatched after a confirmation implies an edit, and that
edit moves `revision` away from `confirmedViewRevision`, so its own uncertainty is
reported by a different display state entirely.

(This is deliberately more conservative than "dispatched since the confirmation", and the
looser variant was CONSIDERED AND REJECTED — do not reintroduce it. It would need a
`confirmedViewRequestId` to order the unanswered operation against the confirmation, and it
is unsafe on its own terms: a reset dispatched BEFORE a later save was confirmed would keep
its in-force claim, but a lost reply says nothing about WHEN the reset landed, and it may
have replaced the row after that save. The ordering test answers a question the evidence
cannot settle. The rule as written needs no ORDERING field — it does need a field, and it has one: `unverifiedHostRow` on the reducer, added in the tenth pass when the ninth's carrier (the unanswered ticket) turned out to be a slot the next failure overwrites. What was rejected is the ORDER test, not the state.)

| DISPLAY state                                                                                                                                               | Authority intact                                                                                    | Alternative account, under the row's OWN condition: `confirmed` when `unverifiedHostRow` is set (an unanswered reset/restore); `refused-rollback` when `persistedUnverified` (a confirmed reset whose read failed) — two different inputs |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loaded-unchanged` — values equal `persisted`, nothing dispatched                                                                                           | "What's on screen is what was loaded; nothing has been changed since."                              | same — the sentence makes NO host claim, so nothing to invalidate                                                                                                                                                                         |
| `edited-unsent` — `revision > lastDispatchedRevision`                                                                                                       | "What's on screen is a newer edit that hasn't been sent."                                           | same — no host claim                                                                                                                                                                                                                      |
| `dispatched-pending`                                                                                                                                        | "Another change is being saved."                                                                    | same — no host claim                                                                                                                                                                                                                      |
| `confirmed` — `confirmedViewRevision === revision`                                                                                                          | "What's on screen is what this host has saved."                                                     | "What's on screen was confirmed as saved on this host. A <reset\|restore> is also outstanding whose result is unknown, so what the host has now hasn't been re-read." (the operation is named; NO order is claimed in either direction)   |
| `refused-rollback`                                                                                                                                          | "What's back on screen is your last saved settings, put back."                                      | the pre-reset account (`persistedUnverified`, D330)                                                                                                                                                                                       |
| `sent-unknown`                                                                                                                                              | "What's on screen was sent, but we don't know what the host did with it."                           | same — the sentence already claims neither verdict                                                                                                                                                                                        |
| `refused-on-screen` - a refusal that did NOT revert, because another outcome was unknown (NOT the `refused-kept` NOTICE outcome, which is a different axis) | "What's on screen is a change the host turned down; it's kept here so you can fix it."              | same - neither "saved" nor "put back" is claimed, so there is no host claim to invalidate                                                                                                                                                 |
| `unanswered` - the display IS the draft whose own reply was lost                                                                                            | the COMBINED sentence, rendered by the `unknown` arm rather than by this table (see the scope note) | n/a - the operation with no answer is the display's own draft                                                                                                                                                                             |

**Only `confirmed` and `refused-rollback` make host claims, so only those two have a second
column.** That is the matrix's own answer to "which sentences need the authority rule",
and it is why the rule is stated once rather than per cell.

Read that as scoped to THIS AXIS, which is what #17 cost a pass to learn. It answers which
DISPLAY-ACCOUNT sentences need the rule; it is not a census of which sentences in the panel
make host claims. Two of the off-axis refusal consequences do — "still in force" and "it is
in force" — and they were outside this table's field of view while being governed by its
rule. When a new sentence is written anywhere in the status place, the question to ask is
"does it say what the host holds", not "is it on an axis".

**What makes `confirmed` TRUE, and the second marker it needed (OSS review P2 /
R-OSS-1).** `confirmedViewRevision === revision` is a claim about VALUES, so it has to stop
holding the moment `persisted` moves away from what is displayed. It did not. The
correcting-rollback branch adopts a confirmed policy into the controls and clears
`refusedDraft` — which was the ONLY marker saying the display was not the user's own work —
so a SECOND, newer success saw an unmarked display, read it as an intervening edit, and
took the moved-on arm: `persisted` advanced to that reply's policy, the controls kept the
first one, and `confirmedViewRevision` went on certifying them. The page then rendered
`confirmed` ("What's on screen is what this host has saved") over values the host did not
have, with no reset, no failed read and no lost reply anywhere in the sequence — C refused,
A succeeds, B succeeds, no user edit between them. Every one of those three overlapping
saves is a gesture the controls permit.

The fix is a second marker, `adoptedView`, beside `refusedDraft`, and one predicate over
both — `draftIsNotUserAuthored`. The two markers mean different things (a value this
reducer PUT BACK, a value this reducer TOOK FROM THE HOST) and the same thing for every arm
that installs an authoritative policy: nobody typed this, so replace it. Both consumers ask
through the one predicate, which is not tidiness — the second consumer, `reconciled`'s
adopt gate, is reachable with an adopted display and no refusal (W succeeds after X's reply
is lost and Y is refused at a later revision), and it had the same defect independently.
`edited` clears both, which is what keeps a real intervening edit protected.

**Reachability of `edited-unsent` (the classifier's `uncommitted`), and which operations can
host it.** `commit` dispatches `edited` and then `save-started` in the same tick, and
`applySaveStarted` stamps `lastDispatchedRevision` at the post-edit revision — so every
switch, select, arrow and button leaves `revision === lastDispatchedRevision`, and its
display is `sent-unknown` — **when the edit is VALID**. That qualifier is the tenth pass's
correction, and both sentences the ninth pass built on it were false:

- **"only a text edit reaches it" is FALSE.** `commit` dispatches `edited` and then returns
  early when `validateFallbackPolicyDraft(next).kind === "invalid"`, BEFORE `save-started`.
  So any control whose value is invalid reaches `edited-unsent` — and one is a plain button:
  "Add a model" calls `onCommit` with a candidate whose `modelFamily` is `""` (deliberately,
  so the panel never invents a family the user did not choose), which the wire schema
  rejects. A button, not a keystroke.
- **"restore cannot host it" is FALSE.** Only the Restore button itself takes
  `restorePending`; "Add a group" lives outside `EmptyGroups` and stays enabled while the
  restore's RPC is in flight. So the display can be edited while a restore is unanswered.
  One refinement the corrected argument needs and the first version of it missed: an empty
  group is schema-VALID (`candidates: z.array(...)` with no `.min(1)`), so "Add a group"
  alone dispatches a save and lands on `sent-unknown`. The sequence that actually reaches
  `edited-unsent` is Restore → Add a group → **Add a model**, whose empty family is what
  makes the draft unsendable.

So `edited-unsent` is reachable from any control that can produce an invalid draft, under
any of the three operations, and the write path — not the control kind — is what decides
it: **a draft is unsent exactly when `commit` returned before `save-started`, plus the
text-field path that never calls `commit` at all.**

The `loaded-unchanged` / `edited-unsent` split is controlled from BOTH sides, by different
pins and different mutations: **M3** (`matchesPersisted ? "loaded-unchanged" : "uncommitted"`
collapsed to `"uncommitted"`) reddens the restore pin, which holds the `loaded-unchanged`
half; the **inverse** collapse to `"loaded-unchanged"` reddens the eighth-pass reset pin's
closing `toContain("hasn't been sent")`, which holds the other. Both of those reach
`uncommitted` through an INVALID draft, where a validation alert above the notice already
says the edit was not sent; the ninth-pass pin covers the VALID-draft variant neither of
them has, where the notice carries the claim alone.

### Axis 2 — the REQUEST account (3 operations × 4 outcomes)

| OUTCOME                       | `set` (draft)                                                   | `reset`                                                                  | `restore`                                                                                   |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| success                       | no notice — the controls carry it                               | no notice; the editor remounts on the re-read                            | no notice                                                                                   |
| refused                       | "Couldn't save: <host reason>" + the rollback/kept split (D330) | "Couldn't reset these settings: <host reason>"                           | "Couldn't restore the default groups: <host reason>"                                        |
| unknown (own reply lost)      | "That change may or may not have been saved."                   | "We don't know whether the reset went through - it hasn't been re-read." | "We don't know whether restoring the default groups went through - it hasn't been re-read." |
| unknown-after-failed-read (S) | n/a — a draft save has no post-write read of its own            | the staleness banner owns it (D327/D330); the notice is not the surface  | n/a                                                                                         |

**The `refused` row is the follow-up #16 fix, and it is the row that turned this
table from a description into a promise.** It PREVIOUSLY read "Couldn't reset:
<host reason>" / "Couldn't restore: <host reason>" while no such string existed
anywhere in the tree — the table was describing copy nobody had written, which
is the orphaned-prose class one level up from the code. The eighth pass
corrected the table DOWN to what `classifyFallbackSaveFailure` actually did
("the operation is NOT named; one classifier serves all three"), because a guess
at a destructive action's wording is a product decision, not a state-model rule.
Ruling (a), tenth-pass close-out: name the operation, parallel with the
`unknown` row directly below, which had always named it correctly — so the
inconsistency was visible inside one panel. The classifier now takes the
operation, and the `unknown` arm's own message dropped its "so we can't tell
whether this was saved" clause with it: that clause said the same thing as this
table's next row, one sentence earlier and in the wrong noun for two of the
three columns.

`RetryableTransportError` (the host's own "never dispatched" guarantee) and a
non-`HostRpcError` throw carry the operation too — "Couldn't reach this host, so
nothing was reset", "Couldn't restore the default groups." Those are not on this
axis because they are not host ANSWERS: the axis is what the host said, and
those two are what the transport said.

### Reachability and coverage

Every cell is either pinned or carries its reason. The unreachable ones are unreachable by
construction, not by assumption:

| Cell                                                    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `confirmed` × reset × unknown                           | **PINNED** (ninth pass, cell 1) — the composition eight passes never reached                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `loaded-unchanged` × restore × unknown                  | **PINNED** (ninth pass, cell 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `edited-unsent` × reset × unknown, validation preserved | **PINNED** (ninth pass, cell 2) — both alerts asserted together                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `edited-unsent` × reset × unknown, VALID draft          | **PINNED** (ninth pass, cell 4) — the reset is the operation because it is the cheapest one that reaches this display state — NOT because a restore cannot, which the row below proves it can (the ninth pass's claim here was wrong and is corrected in the reachability note above), and the draft is valid because both older `uncommitted` assertions carry a validation alert that says "not sent" beside the notice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `edited-unsent` × restore × unknown                     | **PINNED** (tenth pass) — the cell the ninth pass argued was impossible. Restore → Add a group → Add a model while the restore is pending, then lose its reply. "Add a group" is outside `EmptyGroups` and never disabled. The middle step is NOT optional: `candidates: z.array(tierCandidateSchema)` carries no `.min(1)` (`protocol/src/host/fallback-policy.ts:44`), so an empty group is schema-VALID and adding one alone dispatches a save — it is "Add a model", whose family is deliberately blank, that makes the draft unsendable                                                                                                                                                                                                                                                                                                                                                                                                           |
| `refused-on-screen` × set × refused-while-unknown       | **PINNED** (tenth pass, N1) — the display state the matrix did not have. X/A/B: A lost, B refused while A is unknown, X lost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `confirmed` × reset × unknown, ticket REPLACED since    | **PINNED** (tenth pass, N2) — R lost, then A lost. The obligation has to outlive the notice that raised it. The obligation's RECOVERY is pinned per operation and they are not the same path: a restore's success reaches `save-succeeded` and clears it there, while a reset's success never dispatches `save-succeeded` at all — `resetAll` re-reads and the panel REMOUNTS, so the reset's recovery is the fresh initial state, asserted separately                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `confirmed` × reset × unknown, reset dispatched FIRST   | **PINNED** (tenth pass, N3) — the reverse dispatch order, which is why the sentence may not claim one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `confirmed` × set × unknown                             | **PINNED** (seventh pass, sequences 1 and 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sent-unknown` × set × unknown                          | **PINNED** (seventh pass, sequence 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `edited-unsent` × set × unknown                         | **PINNED** (fifth pass, the invalid-C two-alert pin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `refused-rollback` × set × refused                      | **PINNED** (D330, R10-A and the revert pins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dispatched-pending` × set × unknown                    | **PINNED** (sixth pass, the PENDING control)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `*` × set × success                                     | **UNPINNED, and no sentence to pin** — a success renders no notice; the controls are the report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `confirmed`/`sent-unknown` × restore × unknown          | **UNPINNED** — the restore's request account is pinned at `loaded-unchanged`, and the display axis is pinned independently at `set`. Since the two accounts are independent by construction, the composition adds no derivation; pinning it would assert the factorisation, not test it. **The pin that WOULD refute the factorisation** is a restore composition whose DISPLAY account differs from the reset's at the same display state — `confirmed × restore × unknown` asserting a display sentence other than "…a restore is also outstanding whose result is unknown…". If that ever needs writing, the factorisation is false and this whole section is the thing to fix, not the cell                                                                                                                                                                                                                                                        |
| `*` × reset × unknown-after-failed-read                 | **UNREACHABLE as a notice.** A confirmed reset whose read fails raises the BANNER, not the notice (D327: the banner owns the reset's unread state). The notice path requires an unanswered SAVE, and a reset that was confirmed has no unanswered outcome to report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `loaded-unchanged` × set × refused                      | **REACHABLE; the composition is UNPINNED and the reason is that pinning it cannot fail differently.** Recorded UNREACHABLE by the ninth pass on an argument that assumed a refusal implies the refused draft is still displayed; a refusal of an OLDER draft takes the `refused-kept` arm and reverts nothing, so Enter-commit a family, type it back without committing, and let the refusal arrive. But `refused-kept` never calls `displayAccount` (see the P3 scope table), and its `draftConfirmed` branch is taken whether the display got there by a confirmed save or by typing the value back — the draft equals `persisted` either way — so the rendered text is identical to the CONFIRMED-display case, which IS pinned. The tenth pass's first pin for this row asserted a display string the path cannot produce, reddened under no recipe, and now stands under its real claim: the `refused-kept` consequence over a confirmed display |

## Current Status

The settings surface is a real local settings shell; every row is wired into
runtime behavior. The previously-inert Language, Speed, Show in menu bar, and
Default workspace mode rows were removed.

## Maintenance Note

- keep this file focused on structure, ownership, and linkage status
- keep inline comments in settings source files pointing back here
- when adding or removing sections, update both this file and
  `settings-sections.ts`
