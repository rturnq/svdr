import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assetsPrefix, assetUrl, Bundler, type Page } from "./bundler.ts";
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
  type WsMessage,
} from "./ws.ts";

const markoExt = ".marko";
const wsTopic = "ws";

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
  // Resolved, so that files reached through symlinks can be told apart from
  // files that are inside the directory.
  const root = await realpath(options.dir);
  const relative = (file: string) => path.relative(root, file);
  const { hot } = options;

  const bundler = new Bundler({
    root,
    prod: options.prod,
    script: hot ? wsScriptPath : undefined,
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

  const send = createSend(options);
  const staticOptions = {
    send,
    hot,
    compression: options.compression.length > 0,
  };
  const tls = options.http ? undefined : await loadCertificate();

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
    if (encoding) {
      body = compressStream(encoding, body);
      headers.set("content-encoding", encoding);
    }
    // The body of a page is streamed and has no known length. For a HEAD
    // request the server sends the headers alone.
    return new Response(body, { headers });
  };

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

  const fetch = async (req: Request, server: Bun.Server<undefined>) => {
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
      if (server.upgrade(req)) return;
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
  const servers: Bun.Server<undefined>[] = [];
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
            socket.subscribe(wsTopic);
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

  const publish = (message: WsMessage) => {
    for (const server of servers) {
      server.publish(wsTopic, JSON.stringify(message));
    }
  };

  const watcher = watchDir(root, async (paths) => {
    try {
      const result = await bundler.update(paths);
      watcher.updateDependencies(bundler.dependencies);
      if (!hot) return;
      const messages = await messagesFor(
        root,
        paths,
        result,
        (error) => `Bundling failed\n${errorMessage(error)}`,
      );
      for (const message of messages) publish(message);
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
