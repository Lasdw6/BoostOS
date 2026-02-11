# Boost - Manual Testing Guide

This guide provides a comprehensive checklist for manually testing all features of the Boost app.

## Prerequisites

Before testing, ensure you have:

- Windows OS (primary platform)
- Bun installed
- PowerShell (for workflow automation features)
- Dependencies installed: `bun install`

---

## 1. Initial Setup & Installation

### 1.1 Application Launch

- [ ] Run `bun run dev` and verify the app window opens
- [ ] Check that the system tray icon appears
- [ ] Verify the app continues running when window is closed
- [ ] Confirm the app reopens when clicking the tray icon
- [ ] Test closing the app completely via tray menu "Quit"

### 1.2 Build & Production

- [ ] Run `bun run build` and verify no TypeScript errors
- [ ] Run `bun run build:win` and verify .exe is created in `dist/`
- [ ] Install and launch the built executable
- [ ] Verify production app runs without console/dev tools

### 1.3 Initial Configuration

- [ ] Check that data directory is created: `%APPDATA%\Boost\data\`
- [ ] Verify `activity.jsonl` file is created on first run
- [ ] Check that `workflows.db` SQLite database is created

---

## 2. Activity Logging Features

### 2.1 App Focus Tracking

- [ ] Switch between different applications (browser, VSCode, etc.)
- [ ] Run `bun run data:tail` to verify events are logged
- [ ] Confirm each event has: `timestamp`, `appName`, `processId`, `type: "focus"`
- [ ] Verify executable paths are logged (if enabled in settings)
- [ ] Verify window titles are logged (if enabled in settings)

### 2.2 Idle Detection

- [ ] Leave computer idle for >30 seconds
- [ ] Check that `type: "idle"` event is logged
- [ ] Return to computer and verify `type: "active"` event is logged
- [ ] Confirm idle duration is reasonable

### 2.3 Background Logging

- [ ] Close the Boost window (should minimize to tray)
- [ ] Switch apps with window closed
- [ ] Reopen Boost and verify events were still logged
- [ ] Check CPU usage in Task Manager (should be <1%)

### 2.4 Next-App Prediction

- [ ] Establish a pattern: switch between 2 apps repeatedly (e.g., Chrome → VSCode → Chrome → VSCode)
- [ ] After 3-4 switches, check if a toast notification appears predicting the next app
- [ ] Verify prediction accuracy improves over time
- [ ] Check `predictor.ts` logs for inference timing (<100ms)

### 2.5 Privacy Controls

- [ ] Open Settings/Config in the UI
- [ ] Toggle "Log window titles" OFF
- [ ] Switch apps and verify titles are NOT in `activity.jsonl`
- [ ] Toggle "Log executable paths" OFF
- [ ] Verify paths are NOT in `activity.jsonl`
- [ ] Add an app to exclusion list (e.g., "notepad.exe")
- [ ] Verify that app's events are NOT logged

### 2.6 Data Viewing

- [ ] Run `bun run data:tail` - verify last 10 events are shown
- [ ] Run `bun run data:summary` - verify summary statistics (app usage, idle time)
- [ ] Run `bun run data:json` - verify full JSON output for last 10 events
- [ ] Check that JSONL file is valid (each line is valid JSON)

---

## 3. Workflow Automation Features

### 3.1 PowerShell Hook Installation

- [ ] Run `bun run boost install-hooks`
- [ ] Verify success message is shown
- [ ] Open new PowerShell terminal
- [ ] Run a simple command: `echo "test"`
- [ ] Verify the command was captured (check for HTTP request in console logs)
- [ ] Check `command-history.jsonl` file exists in data directory

### 3.2 Command Capture

- [ ] In PowerShell, run several commands:
  ```powershell
  cd C:\Windows
  dir
  cd ..
  echo "hello"
  ```
- [ ] Run `bun run boost status` to verify commands are being recorded
- [ ] Check `command-history.jsonl` has entries with:
  - `command` field
  - `cwd` field (working directory)
  - `timestamp`
  - `sessionId`
  - `exitCode` (0 for success)

### 3.3 Pattern Detection

- [ ] Create a repeated sequence (run 3+ times):
  ```powershell
  git status
  git add .
  git commit -m "test"
  ```
- [ ] Run `bun run boost patterns`
- [ ] Verify the sequence is detected and shown with:
  - Pattern ID
  - Commands in the sequence
  - Number of occurrences
  - Confidence score
- [ ] Try a 2-command pattern and a 5-command pattern
- [ ] Verify patterns with different working directories are treated separately

### 3.4 Workflow Creation (CLI)

You'll need to implement workflow creation from patterns, but test these once available:

- [ ] Create a workflow from a detected pattern
- [ ] Verify workflow is saved to `workflows.db`
- [ ] Run `bun run boost list` to see the workflow

### 3.5 Workflow Creation (UI)

- [ ] Open the Boost app window
- [ ] Navigate to "Workflows" tab
- [ ] Click "Create Workflow" or similar button
- [ ] Add steps manually:
  - Command: `echo "Step 1"`
  - CWD: `C:\`
  - Blocking: true
- [ ] Add a second step
- [ ] Save workflow with name: "test-workflow"
- [ ] Verify it appears in workflow list

### 3.6 Workflow Execution (CLI)

- [ ] Run `bun run boost run test-workflow`
- [ ] Verify each step executes in order
- [ ] Check console output shows step-by-step progress
- [ ] Verify exit code is 0 on success
- [ ] Check execution logs in `data/execution-logs/<workflow-name>/`

### 3.7 Workflow Execution (UI)

- [ ] In Workflows tab, click "Run" on a workflow
- [ ] Verify real-time execution status updates
- [ ] Check stdout/stderr is displayed for each step
- [ ] Verify workflow completes successfully
- [ ] Check "History" shows the execution

### 3.8 Workflow Dependencies (DAG)

- [ ] Create a workflow with dependencies:
  ```json
  Step 1: echo "Start"
  Step 2: echo "Depends on 1" (depends on Step 1)
  Step 3: echo "Also depends on 1" (depends on Step 1)
  Step 4: echo "Depends on 2 and 3" (depends on Step 2, Step 3)
  ```
- [ ] Run the workflow
- [ ] Verify execution order follows dependencies (Kahn's algorithm)
- [ ] Step 1 runs first
- [ ] Steps 2 and 3 run after Step 1 (can be parallel)
- [ ] Step 4 runs last

### 3.9 Blocking vs Non-Blocking Steps

- [ ] Create a workflow with non-blocking step:
  ```
  Step 1: notepad.exe (blocking: false)
  Step 2: echo "Continues immediately"
  ```
- [ ] Run the workflow
- [ ] Verify Step 2 runs while notepad is still open
- [ ] Close notepad manually

### 3.10 Multi-Shell Support

- [ ] Create workflows with different shell types:
  - PowerShell: `Get-Process | Select-Object -First 5`
  - CMD: `dir`
  - Bash (if WSL installed): `ls -la`
- [ ] Verify each shell executes correctly
- [ ] Check that shell type is properly detected from command syntax

### 3.11 Execution History & Logs

- [ ] Run `bun run boost logs test-workflow 10`
- [ ] Verify last 10 executions are shown with:
  - Execution timestamp
  - Status (success/failure)
  - Duration
- [ ] Check detailed logs in `data/execution-logs/<workflow-name>/`
- [ ] Verify stdout and stderr are captured separately

---

## 4. Data Persistence & File Operations

### 4.1 JSONL File Rotation

- [ ] Generate large amount of activity data (leave app running overnight or use script)
- [ ] Check file size of `activity.jsonl`
- [ ] Verify file rotates when it reaches ~50MB
- [ ] Check that old file is renamed (e.g., `activity-2025-01-21.jsonl`)
- [ ] Verify new file continues logging

### 4.2 Command History Rotation

- [ ] Record many commands in PowerShell
- [ ] Check `command-history.jsonl` file size
- [ ] Verify rotation at 50MB threshold
- [ ] Ensure old commands are preserved in rotated files

### 4.3 SQLite Database Integrity

- [ ] Create several workflows
- [ ] Close and reopen the app
- [ ] Verify workflows persist correctly
- [ ] Use SQLite viewer to inspect `workflows.db`:
  - Check `workflows` table
  - Check `workflow_steps` table
  - Check `step_dependencies` table
- [ ] Verify foreign key constraints are working

### 4.4 Batch Writing Performance

- [ ] Generate rapid events (switch apps quickly)
- [ ] Check that events are batched (10 events or 5s interval)
- [ ] Verify no events are lost
- [ ] Check that app remains responsive during writes

---

## 5. Edge Cases & Error Handling

### 5.1 Workflow Execution Errors

- [ ] Create a workflow with failing command:
  ```
  Step 1: non-existent-command
  ```
- [ ] Run the workflow
- [ ] Verify error is caught and logged
- [ ] Check that execution stops (blocking step)
- [ ] Verify clear error message in logs

### 5.2 Non-Blocking Step Failures

- [ ] Create workflow:
  ```
  Step 1: non-existent-command (blocking: false)
  Step 2: echo "Should still run"
  ```
- [ ] Run workflow
- [ ] Verify Step 2 executes despite Step 1 failure
- [ ] Check error is logged but doesn't halt execution

### 5.3 Circular Dependencies

- [ ] Try to create a workflow with circular dependency:
  ```
  Step 1 depends on Step 2
  Step 2 depends on Step 1
  ```
- [ ] Verify validation error is shown
- [ ] Workflow should not be created

### 5.4 Session Timeout

- [ ] Start PowerShell session
- [ ] Run commands to create a session
- [ ] Wait 30+ minutes
- [ ] Run another command
- [ ] Verify new session is created (different sessionId)

### 5.5 Rapid App Switching

- [ ] Switch between apps very rapidly (every 0.5s)
- [ ] Verify all switches are captured
- [ ] Check for duplicate events
- [ ] Ensure no crashes or memory leaks

### 5.6 Missing Dependencies

- [ ] Create workflow that depends on non-existent step
- [ ] Verify validation error
- [ ] Workflow should not be created or executed

### 5.7 Long-Running Commands

- [ ] Create workflow with long-running step:
  ```powershell
  Start-Sleep -Seconds 30
  ```
- [ ] Run workflow
- [ ] Verify it waits for completion
- [ ] Check timeout handling (if implemented)

### 5.8 Invalid JSONL Recovery

- [ ] Manually corrupt `activity.jsonl` (add invalid JSON line)
- [ ] Restart the app
- [ ] Verify app handles error gracefully
- [ ] Check that new events are still logged

### 5.9 Concurrent Workflow Execution

- [ ] Run two workflows simultaneously from different terminals:
  ```bash
  bun run boost run workflow1
  bun run boost run workflow2
  ```
- [ ] Verify both execute without interference
- [ ] Check logs are isolated

### 5.10 PowerShell Hook Uninstall

- [ ] Run uninstall command (if implemented)
- [ ] Verify hooks are removed from PowerShell profile
- [ ] Open new PowerShell
- [ ] Run commands and verify they're NOT captured

---

## 6. Performance Testing

### 6.1 Resource Usage

- [ ] Open Task Manager
- [ ] Run app for 1 hour with active usage
- [ ] Check CPU usage (should be <1%)
- [ ] Check memory usage (should be <100 MB)
- [ ] Verify no memory leaks over time

### 6.2 Command Capture Latency

- [ ] Run: `Measure-Command { echo "test" }`
- [ ] Verify latency is <100ms compared to without hooks
- [ ] Test with complex commands
- [ ] Ensure no noticeable slowdown

### 6.3 Prediction Latency

- [ ] Enable verbose logging for predictions
- [ ] Check logs for inference timing
- [ ] Verify <10ms with cache
- [ ] Verify <100ms without cache

### 6.4 Large Workflow Execution

- [ ] Create workflow with 50+ steps
- [ ] Run and verify all steps execute
- [ ] Check execution completes in reasonable time
- [ ] Verify logs are manageable

---

## 7. UI/UX Testing

### 7.1 Dashboard Navigation

- [ ] Test all tab navigation (Activity Logger, Workflows, Patterns)
- [ ] Verify no console errors
- [ ] Check responsive layout
- [ ] Test scrolling on long lists

### 7.2 Workflow Management UI

- [ ] Create workflow via UI
- [ ] Edit existing workflow
- [ ] Delete workflow
- [ ] Run workflow from UI
- [ ] View execution history
- [ ] Check visual feedback for all actions

### 7.3 Pattern Browsing

- [ ] View detected patterns in UI
- [ ] Sort patterns by frequency/confidence
- [ ] Create workflow from pattern
- [ ] Dismiss/ignore patterns

### 7.4 Settings/Configuration

- [ ] Access settings panel
- [ ] Toggle privacy options
- [ ] Test exclusion list (add/remove apps)
- [ ] Verify changes persist after restart

---

## 8. Cross-Platform Considerations (Future)

### 8.1 macOS (when implemented)

- [ ] Test on macOS
- [ ] Verify Bash/Zsh hooks work
- [ ] Check Apple Events API integration
- [ ] Test Accessibility API usage

### 8.2 Linux (when implemented)

- [ ] Test on Linux
- [ ] Verify Bash hooks
- [ ] Check X11/Wayland compatibility

---

## Test Result Template

For each test section, document:

```
✅ PASS / ❌ FAIL / ⚠️ PARTIAL

Section: [Section Name]
Date: [Test Date]
Tester: [Your Name]

Notes:
- [Any observations]
- [Issues found]
- [Performance metrics]

Issues:
1. [Description of issue]
   - Severity: High/Medium/Low
   - Steps to reproduce
   - Expected vs Actual behavior
```

---

## Critical Path Testing (Quick Smoke Test)

If you have limited time, test this critical path:

1. Launch app → System tray appears
2. Switch apps → Events logged to JSONL
3. Install PowerShell hooks → Success
4. Run commands → Captured in command-history.jsonl
5. Create simple workflow → Saves to DB
6. Run workflow → Executes successfully
7. Close and reopen app → Data persists

If all 7 steps pass, core functionality is working.

---

## Reporting Issues

When you find issues, include:

1. Steps to reproduce
2. Expected behavior
3. Actual behavior
4. Screenshots/logs
5. System info (Windows version, PowerShell version)
6. Console errors (if any)

Good luck testing! 🚀
