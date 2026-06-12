// ============================================================
// Tab Tree History - background service worker
// タブごとの訪問履歴をツリー構造で記録する
// ============================================================

// ---- 状態 ----------------------------------------------------
// trees: { [tabId]: Tree }
// Tree: {
//   rootId: string | null,
//   currentNodeId: string | null,   // ★ 現在位置
//   nodes: { [nodeId]: Node }
// }
// Node: {
//   id, url, title, parentId, children: [nodeId],
//   createdAt,
//   spawnedTabId?: number,              // 子タブの最初のページを表すノード(親ツリー側)
//   inheritedFrom?: { tabId, nodeId }   // 親タブから継承したルート(子ツリー側)
// }

let statePromise = null;

// service worker は再起動されるため、毎回 storage.session から復元する
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

// ジャンプ待ち: サイドパネルからのジャンプ要求 { [tabId]: { nodeId, url } }
const pendingJumps = {};
// 子タブ待ち: openerTabId 付きで作られたタブ { [tabId]: { openerTabId, openerNodeId } }
const pendingChildTabs = {};

// ---- ユーティリティ ------------------------------------------

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

// ツリーに通常ノードを追加して現在位置を移動する
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

// 戻る/進む時: URL が一致する既存ノードを探す
// 優先順: 現在ノードの祖先 → 子孫(BFS) → ツリー全体
function findNodeByUrl(tree, url) {
  const cur = tree.nodes[tree.currentNodeId];
  if (!cur) return null;

  // 祖先をたどる(近い順)
  let p = cur.parentId;
  while (p) {
    if (tree.nodes[p].url === url) return tree.nodes[p];
    p = tree.nodes[p].parentId;
  }

  // 子孫を BFS(近い順)
  const queue = [...cur.children];
  while (queue.length) {
    const id = queue.shift();
    const n = tree.nodes[id];
    if (!n) continue;
    if (n.url === url) return n;
    queue.push(...n.children);
  }

  // ツリー全体から
  for (const id in tree.nodes) {
    if (tree.nodes[id].url === url) return tree.nodes[id];
  }
  return null;
}

function shouldIgnoreUrl(url) {
  if (!url) return true;
  // 拡張機能ページ・devtools 等は記録しない
  // chrome://newtab は仕様どおり記録する
  return (
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://") ||
    url.startsWith("about:blank")
  );
}

function notifyPanel(tabId) {
  chrome.runtime
    .sendMessage({ type: "treeUpdated", tabId })
    .catch(() => {}); // パネルが閉じているときは無視
}

// ---- ナビゲーション処理(中核) --------------------------------

async function handleNavigation(details, { isHistoryApi = false } = {}) {
  if (details.frameId !== 0) return; // メインフレームのみ
  const { tabId, url } = details;
  if (shouldIgnoreUrl(url)) return;

  const state = await getState();
  if (!state.trees[tabId]) state.trees[tabId] = newTree();
  const tree = state.trees[tabId];
  const currentNode = tree.nodes[tree.currentNodeId] || null;

  const qualifiers = details.transitionQualifiers || [];
  const transitionType = details.transitionType || "";

  // 1) サイドパネルからのジャンプか?
  const jump = pendingJumps[tabId];
  if (jump && jump.url === url) {
    delete pendingJumps[tabId];
    if (tree.nodes[jump.nodeId]) {
      tree.currentNodeId = jump.nodeId; // ★だけ移動、ノードは作らない
      scheduleSave(state);
      notifyPanel(tabId);
      return;
    }
  }

  // 2) リロード・同一URLは無視
  if (transitionType === "reload") return;
  if (currentNode && currentNode.url === url) return;

  // 3) ブラウザの戻る/進むボタン → 既存ノードへ★を移動
  if (qualifiers.includes("forward_back")) {
    const found = findNodeByUrl(tree, url);
    if (found) {
      tree.currentNodeId = found.id;
      scheduleSave(state);
      notifyPanel(tabId);
      return;
    }
    // 見つからなければ通常遷移として記録(フォールバック)
  }

  // 4) 親タブから開かれた子タブの最初の遷移か?
  const childInfo = pendingChildTabs[tabId];
  if (childInfo && !tree.rootId) {
    delete pendingChildTabs[tabId];

    // 子ツリー側: ルートに「親から継承」の注釈を付ける
    const rootNode = appendNode(tree, url, details.title);
    rootNode.inheritedFrom = {
      tabId: childInfo.openerTabId,
      nodeId: childInfo.openerNodeId,
    };

    // 親ツリー側: 分岐ノードとして子タブの最初のページを追加(★は動かさない)
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

  // 5) 通常の遷移 → 現在位置の子として追加(分岐が発生しうる)
  //    SPA の History API 遷移も同様に扱う
  appendNode(tree, url, undefined);
  scheduleSave(state);
  notifyPanel(tabId);
}

// ---- イベント登録 --------------------------------------------

chrome.webNavigation.onCommitted.addListener((details) => {
  handleNavigation(details);
});

// SPA (history.pushState) と #ハッシュ遷移
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  handleNavigation(details, { isHistoryApi: true });
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  handleNavigation(details, { isHistoryApi: true });
});

// 子タブ(リンクを新しいタブで開く)の検知
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
  const state = await getState();
  const parentTree = state.trees[tab.openerTabId];
  pendingChildTabs[tab.id] = {
    openerTabId: tab.openerTabId,
    openerNodeId: parentTree ? parentTree.currentNodeId : null,
  };
});

// タイトル確定時に現在ノードのタイトルを更新
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

// タブが閉じられたらツリーを破棄(セッション内のみ保持)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.trees[tabId]) {
    delete state.trees[tabId];
    scheduleSave(state);
  }
  delete pendingJumps[tabId];
  delete pendingChildTabs[tabId];
});

// ---- サイドパネルとのメッセージング ---------------------------

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
        // 同じURLなら★だけ移動
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

    sendResponse({});
  })();
  return true; // 非同期レスポンス
});

// ツールバーアイコンのクリックでサイドパネルを開く
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
