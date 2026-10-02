import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WsMessage } from "../src/ws.ts";
import type { Options } from "../src/options.ts";
import { serveDir, type Logger, type ServeDir } from "../src/server.ts";

const silent = { info() {}, error() {} };
const fixture = path.join(import.meta.dir, "fixture");
const tmpDirs: string[] = [];

async function createSite() {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "svdr-test-")),
  );
  tmpDirs.push(dir);
  await cp(fixture, dir, { recursive: true });
  return dir;
}

function start(
  dir: string,
  overrides: Partial<Options> = {},
  log: Logger = silent,
) {
  return serveDir(
    {
      dir,
      port: 0,
      compression: ["br", "gzip"],
      extensions: ["marko", "html"],
      http: true,
      prod: false,
      hot: !overrides.prod,
      ...overrides,
    },
    log,
  );
}

async function waitFor<T>(check: () => Promise<T | false | undefined>) {
  for (const start = Date.now(); Date.now() - start < 5000;) {
    const result = await check();
    if (result) return result;
    await Bun.sleep(25);
  }
  throw new Error("Timed out");
}

const wsScriptUrl = "/_svdr/ws.js";

/** The URLs of the bundled files a page links to. */
function bundledUrls(html: string) {
  return Array.from(
    html.matchAll(/(?:href|src)="(\/_svdr\/[^"]+)"/g),
    (match) => match[1]!,
  ).filter((url) => url !== wsScriptUrl);
}

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("static files", () => {
  let dir: string;
  let server: ServeDir;
  const get = (pathname: string, init?: RequestInit) =>
    fetch(server.url + pathname, { redirect: "manual", ...init });

  beforeAll(async () => {
    dir = await createSite();
    server = await start(dir);
  });
  afterAll(() => server.stop());

  test("serves static files", async () => {
    const res = await get("/assets/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("A plain static file.\n");
  });

  test("revalidates static files", async () => {
    const etag = (await get("/assets/site.css")).headers.get("etag")!;
    const res = await get("/assets/site.css", {
      headers: { "if-none-match": etag },
    });
    expect(res.status).toBe(304);
  });

  test("serves byte ranges", async () => {
    const res = await get("/assets/hello.txt", {
      headers: { range: "bytes=2-6" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-6/21");
    expect(await res.text()).toBe("plain");
  });

  test("does not serve missing, hidden, node_modules or outside files", async () => {
    await writeFile(path.join(dir, ".secret"), "hidden");
    await mkdir(path.join(dir, "lib/node_modules"), { recursive: true });
    await writeFile(path.join(dir, "lib/node_modules/dep.js"), "dep");
    expect((await get("/missing.txt")).status).toBe(404);
    expect((await get("/.secret")).status).toBe(404);
    expect((await get("/lib/node_modules/dep.js")).status).toBe(404);
    expect((await get("/%2e%2e%2f%2e%2e%2fetc/passwd")).status).toBe(404);
    expect((await get("/assets/hello.txt/")).status).toBe(404);
  });

  test("judges files by their own path, not the requested spelling", async () => {
    // On a case-insensitive file system these reach excluded files.
    expect((await get("/TAGS/counter.MARKO")).status).toBe(404);
    expect((await get("/.SECRET")).status).toBe(404);
    // A page is still a page, and a file still a file.
    const page = await get("/Index.MARKO");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Hello from svdr</h1>");
    expect((await get("/ASSETS/hello.TXT")).status).toBe(200);
  });

  test("does not resolve segments that appear once decoded", async () => {
    // Dot segments in the URL itself are resolved by the URL parser, within
    // the root, before the path is seen; these only appear after decoding.
    expect((await get("/assets/./hello.txt")).status).toBe(200);
    for (const pathname of [
      "//attacker.invalid/%2e%2e%2fassets",
      "/assets/%2e%2e%2fassets/hello.txt",
      "/assets/.%2fhello.txt",
      "/assets//hello.txt",
    ]) {
      expect((await get(pathname)).status).toBe(404);
    }
  });

  test("only answers requests for this machine", async () => {
    for (const host of ["localhost", "127.0.0.1", "app.localhost"]) {
      expect(
        (await get("/assets/hello.txt", { headers: { host } })).status,
      ).toBe(200);
    }
    const res = await get("/assets/hello.txt", {
      headers: { host: "attacker.invalid" },
    });
    expect(res.status).toBe(403);
  });

  test("only allows reads", async () => {
    expect((await get("/", { method: "POST" })).status).toBe(405);
  });

  test("serves files without their extension", async () => {
    await mkdir(path.join(dir, "docs/guide"), { recursive: true });
    await writeFile(path.join(dir, "docs.html"), "docs file");
    await writeFile(path.join(dir, "docs/index.html"), "docs index");
    await writeFile(path.join(dir, "docs/guide.html"), "guide");
    await writeFile(path.join(dir, "docs/readme"), "exact");
    await writeFile(path.join(dir, "docs/readme.html"), "not exact");

    // Without a trailing slash a path is a file, with one it is a directory.
    expect(await (await get("/docs")).text()).toStartWith("docs file");
    expect(await (await get("/docs/")).text()).toStartWith("docs index");
    expect(await (await get("/docs/guide")).text()).toStartWith("guide");
    expect((await get("/docs/guide/")).status).toBe(404);
    expect((await get("/docs.html/")).status).toBe(404);

    expect(await (await get("/docs/readme")).text()).toBe("exact");
    expect(await (await get("/about")).text()).toContain("<h1>About</h1>");
    expect((await get("/about/")).status).toBe(404);
  });

  test("prefers extensions in the configured order", async () => {
    await writeFile(path.join(dir, "about.html"), "about file");
    try {
      expect(await (await get("/about")).text()).toContain("<h1>About</h1>");
      expect(await (await get("/about.html")).text()).toStartWith("about file");
    } finally {
      await rm(path.join(dir, "about.html"));
    }
  });

  test("redirects directories without a matching file to a trailing slash", async () => {
    const res = await get("/assets?x=1");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/assets/?x=1");
    expect((await get("/assets/")).status).toBe(404);
  });

  test("does not serve tags directories or treat them as pages", async () => {
    await writeFile(path.join(dir, "tags/note.txt"), "note");
    expect((await get("/tags/counter.marko")).status).toBe(404);
    expect((await get("/tags/counter")).status).toBe(404);
    expect((await get("/tags/note.txt")).status).toBe(404);
    expect((await get("/tags")).status).toBe(404);
    expect([...server.bundler.pages.keys()].sort()).toEqual([
      path.join(dir, "about.marko"),
      path.join(dir, "index.marko"),
    ]);
  });
});

describe("pages", () => {
  let dir: string;
  let server: ServeDir;
  const get = (pathname: string, init?: RequestInit) =>
    fetch(server.url + pathname, { redirect: "manual", ...init });

  beforeAll(async () => {
    dir = await createSite();
    server = await start(dir);
  });
  afterAll(() => server.stop());

  test("renders pages with their bundled assets", async () => {
    const res = await get("/index.marko");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<h1>Hello from svdr</h1>");
    expect(html).toContain("Clicked <!>0");
    expect(await (await get("/")).text()).toContain("<h1>Hello from svdr</h1>");

    const scripts = await Promise.all(
      Array.from(
        html.matchAll(
          /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)">/g,
        ),
        ([, url]) => url!,
      )
        .filter((url) => url !== wsScriptUrl)
        .map((url) => get(url)),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const js of scripts) {
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toStartWith("text/javascript");
      expect(js.headers.get("cache-control")).toContain("immutable");
    }
    expect(scripts.map((js) => js.headers.get("content-encoding"))).toContain(
      "br",
    );
    const code = await Promise.all(scripts.map((js) => js.text()));
    expect(code.join("\n")).toContain("$scope.count + 1");

    const styles = await Promise.all(
      Array.from(
        html.matchAll(/<link rel="stylesheet" href="(\/_svdr\/[^"]+)">/g),
        async (match) => (await get(match[1]!)).text(),
      ),
    );
    expect(styles.join("\n")).toContain("rebeccapurple");
    expect(styles.join("\n")).toContain(".counter");
  });

  test("ships no script for pages without client side behavior", async () => {
    const html = await (await get("/about.marko")).text();
    expect(html).toContain("<h1>About</h1>");
    expect(bundledUrls(html)).toEqual([]);
  });

  test("compresses with the preferred encoding the client accepts", async () => {
    const page = await get("/", { headers: { "accept-encoding": "gzip" } });
    expect(page.headers.get("content-encoding")).toBe("gzip");
    expect(await page.text()).toContain("<h1>Hello from svdr</h1>");

    const identity = await get("/", {
      headers: { "accept-encoding": "identity" },
    });
    expect(identity.headers.get("content-encoding")).toBeNull();
  });

  test("shares chunks between pages", async () => {
    await writeFile(
      path.join(dir, "other.marko"),
      "<h1>Other</h1>\n<counter/>\n",
    );
    const other = await waitFor(async () => {
      const res = await get("/other");
      return res.status === 200 && (await res.text());
    });
    const index = await (await get("/")).text();
    const assets = bundledUrls;
    const shared = assets(index).filter((url) => assets(other).includes(url));

    expect(shared.some((url) => url.endsWith(".js"))).toBe(true);
    expect(shared.some((url) => url.endsWith(".css"))).toBe(true);
    for (const url of shared) expect((await get(url)).status).toBe(200);
    // Each page still has an entry of its own.
    expect(assets(index).at(-1)).not.toBe(assets(other).at(-1));
    await rm(path.join(dir, "other.marko"));
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "other.marko")),
    );
    expect((await get("/other")).status).toBe(404);
  });
});

describe("bundled files", () => {
  let dir: string;
  let server: ServeDir;
  const get = (pathname: string, init?: RequestInit) =>
    fetch(server.url + pathname, { redirect: "manual", ...init });

  beforeAll(async () => {
    dir = await createSite();
    server = await start(dir);
  });
  afterAll(() => server.stop());

  test("lists the bundled files", async () => {
    const redirect = await get("/_svdr");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/_svdr/");

    const res = await get("/_svdr/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const listing = await res.text();
    const rows = Array.from(
      listing.matchAll(
        /<a href="([^"]+)">([^<]+)<\/a><\/td><td class="size">([^<]+)<\/td><td><time datetime="([^"]+)">/g,
      ),
      ([, href, name, size, updated]) => ({ href, name, size, updated }),
    );
    // Links are relative to the listing and named by that same path.
    expect(rows.map((row) => "/_svdr/" + row.href)).toEqual(
      [...server.bundler.assets.keys()].sort(),
    );
    for (const row of rows) {
      expect(row.name).toBe(row.href!);
      expect(row.size).toMatch(/^[\d.]+ k?B$/);
      expect(Date.parse(row.updated!)).not.toBeNaN();
      expect((await get("/_svdr/" + row.href)).status).toBe(200);
    }

    // Everything a page links to is listed, as are the server only files.
    const html = await (await get("/")).text();
    for (const url of bundledUrls(html)) {
      expect(rows.map((row) => "/_svdr/" + row.href)).toContain(url);
    }
    const serverFiles = rows.filter((row) => row.href!.startsWith("server/"));
    expect(
      serverFiles.some((row) =>
        /^server\/index\.server-entry-.+\.js$/.test(row.href!),
      ),
    ).toBe(true);
    const serverEntry = await get("/_svdr/" + serverFiles[0]!.href);
    expect(serverEntry.headers.get("content-type")).toStartWith(
      "text/javascript",
    );
  });

  test("does not bundle empty files", async () => {
    // The about page has no client side behavior, so it has no client entry.
    const files = [...server.bundler.assets.keys()];
    expect(files.some((url) => url.includes("index.client-entry"))).toBe(true);
    expect(files.some((url) => url.includes("about.client-entry"))).toBe(false);
    expect(files.some((url) => url.includes("about.server-entry"))).toBe(true);
    for (const asset of server.bundler.assets.values()) {
      expect(asset.body.length).toBeGreaterThan(0);
    }
    expect((await get("/_svdr/about.client-entry.js")).status).toBe(404);
  });

  test("only updates the date of files that changed", async () => {
    const before = new Map(server.bundler.assets);
    const find = (assets: ReadonlyMap<string, unknown>, part: string) =>
      [...assets.keys()].find((url) => url.includes(part))!;
    await Bun.sleep(10);
    await writeFile(
      path.join(dir, "about.marko"),
      "<h1>About</h1>\n<p>Changed</p>\n",
    );
    await waitFor(async () =>
      (await (await get("/about")).text()).includes("Changed"),
    );

    const after = server.bundler.assets;
    const unchanged = find(before, "index.client-entry");
    expect(after.get(unchanged)!.updated).toBe(before.get(unchanged)!.updated);
    const changed = find(after, "about.server-entry");
    expect(before.has(changed)).toBe(false);
    expect(after.get(changed)!.updated.getTime()).toBeGreaterThan(
      before.get(find(before, "about.server-entry"))!.updated.getTime(),
    );
  });

  test("keeps unchanged server modules across builds", async () => {
    const index = path.join(dir, "index.marko");
    const about = path.join(dir, "about.marko");
    const before = server.bundler.pages.get(index)!.template;
    await writeFile(about, "<h1>About</h1>\n<p>Changed again</p>\n");
    await waitFor(async () =>
      (await (await get("/about")).text()).includes("Changed again"),
    );
    // The page that did not change was not loaded again.
    expect(server.bundler.pages.get(index)!.template).toBe(before!);
  });
});

describe("watching", () => {
  let dir: string;
  let server: ServeDir;
  const get = (pathname: string, init?: RequestInit) =>
    fetch(server.url + pathname, { redirect: "manual", ...init });

  beforeAll(async () => {
    dir = await createSite();
    server = await start(dir);
  });
  afterAll(() => server.stop());

  test("rebundles when a dependency changes", async () => {
    await writeFile(
      path.join(dir, "greeting.js"),
      "export const greeting = (name) => `Changed ${name}`;\n",
    );
    await waitFor(async () =>
      (await (await get("/")).text()).includes("<h1>Changed svdr</h1>"),
    );
  });

  test("picks up added and removed pages", async () => {
    const file = path.join(dir, "added.marko");
    await writeFile(file, "<p>Added</p>\n");
    await waitFor(async () => (await get("/added.marko")).status === 200);
    expect(await (await get("/added")).text()).toContain("<p>Added</p>");

    await rm(file);
    await waitFor(async () => !server.bundler.pages.has(file));
    expect((await get("/added.marko")).status).toBe(404);
  });
});

test("keeps serving the last working build while bundling fails", async () => {
  const dir = await createSite();
  const errors: string[] = [];
  const server = await start(
    dir,
    {},
    { info() {}, error: (message) => errors.push(message) },
  );
  const get = (pathname: string) => fetch(server.url + pathname);
  const text = async (pathname: string) => (await get(pathname)).text();

  try {
    const index = await text("/");
    const assets = Array.from(
      index.matchAll(/(?:href|src)="(\/_svdr\/[^"]+)"/g),
      (match) => match[1]!,
    );
    expect(assets.length).toBeGreaterThan(0);

    await writeFile(path.join(dir, "about.marko"), "<h1>Broken ${");
    await writeFile(path.join(dir, "new.marko"), "<p>New</p>\n");
    await waitFor(async () => errors.length > 0);
    expect(errors[0]).toContain("Bundling failed, still serving");

    // Pages of the last working build are served as they were...
    expect(await text("/about")).toContain("<h1>About</h1>");
    expect(await text("/")).toBe(index);
    for (const url of assets) expect((await get(url)).status).toBe(200);
    // ...while a page that has never been bundled can only show the error.
    const added = await get("/new");
    expect(added.status).toBe(500);
    expect(await added.text()).toContain("Error bundling new.marko");

    await writeFile(path.join(dir, "about.marko"), "<h1>Fixed</h1>\n");
    await waitFor(async () =>
      (await text("/about")).includes("<h1>Fixed</h1>"),
    );
    expect(await text("/new")).toContain("<p>New</p>");
  } finally {
    await server.stop();
  }
});

test("shows the error when the first build fails", async () => {
  const dir = await createSite();
  await writeFile(path.join(dir, "about.marko"), "<h1>Broken ${");
  const server = await start(dir);
  try {
    const res = await fetch(server.url + "/");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Error bundling index.marko");
    expect((await fetch(server.url + "/assets/hello.txt")).status).toBe(200);
  } finally {
    await server.stop();
  }
});

describe("live reload", () => {
  let dir: string;
  let server: ServeDir;
  let socket: WebSocket;
  let received: WsMessage[] = [];
  const text = async (pathname: string) =>
    (await fetch(server.url + pathname)).text();
  /** Waits for the message of the next change, which must be the only one. */
  const message = async () => {
    await waitFor(async () => received.length > 0);
    // Give messages that should not have been sent a chance to arrive.
    await Bun.sleep(150);
    const messages = received;
    received = [];
    expect(messages).toHaveLength(1);
    return messages[0]!;
  };

  beforeAll(async () => {
    dir = await createSite();
    server = await start(dir);
    socket = new WebSocket(server.url.replace("http", "ws") + "/_svdr/ws");
    socket.onmessage = (event) => received.push(JSON.parse(event.data));
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
  });
  afterAll(async () => {
    socket.close();
    await server.stop();
  });

  const tag = `<script type="module" src="${wsScriptUrl}"></script>`;

  test("adds its script to every page", async () => {
    expect(await text("/")).toContain(tag);
    expect(await text("/about")).toContain(tag);

    const script = await fetch(server.url + wsScriptUrl);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toStartWith("text/javascript");
    expect(await script.text()).toContain("new WebSocket");
    // It is not a bundled file.
    expect(await text("/_svdr/")).not.toContain("ws.js");
    expect((await fetch(server.url + "/_svdr/ws")).status).toBe(426);
  });

  test("appends its script to html files", async () => {
    const html = "<!doctype html>\n<title>Plain</title>\n<p>Plain</p>\n";
    await writeFile(path.join(dir, "plain.html"), html);
    await Bun.sleep(150);
    received = [];

    const res = await fetch(server.url + "/plain");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(await res.text()).toBe(`${html}\n${tag}\n`);
    expect(res.headers.get("content-length")).toBe(
      String(Buffer.byteLength(`${html}\n${tag}\n`)),
    );

    const etag = res.headers.get("etag")!;
    const fresh = await fetch(server.url + "/plain.html", {
      headers: { "if-none-match": etag },
    });
    expect(fresh.status).toBe(304);
    // A page that is served differently is a different response.
    const plain = await start(dir, { hot: false });
    try {
      const asIs = await fetch(plain.url + "/plain.html");
      expect(await asIs.text()).toBe(html);
      expect(asIs.headers.get("etag")).not.toBe(etag);
    } finally {
      await plain.stop();
    }
  });

  test("swaps bundled stylesheets when only styles changed", async () => {
    const before = bundledUrls(await text("/")).filter((url) =>
      url.endsWith(".css"),
    );
    const file = path.join(dir, "index.marko");
    await writeFile(
      file,
      (await Bun.file(file).text()).replace("rebeccapurple", "seagreen"),
    );

    const update = await message();
    if (update.type !== "styles") throw new Error(`Got ${update.type}`);
    expect(update.files).toEqual([]);
    expect(update.styles).toHaveLength(1);
    const [from, to] = update.styles[0]!;
    expect(before).toContain(from);
    expect(to).not.toBe(from);
    expect(await text(to)).toContain("seagreen");
    // The page now links the new stylesheet in place of the old one.
    const after = bundledUrls(await text("/"));
    expect(after).toContain(to);
    expect(after).not.toContain(from);
  });

  test("swaps stylesheets that are served as they are", async () => {
    await writeFile(path.join(dir, "assets/site.css"), "body { margin: 0 }\n");
    expect(await message()).toEqual({
      type: "styles",
      styles: [],
      files: ["/assets/site.css"],
    });
  });

  test("reloads when a page changed", async () => {
    await writeFile(
      path.join(dir, "greeting.js"),
      "export const greeting = (name) => `Changed ${name}`;\n",
    );
    expect(await message()).toEqual({ type: "reload" });
    expect(await text("/")).toContain("<h1>Changed svdr</h1>");
  });

  test("reloads when a file that is served as it is changed", async () => {
    await writeFile(path.join(dir, "assets/hello.txt"), "Changed\n");
    expect(await message()).toEqual({ type: "reload" });
  });

  test("does nothing when nothing a page shows changed", async () => {
    // Written again as it was, in a tags directory, hidden and removed.
    const file = path.join(dir, "about.marko");
    await writeFile(file, await Bun.file(file).text());
    await writeFile(path.join(dir, "tags/note.txt"), "note");
    await writeFile(path.join(dir, ".hidden"), "hidden");
    await rm(path.join(dir, "assets/hello.txt"));
    await Bun.sleep(400);
    await server.bundler.settled;
    expect(received).toEqual([]);
  });

  test("reports a failed build without reloading", async () => {
    const file = path.join(dir, "about.marko");
    const source = await Bun.file(file).text();
    await writeFile(file, "<h1>Broken ${");
    const failed = await message();
    if (failed.type !== "error") throw new Error(`Got ${failed.type}`);
    expect(failed.message).toContain("Bundling failed");

    // Fixing it gets back to what the page already shows.
    await writeFile(file, source);
    await Bun.sleep(400);
    await server.bundler.settled;
    expect(received).toEqual([]);
  });
});

test("live reload can be turned off, and on in production", async () => {
  const dir = await createSite();
  const tag = `<script type="module" src="${wsScriptUrl}"></script>`;

  for (const prod of [false, true]) {
    const off = await start(dir, { prod, hot: false });
    try {
      expect(await (await fetch(off.url + "/")).text()).not.toContain(
        "/_svdr/ws",
      );
      expect((await fetch(off.url + wsScriptUrl)).status).toBe(404);
      expect((await fetch(off.url + "/_svdr/ws")).status).toBe(404);
    } finally {
      await off.stop();
    }

    const on = await start(dir, { prod, hot: true });
    try {
      expect(await (await fetch(on.url + "/")).text()).toContain(tag);
      expect((await fetch(on.url + wsScriptUrl)).status).toBe(200);
      expect((await fetch(on.url + "/_svdr/ws")).status).toBe(426);
    } finally {
      await on.stop();
    }
  }
});

test("fails when the port is taken", async () => {
  const dir = await createSite();
  const server = await start(dir);
  try {
    const port = Number(new URL(server.url).port);
    expect(start(dir, { port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await server.stop();
  }
});

test("serves HTTPS with a generated certificate and HTTP/2", async () => {
  const dir = await createSite();
  const cacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(dir, ".cache");
  const server = await start(dir, { http: false, compression: [] });
  try {
    expect(server.url).toStartWith("https://");
    const res = await fetch(server.url + "/assets/site.css", {
      tls: { rejectUnauthorized: false },
      protocol: "http2",
      headers: { "accept-encoding": "br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toContain("font-family");
  } finally {
    await server.stop();
    if (cacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = cacheHome;
  }
});

test("only uses the configured extensions", async () => {
  const dir = await createSite();
  await writeFile(path.join(dir, "index.html"), "html index");
  await writeFile(path.join(dir, "page.htm"), "htm page");
  const server = await start(dir, { extensions: ["htm", "html"] });
  try {
    expect(await (await fetch(server.url + "/")).text()).toStartWith(
      "html index",
    );
    expect(await (await fetch(server.url + "/page")).text()).toStartWith(
      "htm page",
    );
    expect((await fetch(server.url + "/about")).status).toBe(404);
    expect((await fetch(server.url + "/about.marko")).status).toBe(200);
  } finally {
    await server.stop();
  }

  const none = await start(dir, { extensions: [] });
  try {
    expect((await fetch(none.url + "/")).status).toBe(404);
    expect((await fetch(none.url + "/page")).status).toBe(404);
    expect((await fetch(none.url + "/page.htm")).status).toBe(200);
  } finally {
    await none.stop();
  }
});

test("production bundles are minified and still watched", async () => {
  const dir = await createSite();
  const server = await start(dir, { prod: true });
  try {
    const html = await (await fetch(server.url + "/")).text();
    const script = /<script type="module" src="([^"]+)">/.exec(html)![1]!;
    expect((await fetch(server.url + script)).status).toBe(200);
    expect((await fetch(server.url + script + ".map")).status).toBe(404);

    expect(await (await fetch(server.url + script)).text()).not.toContain(
      "\n\t",
    );

    await writeFile(path.join(dir, "added.marko"), "<p>Added</p>\n");
    await waitFor(
      async () => (await fetch(server.url + "/added.marko")).status === 200,
    );
  } finally {
    await server.stop();
  }
});
