# Input Logging Status - Current Implementation

## ⚠️ Current State: Clipboard Monitoring Only

### What's Actually Being Logged Right Now

**Currently Active:**

- ✅ Clipboard changes (6-char SHA-256 hash only)
- ✅ Monitored every 5 seconds
- ✅ Privacy-safe: only hash stored, not content

**Not Yet Active (Requires Native Hooks):**

- ❌ Individual keystrokes
- ❌ Mouse clicks
- ❌ Scroll events

### Why Only Clipboard?

Electron's built-in APIs provide clipboard access, but **keystroke and mouse capture require native modules** like:

- `uiohook-napi` (cross-platform input hooks)
- `node-global-key-listener` (keyboard only)
- Platform-specific APIs (Windows: SetWindowsHookEx, macOS: CGEventTap)

## 🔧 How to Enable Input Logging

### Step 1: Enable in Settings

1. Open Boost from system tray
2. Go to Settings
3. Check **"Enable input logging (privacy-safe: key names & coordinates only)"**
4. Click "Save Settings"

### Step 2: What Will Be Logged

Once enabled, the app will monitor:

**Clipboard Changes:**

```json
{
  "event_type": "keydown",
  "data": {
    "app_name": "Cursor",
    "input_event": {
      "type": "keydown",
      "key": "clipboard_change"
    },
    "clipboard_hash": "a1b2c3" // 6-char hash only
  }
}
```

## 🚀 How to Add Full Input Logging

To capture actual keystrokes and mouse events, you need to:

### Option 1: Add uiohook-napi (Recommended)

```bash
bun add uiohook-napi
```

Then wire it into `input-logger.ts`:

```typescript
import { uIOhook } from 'uiohook-napi'

// In start()
uIOhook.start()

uIOhook.on('keydown', (event) => {
  this.logKeystroke('keydown', event.keycode, [])
})

uIOhook.on('mousedown', (event) => {
  this.logClick(event.button === 1 ? 'left' : 'right', event.x, event.y)
})

uIOhook.on('wheel', (event) => {
  this.logScroll(event.x, event.y)
})
```

### Option 2: Platform-Specific Implementation

**Windows:**

- Use `SetWindowsHookEx` via `node-ffi-napi`
- Hook `WH_KEYBOARD_LL` and `WH_MOUSE_LL`

**macOS:**

- Use `CGEventTap` via native addon
- Requires accessibility permissions

## 📊 Current Data Being Collected

With input logging **ENABLED**, you're currently getting:

```bash
# Check your logs
bun run data:json

# Look for clipboard changes
bun run data:tail | grep clipboard
```

**Example Event:**

```json
{
  "timestamp": "2026-01-02T04:44:58.567800Z",
  "event_type": "keydown",
  "sequence": 42,
  "session_id": "...",
  "data": {
    "app_name": "Cursor",
    "input_event": {
      "type": "keydown",
      "key": "clipboard_change",
      "modifiers": []
    },
    "clipboard_hash": "a1b2c3"
  },
  "context": { ... }
}
```

## 🔒 Privacy Guarantees (Even With Full Logging)

| Action             | What's Logged                 | What's NOT Logged               |
| ------------------ | ----------------------------- | ------------------------------- |
| Type "password123" | Key names: "p", "a", "s", ... | The actual string "password123" |
| Copy text          | Hash: "a1b2c3"                | The actual clipboard content    |
| Click button       | Coordinates: (1203, 455)      | What's at those pixels          |
| Scroll page        | Position: (0, 500)            | Page content                    |

## 🎯 Next Steps

To get full input logging:

1. **Quick Test**: Enable input logging in settings and copy/paste some text. Check logs with `bun run data:json` to see clipboard hash changes.

2. **Full Implementation**: Install `uiohook-napi` and wire it into the input logger (see Option 1 above).

3. **Verify Privacy**: After enabling, check your logs to confirm no actual text content is being stored, only key names and hashes.

## ⚙️ Configuration

Input logging configuration in `%APPDATA%/boost-activity-collector/config.json`:

```json
{
  "input_logging_enabled": false, // Set to true to enable
  "privacy": {
    "log_window_titles": true,
    "log_executable_paths": true
  }
}
```

## 📝 File Structure

```
src/main/
├── input-logger.ts    ← Input logging implementation
├── index.ts           ← Wired up to start/stop with config
├── activity-events.ts ← Input event builders
└── schema.ts          ← Input event types in schema
```


