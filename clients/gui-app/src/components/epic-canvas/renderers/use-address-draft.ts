import { useState } from "react";

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
  readonly onAddressChange: (value: string) => void;
  readonly onAddressFocusChange: (focused: boolean) => void;
  /** Holds `url` in the field until the next navigation lands. */
  readonly onAddressSubmitted: (url: string) => void;
}

export function useAddressDraft(liveUrl: string): AddressDraftController {
  const [draft, setDraft] = useState<AddressDraft>(EMPTY_DRAFT);
  const [seenLiveUrl, setSeenLiveUrl] = useState(liveUrl);
  if (seenLiveUrl !== liveUrl) {
    setSeenLiveUrl(liveUrl);
    if (draft.submitted) setDraft(EMPTY_DRAFT);
  }
  return {
    addressValue: draft.focused || draft.submitted ? draft.value : liveUrl,
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
