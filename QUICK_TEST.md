# Quick Test - Boost App

Run these commands to verify the app is working:

## 1. Start the App

```bash
cd C:\Desktop\Boost\Boost
bun run dev
```

**Expected**: App window opens, system tray icon appears, console shows all services started

## 2. Check Activity Logging (in a new terminal)

```bash
cd C:\Desktop\Boost\Boost
bun run data:tail
```

**Expected**: Shows recent app focus events with timestamps

## 3. Install PowerShell Hooks

```bash
bun run boost install-hooks
```

**Expected**: Success message indicating hooks were installed

## 4. Test Command Capture

Open a **new PowerShell terminal** and run:

```powershell
cd C:\
dir
echo "test"
```

Then check if commands were captured:

```bash
bun run boost status
```

**Expected**: Shows system status and recent command count

## 5. View Data Files

Check that these files exist:

```bash
ls "C:\Users\vivid\AppData\Roaming\boost-activity-collector\data\"
```

**Expected files**:

- `activity.jsonl` - Activity log events
- `command-history.jsonl` - Captured commands
- `workflows.db` - SQLite database

## 6. Create a Pattern

In PowerShell, repeat this sequence 3 times:

```powershell
git status
git pull
```

Then check for detected patterns:

```bash
bun run boost patterns
```

**Expected**: Shows the repeated git sequence as a detected pattern

## 7. Test CLI Commands

```bash
# List workflows
bun run boost list

# View help
bun run boost --help
```

## If Everything Works

You should see:

- ✅ App running in system tray
- ✅ Activity events logged to JSONL
- ✅ PowerShell commands captured
- ✅ Patterns detected
- ✅ Database created successfully
- ✅ CLI commands responding

Then you can proceed with the full manual testing guide!

## Troubleshooting

If you see errors:

1. Check the console output for error messages
2. Verify data directory permissions
3. Make sure ports 45678 and 45679 are not in use
4. Check PowerShell execution policy: `Get-ExecutionPolicy`
