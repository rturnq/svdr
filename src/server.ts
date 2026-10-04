import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assetsPrefix,
  assetUrl,
  Bundler,
  entryPrefix,
  type Page,
} from "./bundler.ts";
import { loadCertificate } from "./cert.ts";
import { compressStream, negotiate } from "./compression.ts";
import { renderEntries, renderListing } from "./listing.ts";
import { loadMarko } from "./marko.ts";
import type { Options } from "./options.ts";
import { isServable } from "./paths.ts";
import {
  createSend,
  errorMessage,
  notFound,
  redirectToDirectory,
} from "./respond.ts";
import { serveFile } from "./static.ts";
import { watchDir } from "./watcher.ts";
import {
  messagesFor,
  wsPath,
  wsScript,
  wsScriptPath,
  type Notice,
  type WsMessage,
} from "./ws.ts";

const markoExt = ".marko";
const wsTopic = "ws";

export interface ServeDir {
  url: string;
  bundler: Bundler;
  stop(): Promise<void>;
}

/** What the server knows about a connected page. */
interface SocketData {
  /** The directory of the entry the page was rendered from, if it was. */
  entry?: string;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export async function serveDir(
  options: Options,
  log: Logger = console,
): Promise<ServeDir> {
  // Resolved, so that files reached through symlinks can be told apart from
  // files that are inside the directory.
  const root = await realpath(options.dir);
  /** A path within the served directory, written the way its URL is. */
  const relative = (file: string) =>
    path.relative(root, file).split(path.sep).join("/");
  const { hot } = options;

  /** The removed files logged for the changes being handled. */
  let loggedRemoved = new Set<string>();

  const bundler = new Bundler({
    root,
    prod: options.prod,
    script: hot ? wsScriptPath : undefined,
    marko: await loadMarko(root),
    onEvent(event) {
      switch (event.type) {
        case "plan": {
          const count = event.entries.length;
          log.info(`↻ bundling ${count} ${count === 1 ? "entry" : "entries"}`);
          break;
        }
        case "entry": {
          const time = `(${Math.round(event.ms)}ms)`;
          if (!event.error) {
            log.info(`  ✓ ${relative(event.file)} ${time}`);
          } else {
            const kept = event.kept
              ? ", still serving its last working build"
              : "";
            // The entry is named on this line already.
            const message = errorMessage(event.error.cause ?? event.error);
            log.error(
              `  ✗ ${relative(event.file)} ${time}${kept}\n${message.replace(/^(?=.)/gm, "  ")}`,
            );
          }
          break;
        }
        case "removed":
          // Usually the file's own removal was logged; a page that went away
          // with its directory is only known from here.
          if (!loggedRemoved.has(event.file)) {
            log.info(`- ${relative(event.file)}`);
          }
          break;
        case "collision":
          log.error(
            `! hash collision: ${relative(event.file)} and ${relative(event.other)} both map to ${event.prefix}; ${relative(event.file)} is not served`,
          );
          break;
      }
    },
  });

  const send = createSend(options);
  const staticOptions = {
    send,
    hot,
    compression: options.compression,
  };
  const tls = options.http ? undefined : await loadCertificate();

  // The name of an asset changes whenever its content does.
  const immutable = "public, max-age=31536000, immutable";

  const serveAsset = async (req: Request, pathname: string) => {
    const asset = bundler.assets.get(pathname);
    if (!asset) return notFound();
    if ("body" in asset) {
      return send(
        req,
        asset.body,
        new Headers({
          "content-type": asset.type,
          "cache-control": immutable,
        }),
        pathname,
      );
    }
    // A file a page refers to is served from where it is, like any file.
    // Its URL stands for the content it had when it was bundled, so once
    // the file has changed there is nothing to serve under that URL.
    const stats = await stat(asset.file).catch(() => null);
    if (
      !stats?.isFile() ||
      stats.size !== asset.size ||
      stats.mtimeMs !== asset.mtimeMs
    ) {
      return notFound();
    }
    return serveFile(req, asset.file, stats.size, stats.mtime, {
      ...staticOptions,
      hot: false,
      cacheControl: immutable,
    });
  };

  const pageUrl = async (file: string) => {
    const exact = assetUrl("/" + file);
    const index = options.extensions.indexOf("marko");
    if (index === -1) return exact;
    const stem = file.slice(0, -markoExt.length);
    const isIndex = path.basename(file) === "index.marko";
    // Use the short route only when it resolves to this template rather than
    // an exact file or an extension with higher priority.
    const preceding = [
      ...(isIndex ? [] : [stem]),
      ...options.extensions.slice(0, index).map((ext) => `${stem}.${ext}`),
    ];
    for (const candidate of preceding) {
      if (
        (await stat(path.join(root, candidate)).catch(() => null))?.isFile()
      ) {
        return exact;
      }
    }
    return assetUrl(
      "/" + (isIndex ? file.slice(0, -"index.marko".length) : stem),
    );
  };

  const serveListing = async (req: Request, prefix = assetsPrefix) => {
    await bundler.settled;
    const entries = bundler.entries;
    const entry = entries.find((entry) => entry.prefix === prefix);
    if (prefix !== assetsPrefix && !entry) return notFound();
    const body = Buffer.from(
      entry
        ? renderListing(entry, await pageUrl(entry.file))
        : renderEntries(entries),
    );
    return send(
      req,
      body,
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      }),
      `${prefix}\0${Bun.hash(body)}`,
    );
  };

  const servePage = async (req: Request, file: string) => {
    // A page that is being bundled for the first time is waited for; one
    // that has been bundled before is served as it is while it rebuilds.
    const page = await bundler.page(file);
    if (!page) return notFound();

    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    if (options.compression.length) headers.set("vary", "accept-encoding");

    // A page that has never bundled has nothing to show. With live reload
    // it is served empty, for its script to show the error and to load the
    // page once it bundles.
    const prefix = entryPrefix(root, file);
    if (!page.template && hot && bundler.failure(prefix)) {
      return send(
        req,
        Buffer.from(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${Bun.escapeHTML(relative(file))}</title>
</head>
<body>
<script type="module" src="${wsScriptPath}?entry=${prefix.slice(assetsPrefix.length, -1)}"></script>
</body>
</html>
`),
        headers,
        `${prefix}\0empty`,
      );
    }

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
    if (encoding) {
      body = compressStream(encoding, body);
      headers.set("content-encoding", encoding);
    }
    // The body of a page is streamed and has no known length. For a HEAD
    // request the server sends the headers alone.
    return new Response(body, { headers });
  };

  /** A bundling error as pages show it; the entry is the page's own. */
  const describeError = (error: Error) =>
    `Bundling failed\n${errorMessage(error.cause ?? error)}`;

  const serverError = (page: Page, error: unknown) =>
    new Response(
      options.prod
        ? "Internal Server Error"
        : `${page.template ? "Error rendering" : "Error bundling"} ${relative(page.file)}\n\n${errorMessage(error)}`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );

  /**
   * Serves the file at the path if there is one. What may be served, and
   * how, is decided by the file's own path: the requested one may spell it
   * differently on a case-insensitive file system or reach it through a
   * symlink.
   */
  const serve = async (req: Request, candidate: string) => {
    const stats = await stat(candidate).catch(() => null);
    if (!stats?.isFile()) return null;
    const file = await realpath(candidate);
    const relativePath = relative(file);
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      !isServable(relativePath)
    ) {
      return notFound();
    }
    return file.endsWith(markoExt)
      ? servePage(req, file)
      : serveFile(req, file, stats.size, stats.mtime, staticOptions);
  };

  const fetch = async (req: Request, server: Bun.Server<SocketData>) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(req.url);
    // Only the machine itself is served, so a request addressed to another
    // host comes from somewhere it should not.
    if (!isLoopbackHost(url.hostname)) {
      return new Response("Forbidden", { status: 403 });
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    // A path is taken as it is: no empty, `.` or `..` segments to resolve.
    const segments = pathname.split("/").slice(1);
    if (
      segments.some(
        (segment, i) =>
          segment === "." ||
          segment === ".." ||
          (segment === "" && i !== segments.length - 1),
      )
    ) {
      return notFound();
    }

    if (hot && pathname === wsPath) {
      // A rendered page names its entry by the hash of its directory.
      const hash = url.searchParams.get("entry");
      const entry =
        hash && /^[\w-]+$/.test(hash) ? `${assetsPrefix}${hash}/` : undefined;
      if (server.upgrade(req, { data: { entry } })) return;
      return new Response("Upgrade Required", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    if (hot && pathname === wsScriptPath) {
      return send(
        req,
        Buffer.from(wsScript),
        new Headers({
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
        }),
        wsScriptPath,
      );
    }
    if (pathname === assetsPrefix) return serveListing(req);
    if (pathname + "/" === assetsPrefix) {
      return redirectToDirectory(assetsPrefix, url.search);
    }
    if (pathname.startsWith(assetsPrefix)) {
      // Entry indexes occupy only the first level; nested paths are assets.
      if (/^[^/]+\/?$/.test(pathname.slice(assetsPrefix.length))) {
        if (pathname.endsWith("/")) return serveListing(req, pathname);
        await bundler.settled;
        const prefix = pathname + "/";
        if (bundler.entries.some((entry) => entry.prefix === prefix)) {
          return redirectToDirectory(prefix, url.search);
        }
      }
      return serveAsset(req, pathname);
    }

    const file = path.join(root, pathname);
    const relativePath = relative(file);
    if (
      pathname.includes("\0") ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      !isServable(relativePath)
    ) {
      return notFound();
    }

    // A trailing slash asks for a directory, which is served by its index.
    if (pathname.endsWith("/")) {
      for (const extension of options.extensions) {
        const res = await serve(req, path.join(file, `index.${extension}`));
        if (res) return res;
      }
      return notFound();
    }

    // Anything else asks for a file, with or without its extension.
    for (const candidate of [
      file,
      ...options.extensions.map((extension) => `${file}.${extension}`),
    ]) {
      const res = await serve(req, candidate);
      if (res) return res;
    }

    if ((await stat(file).catch(() => null))?.isDirectory()) {
      return redirectToDirectory(`${url.pathname}/`, url.search);
    }
    return notFound();
  };

  // "localhost" is either of the loopback addresses, depending on who asks.
  const servers: Bun.Server<SocketData>[] = [];
  const listen = (hostname: string, port: number) => {
    servers.push(
      Bun.serve({
        hostname,
        port,
        http2: true,
        tls,
        fetch,
        websocket: {
          open(socket) {
            // Every page hears about files that are served as they are, and
            // a rendered page also about its own entry.
            socket.subscribe(wsTopic);
            const { entry } = socket.data;
            if (!entry) return;
            socket.subscribe(`${wsTopic}:${entry}`);
            // A page that loads while its entry is failing was not there
            // when that was announced.
            const error = bundler.failure(entry);
            if (error) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  message: describeError(error),
                } satisfies WsMessage),
              );
            }
          },
          message() {},
        },
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

  const publish = ({ entry, message }: Notice) => {
    const topic = entry ? `${wsTopic}:${entry}` : wsTopic;
    for (const server of servers) {
      server.publish(topic, JSON.stringify(message));
    }
  };

  /** Files seen to exist, to tell a file being replaced from one being added. */
  const known = new Set<string>();
  const watcher = watchDir(root, async (changes) => {
    try {
      const paths = new Set(changes.keys());
      const dependencies = bundler.dependencies;
      loggedRemoved = new Set();
      for (const [file, event] of changes) {
        const stats = await stat(file).catch(() => null);
        const wasKnown =
          known.has(file) || dependencies.has(file) || bundler.pages.has(file);
        if (!stats) {
          known.delete(file);
          loggedRemoved.add(file);
          log.info(`- ${relative(file)}`);
        } else if (!stats.isDirectory()) {
          known.add(file);
          // A file that appeared is new when it has not been modified since
          // it was created. One saved by replacing it looks the same, unless
          // it was seen before.
          const added =
            event === "rename" &&
            !wasKnown &&
            stats.mtimeMs - stats.birthtimeMs < 100;
          log.info(added ? `+ ${relative(file)}` : `~ ${relative(file)}`);
        }
      }
      const result = await bundler.update(paths);
      // What follows belongs to the next change.
      log.info("");
      watcher.updateDependencies(bundler.dependencies);
      if (!hot) return;
      const messages = await messagesFor(root, paths, result, describeError);
      for (const notice of messages) publish(notice);
    } catch (error) {
      log.error(errorMessage(error, true));
    }
  });

  watcher.updateDependencies(bundler.dependencies);

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

/** Whether a host name, as a URL has it, is this machine. */
function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
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
  if (first.done) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }

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
