import { statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseCompression, type Encoding } from "./compression.ts";

export interface Options {
  /** Absolute path of the directory being served. */
  dir: string;
  port: number;
  /** Encodings to offer, in order of preference. Empty disables compression. */
  compression: Encoding[];
  /**
   * Extensions (without the dot) to try, in order, for a path that is not a
   * file, and to look for as the index of a directory.
   */
  extensions: string[];
  /** Serve plain HTTP instead of HTTPS with a self-signed certificate. */
  http: boolean;
  prod: boolean;
}

export const usage = `Usage: svdr [options]

Options:
  -d, --dir <path>          Directory to serve (default: current directory)
  -p, --port <number>       Port to listen on (default: 3000)
  -c, --compression <list>  Comma separated encodings in order of preference:
                            br, gz, zstd, deflate, or "none" (default: br,gz)
  -x, --extensions <list>   Comma separated extensions to try for paths without
                            one and for directory indexes, in order of
                            preference, or "none" (default: marko,html)
      --http                Serve plain HTTP instead of HTTPS
      --prod                Minified bundles, stronger compression, no source maps
  -h, --help                Show this help
`;

export class UsageError extends Error {}

/** Parses command line arguments; returns `null` when help was requested. */
export function parseOptions(argv: string[]): Options | null {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: "string", short: "d", default: "." },
        port: { type: "string", short: "p", default: "3000" },
        compression: { type: "string", short: "c", default: "br,gz" },
        extensions: { type: "string", short: "x", default: "marko,html" },
        http: { type: "boolean", default: false },
        prod: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }

  if (values.help) return null;

  const dir = path.resolve(values.dir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`Not a directory: ${dir}`);
  }

  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port > 65535) {
    throw new UsageError(`Invalid port: ${values.port}`);
  }

  let compression;
  try {
    compression = parseCompression(values.compression);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }

  return {
    dir,
    port,
    compression,
    extensions: parseExtensions(values.extensions),
    http: values.http,
    prod: values.prod,
  };
}

/** Parses an `--extensions` value such as `marko,html` into an ordered list of extensions. */
export function parseExtensions(value: string): string[] {
  const extensions = value
    .split(",")
    .map((extension) => extension.trim().replace(/^\./, ""))
    .filter(Boolean);

  if (extensions.includes("none")) {
    if (extensions.length > 1) {
      throw new UsageError(`"none" cannot be combined with other extensions`);
    }
    return [];
  }

  if (!extensions.length) throw new UsageError("Missing extension");

  for (const extension of extensions) {
    if (!/^[\w.-]+$/.test(extension)) {
      throw new UsageError(`Invalid extension "${extension}"`);
    }
  }
  return [...new Set(extensions)];
}
