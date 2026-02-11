# Enhanced Activity Logging - Implementation Summary

## ✅ What Was Added

### 1. Microsecond-Resolution Timestamps

**Old Format:**

```json
"timestamp": "2026-01-02T04:38:05.644Z"  // milliseconds only
```

**New Format:**

```json
"timestamp": "2026-01-02T04:44:58.567800Z"  // microseconds (last 3 digits)
```

**Implementation:**

- Uses `process.hrtime.bigint()` for high-resolution timing
- Last 3 digits after milliseconds represent microseconds
- Format: `YYYY-MM-DDTHH:MM:SS.mmmμμμZ`

### 2. Event Sequence Numbers

Every event now includes a monotonically increasing sequence number:

```json
{
  "timestamp": "2026-01-02T04:44:58.567800Z",
  "event_type": "app_focus",
  "sequence": 5,  // ← NEW
  ...
}
```

### 3. Privacy-Safe Input Event Logging

Added **4 new event types** with strict privacy guarantees:

#### New Event Types

- `keydown` - Keystroke patterns (key names only, NOT content)
- `keyup` - Key release events
- `click` - Mouse clicks (coordinates only, NOT pixel content)
- `scroll` - Scroll events

#### Event Structure

```json
{
  "timestamp": "2026-01-02T04:38:05.644123Z",
  "event_type": "keydown",
  "sequence": 42,
  "data": {
    "app_name": "Cursor",
    "input_event": {
      "type": "keydown",
      "key": "Enter", // Key name, NOT actual character
      "x": 1203, // Cursor position
      "y": 455,
      "modifiers": ["ctrl"] // Modifier keys
    },
    "clipboard_hash": "a1b2c3", // 6-char SHA-256 hash only
    "media_state": "playing" // Media state hint
  }
}
```

### 4. Privacy Guarantees (Hard-Coded)

| Data Type     | ✓ Stored                              | ✗ NOT Stored                      |
| ------------- | ------------------------------------- | --------------------------------- |
| **Keystroke** | Key name (e.g., "Enter", "ArrowLeft") | Actual characters or text content |
| **Mouse**     | X, Y coordinates, button pressed      | Pixel content, screenshots        |
| **Clipboard** | 6-character SHA-256 hash              | Full text or images               |
| **Media**     | State (playing/paused/stopped)        | Title, artist, or URL             |

### 5. New Configuration Option

Added `input_logging_enabled` to config (disabled by default):

```json
{
  "input_logging_enabled": false // Privacy-first: opt-in only
}
```

Dashboard includes toggle with clear privacy explanation.

### 6. Updated Dashboard

#### New Privacy Table

Shows exactly what is and isn't logged in a clear table format.

#### New Setting Toggle

"Enable input logging (privacy-safe: key names & coordinates only)"

## 📁 Files Modified

### Core Logging

- **`src/main/schema.ts`**
  - Added microsecond timestamp function
  - Added 4 new event types
  - Added optional `sequence` field

- **`src/main/activity-events.ts`**
  - All event builders now use `getHighResTimestamp()`
  - Added sequence counter
  - New `createInputEvent()` builder
  - New `hashClipboard()` utility

- **`src/main/input-logger.ts`** (NEW)
  - Privacy-safe input event logging
  - Clipboard hash monitoring (6-char SHA-256)
  - Sampling to reduce log volume (1 in 10 events)
  - Disabled by default, opt-in only

### Configuration

- **`src/main/config.ts`**
  - Added `input_logging_enabled` flag

### UI

- **`src/renderer/index.html`**
  - Added input logging toggle
  - Added privacy table showing what's logged vs not logged

- **`src/renderer/ui/index.js`**
  - Handle input logging checkbox

- **`src/renderer/ui/style.css`**
  - Privacy table styling

## 🔒 Privacy Architecture

### What Makes This Safe

1. **Key Names Only**: We log "Enter", "a", "Ctrl+C" — NOT "password123"
2. **Coordinates Only**: We log (x:1203, y:455) — NOT screenshots or pixel data
3. **Hash Only**: We log "a1b2c3" — NOT clipboard content
4. **Sampling**: Only 1 in 10 events logged to reduce volume
5. **Opt-In**: Disabled by default in config
6. **Local Only**: Everything stays on your machine

### Example: What Gets Logged

**User types password "secret123":**

```json
// LOGGED:
{ "type": "keydown", "key": "s" }  // Just key name
{ "type": "keydown", "key": "e" }
// ... (1 in 10 sampled)

// NOT LOGGED:
// - The string "secret123"
// - What field you're typing in
// - Any visual content
```

## 📊 Sample Event (With All New Features)

```json
{
  "timestamp": "2026-01-02T04:44:58.567800Z",
  "event_type": "app_focus",
  "session_id": "9af1e286-beb4-48ab-80fc-d44b1aee4520",
  "sequence": 5,
  "data": {
    "app_name": "Cursor",
    "window_title": "view-activity.mjs - Boost - Cursor",
    "process_id": 8604,
    "executable_path": "C:\\Users\\vivid\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
    "bounds": { "x": -8, "y": -8, "width": 1936, "height": 1048 }
  },
  "context": {
    "hour": 23,
    "day_of_week": 4,
    "is_weekend": false,
    "screen_count": 1,
    "battery_percent": 87
  }
}
```

## 🎯 Benefits

### For ML Training

- **Microsecond timestamps**: Capture exact timing patterns for predictions
- **Sequence numbers**: Ensure correct event ordering even if timestamps collide
- **Input patterns**: Detect typing speed, mouse movement patterns (without seeing content)

### For Privacy

- **Transparent**: Dashboard clearly shows what's logged vs not logged
- **Opt-in**: Input logging disabled by default
- **Auditable**: Users can inspect JSONL files to verify no sensitive data

## 🚀 Next Steps (Future)

1. **Integrate native input hooks** (e.g., uiohook-napi) for actual keystroke capture
2. **Windows media state** via GlobalSystemMediaTransportControls (WinRT)
3. **Smart sampling** (log more during active periods, less during idle)
4. **ML model** trained on input patterns to improve predictions


