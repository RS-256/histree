# Tab Tree History

A Chrome/Edge extension that manages each tab's browsing history as a tree.
Even when navigation branches, you can return to any previous page with one click from the side panel tree.

## Installation (Development)

### Chrome
1. Open `chrome://extensions`
2. Turn on "Developer mode" in the top-right corner
3. Click "Load unpacked" and select this folder

### Edge
1. Open `edge://extensions`
2. Turn on "Developer mode" in the bottom-left corner
3. Click "Load unpacked" and select this folder

Click the toolbar icon to open the side panel.

## Behavior

- **Tree view**: Shows only the history tree for the currently active tab. The tree switches automatically when you switch tabs.
- **Nodes**: Compact favicon-only nodes. Hovering shows the title and URL in a tooltip.
- **Current position**: Shown with a blue ring and glow.
- **Jumping**: Clicking a node moves the current-position marker to that node and navigates the page there.
  Existing history is not deleted. If you navigate elsewhere after jumping, a new branch grows from that point.
- **Back/forward buttons**: Browser history button actions move the marker between existing nodes instead of creating duplicate nodes.
- **New tab inheritance**:
  - Parent tab side: Shows the child tab's first page as a purple dashed-ring node with a dotted line fading downward.
    Clicking it focuses that child tab.
  - Child tab side: Shows a dotted "From parent tab" annotation at the beginning of the tree. Clicking it moves to the parent tab.
- **New tab page**: Records `chrome://newtab` as a node.
- **Storage scope**: Kept within the browser session via `chrome.storage.session`. Closing a tab discards its tree.

## Future Work (Out of Scope)

- Collapsible child-tab trees inside the parent tab tree

## File Structure

```
manifest.json          MV3 manifest
src/
  background.js        Navigation tracking and tree management (service worker)
  sidepanel/
    sidepanel.html     Side panel UI
    sidepanel.css      Tree rendering styles
    sidepanel.js       Rendering, tab-switch tracking, and jump handling
icons/                 Extension icons
```
