/**
 * The app header's height, and the offset that puts a layer directly below it.
 *
 * A LEAF module on purpose: the pre-app boot surfaces need this number and
 * they mount in trees that cannot import the header itself (the runtime
 * fallback draws before the router exists; the window narrator's startup layer
 * mounts at the app root and its suites do not carry the header's provider
 * stack). Two of them use it to reserve the header's slot so the boot card
 * centres in the SAME box before, during and after the header is on screen -
 * a launch crosses three boot surfaces, and a card that centred once against
 * the whole viewport and once against the area under a 40px header moved 20px
 * at each hand-off.
 *
 * The two literals MUST agree; they are separate because Tailwind resolves
 * class names statically and `top-` and `h-` cannot share one token.
 */
export const APP_HEADER_HEIGHT_CLASS = "h-10";
export const BELOW_APP_HEADER_TOP_CLASS = "top-10";
