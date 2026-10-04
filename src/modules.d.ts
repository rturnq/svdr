// Scripts that are served or bundled as they are, imported as text.
declare module "*.js" {
  const text: string;
  export default text;
}
