// The socket is served next to this script, under the same name without the
// extension. The query names the entry the page belongs to, if it has one.
const url = new URL(import.meta.url);
url.pathname = url.pathname.replace(/\.js$/, "");
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
        showError(message.message);
        break;
      case "ok":
        hideError();
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
    const path = current.pathname.split("/").map(decodeURIComponent).join("/");
    const replaced = styles.find(([from]) => from === path);
    if (replaced) {
      swap(link, replaced[1].split("/").map(encodeURIComponent).join("/"));
    } else if (files.includes(path)) {
      // The URL stays the same, so the query is what makes the browser fetch it again.
      swap(link, current.pathname + "?v=" + Date.now());
    }
  }
}

function swap(link, href) {
  const next = link.cloneNode();
  next.href = href;
  // The old stylesheet stays until the new one is ready, to avoid a flash of
  // unstyled content, and for good if the new one cannot be loaded.
  next.onload = () => link.remove();
  next.onerror = () => {
    next.remove();
    console.error("[svdr] Failed to load the stylesheet " + href);
  };
  link.after(next);
}

let toast;

function hideError() {
  toast?.remove();
  toast = undefined;
}

/**
 * Shows an error at the top of the page, over it but not in its way: it
 * takes no focus, blocks nothing around it and can be dismissed. It is built
 * in a shadow root so that the page's styles and its own do not mix.
 */
function showError(message) {
  hideError();
  const [title, ...rest] = message.split("\n");
  const element = (name, props = {}) =>
    Object.assign(document.createElement(name), props);

  const close = element("button", {
    type: "button",
    textContent: "\u00d7",
    title: "Dismiss",
    onclick: hideError,
  });
  close.setAttribute("aria-label", "Dismiss");
  const header = element("header");
  header.append(element("strong", { textContent: title }), close);
  const box = element("div", { className: "toast" });
  box.setAttribute("role", "alert");
  box.append(header, element("pre", { textContent: rest.join("\n") }));

  toast = element("div");
  toast.setAttribute("data-svdr-error", "");
  toast.attachShadow({ mode: "open" }).append(
    element("style", {
      textContent: `
:host {
  all: initial;
  position: fixed;
  top: 12px;
  left: 0;
  right: 0;
  width: fit-content;
  max-width: min(90vw, 60rem);
  margin: 0 auto;
  z-index: 2147483647;
}
.toast {
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid #b3261e;
  border-radius: 8px;
  background: #2b1113;
  color: #ffe9e9;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  font: 13px/1.4 system-ui, sans-serif;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
button {
  all: unset;
  padding: 0 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 18px;
  line-height: 1.2;
}
button:hover,
button:focus-visible {
  background: rgb(255 255 255 / 0.15);
}
pre {
  margin: 8px 0 0;
  max-height: 50vh;
  overflow: auto;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre:empty {
  display: none;
}`,
    }),
    box,
  );
  // Next to the body rather than in it, where the page renders.
  document.documentElement.append(toast);
}

connect();
