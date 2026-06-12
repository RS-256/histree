// ============================================================
// histree - background service worker
// Tracks each tab's browsing history as a tree.
// ============================================================

// ---- State ---------------------------------------------------
// trees: { [tabId]: Tree }
// Tree: {
//   rootId: string | null,
//   currentNodeId: string | null,   // current position
//   nodes: { [nodeId]: Node }
// }
// Node: {
//   id, url, title, parentId, children: [nodeId],
//   createdAt,
//   spawnedTabId?: number,              // node for the child tab's first page in the parent tree
//   inheritedFrom?: { tabId, nodeId }   // root inherited from the parent tab in the child tree
// }

let statePromise = null;

// Service workers can restart, so restore from storage.session each time.
function getState() {
  if (!statePromise) {
    statePromise = chrome.storage.session
      .get("trees")
      .then((res) => ({ trees: res.trees || {} }))
      .catch(() => ({ trees: {} }));
  }
  return statePromise;
}

let saveTimer = null;
function scheduleSave(state) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ trees: state.trees }).catch(() => {});
  }, 200);
}

// Pending jumps requested by the side panel: { [tabId]: { nodeId, url } }
const pendingJumps = {};
// Pending child tabs created with openerTabId: { [tabId]: { openerTabId, openerNodeId } }
const pendingChildTabs = {};

// ---- Utilities -----------------------------------------------

function newTree() {
  return { rootId: null, currentNodeId: null, nodes: {} };
}

function makeNode(url, title, parentId) {
  return {
    id: crypto.randomUUID(),
    url,
    title: title || url,
    parentId: parentId || null,
    children: [],
    createdAt: Date.now(),
  };
}

// Appends a regular node to the tree and moves the current position.
function appendNode(tree, url, title) {
  const node = makeNode(url, title, tree.currentNodeId);
  tree.nodes[node.id] = node;
  if (tree.currentNodeId) {
    tree.nodes[tree.currentNodeId].children.push(node.id);
  } else {
    tree.rootId = node.id;
  }
  tree.currentNodeId = node.id;
  return node;
}

// For back/forward navigation, find an existing node with the same URL.
// Priority: current node's ancestors -> descendants (BFS) -> entire tree.
function findNodeByUrl(tree, url) {
  const cur = tree.nodes[tree.currentNodeId];
  if (!cur) return null;

  // Walk ancestors, nearest first.
  let p = cur.parentId;
  while (p) {
    if (tree.nodes[p].url === url) return tree.nodes[p];
    p = tree.nodes[p].parentId;
  }

  // Search descendants with BFS, nearest first.
  const queue = [...cur.children];
  while (queue.length) {
    const id = queue.shift();
    const n = tree.nodes[id];
    if (!n) continue;
    if (n.url === url) return n;
    queue.push(...n.children);
  }

  // Search the entire tree.
  for (const id in tree.nodes) {
    if (tree.nodes[id].url === url) return tree.nodes[id];
  }
  return null;
}

function collectDescendantIds(tree, nodeId) {
  const descendants = [];
  const queue = [...(tree.nodes[nodeId]?.children || [])];
  while (queue.length) {
    const id = queue.shift();
    const node = tree.nodes[id];
    if (!node) continue;
    descendants.push(id);
    queue.push(...node.children);
  }
  return descendants;
}

function deleteSubtreeBelow(tree, nodeId) {
  const node = tree.nodes[nodeId];
  if (!node) return false;

  const descendants = collectDescendantIds(tree, nodeId);
  if (!descendants.length) return false;

  const deleted = new Set(descendants);
  for (const id of descendants) delete tree.nodes[id];

  node.children = [];
  if (deleted.has(tree.currentNodeId)) tree.currentNodeId = nodeId;
  return true;
}

function shouldIgnoreUrl(url) {
  if (!url) return true;
  // Do not record extension pages, devtools, and similar internal pages.
  // chrome://newtab is recorded intentionally.
  return (
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://") ||
    url.startsWith("about:blank")
  );
}

function notifyPanel(tabId) {
  chrome.runtime
    .sendMessage({ type: "treeUpdated", tabId })
    .catch(() => {}); // Ignore when the panel is closed.
}

// ---- Navigation Core -----------------------------------------

async function handleNavigation(details, { isHistoryApi = false } = {}) {
  if (details.frameId !== 0) return; // Main frame only.
  // Do not record frames while they are prerendering.
  // When the frame becomes visible, tabs.onReplaced handles it.
  if (details.documentLifecycle && details.documentLifecycle !== "active") return;
  const { tabId, url } = details;
  if (shouldIgnoreUrl(url)) return;

  const state = await getState();
  if (!state.trees[tabId]) state.trees[tabId] = newTree();
  const tree = state.trees[tabId];
  const currentNode = tree.nodes[tree.currentNodeId] || null;

  const qualifiers = details.transitionQualifiers || [];
  const transitionType = details.transitionType || "";

  // 1) Is this a jump requested by the side panel?
  const jump = pendingJumps[tabId];
  if (jump && jump.url === url) {
    delete pendingJumps[tabId];
    if (tree.nodes[jump.nodeId]) {
      tree.currentNodeId = jump.nodeId; // Move only the current marker; do not create a node.
      scheduleSave(state);
      notifyPanel(tabId);
      return;
    }
  }

  // 2) Ignore reloads and same-URL navigations.
  if (transitionType === "reload") return;
  if (currentNode && currentNode.url === url) return;

  // 3) Browser back/forward button: move the current marker to an existing node.
  if (qualifiers.includes("forward_back")) {
    const found = findNodeByUrl(tree, url);
    if (found) {
      tree.currentNodeId = found.id;
      scheduleSave(state);
      notifyPanel(tabId);
      return;
    }
    // If none is found, fall back to recording it as a regular navigation.
  }

  // 4) Is this the first navigation in a child tab opened from a parent tab?
  const childInfo = pendingChildTabs[tabId];
  if (childInfo && !tree.rootId) {
    delete pendingChildTabs[tabId];

    // Child tree side: mark the root as inherited from the parent.
    const rootNode = appendNode(tree, url, details.title);
    rootNode.inheritedFrom = {
      tabId: childInfo.openerTabId,
      nodeId: childInfo.openerNodeId,
    };

    // Parent tree side: add the child tab's first page as a branch node without moving the marker.
    const parentTree = state.trees[childInfo.openerTabId];
    if (parentTree && childInfo.openerNodeId && parentTree.nodes[childInfo.openerNodeId]) {
      const spawnNode = makeNode(url, details.title, childInfo.openerNodeId);
      spawnNode.spawnedTabId = tabId;
      parentTree.nodes[spawnNode.id] = spawnNode;
      parentTree.nodes[childInfo.openerNodeId].children.push(spawnNode.id);
      notifyPanel(childInfo.openerTabId);
    }

    scheduleSave(state);
    notifyPanel(tabId);
    return;
  }

  // 5) Regular navigation: append as a child of the current position, which may create a branch.
  //    Treat SPA History API navigations the same way.
  appendNode(tree, url, undefined);
  scheduleSave(state);
  notifyPanel(tabId);
}

// ---- Event Registration --------------------------------------

chrome.webNavigation.onCommitted.addListener((details) => {
  handleNavigation(details);
});

// SPA (history.pushState) and #hash navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  handleNavigation(details, { isHistoryApi: true });
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  handleNavigation(details, { isHistoryApi: true });
});

// Detect child tabs opened from links in a new tab.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
  const state = await getState();
  const parentTree = state.trees[tab.openerTabId];
  pendingChildTabs[tab.id] = {
    openerTabId: tab.openerTabId,
    openerNodeId: parentTree ? parentTree.currentNodeId : null,
  };
});

// Update the current node title when the tab title settles.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.title) return;
  const state = await getState();
  const tree = state.trees[tabId];
  if (!tree) return;
  const cur = tree.nodes[tree.currentNodeId];
  if (cur && cur.url === tab.url) {
    cur.title = changeInfo.title;
    scheduleSave(state);
    notifyPanel(tabId);
  }
});

// Handle tab replacement, such as Home button or NTP prerender flows that change the tab ID.
// Move the old tab's tree to the new tab ID, then append the new page as a node.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const state = await getState();
  const oldTree = state.trees[removedTabId];
  const preTree = state.trees[addedTabId]; // Tree that may have been recorded before replacement.
  delete state.trees[removedTabId];

  if (oldTree) {
    state.trees[addedTabId] = oldTree;

    // Graft pages already recorded on the replacement tab, usually a single NTP node, into the old tree.
    if (preTree && preTree.rootId) {
      let id = preTree.rootId;
      while (id) {
        const n = preTree.nodes[id];
        const cur = oldTree.nodes[oldTree.currentNodeId];
        if (!cur || cur.url !== n.url) {
          const grafted = appendNode(oldTree, n.url, n.title);
          if (n.id === preTree.currentNodeId) oldTree.currentNodeId = grafted.id;
        }
        id = n.children[0] || null;
      }
    } else {
      // If nothing has been recorded yet, append the current URL.
      const tab = await chrome.tabs.get(addedTabId).catch(() => null);
      if (tab && tab.url && !shouldIgnoreUrl(tab.url)) {
        const cur = oldTree.nodes[oldTree.currentNodeId];
        if (!cur || cur.url !== tab.url) appendNode(oldTree, tab.url, tab.title);
      }
    }
  }

  // Carry over pending state as well.
  if (pendingJumps[removedTabId]) {
    pendingJumps[addedTabId] = pendingJumps[removedTabId];
    delete pendingJumps[removedTabId];
  }
  if (pendingChildTabs[removedTabId]) {
    pendingChildTabs[addedTabId] = pendingChildTabs[removedTabId];
    delete pendingChildTabs[removedTabId];
  }

  scheduleSave(state);
  notifyPanel(addedTabId);
});

// Drop the tree when a tab closes; data is kept only for the session.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.trees[tabId]) {
    delete state.trees[tabId];
    scheduleSave(state);
  }
  delete pendingJumps[tabId];
  delete pendingChildTabs[tabId];
});

// ---- Side Panel Messaging ------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await getState();

    if (msg.type === "getTree") {
      sendResponse({ tree: state.trees[msg.tabId] || null });
      return;
    }

    if (msg.type === "jumpToNode") {
      const tree = state.trees[msg.tabId];
      const node = tree && tree.nodes[msg.nodeId];
      if (!node) {
        sendResponse({ ok: false });
        return;
      }
      if (node.url === (tree.nodes[tree.currentNodeId] || {}).url) {
        // If the URL is the same, move only the current marker.
        tree.currentNodeId = node.id;
        scheduleSave(state);
        notifyPanel(msg.tabId);
        sendResponse({ ok: true });
        return;
      }
      pendingJumps[msg.tabId] = { nodeId: node.id, url: node.url };
      await chrome.tabs.update(msg.tabId, { url: node.url });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "deleteSubtreeBelow") {
      const tree = state.trees[msg.tabId];
      if (!tree || !tree.nodes[msg.nodeId]) {
        sendResponse({ ok: false });
        return;
      }

      const changed = deleteSubtreeBelow(tree, msg.nodeId);
      if (changed) {
        scheduleSave(state);
        notifyPanel(msg.tabId);
      }
      sendResponse({ ok: true, changed });
      return;
    }

    sendResponse({});
  })();
  return true; // Async response.
});

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
