import { useCallback, useRef, useState } from "react";

/**
 * The address-bar draft policy both browser chromes share.
 *
 * One policy, because the same toolbar renders over both transports and a URL
 * half-typed in an Electron tile must not be discarded on rules a screencast
 * tile would have kept it under. The screencast rule is the one that survived:
 *
 * - the draft is OWNED BY FOCUS - while the caret is in the field, a navigation
 *   arriving underneath (an agent driving the page, a redirect) never rewrites
 *   what the user is typing;
 * - a SUBMITTED draft outlives blur but yields to the next navigation, so the
 *   field shows where the page actually landed rather than what was asked for;
 * - blur without a submit drops the draft and the live URL comes back.
 */
interface AddressDraft {
  readonly focused: boolean;
  readonly submitted: boolean;
  readonly value: string;
}

const EMPTY_DRAFT: AddressDraft = {
  focused: false,
  submitted: false,
  value: "",
};

export interface AddressDraftController {
  /** What the address field renders: the draft while it owns the field. */
  readonly addressValue: string;
  /**
   * Callback ref for the rendered field. A plain function, not a `RefObject`:
   * `react-hooks/refs` rejects a ref object travelling through render, and
   * this controller is passed to the toolbar as a prop.
   */
  readonly setAddressInput: (node: HTMLInputElement | null) => void;
  /**
   * Put the caret in the address field - Cmd+L while a native guest holds
   * focus (see `@/lib/browser-view/reserved-chords-registration`; main takes
   * OS keyboard focus off the guest first, or the caret would render here
   * while typing still reached the page). Focus still ARRIVES as the input's
   * own event, so the draft policy above is unchanged by it.
   */
  readonly focusAddress: () => void;
  readonly onAddressChange: (value: string) => void;
  readonly onAddressFocusChange: (focused: boolean) => void;
  /** Holds `url` in the field until the next navigation lands. */
  readonly onAddressSubmitted: (url: string) => void;
}

export function useAddressDraft(liveUrl: string): AddressDraftController {
  const [draft, setDraft] = useState<AddressDraft>(EMPTY_DRAFT);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const setAddressInput = useCallback((node: HTMLInputElement | null) => {
    addressInputRef.current = node;
  }, []);
  const focusAddress = useCallback(() => {
    const input = addressInputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);
  const [seenLiveUrl, setSeenLiveUrl] = useState(liveUrl);
  if (seenLiveUrl !== liveUrl) {
    setSeenLiveUrl(liveUrl);
    if (draft.submitted) setDraft(EMPTY_DRAFT);
  }
  return {
    addressValue: draft.focused || draft.submitted ? draft.value : liveUrl,
    setAddressInput,
    focusAddress,
    onAddressChange: (value: string) => {
      setDraft({ focused: true, submitted: false, value });
    },
    onAddressFocusChange: (focused: boolean) => {
      setDraft((current) => {
        if (!focused) return EMPTY_DRAFT;
        if (current.focused) return current;
        return { focused: true, submitted: false, value: liveUrl };
      });
    },
    onAddressSubmitted: (url: string) => {
      setDraft({ focused: true, submitted: true, value: url });
    },
  };
}
