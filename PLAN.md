# System Toggles — Plan

**Bundle ID:** `io.github.x-o-r-r-o.system-toggles` · **Keyword:** `tog` (configurable; sub-lists `tog eject`, `tog input`, `tog awake` (`tog awake while`), `tog focus`, `tog position`) · **Hotkeys:** show the list, flip Dark Mode, flip Keep Awake

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-28 brief):

| Raycast extension | Downloads | What it lacks (source, open issues) |
|---|---|---|
| Screen Saver | 10.7k | start only |
| Single Disk Eject | 9.7k | lists `ls /Volumes` names only, no busy-app info, falsely reported success before 2023-11 |
| Dock Tinker | 7k | `defaults write … && killall Dock` for everything (flickers) |
| Night Light | 6.6k | needs the `nightlight` Homebrew binary (#29427 "No such file or directory") |
| Keyboard Layout Switcher | 5k | ships an unsigned `keyboardSwitcher` binary; #26804 asks for switching by name |
| Toggle Desktop Visibility | – | per-macOS-version code paths; fixed for Tahoe 2026-05 |
| Hide All Apps | – | #21285 "too slow" (AppleScript over System Events) |

Plus the many single-purpose Alfred toggles (dark mode, hidden files, caffeinate, eject). None shows the current state.

**Not in scope (owned elsewhere):** brightness, audio, display modes and AirPods → `alfred-display-audio`; cleaning and processes → Burrow.

## Features (v1.0)
- [x] One list, every row shows its current state (`Name: On ✓` / `Off`), fuzzy filter (word start, synonyms, substrings, initials such as `dm`, letters in order); state is read only for rows that survive the filter
- [x] Dark Mode — read `AppleInterfaceStyle`, set through System Events (notes "Appearance is Auto")
- [x] Night Shift — CoreBrightness `CBBlueLightClient` through the JXA bridge (`getBlueLightStatus:` via `objc_msgSend` with a 64-byte buffer, `setEnabled:`); the method's type encoding must match the known 40-byte struct (with or without the trailing `available` BOOL) or the row hides; schedule shown; hidden when unsupported. No binary (beats Night Light's Homebrew dependency)
- [x] True Tone — `CBTrueToneClient` `supported`/`available`/`enabled`/`setEnabled:`; hidden when there's no True Tone display
- [x] Focus — runs the user's own Shortcut (`shortcuts run -- name`), picked from `tog focus` (focus-like names first) or set in the configuration; state from `~/Library/DoNotDisturb/DB` only when Alfred has Full Disk Access, otherwise no ✓ is claimed
- [x] Low Power Mode — `pmset -g` (`lowpowermode` or, on High Power Mode Macs, `powermode`); set with macOS's own administrator dialog (`do shell script … with prompt … with administrator privileges`), labelled with what changes; Cancel changes nothing; never sudo
- [x] Keep Awake — `caffeinate -di|-i [-t s]` detached in its own process group, pid + end time in the data folder, presets and typed durations (`45`, `90m`, `1h30`, `1:30`, `2 hours`), stop kills only a pid that is still `caffeinate`
- [x] Keep Awake until a time (`until 17:30`, `5pm`, `at 9` = the sooner of 9:00 and 21:00; local calendar, DST-safe) and while an app runs (`awake while` → `caffeinate -w pid`) — Raycast Coffee “Caffeinate Until/While”, Gallery Caffeine Dose
- [x] Hotkeys that flip Dark Mode and Keep Awake without the list (`{"op":"flip"}` reads the state, then toggles)
- [x] Desktop icons — `CreateDesktop` + Finder restart (warned in the subtitle); on macOS 14/15 hiding uses `StandardHideDesktopIcons`, or `HideDesktop` under Stage Manager (no restart); desktop widgets (`StandardHideWidgets`, or `StageManagerHideWidgets` under Stage Manager, 14+) — Raycast #14949
- [x] Hidden files — `AppleShowAllFiles` + Finder restart; Finder is reopened if it doesn't come back in 3 s
- [x] Dock auto-hide, magnification, position and menu bar auto-hide through System Events (no Dock restart); without Automation permission the Dock falls back to `defaults write` + `killall Dock`
- [x] Input sources — TIS through the bridge (BridgeSupport constants + `castRefToObject`): next source on ↩, full list with ✓
- [x] Eject — Finder-like list (ejectable/removable/external/network, browsable), grouped per disk; eject all or one; ⌥ force, ⌃ unmount one volume, ⌘ reveal; busy disks name the app from diskutil's "dissented by PID"; verifies the volume is really gone
- [x] Start screen saver, lock screen (`SACLockScreenImmediate`), sleep displays (`pmset displaysleepnow`), hide all apps / other apps (`NSRunningApplication.hide`, no System Events)
- [x] ⌘↩ acts and reopens the list on the same query

## Tech
- JXA + ObjC bridge and /usr/bin tools only; no binaries, no network.
- `ST_DRY_RUN=1` makes every setter print what it would do; `ST_FIXTURE=file` replaces every state reader (and implies dry run). Tests always use one of them.

## Known limitations
- Night Shift and True Tone use a private framework (CoreBrightness); rows hide themselves if the class or selectors disappear.
- Focus can't be changed without a Shortcut; its state needs Full Disk Access.
- Finder restarts interrupt file copies in progress (warned, not detected).
- Selecting a CJK input mode from a background process is unreliable on some macOS versions (known TIS behaviour).
- Low Power Mode needs an administrator account, and `pmset -a` sets it for battery and power adapter alike.
- An external drive with an APFS container and a non-APFS partition shows as two disks in the eject list.

## Verify in real Alfred
- [ ] Automation prompt for System Events appears once, then Dark Mode / Dock / menu bar toggle without restarts; ⌘↩ reopens with the new state
- [ ] Night Shift and True Tone toggle (and the schedule note) on a MacBook; rows hidden on a Mac mini without True Tone
- [ ] Low Power Mode dialog text, Cancel → "Low Power Mode unchanged"; `powermode` on a High Power Mode Mac
- [ ] Hidden files / desktop icons: Finder restarts and restores windows; macOS 14/15 hide path without restart
- [ ] Desktop widgets toggle applies without a restart
- [ ] Eject a USB drive with two partitions, an APFS drive, a DMG and an SMB share; busy disk (file open in Preview) names Preview; ⌥ force works
- [ ] Input source switch with 2+ layouts and a CJK input method
- [ ] Keep Awake: `pmset -g assertions` shows caffeinate; stop works; survives Alfred closing
- [ ] Keep Awake until 17:30 / 5pm shows the right time left; `awake while` on an app ends when the app quits (row turns Off)
- [ ] Hotkeys: Dark Mode hotkey flips appearance and notifies; Keep Awake hotkey starts, then stops
- [ ] Stage Manager on (macOS 14/15): Desktop Icons / Widgets rows match System Settings › Desktop & Dock “In Stage Manager”, and toggling applies without a restart
- [ ] Lock screen, screen saver, sleep displays, hide all/others
- [ ] Focus Shortcut run and state with and without Full Disk Access
- [ ] macOS 13: rows that need 14+ (widgets) are hidden; System Events `autohide menu bar` works

## Ideas for v1.1
Ranked by value and risk (independent audit, 2026-09-28):
1. Hide rows you never use (⌃↩ like `audio`), and more flip Hotkeys (the `flip` action already supports every toggle id).
2. Keep Awake with the lid closed on power (`caffeinate -s`, Raycast Coffee #31139), and a menu of `pmset -g assertions` owners (“what’s keeping my Mac awake”).
3. Eject: group an APFS container (`/dev/disk5`, synthesized) with its physical disk’s other partitions (`diskutil info -plist` → `APFSPhysicalStores`), so a mixed APFS + ExFAT drive is ejected in one step; list `lsof` holders of a busy disk before forcing.
4. Low Power Mode per power source (`pmset -b`/`-c`) so “Only on battery” survives a toggle (today `-a` sets both).
5. Night Shift strength (`setStrength:commit:`) and schedule.
6. Stage Manager on/off (`GloballyEnabled`), Reduce Motion / Transparency (need permission research).
7. Detect Finder copies in progress before restarting it.

## Release checklist
- [x] README `## Setup` (System Events Automation) then `## Usage`; paragraphs end "via the `tog` keyword"
- [ ] Screenshots in `images/` (tog, focus, awake, input, eject)
- [x] Keyword ≥ 3 characters and configurable; settings in Workflow Configuration
- [x] No binaries, no network, no self-updater; nothing installed
- [x] AI disclosure in README
- [ ] Forum post, Gallery submission
