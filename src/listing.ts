import { assetsPrefix, assetUrl, type EntryFiles } from "./bundler.ts";

/** Local time in the local language. */
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** The top-level index names pages and links to their isolated directories. */
export function renderEntries(entries: readonly EntryFiles[]): string {
  const rows = [...entries]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, prefix, assets }) => {
      const size = [...assets].reduce(
        (sum, [url, asset]) =>
          // What a browser loads to show the page: not the server bundle,
          // and not source maps.
          sum +
          (url.startsWith(prefix + "server/") || url.endsWith(".map")
            ? 0
            : asset.size),
        0,
      );
      return `<tr><td><a href="${Bun.escapeHTML(prefix.slice(assetsPrefix.length))}">${Bun.escapeHTML(file)}</a></td><td>${assets.size}</td><td class="size">${formatSize(size)}</td></tr>`;
    });
  return renderPage(
    "Entries",
    rows.length
      ? `<table>
<thead><tr><th>Entry</th><th>Files</th><th class="size">Client Size</th></tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table>`
      : "<p>No Marko entries found.</p>",
  );
}

/** Lists all files belonging to a single entry, including its server bundle. */
export function renderListing(
  { file, prefix, assets }: EntryFiles,
  pageUrl: string,
): string {
  const sorted = [...assets].sort(([a], [b]) => a.localeCompare(b));
  const rows = sorted.map(([url, asset]) => {
    const name = url.slice(prefix.length);
    return (
      `<tr><td><a href="${Bun.escapeHTML(assetUrl(name))}">${Bun.escapeHTML(name)}</a></td>` +
      `<td class="size">${formatSize(asset.size)}</td>` +
      `<td><time datetime="${asset.updated.toISOString()}">${dateFormat.format(asset.updated)}</time></td></tr>`
    );
  });
  return renderPage(
    file,
    `<p><a href="../">All entries</a></p>` +
      (sorted.length
        ? `<table>
<thead><tr><th>File</th><th class="size">Size</th><th>Last updated</th></tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table>`
        : "<p>No files have been bundled.</p>"),
    pageUrl,
  );
}

function renderPage(title: string, content: string, href?: string): string {
  const heading = Bun.escapeHTML(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${Bun.escapeHTML(title)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; }
th, td { padding: 0.25rem 1.5rem 0.25rem 0; text-align: left; }
th { border-bottom: 1px solid; }
.size { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>${href ? `<a href="${Bun.escapeHTML(href)}">${heading}</a>` : heading}</h1>
${content}
</body>
</html>
`;
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}
