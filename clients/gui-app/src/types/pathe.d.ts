declare module "pathe" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function normalize(path: string): string;
}
