// ============================================================
// histree - side panel script
// Vertical layout: linear paths go downward, branches spread horizontally.
// ============================================================

let activeTabId = null;

const treeContainer = document.getElementById("treeContainer");
const emptyState = document.getElementById("emptyState");
const tabLabel = document.getElementById("tabLabel");
const tooltip = document.getElementById("tooltip");
const tooltipTitle = document.getElementById("tooltipTitle");
const tooltipUrl = document.getElementById("tooltipUrl");

// Layout constants.
const NODE_R = 16;      // Node radius for the 32px circle.
const SLOT_W = 52;      // Horizontal width for one leaf node.
const LEVEL_H = 60;     // Vertical distance between levels.
const PAD = 20;         // Canvas padding.
const TAIL_LEN = 26;    // Length of the dotted child-tab branch tail.
const SVG_NS = "http://www.w3.org/2000/svg";

// ---- Favicon Lookup (MV3 _favicon API) ----
function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", "32");
  return u.toString();
}

// ---- Layout Calculation ----
// Calculate each subtree's required width and center parents over their children.
function layoutTree(tree) {
  const pos = {};      // nodeId -> {x, y, depth}
  let maxDepth = 0;

  function subtreeWidth(id) {
    const n = tree.nodes[id];
    if (!n.children.length) return SLOT_W;
    return n.children.reduce((sum, c) => sum + subtreeWidth(c), 0);
  }

  function assign(id, left, depth) {
    const n = tree.nodes[id];
    maxDepth = Math.max(maxDepth, depth);
    const w = subtreeWidth(id);

    if (!n.children.length) {
      pos[id] = { x: left + w / 2, depth };
      return;
    }
    let cursor = left;
    for (const c of n.children) {
      const cw = subtreeWidth(c);
      assign(c, cursor, depth + 1);
      cursor += cw;
    }
    const first = pos[n.children[0]].x;
    const last = pos[n.children[n.children.length - 1]].x;
    pos[id] = { x: (first + last) / 2, depth };
  }

  assign(tree.rootId, 0, 0);

  const width = subtreeWidth(tree.rootId) + PAD * 2;
  const height = (maxDepth + 1) * LEVEL_H + PAD * 2;
  for (const id in pos) {
    pos[id].x += PAD;
    pos[id].y = pos[id].depth * LEVEL_H + PAD + NODE_R;
  }
  return { pos, width, height };
}

// ---- Tree Rendering ----
async function refresh() {
  if (activeTabId == null) return;

  const [{ tree }, tab] = await Promise.all([
    chrome.runtime.sendMessage({ type: "getTree", tabId: activeTabId }),
    chrome.tabs.get(activeTabId).catch(() => null),
  ]);

  tabLabel.textContent = tab ? tab.title || tab.url || "" : "";
  treeContainer.querySelectorAll(".tree-canvas").forEach((el) => el.remove());

  if (!tree || !tree.rootId || !tree.nodes[tree.rootId]) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const { pos, width, height } = layoutTree(tree);
  const root = tree.nodes[tree.rootId];
  const inherited = !!root.inheritedFrom;
  const topExtra = inherited ? 34 : 0;
  const canvasH = height + topExtra + TAIL_LEN;

  const canvas = document.createElement("div");
  canvas.className = "tree-canvas";
  canvas.style.width = `${width}px`;
  canvas.style.height = `${canvasH}px`;

  // ---- SVG: Connector Line Layer ----
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", canvasH);
  svg.classList.add("edges");

  function line(x1, y1, x2, y2, cls) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("class", cls);
    svg.appendChild(l);
  }

  for (const id in pos) {
    const n = tree.nodes[id];
    const p = pos[id];
    const py = p.y + topExtra;

    // Parent-to-child connector lines.
    for (const cid of n.children) {
      const c = pos[cid];
      const child = tree.nodes[cid];
      const cls = child.spawnedTabId != null ? "edge edge-spawn" : "edge";
      line(p.x, py + NODE_R, c.x, c.y + topExtra - NODE_R, cls);
    }

    // Child tab branch node: dotted line fading downward.
    if (n.spawnedTabId != null) {
      line(p.x, py + NODE_R, p.x, py + NODE_R + TAIL_LEN, "edge edge-spawn edge-fade-down");
    }
  }

  // Root inherited from a parent tab: dotted line coming down from above.
  if (inherited) {
    const rp = pos[tree.rootId];
    line(rp.x, 6, rp.x, rp.y + topExtra - NODE_R, "edge edge-spawn edge-fade-up");
  }

  canvas.appendChild(svg);

  // ---- Node Layer ----
  for (const id in pos) {
    const n = tree.nodes[id];
    const p = pos[id];

    const btn = document.createElement("button");
    btn.className = "node";
    btn.style.left = `${p.x - NODE_R}px`;
    btn.style.top = `${p.y + topExtra - NODE_R}px`;
    if (id === tree.currentNodeId) btn.classList.add("current");
    if (n.spawnedTabId != null) btn.classList.add("spawned");

    const img = document.createElement("img");
    img.src = faviconUrl(n.url);
    img.alt = "";
    btn.appendChild(img);

    btn.addEventListener("mouseenter", (e) => showTooltip(e, n));
    btn.addEventListener("mousemove", moveTooltip);
    btn.addEventListener("mouseleave", hideTooltip);
    btn.addEventListener("click", () => onNodeClick(n));

    canvas.appendChild(btn);
  }

  // "From parent tab" label.
  if (inherited) {
    const rp = pos[tree.rootId];
    const label = document.createElement("button");
    label.className = "inherit-label";
    label.textContent = "親タブから";
    label.title = "クリックで親タブへ移動";
    label.style.left = `${rp.x + 8}px`;
    label.style.top = `4px`;
    label.addEventListener("click", () => {
      chrome.tabs.update(root.inheritedFrom.tabId, { active: true }).catch(() => {});
    });
    canvas.appendChild(label);
  }

  treeContainer.appendChild(canvas);

  // Bring the current node into view.
  const cur = canvas.querySelector(".node.current");
  if (cur) cur.scrollIntoView({ block: "nearest", inline: "center" });
}

function onNodeClick(node) {
  hideTooltip();
  if (node.spawnedTabId != null) {
    // Child tab branch node: activate that child tab.
    chrome.tabs.update(node.spawnedTabId, { active: true }).catch(() => {
      // If the child tab has already closed, perform a regular jump.
      chrome.runtime.sendMessage({
        type: "jumpToNode", tabId: activeTabId, nodeId: node.id,
      });
    });
  } else {
    chrome.runtime.sendMessage({
      type: "jumpToNode", tabId: activeTabId, nodeId: node.id,
    });
  }
}

// ---- Tooltip ----
function showTooltip(e, node) {
  tooltipTitle.textContent = node.title || node.url;
  tooltipUrl.textContent = node.url;
  tooltip.hidden = false;
  moveTooltip(e);
}
function moveTooltip(e) {
  const pad = 12;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 4) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 4) y = e.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(4, x)}px`;
  tooltip.style.top = `${Math.max(4, y)}px`;
}
function hideTooltip() {
  tooltip.hidden = true;
}

// ---- Events ----

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "treeUpdated" && msg.tabId === activeTabId) {
    refresh();
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  refresh();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) {
    activeTabId = tab.id;
    refresh();
  }
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    refresh();
  }
})();
