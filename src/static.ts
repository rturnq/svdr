import { isCompressible } from "./compression.ts";
import type { Send } from "./respond.ts";
import { wsScriptTag } from "./ws.ts";

/** Files larger than this are streamed from disk instead of compressed in memory. */
const maxCompressSize = 16 * 1024 * 1024;
const htmlReg = /\.html?$/i;
const wsScriptTagBytes = Buffer.from(`\n${wsScriptTag}\n`);

export interface StaticOptions {
  send: Send;
  /** Whether html files take part in live reload. */
  hot: boolean;
  compression: boolean;
}

/** Serves a file as it is, apart from the live reload script html files get. */
export async function serveFile(
  req: Request,
  file: string,
  size: number,
  mtime: Date,
  options: StaticOptions,
): Promise<Response> {
  const blob = Bun.file(file);
  // HTML pages take part in live reload like rendered pages do, which
  // makes them a different response from the file itself.
  const inject = options.hot && htmlReg.test(file) && size <= maxCompressSize;
  const etag = `W/"${size.toString(36)}-${Math.round(mtime.getTime()).toString(36)}${inject ? "-hot" : ""}"`;
  const headers = new Headers({
    "content-type": blob.type,
    "cache-control": "no-cache",
    "last-modified": mtime.toUTCString(),
    etag,
  });

  if (isFresh(req, etag, mtime)) {
    return new Response(null, { status: 304, headers });
  }

  if (inject) {
    const body = Buffer.concat([await blob.bytes(), wsScriptTagBytes]);
    return options.send(req, body, headers, `${file}\0${etag}`);
  }
  headers.set("accept-ranges", "bytes");

  // A range of the current version only: an entity tag is weak and never
  // matches, a date matches when it is the modification time.
  const ifRange = req.headers.get("if-range");
  const range =
    ifRange === null ||
    (!ifRange.startsWith("W/") &&
      !ifRange.startsWith('"') &&
      Date.parse(ifRange) === Math.floor(mtime.getTime() / 1000) * 1000)
      ? req.headers.get("range")
      : null;
  if (range) {
    const parsed = parseRange(range, size);
    if (parsed === null) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (parsed) {
      const [start, end] = parsed;
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(
        req.method === "HEAD" ? null : blob.slice(start, end + 1),
        { status: 206, headers },
      );
    }
  }

  if (
    options.compression &&
    size <= maxCompressSize &&
    isCompressible(blob.type)
  ) {
    return options.send(req, await blob.bytes(), headers, `${file}\0${etag}`);
  }

  headers.set("content-length", String(size));
  return new Response(req.method === "HEAD" ? null : blob, { headers });
}

function isFresh(req: Request, etag: string, mtime: Date) {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    return ifNoneMatch
      .split(",")
      .some((value) => value.trim() === etag || value.trim() === "*");
  }
  const ifModifiedSince = Date.parse(
    req.headers.get("if-modified-since") ?? "",
  );
  return Math.floor(mtime.getTime() / 1000) * 1000 <= ifModifiedSince;
}

/**
 * Parses a `Range` header with a single byte range. Returns the inclusive
 * range, `null` when it cannot be satisfied and `undefined` when the header
 * should be ignored.
 */
function parseRange(
  header: string,
  size: number,
): [start: number, end: number] | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;

  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(size - Number(match[2]), 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? null : [start, end];
}
