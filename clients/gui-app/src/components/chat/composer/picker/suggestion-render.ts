import type { Editor } from "@tiptap/core";
import type { PluginKey } from "@tiptap/pm/state";
import type { SuggestionProps } from "@tiptap/suggestion";
import { isDismissedMentionQuery } from "@/lib/composer/mentions/mention-dismissal";
import { githubMentionSectionForStep } from "@/lib/composer/mentions/providers";
import { activePickerItemDisabledReason } from "./composer-picker-store";
import type {
  ComposerPickerItem,
  ComposerPickerKind,
  ComposerSlashScope,
  ComposerSlashTrigger,
  ComposerPickerStore,
} from "./composer-picker-store";

export interface ComposerSuggestionRenderArgs {
  readonly pickerStore: ComposerPickerStore;
  readonly kind: ComposerPickerKind;
  readonly slashTrigger: ComposerSlashTrigger | null;
  readonly slashScopeForProps:
    | ((props: SuggestionProps) => ComposerSlashScope)
    | null;
  /**
   * The suggestion plugin's own key, for dismissals that must survive the
   * NEXT `@` occurrence. Closing only the picker store leaves the tiptap
   * session active, and when its matcher later lands on a different `@` it
   * fires `onUpdate` on this same renderer - whose store session is already
   * dead - so the new menu can never open. Dispatching the plugin's
   * `{ exit: true }` meta records the dismissed range instead, and a fresh
   * `@` elsewhere starts a fresh `onStart`. Null for the slash pickers,
   * which have no query-content dismissal rules.
   */
  readonly suggestionPluginKey: PluginKey | null;
}

let nextSessionId = 0;

interface SuggestionRender<TItem extends ComposerPickerItem> {
  onStart(props: SuggestionProps<unknown, TItem>): void;
  onUpdate(props: SuggestionProps<unknown, TItem>): void;
  onExit(): void;
  onKeyDown(props: { event: KeyboardEvent }): boolean;
}

/**
 * Moves focus into the open step's chrome (the Filter/Refresh bar), or
 * reports that there is nothing to move to. A global query is sound here:
 * one picker menu exists at a time, and `data-mention-step-chrome` is only
 * rendered on a header whose step actually published chrome. Returning
 * whether focus actually moved lets the caller fall through to the browser
 * default when it did not.
 */
function focusMentionStepChrome(): boolean {
  const chrome = document.querySelector("[data-mention-step-chrome]");
  if (chrome === null) return false;
  const control = chrome.querySelector<HTMLButtonElement>(
    "button:not(:disabled)",
  );
  if (control === null) return false;
  control.focus();
  return document.activeElement === control;
}

export function createComposerSuggestionRender<
  TItem extends ComposerPickerItem,
>(args: ComposerSuggestionRenderArgs): () => SuggestionRender<TItem> {
  return () => {
    // Tiptap's suggestion plugin builds a fresh `props` object on every
    // view.update - including a `command` closure bound to the *current*
    // state.range. The closure captured during onStart points at the
    // range covering only the trigger char, so committing later would
    // leave the typed query in place. Track the latest props so commits
    // dispatch against the up-to-date range.
    let latestProps: SuggestionProps<unknown, TItem> | null = null;
    // Identity for this renderer's store writes. Tiptap creates ONE renderer
    // per suggestion plugin for the editor's lifetime, and several plugins
    // (`/`, `$`, `@`) share the store, so every write is tagged to keep a
    // departing plugin's teardown from writing over another plugin's state.
    nextSessionId += 1;
    const sessionId = nextSessionId;
    // True while a dismissal is pending inside a still-active plugin
    // session. One renderer spans occurrences (see above), and synchronous
    // transactions can outrun the queued exit below, so a valid-query
    // `onUpdate` can arrive after a dismissal with no `onStart` ever coming -
    // whether the matcher moved to a new trigger or this occurrence's query
    // was restored (a saved-selection restore, deletes). That update is a
    // start. Cleared on start and exit.
    let dismissed = false;
    // Epoch guarding queued exits. A queued exit belongs to the occurrence it
    // was queued for; any legitimate start (or a newer dismissal) bumps the
    // epoch so a stale exit cannot fire and dismiss the occurrence that
    // superseded it - application code can dispatch several transactions
    // before a microtask drains (setContent + setTextSelection).
    let exitEpoch = 0;

    // The prose heuristics are step-dependent, and the step lives in the
    // store - `,` and `:` are prose everywhere except inside the PR/Issue
    // sections, where they are ordinary title punctuation. Read at decision
    // time rather than captured: the user can drill into a section without the
    // suggestion session restarting.
    const inGithubMentionSection = (): boolean => {
      const state = args.pickerStore.getState();
      if (state.kind !== "mention") return false;
      return githubMentionSectionForStep(state.step) !== null;
    };

    // Ends the tiptap suggestion session itself (see `suggestionPluginKey`).
    // Deferred: dismissals fire inside the plugin's own update cycle, and
    // dispatching a transaction synchronously would re-enter it.
    const exitPluginSession = (editor: Editor): void => {
      const pluginKey = args.suggestionPluginKey;
      if (pluginKey === null) return;
      exitEpoch += 1;
      const epoch = exitEpoch;
      queueMicrotask(() => {
        if (editor.isDestroyed) return;
        // Superseded: the plugin has legitimately moved on (a new occurrence
        // opened, or the session already exited); exiting now would dismiss
        // state this exit was never aimed at.
        if (epoch !== exitEpoch) return;
        const { view } = editor;
        view.dispatch(view.state.tr.setMeta(pluginKey, { exit: true }));
      });
    };

    // Full dismissal of the CURRENT occurrence: close the picker now, end
    // the plugin session (deferred).
    const dismissOccurrence = (editor: Editor): void => {
      dismissed = true;
      args.pickerStore.getState().closeSession(sessionId);
      exitPluginSession(editor);
    };

    // Returning to ROOT re-arms root's prose rules on a query the section
    // exempted, which nothing else re-evaluates.
    //
    // This is the mirror of the note on `inGithubMentionSection`: the step
    // lives in the store and moves without the editor moving, so no `onUpdate`
    // follows a Back. Only the drill-IN direction was covered. A real title the
    // section legitimately allowed - `fix(relay): stop the busy-loop, again` -
    // therefore survived the return to root, where the comma is prose, leaving
    // the root menu open on it and its workspace and epic providers fetching
    // for a query root would never have opened for.
    //
    // Store-subscribed rather than hooked into the Back row, because Back is
    // one of several ways the step returns to root (click, keyboard commit)
    // and the rule belongs to the STEP, not to the control that changed it.
    let unwatchStep: (() => void) | null = null;

    const stopWatchingStep = (): void => {
      if (unwatchStep === null) return;
      unwatchStep();
      unwatchStep = null;
    };

    const watchStepForProse = (): void => {
      stopWatchingStep();
      if (args.kind !== "mention") return;
      unwatchStep = args.pickerStore.subscribe(() => {
        const props = latestProps;
        // `dismissed` also breaks the re-entry `dismissOccurrence` would cause
        // by writing to the very store this listens to.
        if (props === null || dismissed) return;
        const state = args.pickerStore.getState();
        if (!state.open || state.sessionId !== sessionId) return;
        if (state.kind !== "mention") return;
        if (githubMentionSectionForStep(state.step) !== null) return;
        // The store's own query, which is what the picker is actually showing
        // rows for - and `false` because this branch has already established
        // the step is not a section.
        if (!isDismissedMentionQuery(state.query, false)) return;
        dismissOccurrence(props.editor);
      });
    };

    const startSession = (props: SuggestionProps<unknown, TItem>): void => {
      dismissed = false;
      watchStepForProse();
      // Cancel any exit still queued for a previous occurrence - it must not
      // fire into the session that starts here.
      exitEpoch += 1;
      const slashScope = args.slashScopeForProps?.(props) ?? null;
      args.pickerStore.getState().openPicker({
        sessionId,
        kind: args.kind,
        slashScope,
        slashTrigger: args.slashTrigger,
        range: { from: props.range.from, to: props.range.to },
        query: props.query,
        commit: (item) => {
          if (latestProps === null) return;
          latestProps.command(item as TItem);
        },
        // Dismissal handle for pickers with post-open close rules (the
        // mention hook's zero-match rule): closes the store now and the
        // plugin session with it, so the dismissal cannot leak into the
        // next `@` occurrence.
        dismiss: () => {
          if (latestProps === null) return;
          dismissOccurrence(latestProps.editor);
        },
        // The editor handle only exists here, so the one place that has to
        // hand focus back to the composer (the filter popover's close) reaches
        // it through the store, exactly like `commit` and `dismiss`.
        //
        // `resumeText` is the character that closed the popover. It is
        // inserted in the SAME chain as the focus so the caret is already back
        // in the composer when it lands - the key event itself went to the
        // radio group and can never reach the editor on its own.
        focusEditor: (resumeText) => {
          if (latestProps === null) return;
          if (resumeText === null) {
            latestProps.editor.commands.focus();
            return;
          }
          latestProps.editor.chain().focus().insertContent(resumeText).run();
        },
        clientRect: props.clientRect ?? null,
      });
    };

    return {
      onStart(props) {
        latestProps = props;
        // A pasted "@ ..." or "@x, y" is already prose; never open for it,
        // and end the plugin session so a later `@` elsewhere can start over.
        //
        // `false`, not `inGithubMentionSection()`: a new occurrence always
        // begins at the root step, but the store is not there yet. Tiptap
        // fires this before the departing session's `onExit`, so the store can
        // still hold that session's drilled PR/Issue step - and judging a
        // fresh `@` by the section's punctuation rules would let `@x, y` open
        // the menu instead of reading as prose.
        if (
          args.kind === "mention" &&
          isDismissedMentionQuery(props.query, false)
        ) {
          dismissed = true;
          exitPluginSession(props.editor);
          return;
        }
        startSession(props);
      },

      onUpdate(props) {
        latestProps = props;
        // The typed query turned into prose (leading space, `,`/`;`, double
        // space): close the menu now and end the plugin session. The plugin
        // records the dismissed range, so this `@` occurrence stays dismissed
        // while a new `@` elsewhere opens fresh.
        if (
          args.kind === "mention" &&
          isDismissedMentionQuery(props.query, inGithubMentionSection())
        ) {
          dismissOccurrence(props.editor);
          return;
        }
        if (dismissed) {
          // The query is valid again while a dismissal is still pending (the
          // branch above re-dismisses every still-prose update): the matcher
          // moved to a new trigger, or this occurrence's query was restored
          // before the queued exit could land. The plugin never went
          // inactive, so no `onStart` is coming - this update is a start.
          startSession(props);
          return;
        }
        const slashScope = args.slashScopeForProps?.(props) ?? null;
        args.pickerStore.getState().updateRange({
          sessionId,
          range: { from: props.range.from, to: props.range.to },
          query: props.query,
          slashScope,
          clientRect: props.clientRect ?? null,
        });
      },

      onExit() {
        stopWatchingStep();
        latestProps = null;
        dismissed = false;
        // The plugin session is over; a queued exit has nothing left to end,
        // and letting it fire could dismiss whatever session opens next.
        exitEpoch += 1;
        // Ownership-checked: swapping `$` for `/` over a selection starts the
        // new session before this one exits, and an unconditional close here
        // would shut the picker that just opened.
        args.pickerStore.getState().closeSession(sessionId);
      },

      onKeyDown({ event }) {
        const state = args.pickerStore.getState();
        if (!state.open) return false;

        if (event.key === "ArrowDown") {
          state.moveActive(1);
          return true;
        }
        if (event.key === "ArrowUp") {
          state.moveActive(-1);
          return true;
        }
        if (event.key === "Enter") {
          if (event.shiftKey) return false;
          // The visible highlight is the selection: Enter accepts it without
          // requiring an otherwise invisible arrow-key "engagement" state.
          // Swallow Enter even while loading or on an inert row so the prompt
          // cannot submit with the picker still open.
          state.commitActiveItem();
          return true;
        }
        if (event.key === "Tab") {
          // Shift+Tab is FOCUS, not commit: it is the keyboard route to the
          // picker's own chrome. The Filter and Refresh buttons render
          // through a portal into `document.body` AFTER the editor, so no
          // native traversal direction can reach them from the composer -
          // backward traversal lands on an earlier composer control, and
          // plain Tab commits the highlighted row. The move is therefore
          // explicit; with no chrome on this step the browser default stands.
          // (Under jsdom this handler was once measured as never receiving
          // Shift+Tab, but jsdom cannot be trusted for ProseMirror key
          // handling - the behaviour is implemented for the event actually
          // arriving and tested by invoking the handler directly.)
          if (event.shiftKey) return focusMentionStepChrome();
          if (state.items.length === 0) return false;
          if (activePickerItemDisabledReason(state) !== null) return true;
          return state.commitActiveItem();
        }
        if (event.key === "Escape") {
          // Tiptap itself dispatches the plugin exit for Escape, synchronously
          // in its handleKeyDown - only the store needs closing here.
          state.closeSession(sessionId);
          return true;
        }
        return false;
      },
    };
  };
}
