/**
 * Infer the platform's setTimeout/setInterval handle (DOM `number` vs Node `Timeout`) rather than naming `NodeJS`.
 * Parameter list is `(...args: any[]) => infer R`; `never[]` fails to match Node's overloaded timers.
 */
export type TimerHandle = typeof setTimeout extends (
  ...args: any[]
) => infer Handle
  ? Handle
  : never;

export type IntervalHandle = typeof setInterval extends (
  ...args: any[]
) => infer Handle
  ? Handle
  : never;
