import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { entryPrefix } from "../src/bundler.ts";
import type { WsMessage } from "../src/ws.ts";
import type { Options } from "../src/options.ts";
import { serveDir, type Logger, type ServeDir } from "../src/server.ts";

/** What the servers of the tests logged, to explain a wait that timed out. */
const logged: string[] = [];
const silent = {
  info: (message: string) => void logged.push(message),
  error: (message: string) => void logged.push(message),
};
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
  throw new Error(`Timed out. Last logged:\n${logged.slice(-25).join("\n")}`);
}

const wsScriptUrl = "/_svdr/ws.js";

/** The hash a page's directory under the assets prefix is named by. */
const entryHash = (dir: string, page: string) =>
  entryPrefix(dir, path.join(dir, page)).slice("/_svdr/".length, -1);

/** The script tag of a rendered page, which names the page's entry. */
const entryScriptTag = (dir: string, page: string) =>
  `<script type="module" src="${wsScriptUrl}?entry=${entryHash(dir, page)}"></script>`;

/** Connects the way the script of a page of the given entry does. */
async function connect(server: ServeDir, dir: string, page?: string) {
  const messages: WsMessage[] = [];
  const socket = new WebSocket(
    server.url.replace("http", "ws") +
      "/_svdr/ws" +
      (page ? `?entry=${entryHash(dir, page)}` : ""),
  );
  socket.onmessage = (event) => messages.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return { socket, messages };
}

/** The URLs of the bundled files a page links to. */
function bundledUrls(html: string) {
  return Array.from(
    html.matchAll(/(?:href|src)="(\/_svdr\/[^"]+)"/g),
    (match) => match[1]!,
  ).filter((url) => !url.startsWith(wsScriptUrl));
}

/**
 * Waits for a page to be bundled and returns its html. A page that has not
 * bundled yet, for instance because the tags it uses are still being
 * written, is served empty for its script to show the error.
 */
function rendered(
  get: (pathname: string) => Promise<Response>,
  pathname: string,
) {
  return waitFor(async () => {
    const res = await get(pathname);
    if (res.status !== 200) return false;
    const html = await res.text();
    return !/<body>\n<script[^>]*><\/script>\n<\/body>/.test(html) && html;
  });
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

  test("only serves a range of the version the client has", async () => {
    const full = await get("/assets/hello.txt");
    const lastModified = full.headers.get("last-modified")!;
    const etag = full.headers.get("etag")!;
    const ranged = (ifRange: string) =>
      get("/assets/hello.txt", {
        headers: { range: "bytes=0-2", "if-range": ifRange },
      });
    expect((await ranged(lastModified)).status).toBe(206);
    expect((await ranged(new Date(0).toUTCString())).status).toBe(200);
    // Entity tags are weak and never match.
    expect((await ranged(etag)).status).toBe(200);
  });

  test("compresses a large file as it is read from disk", async () => {
    const size = 17 * 1024 * 1024;
    await writeFile(path.join(dir, "assets/big.txt"), "a".repeat(size));
    const res = await get("/assets/big.txt", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBeNull();
    expect((await res.text()).length).toBe(size);

    const plain = await get("/assets/big.txt", {
      headers: { "accept-encoding": "identity" },
    });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("content-length")).toBe(String(size));
    await plain.body?.cancel();

    const ranged = await get("/assets/big.txt", {
      headers: { "accept-encoding": "gzip", range: "bytes=0-9" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-encoding")).toBeNull();
    expect(await ranged.text()).toBe("aaaaaaaaaa");
    await rm(path.join(dir, "assets/big.txt"));
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

  test("judges files by their own path, not the requested one", async () => {
    // A link to an excluded file is the excluded file, a link to a page is
    // the page, and a link out of the directory leads nowhere.
    await symlink(
      path.join(dir, "tags/counter.marko"),
      path.join(dir, "alias.txt"),
    );
    await symlink(path.join(dir, "index.marko"), path.join(dir, "home.txt"));
    await symlink(os.tmpdir(), path.join(dir, "outside"));
    expect((await get("/alias.txt")).status).toBe(404);
    expect(await (await get("/home.txt")).text()).toContain(
      "<h1>Hello from svdr</h1>",
    );
    expect((await get("/outside/")).status).toBe(404);

    // Where the file system ignores case, another spelling is the same file.
    const spelling = await get("/TAGS/counter.MARKO");
    expect(spelling.status).toBe(404);
    expect((await get("/.SECRET")).status).toBe(404);
    if (existsSync(path.join(dir, "INDEX.MARKO"))) {
      const page = await get("/Index.MARKO");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<h1>Hello from svdr</h1>");
      expect((await get("/ASSETS/hello.TXT")).status).toBe(200);
    } else {
      expect((await get("/Index.MARKO")).status).toBe(404);
    }
    for (const name of ["alias.txt", "home.txt", "outside"]) {
      await rm(path.join(dir, name));
    }
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

  test("serves files in tags directories, but not their templates", async () => {
    await writeFile(path.join(dir, "tags/note.txt"), "note");
    expect((await get("/tags/counter.marko")).status).toBe(404);
    expect((await get("/tags/counter")).status).toBe(404);
    expect(await (await get("/tags/note.txt")).text()).toBe("note");
    expect((await get("/tags")).status).toBe(308);
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
        .filter((url) => !url.startsWith(wsScriptUrl))
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

  test("rewrites relative references in bundled styles", async () => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(
      path.join(dir, "docs/styled.marko"),
      `<p>Styled</p>
<style>
  p { background: url(../assets/bg.svg) }
  i { background: url("img.png") }
</style>
`,
    );
    const html = await rendered(get, "/docs/styled");
    const [style] = bundledUrls(html).filter((url) => url.endsWith(".css"));
    const css = await (await get(style!)).text();
    expect(css).toContain("url(/assets/bg.svg)");
    expect(css).toContain('url("/docs/img.png")');
  });

  test("keeps each page's cascade order when other pages change", async () => {
    for (const name of ["ta", "tb", "tc"]) {
      await writeFile(
        path.join(dir, `tags/${name}.marko`),
        `<span class="${name}">${name}</span>\n<style>\n  .m { color: ${name}; }\n</style>\n`,
      );
    }
    const order = async (pathname: string) => {
      const html = await rendered(get, pathname);
      const sheets = bundledUrls(html).filter((url) => url.endsWith(".css"));
      const css = (
        await Promise.all(sheets.map(async (url) => (await get(url)).text()))
      ).join("\n");
      return ["ta", "tb", "tc"]
        .map((name) => [name, css.indexOf(`color: ${name}`)] as const)
        .filter(([, index]) => index >= 0)
        .sort((a, b) => a[1] - b[1])
        .map(([name]) => name);
    };
    const removed = async (file: string) => {
      await rm(path.join(dir, file));
      await waitFor(
        async () => !server.bundler.pages.has(path.join(dir, file)),
      );
    };

    // The order a page gets on its own is the order it keeps when another
    // page uses some of the same source stylesheets.
    await writeFile(path.join(dir, "one.marko"), "<ta/>\n<tc/>\n<tb/>\n");
    const alone = await order("/one");
    expect(alone).toHaveLength(3);
    await writeFile(path.join(dir, "two.marko"), "<ta/>\n<tb/>\n");
    await rendered(get, "/two");
    expect(await order("/one")).toEqual(alone);
    const together = await order("/two");
    expect(together).toHaveLength(2);
    await removed("one.marko");
    expect(await order("/two")).toEqual(together);

    await removed("two.marko");
    for (const name of ["ta", "tb", "tc"]) {
      await rm(path.join(dir, `tags/${name}.marko`));
    }
  });

  test("writes the styles of a dynamically imported template with the page", async () => {
    await writeFile(
      path.join(dir, "tags/lazy-tag.marko"),
      '<span class="lazy">lazy</span>\n<style>\n  .lazy { color: lazyblue; }\n</style>\n',
    );
    // One page loads the template lazily through Marko...
    await writeFile(
      path.join(dir, "lazy-a.marko"),
      'import LazyTag from "./tags/lazy-tag.marko" with { load: "idle" };\n<LazyTag/>\n',
    );
    // ...and another through an ordinary dynamic import.
    await writeFile(
      path.join(dir, "later.js"),
      'export const later = () => import("./tags/lazy-tag.marko");\n',
    );
    await writeFile(
      path.join(dir, "lazy-b.marko"),
      'import { later } from "./later.js";\n<button onClick() { later(); }>later</button>\n',
    );
    const html = await rendered(get, "/lazy-b");
    const sheets = bundledUrls(html).filter((url) => url.endsWith(".css"));
    const css = (
      await Promise.all(sheets.map(async (url) => (await get(url)).text()))
    ).join("\n");
    expect(css).toContain("lazyblue");
    await Promise.all(
      ["lazy-a.marko", "lazy-b.marko", "later.js", "tags/lazy-tag.marko"].map(
        (file) => rm(path.join(dir, file)),
      ),
    );
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "lazy-b.marko")),
    );
  });

  test("links stylesheets of pages with unusual names", async () => {
    await writeFile(
      path.join(dir, "hash#page.marko"),
      "<p>Hash</p>\n<style>\n  p { color: hashred; }\n</style>\n",
    );
    const html = await rendered(get, "/hash%23page");
    const [href] = Array.from(
      html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g),
      (match) => match[1]!,
    );
    expect(href).toContain("%23");
    expect(await (await get(href!)).text()).toContain("hashred");
    await rm(path.join(dir, "hash#page.marko"));
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "hash#page.marko")),
    );
  });

  test("supports CSS modules in style blocks and files", async () => {
    await writeFile(
      path.join(dir, "shared.module.css"),
      ".shared { color: sharedgreen }\n",
    );
    await writeFile(
      path.join(dir, "modules.marko"),
      `import shared from "./shared.module.css";
<style/s>
  .box { color: boxred }
  .big { composes: box; font-size: 2em }
</style>
<div class=s.box>box</div>
<div class=s.big>big</div>
<div class=shared.shared>shared</div>
`,
    );
    const html = await rendered(get, "/modules");
    const classes = Array.from(
      html.matchAll(/<div class="?([^">]+)"?>/g),
      (match) => match[1]!,
    );
    expect(classes).toHaveLength(3);
    const [box, big, shared] = classes as [string, string, string];
    // Names are unique, and composed names come along.
    expect(box).not.toBe("box");
    expect(box).toMatch(/box$/);
    expect(big.split(" ")).toEqual([expect.stringMatching(/big$/), box]);
    expect(shared).toMatch(/shared$/);
    // The stylesheets use the same names.
    const sheets = bundledUrls(html).filter((url) => url.endsWith(".css"));
    const css = (
      await Promise.all(sheets.map(async (url) => (await get(url)).text()))
    ).join("\n");
    expect(css).toContain(`.${box} {`);
    expect(css).toContain(`.${shared} {`);
    expect(css).toContain("boxred");
    expect(css).toContain("sharedgreen");
    await rm(path.join(dir, "modules.marko"));
    await rm(path.join(dir, "shared.module.css"));
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "modules.marko")),
    );
  });

  test("serves the files pages refer to from disk, with ranges", async () => {
    const clip = path.join(dir, "clip.mp4");
    await writeFile(clip, "0123456789".repeat(300));
    for (const name of ["media", "media2"]) {
      await writeFile(
        path.join(dir, `${name}.marko`),
        'import clip from "./clip.mp4";\n<video src=clip/>\n',
      );
    }
    const urlOf = async (page: string) => {
      const html = await rendered(get, page);
      return /src="?(\/_svdr\/[^" >]+\.mp4)/.exec(html)![1]!;
    };
    const url = await urlOf("/media");
    const other = await urlOf("/media2");

    // Each page has the file under its own directory, and neither holds it.
    expect(other).not.toBe(url);
    for (const assetUrl of [url, other]) {
      const asset = server.bundler.assets.get(assetUrl)!;
      expect("body" in asset).toBe(false);
      expect(asset).toMatchObject({ file: clip, size: 3000 });
    }

    const full = await get(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("3000");
    expect(full.headers.get("cache-control")).toContain("immutable");
    expect((await full.text()).length).toBe(3000);

    const ranged = await get(url, { headers: { range: "bytes=10-14" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 10-14/3000");
    expect(await ranged.text()).toBe("01234");
    const fresh = await get(url, {
      headers: { "if-none-match": full.headers.get("etag")! },
    });
    expect(fresh.status).toBe(304);

    // A changed file gets a new URL; the old one stands for the old content.
    await writeFile(clip, "9876543210".repeat(300));
    const next = await waitFor(async () => {
      const current = await urlOf("/media");
      return current !== url && current;
    });
    expect((await get(url)).status).toBe(404);
    expect(await (await get(next)).text()).toStartWith("9876543210");

    for (const name of ["media.marko", "media2.marko", "clip.mp4"]) {
      await rm(path.join(dir, name));
    }
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "media2.marko")),
    );
  });

  test("compresses the compressible files pages refer to", async () => {
    await writeFile(
      path.join(dir, "assets/icon.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(300)}</svg>`,
    );
    await writeFile(
      path.join(dir, "icon.marko"),
      '<i class="icon"/>\n<style>\n  .icon { background: url(./assets/icon.svg) }\n</style>\n',
    );
    const html = await rendered(get, "/icon");
    const [sheet] = bundledUrls(html).filter((url) => url.endsWith(".css"));
    const css = await (await get(sheet!)).text();
    const icon = /url\("?(\/_svdr\/[^")]+\.svg)"?\)/.exec(css)![1]!;
    const res = await get(icon, { headers: { "accept-encoding": "br" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(await res.text()).toContain("<rect/>");
    const ranged = await get(icon, {
      headers: { "accept-encoding": "br", range: "bytes=0-3" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-encoding")).toBeNull();
    expect(await ranged.text()).toBe("<svg");
    await rm(path.join(dir, "icon.marko"));
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "icon.marko")),
    );
  });

  test("isolates chunks between pages", async () => {
    await writeFile(
      path.join(dir, "other.marko"),
      "<h1>Other</h1>\n<counter/>\n",
    );
    const other = await rendered(get, "/other");
    const index = await (await get("/")).text();
    const assets = bundledUrls;
    const shared = assets(index).filter((url) => assets(other).includes(url));

    expect(shared).toEqual([]);
    for (const url of assets(index))
      expect(url).toStartWith(entryPrefix(dir, path.join(dir, "index.marko")));
    for (const url of assets(other))
      expect(url).toStartWith(entryPrefix(dir, path.join(dir, "other.marko")));
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

  test("lists entries and their bundled files", async () => {
    const redirect = await get("/_svdr");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/_svdr/");

    const res = await get("/_svdr/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const entries = await res.text();
    const prefix = entryPrefix(dir, path.join(dir, "index.marko"));
    // The client size counts what a browser loads: no server bundle, no maps.
    const clientSize = [...server.bundler.assets]
      .filter(
        ([url]) =>
          url.startsWith(prefix) &&
          !url.startsWith(prefix + "server/") &&
          !url.endsWith(".map"),
      )
      .reduce((sum, [, asset]) => sum + asset.size, 0);
    expect(
      [...server.bundler.assets.keys()].some(
        (url) => url.startsWith(prefix) && url.endsWith(".map"),
      ),
    ).toBe(true);
    expect(entries).toContain(
      `<td class="size">${(clientSize / 1024).toFixed(1)} kB</td>`,
    );
    expect(entries).toContain(
      `href="${prefix.slice("/_svdr/".length)}">index.marko</a>`,
    );
    const listing = await (await get(prefix)).text();
    const rows = Array.from(
      listing.matchAll(
        /<a href="([^"]+)">([^<]+)<\/a><\/td><td class="size">([^<]+)<\/td><td><time datetime="([^"]+)">/g,
      ),
      ([, href, name, size, updated]) => ({ href, name, size, updated }),
    );
    // Links are relative to the listing and named by that same path.
    expect(rows.map((row) => prefix + row.href)).toEqual(
      [...server.bundler.assets.keys()]
        .filter((url) => url.startsWith(prefix))
        .sort(),
    );
    for (const row of rows) {
      expect(row.name).toBe(row.href!);
      expect(row.size).toMatch(/^[\d.]+ k?B$/);
      expect(Date.parse(row.updated!)).not.toBeNaN();
      expect((await get(prefix + row.href)).status).toBe(200);
    }

    // Everything a page links to is listed, as are the server only files.
    const html = await (await get("/")).text();
    for (const url of bundledUrls(html)) {
      expect(rows.map((row) => prefix + row.href)).toContain(url);
    }
    const serverFiles = rows.filter((row) => row.href!.startsWith("server/"));
    expect(
      serverFiles.some((row) =>
        /^server\/index\.server-entry-.+\.js$/.test(row.href!),
      ),
    ).toBe(true);
    const serverEntry = await get(prefix + serverFiles[0]!.href);
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
      expect(asset.size).toBeGreaterThan(0);
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

  test("bundles stylesheets named by convention and follows their changes", async () => {
    await mkdir(path.join(dir, "tags/card"), { recursive: true });
    await writeFile(
      path.join(dir, "tags/card/index.marko"),
      '<div class="card"><${input.content}/></div>\n',
    );
    await writeFile(
      path.join(dir, "tags/card/style.css"),
      ".card { border: 1px solid }\n",
    );
    await writeFile(path.join(dir, "conv.marko"), "<card>hi</card>\n");
    const styles = async () => {
      const html = await rendered(get, "/conv");
      const sheets = bundledUrls(html).filter((url) => url.endsWith(".css"));
      return (
        await Promise.all(sheets.map(async (url) => (await get(url)).text()))
      ).join("\n");
    };
    // `style.css` in a tag directory...
    expect(await styles()).toContain("border: 1px solid");
    // ...is followed when it changes...
    await writeFile(
      path.join(dir, "tags/card/style.css"),
      ".card { border: 2px solid }\n",
    );
    await waitFor(async () => (await styles()).includes("border: 2px solid"));
    // ...and `<name>.style.css` is picked up when it appears.
    await writeFile(path.join(dir, "conv.style.css"), "body { margin: 0 }\n");
    await waitFor(async () => (await styles()).includes("margin: 0"));
    await rm(path.join(dir, "conv.style.css"));
    await waitFor(async () => !(await styles()).includes("margin: 0"));
  });

  test("inlines imported stylesheets and follows their changes", async () => {
    await mkdir(path.join(dir, "styles"), { recursive: true });
    await writeFile(
      path.join(dir, "styles/theme.css"),
      ".theme { color: themeblue }\n",
    );
    await writeFile(
      path.join(dir, "imports.marko"),
      '<p class="theme">t</p>\n<style>\n  @import "./styles/theme.css";\n  p { margin: 0 }\n</style>\n',
    );
    const styles = async () => {
      const html = await rendered(get, "/imports");
      const sheets = bundledUrls(html).filter((url) => url.endsWith(".css"));
      return (
        await Promise.all(sheets.map(async (url) => (await get(url)).text()))
      ).join("\n");
    };
    const css = await styles();
    expect(css).toContain("themeblue");
    expect(css).not.toContain("@import");
    await writeFile(
      path.join(dir, "styles/theme.css"),
      ".theme { color: themegreen }\n",
    );
    await waitFor(async () => (await styles()).includes("themegreen"));
    await rm(path.join(dir, "imports.marko"));
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "imports.marko")),
    );
  });

  test("combines stylesheets with their remote imports first", async () => {
    await writeFile(
      path.join(dir, "tags/first.marko"),
      "<i>f</i>\n<style>\n  .first { color: red }\n</style>\n",
    );
    await writeFile(
      path.join(dir, "tags/second.marko"),
      '<b>s</b>\n<style>\n  @import "https://fonts.example/f.css";\n  .second { color: blue }\n</style>\n',
    );
    await writeFile(path.join(dir, "remote.marko"), "<first/>\n<second/>\n");
    const html = await rendered(get, "/remote");
    for (const url of bundledUrls(html).filter((u) => u.endsWith(".css"))) {
      const css = await (await get(url)).text();
      const imports = css.match(/@import/g) ?? [];
      if (imports.length) {
        expect(css.trimStart().startsWith("@import")).toBe(true);
        expect(css.indexOf("@import")).toBeLessThan(css.indexOf("{"));
      }
    }
    await rm(path.join(dir, "remote.marko"));
    await rm(path.join(dir, "tags/first.marko"));
    await rm(path.join(dir, "tags/second.marko"));
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "remote.marko")),
    );
  });

  test("serves files that package stylesheets refer to", async () => {
    await mkdir(path.join(dir, "node_modules/fonts"), { recursive: true });
    await writeFile(
      path.join(dir, "node_modules/fonts/package.json"),
      '{ "name": "fonts", "style": "fonts.css" }',
    );
    await writeFile(
      path.join(dir, "node_modules/fonts/fonts.css"),
      '@font-face { font-family: F; src: url(./f.woff2) format("woff2") }\n',
    );
    await writeFile(path.join(dir, "node_modules/fonts/f.woff2"), "woff2");
    await writeFile(
      path.join(dir, "fonts.marko"),
      '<p>f</p>\n<style>\n  @import "fonts";\n</style>\n',
    );
    const html = await rendered(get, "/fonts");
    const [sheet] = bundledUrls(html).filter((u) => u.endsWith(".css"));
    const css = await (await get(sheet!)).text();
    const [, font] =
      /url\("?(\/_svdr\/[A-Za-z0-9_-]{5}\/assets\/f-[^")]+\.woff2)"?\)/.exec(
        css,
      ) ?? [];
    expect(font).toBeDefined();
    const res = await get(font!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("woff2");
    expect(
      await (await get(entryPrefix(dir, path.join(dir, "fonts.marko")))).text(),
    ).toContain("assets/f-");
    await rm(path.join(dir, "fonts.marko"));
    await rm(path.join(dir, "node_modules"), { recursive: true });
    await waitFor(
      async () => !server.bundler.pages.has(path.join(dir, "fonts.marko")),
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
    expect(errors[0]).toContain("✗ about.marko");
    expect(errors[0]).toContain("still serving its last working build");

    // Pages of the last working build are served as they were...
    expect(await text("/about")).toContain("<h1>About</h1>");
    expect(await text("/")).toBe(index);
    for (const url of assets) expect((await get(url)).status).toBe(200);
    // ...while another entry can publish its first successful build.
    const added = await get("/new");
    expect(added.status).toBe(200);
    expect(await added.text()).toContain("<p>New</p>");

    await writeFile(path.join(dir, "about.marko"), "<h1>Fixed</h1>\n");
    await waitFor(async () =>
      (await text("/about")).includes("<h1>Fixed</h1>"),
    );
    expect(await text("/new")).toContain("<p>New</p>");
  } finally {
    await server.stop();
  }
});

test("finishes pages that render nothing", async () => {
  const dir = await createSite();
  await writeFile(path.join(dir, "empty.marko"), "<if=false>never</if>\n");
  const server = await start(dir, { hot: false });
  try {
    const res = await fetch(server.url + "/empty", {
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  } finally {
    await server.stop();
  }
});

test("does not change what the last working build links to when loading fails", async () => {
  const dir = await createSite();
  const errors: string[] = [];
  const server = await start(
    dir,
    {},
    { info() {}, error: (message) => errors.push(message) },
  );
  try {
    const before = await (await fetch(server.url + "/")).text();
    // A style change together with a dependency that no longer loads.
    const index = path.join(dir, "index.marko");
    await writeFile(
      index,
      (await Bun.file(index).text()).replace("rebeccapurple", "crimson"),
    );
    await writeFile(
      path.join(dir, "greeting.js"),
      'throw new Error("boom");\nexport const greeting = () => "";\n',
    );
    await waitFor(async () => errors.length > 0);
    const html = await (await fetch(server.url + "/")).text();
    expect(html).toBe(before);
    for (const url of bundledUrls(html)) {
      expect((await fetch(server.url + url)).status).toBe(200);
    }
  } finally {
    await server.stop();
  }
});

test("keeps the last working build when a page fails to load", async () => {
  const dir = await createSite();
  const errors: string[] = [];
  const server = await start(
    dir,
    {},
    { info() {}, error: (message) => errors.push(message) },
  );
  try {
    const before = await (await fetch(server.url + "/")).text();
    await writeFile(
      path.join(dir, "greeting.js"),
      'throw new Error("boom");\nexport const greeting = () => "";\n',
    );
    await waitFor(async () => errors.length > 0);
    expect(errors[0]).toContain("✗ index.marko");
    expect(errors[0]).toContain("still serving its last working build");
    expect(errors[0]).toContain("boom");
    expect(await (await fetch(server.url + "/")).text()).toBe(before);
  } finally {
    await server.stop();
  }
});

test("serves a page that never bundled empty, for its script to show the error", async () => {
  const dir = await createSite();
  await writeFile(path.join(dir, "about.marko"), "<h1>Broken ${");
  const server = await start(dir);
  try {
    const res = await fetch(server.url + "/about");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<title>about.marko</title>");
    expect(html).toContain(
      `<body>\n${entryScriptTag(dir, "about.marko")}\n</body>`,
    );
    // Other pages and files are not affected.
    expect(await (await fetch(server.url + "/")).text()).toContain("<h1>Hello");
    expect((await fetch(server.url + "/assets/hello.txt")).status).toBe(200);

    // The script is told the error as soon as it connects...
    const page = await connect(server, dir, "about.marko");
    try {
      await waitFor(async () => page.messages.length > 0);
      const [failed] = page.messages;
      if (failed?.type !== "error") throw new Error(`Got ${failed?.type}`);
      expect(failed.message).toStartWith("Bundling failed\n");
      expect(failed.message).toContain("<h1>Broken ${");

      // ...and to load the page once it bundles.
      await writeFile(path.join(dir, "about.marko"), "<h1>Fixed</h1>\n");
      await waitFor(async () => page.messages.length >= 3);
      expect(page.messages.slice(1)).toEqual([
        { type: "ok" },
        { type: "reload" },
      ]);
      expect(await (await fetch(server.url + "/about")).text()).toContain(
        "<h1>Fixed</h1>",
      );
    } finally {
      page.socket.close();
    }
  } finally {
    await server.stop();
  }
});

test("serves a page that fails to render empty, with the error for its script to show", async () => {
  const dir = await createSite();
  await writeFile(
    path.join(dir, "about.marko"),
    'static function fail() {\n  throw new Error("boom <now>");\n}\n<p>${fail()}</p>\n',
  );
  const lines: string[] = [];
  const log = (message: string) => lines.push(message);
  const logger = { info: log, error: log };
  const script = entryScriptTag(dir, "about.marko");

  const server = await start(dir, { hot: true }, logger);
  try {
    const res = await fetch(server.url + "/about");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain(
      '<meta name="svdr-error" content="Rendering failed\nboom &lt;now&gt;">',
    );
    expect(html).toContain(script);
    expect(lines.some((line) => line.startsWith("✗ about.marko\n"))).toBe(true);

    // The page is still told when its entry changes.
    const page = await connect(server, dir, "about.marko");
    try {
      await writeFile(path.join(dir, "about.marko"), "<h1>Fixed</h1>\n");
      await waitFor(async () => page.messages.length >= 1);
      expect(page.messages).toEqual([{ type: "reload" }]);
    } finally {
      page.socket.close();
    }
  } finally {
    await server.stop();
  }

  await writeFile(
    path.join(dir, "about.marko"),
    'static function fail() {\n  throw new Error("boom");\n}\n<p>${fail()}</p>\n',
  );
  const off = await start(dir, { hot: false }, logger);
  try {
    const res = await fetch(off.url + "/about");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Error rendering about.marko\n\nboom");
  } finally {
    await off.stop();
  }
});

test("ends a page that fails after it started rendering with the error", async () => {
  const dir = await createSite();
  await writeFile(
    path.join(dir, "about.marko"),
    'static const late = () =>\n  new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 50));\n<h1>Started</h1>\n<await|value|=late()>${value}</await>\n',
  );
  const lines: string[] = [];
  const log = (message: string) => lines.push(message);
  const server = await start(dir, { hot: true }, { info: log, error: log });
  try {
    const res = await fetch(server.url + "/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Started</h1>");
    expect(html).toEndWith(
      `\n<meta name="svdr-error" content="Rendering failed\nlate">\n${entryScriptTag(dir, "about.marko")}\n`,
    );
    expect(lines.some((line) => line.startsWith("✗ about.marko\n"))).toBe(true);
  } finally {
    await server.stop();
  }
});

test("responds with the error for a page that never bundled when there is no live reload", async () => {
  const dir = await createSite();
  await writeFile(path.join(dir, "about.marko"), "<h1>Broken ${");
  const server = await start(dir, { hot: false });
  try {
    const res = await fetch(server.url + "/about");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Error bundling about.marko");
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
    const messages = received.splice(0);
    expect(messages).toHaveLength(1);
    return messages[0]!;
  };

  beforeAll(async () => {
    dir = await createSite();
    server = await start(dir);
    // A page rendered from index.marko.
    ({ socket, messages: received } = await connect(
      server,
      dir,
      "index.marko",
    ));
  });
  afterAll(async () => {
    socket.close();
    await server.stop();
  });

  const tag = `<script type="module" src="${wsScriptUrl}"></script>`;

  test("adds its script to every page", async () => {
    expect(await text("/")).toContain(entryScriptTag(dir, "index.marko"));
    expect(await text("/about")).toContain(entryScriptTag(dir, "about.marko"));

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
    received.length = 0;

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
    // Written again as it was, hidden, under node_modules and removed.
    const file = path.join(dir, "about.marko");
    await writeFile(file, await Bun.file(file).text());
    await writeFile(path.join(dir, ".hidden"), "hidden");
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "node_modules/dep.js"), "dep");
    await rm(path.join(dir, "assets/hello.txt"));
    await Bun.sleep(400);
    await server.bundler.settled;
    expect(received).toEqual([]);
  });

  test("only tells a page about its own entry", async () => {
    // Another page that uses the same tag, and a page that does not.
    await writeFile(
      path.join(dir, "other.marko"),
      "<h1>Other</h1>\n<counter/>\n",
    );
    await waitFor(async () =>
      server.bundler.pages.has(path.join(dir, "other.marko")),
    );
    const other = await connect(server, dir, "other.marko");
    const about = await connect(server, dir, "about.marko");
    const plain = await connect(server, dir);
    try {
      received.length = 0;
      const tag = path.join(dir, "tags/counter.marko");
      await writeFile(
        tag,
        (await Bun.file(tag).text()).replace("0.5em 1em", "1em 2em"),
      );
      const forIndex = await message();
      const [forOther] = other.messages;
      for (const [update, page] of [
        [forIndex, "index.marko"],
        [forOther, "other.marko"],
      ] as const) {
        if (update?.type !== "styles") throw new Error(`Got ${update?.type}`);
        // One stylesheet changed for the page, not one for every page.
        expect(update.styles).toHaveLength(1);
        const prefix = entryPrefix(dir, path.join(dir, page));
        expect(update.styles[0]![0]).toStartWith(prefix);
        expect(update.styles[0]![1]).toStartWith(prefix);
      }
      expect(other.messages).toHaveLength(1);
      expect(about.messages).toEqual([]);
      expect(plain.messages).toEqual([]);

      // A change to one page does not reload the others.
      await writeFile(
        path.join(dir, "other.marko"),
        "<h1>Changed</h1>\n<counter/>\n",
      );
      await waitFor(async () => other.messages.length > 1);
      expect(other.messages[1]).toEqual({ type: "reload" });
      await Bun.sleep(150);
      expect(received).toEqual([]);
      expect(about.messages).toEqual([]);
    } finally {
      other.socket.close();
      about.socket.close();
      plain.socket.close();
    }
  });

  test("reports a failed build without reloading", async () => {
    const file = path.join(dir, "index.marko");
    const source = await Bun.file(file).text();
    await writeFile(file, "<h1>Broken ${");
    const failed = await message();
    if (failed.type !== "error") throw new Error(`Got ${failed.type}`);
    expect(failed.message).toContain("Bundling failed");

    // A page loaded while its entry is failing shows its last working
    // build, and is told about the error when it connects.
    expect(await text("/")).toContain("<h1>");
    const late = await connect(server, dir, "index.marko");
    await waitFor(async () => late.messages.length > 0);
    expect(late.messages).toEqual([failed]);
    late.socket.close();

    // Fixing it gets back to what the page already shows, so all there is
    // to tell the page is that the error is over.
    await writeFile(file, source);
    expect(await message()).toEqual({ type: "ok" });
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
      expect(await (await fetch(on.url + "/")).text()).toContain(
        entryScriptTag(dir, "index.marko"),
      );
      expect((await fetch(on.url + wsScriptUrl)).status).toBe(200);
      expect((await fetch(on.url + "/_svdr/ws")).status).toBe(426);
    } finally {
      await on.stop();
    }
  }
});

test("logs what changed, what is bundled because of it, and the result", async () => {
  const dir = await createSite();
  const lines: string[] = [];
  const log = (message: string) => lines.push(...message.split("\n"));
  const server = await start(dir, {}, { info: log, error: log });
  /** The lines logged for one change, up to the blank line that ends them. */
  const batch = async (change: () => Promise<void>) => {
    lines.length = 0;
    await change();
    await waitFor(async () => lines.includes(""));
    return lines
      .slice(0, lines.indexOf(""))
      .map((line) => line.replace(/\(\d+ms\)/, "(ms)"));
  };
  try {
    expect(
      lines.map((line) => line.replace(/\(\d+ms\)/, "(ms)")).sort(),
    ).toEqual([
      "  ✓ about.marko (ms)",
      "  ✓ index.marko (ms)",
      "↻ bundling 2 entries",
    ]);

    expect(
      await batch(() =>
        writeFile(
          path.join(dir, "tags/counter.marko"),
          "<button>changed</button>\n",
        ),
      ),
    ).toEqual([
      "~ tags/counter.marko",
      "↻ bundling 1 entry",
      "  ✓ index.marko (ms)",
    ]);

    const failed = await batch(() =>
      writeFile(path.join(dir, "fresh.marko"), "<p>Broken ${"),
    );
    expect(failed.slice(0, 3)).toEqual([
      "+ fresh.marko",
      "↻ bundling 1 entry",
      "  ✗ fresh.marko (ms)",
    ]);
    // The error belongs to the entry above it: where, and one code frame.
    expect(failed.slice(3)).toEqual([
      expect.stringMatching(/^  at \S*fresh\.marko:1:13$/),
      "  > 1 | <p>Broken ${",
      "      |             ^ EOF reached while parsing placeholder",
    ]);

    expect(await batch(() => rm(path.join(dir, "fresh.marko")))).toEqual([
      "- fresh.marko",
    ]);

    const broken = await batch(() =>
      writeFile(path.join(dir, "about.marko"), "<h1>Broken ${"),
    );
    expect(broken.slice(0, 3)).toEqual([
      "~ about.marko",
      "↻ bundling 1 entry",
      "  ✗ about.marko (ms), still serving its last working build",
    ]);

    // Any change retries an entry that failed, here while fixing it.
    expect(
      await batch(() =>
        writeFile(path.join(dir, "about.marko"), "<h1>About</h1>\n"),
      ),
    ).toEqual(["~ about.marko", "↻ bundling 1 entry", "  ✓ about.marko (ms)"]);

    // A file that is not part of any bundle.
    expect(
      await batch(() =>
        writeFile(path.join(dir, "assets/hello.txt"), "changed\n"),
      ),
    ).toEqual(["~ assets/hello.txt"]);

    // A page that goes away with its directory is reported as removed.
    await batch(async () => {
      await mkdir(path.join(dir, "docs"));
      await writeFile(path.join(dir, "docs/page.marko"), "<p>doc</p>\n");
    });
    // Windows reports a new file more than once, so the page may still be
    // bundling when it is removed: its removal is not always the first thing
    // logged afterwards.
    lines.length = 0;
    await rm(path.join(dir, "docs"), { recursive: true });
    await waitFor(async () => {
      const at = lines.indexOf("- docs/page.marko");
      return at !== -1 && lines.includes("", at);
    });
    expect(lines.filter((line) => line === "- docs/page.marko")).toHaveLength(
      1,
    );
  } finally {
    await server.stop();
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
  // A stylesheet with a remote import after one without must still be valid.
  await writeFile(
    path.join(dir, "tags/second.marko"),
    '<b>s</b>\n<style>\n  @import "https://fonts.example/f.css";\n  .second { color: blue }\n</style>\n',
  );
  await writeFile(path.join(dir, "about.marko"), "<counter/>\n<second/>\n");
  const server = await start(dir, { prod: true });
  try {
    const html = await (await fetch(server.url + "/")).text();
    const script = /<script type="module" src="([^"]+)">/.exec(html)![1]!;
    expect((await fetch(server.url + script)).status).toBe(200);
    expect((await fetch(server.url + script + ".map")).status).toBe(404);

    expect(await (await fetch(server.url + script)).text()).not.toContain(
      "\n\t",
    );
    const sheets = bundledUrls(html).filter((url) => url.endsWith(".css"));
    expect(sheets.length).toBeGreaterThan(0);
    for (const url of sheets) {
      const css = await (await fetch(server.url + url)).text();
      expect(css).not.toContain("\n");
      expect(css).not.toContain(": ");
    }

    await writeFile(path.join(dir, "added.marko"), "<p>Added</p>\n");
    await waitFor(
      async () => (await fetch(server.url + "/added.marko")).status === 200,
    );
  } finally {
    await server.stop();
  }
});
