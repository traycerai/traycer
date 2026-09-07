/** A leaf module on purpose: the pre-app boot surfaces need this number and they mount in trees that cannot
 * import the header itself (the runtime fallback draws before the router exists. */
export const APP_HEADER_HEIGHT_CLASS = "h-10";
export const BELOW_APP_HEADER_TOP_CLASS = "top-10";
