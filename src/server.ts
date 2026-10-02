import { stat } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { assetsPrefix, Bundler, isTagsPath, type Page } from "./bundler.ts";
import { loadCertificate } from "./cert.ts";
import {
  compress,
  compressStream,
  isCompressible,
  negotiate,
  type Encoding,
} from "./compression.ts";
import { loadMarko } from "./marko.ts";
import type { Options } from "./options.ts";
import { watchDir } from "./watcher.ts";

const markoExt = ".marko";
/** Bodies smaller than this are not worth compressing. */
const minCompressSize = 1024;
/** Files larger than this are streamed from disk instead of compressed in memory. */
const maxCompressSize = 16 * 1024 * 1024;
const maxCompressCacheSize = 128 * 1024 * 1024;

export interface ServeDir {
  url: string;
  bundler: Bundler;
  stop(): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export async function serveDir(
  options: Options,
  log: Logger = console,
): Promise<ServeDir> {
  const root = options.dir;
  const relative = (file: string) => path.relative(root, file);

  const bundler = new Bundler({
    root,
    prod: options.prod,
    marko: await loadMarko(root),
    onBuild({ pages, error, ms }) {
      if (error) {
        const kept = pages.some((page) => page.template)
          ? ", still serving the last working build"
          : "";
        log.error(`✗ Bundling failed${kept}\n${errorMessage(error)}`);
        return;
      }
      const count = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
      log.info(`✓ Bundled ${count} (${Math.round(ms)}ms)`);
      for (const page of pages) {
        if (page.error) {
          log.error(
            `✗ ${relative(page.file)}\n${errorMessage(page.error, true)}`,
          );
        }
      }
    },
  });

  const compressed = new CompressionCache(maxCompressCacheSize);
  const tls = options.http ? undefined : await loadCertificate();

  /** Sends a complete body, compressed when the client and content allow it. */
  const send = (
    req: Request,
    body: Uint8Array,
    headers: Headers,
    cacheKey: string,
  ) => {
    let encoding: Encoding | null = null;
    if (
      body.byteLength >= minCompressSize &&
      isCompressible(headers.get("content-type") ?? "")
    ) {
      headers.append("vary", "accept-encoding");
      encoding = negotiate(
        req.headers.get("accept-encoding"),
        options.compression,
      );
    }
    if (encoding) {
      const key = `${encoding}\0${cacheKey}`;
      body = compressed.get(key, () => compress(encoding, body, options.prod));
      headers.set("content-encoding", encoding);
    }
    headers.set("content-length", String(body.byteLength));
    return new Response(req.method === "HEAD" ? null : (body as BodyInit), {
      headers,
    });
  };

  const serveAsset = (req: Request, pathname: string) => {
    const asset = bundler.assets.get(pathname);
    if (!asset) return notFound();
    return send(
      req,
      asset.body,
      new Headers({
        "content-type": asset.type,
        // The name of an asset changes whenever its content does.
        "cache-control": "public, max-age=31536000, immutable",
      }),
      pathname,
    );
  };

  /** Lists the files of the client bundle and, below `server/`, those of the server bundle. */
  const serveAssetIndex = async (req: Request) => {
    await bundler.settled;
    const assets = [...bundler.assets].sort(([a], [b]) => a.localeCompare(b));
    const total = assets.reduce((sum, [, asset]) => sum + asset.body.length, 0);
    const rows = assets.map(
      ([url, asset]) =>
        `<tr><td><a href="${escapeHtml(encodeURI(url.slice(assetsPrefix.length)))}">${escapeHtml(url.slice(assetsPrefix.length))}</a></td>` +
        `<td class="size">${formatSize(asset.body.length)}</td>` +
        `<td><time datetime="${asset.updated.toISOString()}">${formatDate(asset.updated)}</time></td></tr>`,
    );
    const body = Buffer.from(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bundled files</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; }
th, td { padding: 0.25rem 1.5rem 0.25rem 0; text-align: left; }
th { border-bottom: 1px solid; }
.size { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Bundled files</h1>
${
  assets.length
    ? `<p>${assets.length} file${assets.length === 1 ? "" : "s"}, ${formatSize(total)} in total before compression.</p>
<table>
<thead><tr><th>File</th><th class="size">Size</th><th>Last updated</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`
    : "<p>No files have been bundled.</p>"
}
</body>
</html>
`);
    return send(
      req,
      body,
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      }),
      `${assetsPrefix}\0${Bun.hash(body)}`,
    );
  };

  const serveFile = async (
    req: Request,
    file: string,
    size: number,
    mtime: Date,
  ) => {
    const blob = Bun.file(file);
    const etag = `W/"${size.toString(36)}-${Math.round(mtime.getTime()).toString(36)}"`;
    const headers = new Headers({
      "content-type": blob.type,
      "cache-control": "no-cache",
      "last-modified": mtime.toUTCString(),
      "accept-ranges": "bytes",
      etag,
    });

    if (isFresh(req, etag, mtime)) {
      return new Response(null, { status: 304, headers });
    }

    const range = req.headers.get("range");
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
      options.compression.length &&
      size <= maxCompressSize &&
      isCompressible(blob.type)
    ) {
      return send(req, await blob.bytes(), headers, `${file}\0${etag}`);
    }

    headers.set("content-length", String(size));
    return new Response(req.method === "HEAD" ? null : blob, { headers });
  };

  const servePage = async (req: Request, file: string) => {
    await bundler.settled;
    const page = bundler.pages.get(file);
    if (!page) return notFound();

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    if (options.compression.length) headers.set("vary", "accept-encoding");

    let body: ReadableStream<Uint8Array>;
    try {
      if (!page.template) throw page.error;
      body = await primed(
        page.template.render({ $global: { request: req } }).toReadable(),
      );
    } catch (error) {
      if (page.template) {
        log.error(`✗ ${relative(file)}\n${errorMessage(error, true)}`);
      }
      return serverError(page, error);
    }

    const encoding = negotiate(
      req.headers.get("accept-encoding"),
      options.compression,
    );
    if (encoding) headers.set("content-encoding", encoding);
    if (req.method === "HEAD") {
      await body.cancel();
      return new Response(null, { headers });
    }
    return new Response(encoding ? compressStream(encoding, body) : body, {
      headers,
    });
  };

  const serverError = (page: Page, error: unknown) =>
    new Response(
      options.prod
        ? "Internal Server Error"
        : `${page.template ? "Error rendering" : "Error bundling"} ${relative(page.file)}\n\n${errorMessage(error)}`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );

  const fetch = async (req: Request) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (pathname === assetsPrefix) return serveAssetIndex(req);
    if (pathname + "/" === assetsPrefix) {
      return new Response(null, {
        status: 308,
        headers: { location: `${url.pathname}/${url.search}` },
      });
    }
    if (pathname.startsWith(assetsPrefix)) return serveAsset(req, pathname);

    const file = path.join(root, pathname);
    const relativePath = path.relative(root, file);
    if (
      pathname.includes("\0") ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      isHidden(relativePath) ||
      isTagsPath(relativePath)
    ) {
      return notFound();
    }

    const serve = async (candidate: string) => {
      const stats = await stat(candidate).catch(() => null);
      if (!stats?.isFile()) return null;
      return candidate.endsWith(markoExt)
        ? servePage(req, candidate)
        : serveFile(req, candidate, stats.size, stats.mtime);
    };

    // A trailing slash asks for a directory, which is served by its index.
    if (pathname.endsWith("/")) {
      for (const extension of options.extensions) {
        const res = await serve(path.join(file, `index.${extension}`));
        if (res) return res;
      }
      return notFound();
    }

    // Anything else asks for a file, with or without its extension.
    for (const candidate of [
      file,
      ...options.extensions.map((extension) => `${file}.${extension}`),
    ]) {
      const res = await serve(candidate);
      if (res) return res;
    }

    if ((await stat(file).catch(() => null))?.isDirectory()) {
      return new Response(null, {
        status: 308,
        headers: { location: `${url.pathname}/${url.search}` },
      });
    }
    return notFound();
  };

  // "localhost" is either of the loopback addresses, depending on who asks.
  const servers: Bun.Server<undefined>[] = [];
  const listen = (hostname: string, port: number) => {
    servers.push(
      Bun.serve({
        hostname,
        port,
        http2: true,
        tls,
        fetch,
        error(error) {
          log.error(errorMessage(error, true));
          return new Response("Internal Server Error", { status: 500 });
        },
      }),
    );
  };

  let port: number;
  try {
    listen("127.0.0.1", options.port);
    port = servers[0]!.port!;
    try {
      listen("::1", port);
    } catch (error) {
      // Only being able to listen on IPv4 is fine, the port being taken is not.
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw error;
    }
    await bundler.scan();
  } catch (error) {
    await Promise.all(servers.map((server) => server.stop(true)));
    await bundler.close();
    throw error;
  }

  const watcher = watchDir(root, (paths) => {
    bundler
      .update(paths)
      .catch((error) => log.error(errorMessage(error, true)));
  });

  return {
    url: `${tls ? "https" : "http"}://localhost:${port}`,
    bundler,
    async stop() {
      watcher.close();
      await Promise.all(servers.map((server) => server.stop(true)));
      await bundler.close();
    },
  };
}

/** Dotfiles and anything inside a dot directory are never served. */
function isHidden(relativePath: string) {
  return relativePath.split(path.sep).some((part) => part[0] === ".");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

/** Formats a date in local time as `YYYY-MM-DD HH:MM:SS`. */
function formatDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function notFound() {
  return new Response("Not Found", { status: 404 });
}

const stackFrameReg = /^\s+at (?:.+ \(.+\)|(?:\/|file:|node:|native).*)$/;

/** Describes an error, by default without the stack frames that are part of its message. */
function errorMessage(error: unknown, stack = false) {
  const { message, stack: trace } = error as Error;
  const text = stripVTControlCharacters(
    String((stack && trace) || message || error),
  );
  if (stack) return text;
  return text
    .split("\n")
    .filter((line) => !stackFrameReg.test(line))
    .join("\n")
    .trim();
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

/**
 * Waits for a stream to produce its first chunk, so that an error thrown
 * before anything was rendered can still be turned into an error response.
 */
async function primed(
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  const first = await reader.read();
  if (first.done) return new Response(null).body ?? new ReadableStream();

  let started = false;
  return new ReadableStream({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(first.value);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Keeps compressed bodies around, evicting the oldest once over the size limit. */
class CompressionCache {
  #entries = new Map<string, Uint8Array>();
  #size = 0;
  #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
  }

  get(key: string, create: () => Uint8Array): Uint8Array {
    let body = this.#entries.get(key);
    if (!body) {
      body = create();
      this.#entries.set(key, body);
      this.#size += body.byteLength;
      for (const [oldKey, oldBody] of this.#entries) {
        if (this.#size <= this.#maxSize) break;
        this.#entries.delete(oldKey);
        this.#size -= oldBody.byteLength;
      }
    }
    return body;
  }
}
