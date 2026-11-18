declare module "pdfmake/build/pdfmake" {
  const pdfMake: typeof import("pdfmake");
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts" {
  const vfs: Record<string, string>;
  export = vfs;
}
