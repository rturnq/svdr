import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bundler, entryPrefix, type BundlerEvent } from "../src/bundler.ts";
import { scanImports } from "../src/css.ts";
import { loadMarko } from "../src/marko.ts";

const directories: string[] = [];
afterAll(() =>
  Promise.all(
    directories.map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function site(files: Record<string, string>) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "svdr-bundle-")),
  );
  directories.push(root);
  for (const [name, code] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), code);
  }
  return root;
}

const render = async (bundler: Bundler, root: string) =>
  String(
    await bundler.pages
      .get(path.join(root, "index.marko"))!
      .template!.render({}),
  );
const cssBody = (bundler: Bundler, url: string) => {
  const asset = bundler.assets.get(url);
  expect(asset?.type).toBe("text/css; charset=utf-8");
  if (!asset || !("body" in asset)) throw new Error(`${url} is not generated`);
  return Buffer.from(asset.body).toString();
};

test("rebuilds when a package imports mapping changes or is removed", async () => {
  const root = await site({
    "package.json": JSON.stringify({
      type: "module",
      imports: { "#label": "./a.js" },
    }),
    "a.js": 'export const label = "A";',
    "b.js": 'export const label = "B";',
    "index.marko": 'import { label } from "#label";\n<p>${label}</p>',
  });
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
  });
  try {
    expect((await bundler.scan()).error).toBeUndefined();
    expect(await render(bundler, root)).toContain("<p>A</p>");
    const manifest = path.join(root, "package.json");
    await writeFile(
      manifest,
      JSON.stringify({ type: "module", imports: { "#label": "./b.js" } }),
    );
    const update = await bundler.update([manifest]);
    expect(update.build).toBeDefined();
    expect(update.build!.error).toBeUndefined();
    expect(update.bundled.has(manifest)).toBe(true);
    expect(await render(bundler, root)).toContain("<p>B</p>");
    await rm(manifest);
    expect((await bundler.update([manifest])).build?.error).toBeDefined();
  } finally {
    await bundler.close();
  }
});

for (const prod of [false, true]) {
  test(`preserves import boundaries and duplicates in ${prod ? "production" : "development"}`, async () => {
    const root = await site({
      "index.marko":
        'import "./before.css";\nimport "./remote.css";\nimport "./after.css";\n<p/>',
      "before.css": ".before { color: red }",
      "remote.css":
        '@layer base, theme; @import "https://example.com/a.css" layer(theme); @import "https://example.com/b.css"; @import "https://example.com/a.css" layer(theme); @import "./child.css" layer;',
      "child.css":
        '@import "https://example.com/child.css"; .child { color: blue !important }',
      "after.css": ".after { color: green }",
    });
    const bundler = new Bundler({ root, marko: await loadMarko(root), prod });
    try {
      expect((await bundler.scan()).error).toBeUndefined();
      const html = await render(bundler, root);
      const urls = Array.from(
        html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g),
        (match) => match[1]!,
      );
      expect(urls).toHaveLength(3);
      const [before, remote, after] = urls.map((url) => cssBody(bundler, url));
      expect(before).toContain(".before");
      expect(after).toContain(".after");
      const rules = scanImports(remote!);
      expect(rules.map((rule) => rule.target).slice(0, 3)).toEqual([
        "https://example.com/a.css",
        "https://example.com/b.css",
        "https://example.com/a.css",
      ]);
      expect(remote!.indexOf("@layer")).toBeLessThan(
        remote!.indexOf("@import"),
      );
      expect(rules[3]!.conditions).toBe("layer");
      const child = cssBody(bundler, rules[3]!.target);
      expect(child).toContain(".child");
      expect(scanImports(child)[0]!.conditions).toBe("");
      if (prod) {
        expect(remote).not.toContain("\n");
        expect(child).not.toContain("\n");
      }
      // Editing a retained child changes the entry URL and its dependency URL.
      await writeFile(
        path.join(root, "child.css"),
        '@import "https://example.com/child.css"; .child { color: purple !important }',
      );
      expect(
        (await bundler.update([path.join(root, "child.css")])).build?.error,
      ).toBeUndefined();
      const nextHtml = await render(bundler, root);
      expect(nextHtml).not.toContain(urls[1]!);
      const nextUrls = Array.from(
        nextHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/g),
        (match) => match[1]!,
      );
      const nextChild = scanImports(cssBody(bundler, nextUrls[1]!))[3]!.target;
      expect(nextChild).not.toBe(rules[3]!.target);
      expect(cssBody(bundler, nextChild)).toContain("purple");
    } finally {
      await bundler.close();
    }
  });
}

test("cyclic CSS uses the same URL for the linked entry and its back edge", async () => {
  const root = await site({
    "index.marko": 'import "./a.css";\n<p/>',
    "a.css": '@import "./b.css"; .a { color: red }',
    "b.css": '@import "https://example.com/remote.css"; @import "./a.css";',
  });
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
  });
  try {
    expect((await bundler.scan()).error).toBeUndefined();
    const html = await render(bundler, root);
    const url = /<link rel="stylesheet" href="([^"]+)"/.exec(html)![1]!;
    const childUrl = scanImports(cssBody(bundler, url))[0]!.target;
    expect(scanImports(cssBody(bundler, childUrl))[1]!.target).toBe(url);
  } finally {
    await bundler.close();
  }
});

test("waits for a page's first build, and not for later ones", async () => {
  const root = await site({
    "index.marko": "<p>one</p>",
    "other.marko": "<p>other</p>",
  });
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
  });
  try {
    // Asked for before the scan has even found the pages.
    const scan = bundler.scan();
    const index = path.join(root, "index.marko");
    expect(bundler.pages.has(index)).toBe(false);
    const page = await bundler.page(index);
    expect(String(await page!.template!.render({}))).toContain("<p>one</p>");
    await scan;
    expect(
      await bundler.page(path.join(root, "missing.marko")),
    ).toBeUndefined();

    // A page added later is waited for too.
    const added = path.join(root, "added.marko");
    await writeFile(added, "<p>added</p>");
    const update = bundler.update([added]);
    expect((await bundler.page(added))?.template).toBeDefined();
    await update;

    // A page that was bundled before is returned as it is while it rebuilds.
    await writeFile(index, "<p>two</p>");
    const rebuild = bundler.update([index]);
    const stale = await bundler.page(index);
    expect(String(await stale!.template!.render({}))).toContain("<p>one</p>");
    await rebuild;
    expect(await render(bundler, root)).toContain("<p>two</p>");
  } finally {
    await bundler.close();
  }
});

test("reports what it bundles, why, and how it went", async () => {
  const root = await site({
    "index.marko": "<shared/>",
    "other.marko": "<shared/>",
    "alone.marko": "<p>alone</p>",
    "tags/shared.marko": "<p>shared</p>",
  });
  const events: BundlerEvent[] = [];
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
    onEvent: (event) => events.push(event),
  });
  const names = (list = events) =>
    list.map((event) =>
      "file" in event
        ? `${event.type} ${path.relative(root, event.file)}`
        : event.type,
    );
  const file = (name: string) => path.join(root, name);
  try {
    await bundler.scan();
    expect(events[0]).toEqual({
      type: "plan",
      entries: ["alone.marko", "index.marko", "other.marko"].map((name) => ({
        file: file(name),
        reason: "new",
      })),
    });
    expect(names().slice(1).sort()).toEqual([
      "done",
      "entry alone.marko",
      "entry index.marko",
      "entry other.marko",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      bundled: 3,
      failed: 0,
    });

    // A shared tag: only the entries that use it, with the reason.
    events.length = 0;
    await writeFile(file("tags/shared.marko"), "<p>changed</p>");
    await bundler.update([file("tags/shared.marko")]);
    expect(events[0]).toEqual({
      type: "plan",
      entries: [
        { file: file("index.marko"), reason: "uses tags/shared.marko" },
        { file: file("other.marko"), reason: "uses tags/shared.marko" },
      ],
    });

    // A broken entry fails on its own and keeps its last working build.
    events.length = 0;
    await writeFile(file("alone.marko"), "<p>broken ${");
    await writeFile(file("other.marko"), "<p>fine</p>");
    await bundler.update([file("alone.marko"), file("other.marko")]);
    expect(events[0]).toEqual({
      type: "plan",
      entries: [
        { file: file("alone.marko"), reason: "changed" },
        { file: file("other.marko"), reason: "changed" },
      ],
    });
    const failed = events.find(
      (event) => event.type === "entry" && event.file === file("alone.marko"),
    );
    expect(failed).toMatchObject({ kept: true });
    expect((failed as { error?: Error }).error?.message).toContain(
      "alone.marko",
    );
    expect(
      events.find(
        (event) => event.type === "entry" && event.file === file("other.marko"),
      ),
    ).toMatchObject({ error: undefined, kept: false });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      bundled: 1,
      failed: 1,
    });

    // Any change retries a failed entry; a removed page is reported.
    events.length = 0;
    await rm(file("other.marko"));
    await bundler.update([file("other.marko")]);
    expect(names()).toContain("removed other.marko");
    expect(events.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      entries: [{ file: file("alone.marko"), reason: "its last build failed" }],
    });
  } finally {
    await bundler.close();
  }
});

test("reports pages that map to the same directory and serves the first", async () => {
  // Two page paths whose hashed directory is the same.
  const seen = new Map<string, string>();
  let pair: [string, string] | undefined;
  for (let i = 0; !pair; i++) {
    const name = `c${i}.marko`;
    const prefix = entryPrefix("/", `/${name}`);
    const other = seen.get(prefix);
    if (other) pair = [other, name];
    seen.set(prefix, name);
  }
  const [first, second] = pair.sort();
  const root = await site({
    [first!]: "<p>first</p>",
    [second!]: "<p>second</p>",
    "index.marko": "<p>index</p>",
  });
  const events: BundlerEvent[] = [];
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
    onEvent: (event) => events.push(event),
  });
  try {
    expect((await bundler.scan()).error).toBeUndefined();
    expect(events.filter((event) => event.type === "collision")).toEqual([
      {
        type: "collision",
        prefix: entryPrefix(root, path.join(root, first!)),
        file: path.join(root, second!),
        other: path.join(root, first!),
      },
    ]);
    // The others are unaffected; the page that lost says why.
    expect(bundler.pages.get(path.join(root, first!))?.template).toBeDefined();
    expect(
      bundler.pages.get(path.join(root, "index.marko"))?.template,
    ).toBeDefined();
    expect(
      bundler.pages.get(path.join(root, second!))?.error?.message,
    ).toContain("maps to the same directory");

    // Reported once, not with every later change...
    events.length = 0;
    await writeFile(path.join(root, "index.marko"), "<p>changed</p>");
    await bundler.update([path.join(root, "index.marko")]);
    expect(events.some((event) => event.type === "collision")).toBe(false);

    // ...and resolved when the other page goes away.
    await rm(path.join(root, first!));
    await bundler.update([path.join(root, first!)]);
    expect(bundler.pages.get(path.join(root, second!))?.template).toBeDefined();
  } finally {
    await bundler.close();
  }
});
