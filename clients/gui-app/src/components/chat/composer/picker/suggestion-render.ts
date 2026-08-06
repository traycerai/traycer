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
    // Identity for this one suggestion session. Tiptap calls this factory per
    // session, and several plugins share the store, so every write is tagged
    // to keep a departing session from writing over a newer one.
    nextSessionId += 1;
    const sessionId = nextSessionId;
    return {
      onStart(props) {
        latestProps = props;
        // A pasted "@ ..." or "@x, y" is already prose; never open for it.
        // The session still runs (tiptap owns it), but with no `openPicker`
        // this session never owns the store, so its later updates no-op.
        if (args.kind === "mention" && isDismissedMentionQuery(props.query)) {
          return;
        }
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
          clientRect: props.clientRect ?? null,
        });
      },

      onUpdate(props) {
        latestProps = props;
        // The typed query turned into prose (leading space, `,`/`;`, double
        // space): dismiss exactly like Escape. `closeSession` clears the
        // store's owner, so this session's further updates no-op and the menu
        // stays closed for this `@` occurrence.
        if (args.kind === "mention" && isDismissedMentionQuery(props.query)) {
          args.pickerStore.getState().closeSession(sessionId);
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
          state.closeSession(sessionId);
          return true;
        }
        return false;
      },
    };
  };
}
