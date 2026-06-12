// ============================================================
// Tab Tree History - side panel script
// ============================================================

let activeTabId = null;

const treeContainer = document.getElementById("treeContainer");
const emptyState = document.getElementById("emptyState");
const tabLabel = document.getElementById("tabLabel");
const tooltip = document.getElementById("tooltip");
const tooltipTitle = document.getElementById("tooltipTitle");
const tooltipUrl = document.getElementById("tooltipUrl");

// ---- ファビコン取得(MV3 の _favicon API) ----
function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", "32");
  return u.toString();
}

// ---- ツリー描画 ----
async function refresh() {
  if (activeTabId == null) return;

  const [{ tree }, tab] = await Promise.all([
    chrome.runtime.sendMessage({ type: "getTree", tabId: activeTabId }),
    chrome.tabs.get(activeTabId).catch(() => null),
  ]);

  tabLabel.textContent = tab ? tab.title || tab.url || "" : "";

  // 既存ツリーを除去
  treeContainer.querySelectorAll("ul.tree, .inherit-head").forEach((el) => el.remove());

  if (!tree || !tree.rootId) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const root = tree.nodes[tree.rootId];

  // 親タブから継承している場合は先頭に点線注釈を置く
  if (root && root.inheritedFrom) {
    const head = document.createElement("div");
    head.className = "inherit-head";
    const line = document.createElement("div");
    line.className = "inherit-line";
    const label = document.createElement("span");
    label.className = "inherit-label";
    label.textContent = "親タブから";
    label.title = "クリックで親タブへ移動";
    label.addEventListener("click", () => {
      chrome.tabs.update(root.inheritedFrom.tabId, { active: true }).catch(() => {});
    });
    head.append(line, label);
    treeContainer.appendChild(head);
  }

  const ul = document.createElement("ul");
  ul.className = "tree";
  ul.appendChild(renderNode(tree, tree.rootId));
  treeContainer.appendChild(ul);

  // 現在地ノードを視界に入れる
  const cur = treeContainer.querySelector(".node.current");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function renderNode(tree, nodeId) {
  const node = tree.nodes[nodeId];
  const li = document.createElement("li");

  const btn = document.createElement("button");
  btn.className = "node";
  btn.dataset.nodeId = node.id;
  if (node.id === tree.currentNodeId) btn.classList.add("current");
  if (node.spawnedTabId != null) {
    btn.classList.add("spawned");
    li.classList.add("spawn-branch");
  }

  const img = document.createElement("img");
  img.src = faviconUrl(node.url);
  img.alt = "";
  btn.appendChild(img);

  // ホバーでタイトル表示
  btn.addEventListener("mouseenter", (e) => showTooltip(e, node));
  btn.addEventListener("mousemove", (e) => moveTooltip(e));
  btn.addEventListener("mouseleave", hideTooltip);

  // クリック動作
  btn.addEventListener("click", () => {
    hideTooltip();
    if (node.spawnedTabId != null) {
      // 子タブ分岐ノード → その子タブをアクティブにする
      chrome.tabs.update(node.spawnedTabId, { active: true }).catch(() => {
        // 子タブが既に閉じられている場合は通常ジャンプ
        chrome.runtime.sendMessage({
          type: "jumpToNode",
          tabId: activeTabId,
          nodeId: node.id,
        });
      });
    } else {
      chrome.runtime.sendMessage({
        type: "jumpToNode",
        tabId: activeTabId,
        nodeId: node.id,
      });
    }
  });

  li.appendChild(btn);

  // 子タブ分岐は下に消えていく点線を描く(子の中身は子タブ側ツリーにある)
  if (node.spawnedTabId != null) {
    const tail = document.createElement("div");
    tail.className = "spawn-tail";
    li.appendChild(tail);
  }

  if (node.children.length > 0) {
    const ul = document.createElement("ul");
    for (const childId of node.children) {
      ul.appendChild(renderNode(tree, childId));
    }
    li.appendChild(ul);
  }

  return li;
}

// ---- ツールチップ ----
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

// ---- イベント ----

// 背景からの更新通知
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "treeUpdated" && msg.tabId === activeTabId) {
    refresh();
  }
});

// タブ切り替えに追従
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  refresh();
});

// ウィンドウ切り替えにも追従
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) {
    activeTabId = tab.id;
    refresh();
  }
});

// 初期化
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    refresh();
  }
})();
