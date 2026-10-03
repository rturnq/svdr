import { pipeline, Readable } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";

export type Encoding = "br" | "gzip" | "zstd" | "deflate";

const aliases: Record<string, Encoding> = {
  br: "br",
  brotli: "br",
  gz: "gzip",
  gzip: "gzip",
  zstd: "zstd",
  deflate: "deflate",
};

/** Parses a `--compression` value such as `br,gz` into an ordered list of encodings. */
export function parseCompression(value: string): Encoding[] {
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  if (names.includes("none")) {
    if (names.length > 1) {
      throw new Error(`"none" cannot be combined with other compression types`);
    }
    return [];
  }

  if (!names.length) throw new Error("Missing compression type");

  const encodings = new Set<Encoding>();
  for (const name of names) {
    const encoding = aliases[name];
    if (!encoding) {
      throw new Error(
        `Unknown compression type "${name}" (expected br, gz, zstd, deflate or none)`,
      );
    }
    encodings.add(encoding);
  }
  return [...encodings];
}

/**
 * Picks the first of our preferred encodings that the client accepts, or
 * `null` when the response should be sent uncompressed.
 */
export function negotiate(
  acceptEncoding: string | null,
  encodings: readonly Encoding[],
): Encoding | null {
  if (!acceptEncoding || !encodings.length) return null;

  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name = "", ...params] = part.split(";");
    let q = 1;
    for (const param of params) {
      const [key, val] = param.split("=");
      if (key?.trim().toLowerCase() === "q") q = Number(val);
    }
    accepted.set(name.trim().toLowerCase(), Number.isNaN(q) ? 0 : q);
  }

  const wildcard = accepted.get("*") ?? 0;
  for (const encoding of encodings) {
    if ((accepted.get(encoding) ?? wildcard) > 0) return encoding;
  }
  return null;
}

const compressibleTypeReg =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|wasm|x-ndjson)|image\/(?:svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)|font\/(?:ttf|otf))|\+(?:json|xml)(?:;|$)/i;

export function isCompressible(contentType: string): boolean {
  return compressibleTypeReg.test(contentType);
}

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const zstdCompress = promisify(zlib.zstdCompress);
const deflate = promisify(zlib.deflate);

/**
 * Compresses a complete body off the main thread. `best` trades speed for
 * size and is meant for bodies that are compressed once and served many
 * times.
 */
export function compress(
  encoding: Encoding,
  data: Uint8Array,
  best = false,
): Promise<Uint8Array> {
  switch (encoding) {
    case "br":
      return brotliCompress(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: best ? 11 : 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
        },
      });
    case "gzip":
      return gzip(data, { level: best ? 9 : 6 });
    case "zstd":
      return zstdCompress(data, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: best ? 19 : 3 },
      });
    case "deflate":
      return deflate(data, { level: best ? 9 : 6 });
  }
}

/**
 * Compresses a streamed body, flushing after every chunk so that content
 * the page flushes early still reaches the browser early. Cancelling the
 * result cancels the body, so that a client that went away stops the
 * rendering it was waiting for.
 */
export function compressStream(
  encoding: Encoding,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const compressor = createCompressor(encoding);
  pipeline(Readable.fromWeb(body as never), compressor, () => {});
  return Readable.toWeb(compressor) as never;
}

function createCompressor(encoding: Encoding) {
  switch (encoding) {
    case "br":
      return zlib.createBrotliCompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      });
    case "gzip":
      return zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    case "zstd":
      return zlib.createZstdCompress({ flush: zlib.constants.ZSTD_e_flush });
    case "deflate":
      return zlib.createDeflate({ flush: zlib.constants.Z_SYNC_FLUSH });
  }
}
