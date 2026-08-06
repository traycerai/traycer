import type { Editor } from "@tiptap/core";
import type { PluginKey } from "@tiptap/pm/state";
import type { SuggestionProps } from "@tiptap/suggestion";
import { isDismissedMentionQuery } from "@/lib/composer/mentions/mention-dismissal";
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
    ((props: SuggestionProps) => ComposerSlashScope) | null;
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

    const startSession = (props: SuggestionProps<unknown, TItem>): void => {
      dismissed = false;
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
        clientRect: props.clientRect ?? null,
      });
    };

    return {
      onStart(props) {
        latestProps = props;
        // A pasted "@ ..." or "@x, y" is already prose; never open for it,
        // and end the plugin session so a later `@` elsewhere can start over.
        if (args.kind === "mention" && isDismissedMentionQuery(props.query)) {
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
        if (args.kind === "mention" && isDismissedMentionQuery(props.query)) {
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
          if (state.items.length === 0) return false;
          // Enter only commits a mention menu the user has ENGAGED (arrowed
          // into); otherwise it is prose punctuation and falls through to the
          // composer's normal Enter (send). Slash stays commit-on-Enter - a
          // typed /command is deliberate, prose never starts with one.
          if (state.kind === "mention" && !state.engaged) return false;
          // Swallow the key on an inert row. Returning false would let Enter
          // fall through to the composer and submit the message with the
          // picker still open.
          if (activePickerItemDisabledReason(state) !== null) return true;
          return state.commitActiveItem();
        }
        if (event.key === "Tab") {
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
