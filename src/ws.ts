import { assetsPrefix } from "./bundler.ts";

/** Where pages connect to with a WebSocket to hear about changes. */
export const wsPath = `${assetsPrefix}ws`;
/** The script that makes that connection and applies the changes. */
export const wsScriptPath = `${wsPath}.js`;
/** How a page loads that script. */
export const wsScriptTag = `<script type="module" src="${wsScriptPath}"></script>`;

export type WsMessage =
  /** Something changed that the page can only pick up by loading again. */
  | { type: "reload" }
  | {
      type: "styles";
      /** Bundled stylesheets that were replaced, as pairs of the old and new URL path. */
      styles: [from: string, to: string][];
      /** URL paths of stylesheets in the served directory that changed. */
      files: string[];
    }
  | { type: "error"; message: string };

export const wsScript = `const url = new URL(${JSON.stringify(wsPath)}, location.href);
url.protocol = url.protocol.replace("http", "ws");
let lost = false;

function connect() {
  const socket = new WebSocket(url);
  socket.onopen = () => {
    // The server was restarted, so anything may have changed.
    if (lost) location.reload();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "reload":
        location.reload();
        break;
      case "styles":
        swapStyles(message);
        break;
      case "error":
        console.error("[svdr] " + message.message);
        break;
    }
  };
  socket.onclose = () => {
    lost = true;
    setTimeout(connect, 1000);
  };
}

function swapStyles({ styles, files }) {
  for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
    const current = new URL(link.href);
    if (current.origin !== location.origin) continue;
    const path = decodeURI(current.pathname);
    const replaced = styles.find(([from]) => from === path);
    if (replaced) {
      swap(link, encodeURI(replaced[1]));
    } else if (files.includes(path)) {
      // The URL stays the same, so the query is what makes the browser fetch it again.
      swap(link, current.pathname + "?v=" + Date.now());
    }
  }
}

function swap(link, href) {
  const next = link.cloneNode();
  next.href = href;
  // The old stylesheet stays until the new one is ready to avoid a flash of unstyled content.
  next.onload = next.onerror = () => link.remove();
  link.after(next);
}

connect();
`;
