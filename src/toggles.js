#!/usr/bin/osascript -l JavaScript
// System Toggles for Alfred: Dark Mode, Night Shift, True Tone, Focus, Low Power Mode, Keep Awake,
// desktop icons and widgets, hidden files, Dock and menu bar, input sources, eject disks,
// screen saver, lock, display sleep and hiding apps.
//
//   osascript -l JavaScript toggles.js list [query]    Script Filter
//   osascript -l JavaScript toggles.js act '<json>'     run an action (prints the notification text)
//
// No compiled helper: CoreBrightness (Night Shift, True Tone), Text Input Sources and login.framework
// (lock) are reached through the JXA Objective-C bridge; everything else uses tools in /usr/bin.
//
// Environment used by the test suite (never set by Alfred):
//   ST_DRY_RUN=1   print what a setter would do instead of doing it (state is still read for real)
//   ST_FIXTURE=f   read every state from a JSON file instead of the system (implies ST_DRY_RUN)
ObjC.import("Foundation");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

const FIXTURE_PATH = env("ST_FIXTURE", null);
// A fixture always means dry run: fake state must never reach a real setter.
const DRY = env("ST_DRY_RUN", "") === "1" || FIXTURE_PATH !== null;
const dryCalls = [];
function dry(call) {
  dryCalls.push(call);
}

const FM = $.NSFileManager.defaultManager;
const ALFRED = "com.runningwithcrayons.Alfred";

// ---------- small helpers ----------

function fold(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Display text: no control characters or bidi overrides (they can reorder or hide a title).
function clean(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏؜]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(s, max = 120) {
  const t = clean(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function icon(name) {
  return { path: `icons/${name}.png` };
}

function info(title, subtitle = "", ico = "info", extra = {}) {
  return Object.assign({ title, subtitle, valid: false, icon: icon(ico) }, extra);
}

function output(items) {
  return JSON.stringify({ skipknowledge: true, items });
}

function action(op, fields = {}) {
  return JSON.stringify(Object.assign({ op }, fields));
}

// true/false from a preference value that may be a boolean, a number or a string ("1", "true", "YES")
function boolish(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return fallback;
}

function fmtBytes(n) {
  if (!(n > 0)) return "";
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

function fmtMinutes(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function nowMs() {
  const fake = env("ST_NOW", null); // tests only: a fixed clock
  return fake !== null && /^\d+$/.test(fake) ? Number(fake) : Date.now();
}

// ---------- files ----------

function dataDir() {
  const dir = env("alfred_workflow_data", null) || `${$.NSTemporaryDirectory().js}alfred-system-toggles`;
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}

function readText(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}

function readJSON(path, fallback) {
  const s = readText(path);
  if (s === null) return fallback;
  try {
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

// A state file as a plain object: a corrupt, null or array file counts as empty.
function readObject(path) {
  const v = readJSON(path, null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function writeJSON(path, value) {
  // atomically, so a killed run never leaves half a file
  return !!$(JSON.stringify(value, null, 2)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}

function removeFile(path) {
  FM.removeItemAtPathError(path, $());
}

// ---------- processes ----------

// Run a program with argv (never through a shell). Returns {status, out, err}; kills it after `timeout` s.
function spawn(path, args, timeout = 10) {
  const tmp = $.NSTemporaryDirectory().js;
  const outPath = `${tmp}st-${$.NSUUID.UUID.UUIDString.js}.out`;
  const errPath = outPath.replace(/out$/, "err");
  FM.createFileAtPathContentsAttributes(outPath, $(), $());
  FM.createFileAtPathContentsAttributes(errPath, $(), $());
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
  task.standardError = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
  const result = { status: -1, out: "", err: "" };
  if (task.launchAndReturnError($())) {
    const deadline = Date.now() + timeout * 1000;
    while (task.running && Date.now() < deadline) $.NSThread.sleepForTimeInterval(0.005);
    if (task.running) {
      task.terminate;
      result.err = "timed out";
    } else result.status = Number(task.terminationStatus);
    result.out = readText(outPath) || "";
    result.err = result.err || readText(errPath) || "";
  } else result.err = "could not launch";
  removeFile(outPath);
  removeFile(errPath);
  return result;
}

function shellQuote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

// Run a command that changes something, or only describe it in dry-run mode.
function exec(path, args, timeout) {
  if (DRY) {
    dry([path, ...args].map(shellQuote).join(" "));
    return { status: 0, out: "", err: "" };
  }
  return spawn(path, args, timeout);
}

// Start a program in its own session so it outlives this script; returns its pid (0 on failure).
function spawnDetached(args) {
  const r = spawn("/bin/bash", ["-c", 'set -m; /usr/bin/nohup "$@" </dev/null >/dev/null 2>&1 & echo $!', "spawn", ...args]);
  const pid = parseInt(r.out, 10);
  return isFinite(pid) && pid > 0 ? pid : 0;
}

let libc = false;
function processAlive(pid) {
  if (!(pid > 0)) return false;
  if (FIXTURE) return (FIXTURE.alive || []).includes(pid);
  if (!libc) {
    ObjC.bindFunction("kill", ["int", ["int", "int"]]);
    libc = true;
  }
  return $.kill(pid, 0) === 0;
}

function processCommand(pid) {
  if (FIXTURE) return (FIXTURE.alive || []).includes(pid) ? "/usr/bin/caffeinate" : "";
  const r = spawn("/bin/ps", ["-p", String(pid), "-o", "comm="], 5);
  return r.status === 0 ? r.out.trim() : "";
}

// ---------- preferences ----------

function prefDomain(domain) {
  if (FIXTURE) return (FIXTURE.prefs || {})[domain] || {};
  const d = $.NSUserDefaults.standardUserDefaults.persistentDomainForName(domain);
  return d.isNil() ? null : d;
}

function pref(domain, key) {
  const d = prefDomain(domain);
  if (!d) return undefined;
  if (FIXTURE) return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
  const v = d.objectForKey(key);
  return v.isNil() ? undefined : ObjC.unwrap(v);
}

function defaultsWrite(domain, key, value) {
  return exec("/usr/bin/defaults", ["write", domain, key, "-bool", value ? "true" : "false"]);
}

function macosMajor() {
  if (FIXTURE) return FIXTURE.macos || 15;
  return Number($.NSProcessInfo.processInfo.operatingSystemVersion.majorVersion);
}

// ---------- fixture ----------

const FIXTURE = FIXTURE_PATH ? readObject(FIXTURE_PATH) : null;

// ---------- apps ----------

function appRunning(bundleId) {
  if (FIXTURE) return (FIXTURE.running || ["com.apple.finder", "com.apple.dock"]).includes(bundleId);
  ObjC.import("AppKit");
  return $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId).count > 0;
}

// Finder reads CreateDesktop and AppleShowAllFiles only at launch. `killall` sends SIGTERM, which
// Finder handles like Quit (open windows are restored); if it doesn't come back by itself, open it.
function restartFinder() {
  exec("/usr/bin/killall", ["Finder"]);
  if (DRY) return;
  for (let i = 0; i < 30; i++) {
    $.NSThread.sleepForTimeInterval(0.1);
    if (appRunning("com.apple.finder")) return;
  }
  spawn("/usr/bin/open", ["-g", "-b", "com.apple.finder"]);
}

function restartDock() {
  exec("/usr/bin/killall", ["Dock"]); // launchd starts the Dock again at once
}

// System Events: the graceful way for appearance, Dock and menu bar (no restart, no flicker).
// Errors come back as {error, number}; -1743 means Alfred isn't allowed to control System Events.
function systemEvents(description, fn) {
  if (DRY) {
    dry(`System Events: ${description}`);
    return null;
  }
  try {
    fn(Application("System Events"));
    return null;
  } catch (e) {
    return { error: String(e.message || e), number: e.errorNumber };
  }
}

const AUTOMATION_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
function notAllowed(err) {
  return err && (err.number === -1743 || /not allowed|not authori[sz]ed/i.test(err.error));
}
function automationMessage(what) {
  openURL(AUTOMATION_PANE);
  return `Couldn’t change ${what}: allow Alfred to control System Events in System Settings › Privacy & Security › Automation.`;
}

function openURL(url) {
  if (!/^(https|x-apple\.systempreferences|shortcuts):/.test(url)) return;
  if (DRY) return dry(`open ${url}`);
  ObjC.import("AppKit");
  $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
}

function alfredSearch(q) {
  if (DRY) return dry(`Alfred search ${JSON.stringify(q)}`);
  Application(ALFRED).search(q);
}

function keyword() {
  const kw = String(env("keyword_tog", "tog")).trim();
  return kw || "tog";
}

// ---------- CoreBrightness: Night Shift and True Tone (private framework, read through the bridge) ----------

let cbLoaded = null;
function coreBrightness() {
  if (cbLoaded === null) {
    const b = $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/CoreBrightness.framework");
    cbLoaded = !b.isNil() && !!b.load;
  }
  return cbLoaded;
}

// getBlueLightStatus: fills a struct {BOOL active, enabled, sunSchedulePermitted; int mode;
// {int hour, minute} from, to; uint64 disableFlags; BOOL available}. The bridge can't pass a struct
// pointer to an Objective-C method, so it goes through objc_msgSend with a byte buffer.
let blueLight = undefined;
function blueLightClient() {
  if (blueLight !== undefined) return blueLight;
  blueLight = null;
  if (!coreBrightness()) return null;
  const C = $.NSClassFromString("CBBlueLightClient");
  if (C.isNil()) return null;
  if (C.respondsToSelector("supportsBlueLightReduction") && !C.supportsBlueLightReduction) return null;
  const c = C.alloc.init;
  if (c.isNil() || !c.respondsToSelector("setEnabled:") || !c.respondsToSelector("getBlueLightStatus:")) return null;
  blueLight = c;
  return c;
}

let msgSendBound = false;
function nightShiftState() {
  if (FIXTURE) return FIXTURE.nightShift || null;
  const c = blueLightClient();
  if (!c) return null;
  if (!msgSendBound) {
    ObjC.bindFunction("sel_registerName", ["void *", ["char *"]]);
    ObjC.bindFunction("objc_msgSend", ["bool", ["id", "void *", "void *"]]);
    msgSendBound = true;
  }
  const buf = $.NSMutableData.dataWithLength(64);
  if (!$.objc_msgSend(c, $.sel_registerName("getBlueLightStatus:"), buf.mutableBytes)) return null;
  const s = $.NSString.alloc.initWithDataEncoding(buf, $.NSISOLatin1StringEncoding).js;
  const i32 = (o) => (s.charCodeAt(o) | (s.charCodeAt(o + 1) << 8) | (s.charCodeAt(o + 2) << 16) | (s.charCodeAt(o + 3) << 24));
  const available = s.charCodeAt(32) !== 0;
  if (!available) return null;
  return {
    on: s.charCodeAt(1) !== 0,
    mode: i32(4), // 0 off, 1 sunset to sunrise, 2 custom
    from: [i32(8), i32(12)],
    to: [i32(16), i32(20)],
  };
}

let trueToneClient = undefined;
function trueToneState() {
  if (FIXTURE) return FIXTURE.trueTone || null;
  if (trueToneClient === undefined) {
    trueToneClient = null;
    if (coreBrightness()) {
      const C = $.NSClassFromString("CBTrueToneClient");
      if (!C.isNil()) {
        const c = C.alloc.init;
        if (!c.isNil() && c.respondsToSelector("supported") && c.respondsToSelector("setEnabled:")) trueToneClient = c;
      }
    }
  }
  const c = trueToneClient;
  // `supported`: the Mac has the sensor; `available`: a True Tone display is connected (lid open…)
  if (!c || !c.supported || (c.respondsToSelector("available") && !c.available)) return null;
  return { on: !!c.enabled };
}

// ---------- Low Power Mode (pmset; changing it needs an administrator) ----------

function lowPowerState() {
  if (FIXTURE) return FIXTURE.lowPower || null;
  const r = spawn("/usr/bin/pmset", ["-g"], 5);
  if (r.status !== 0) return null;
  // macOS 14+ Macs with High Power Mode report "powermode" (0 automatic, 1 low, 2 high); others "lowpowermode".
  const m = r.out.match(/^\s*(lowpowermode|powermode)\s+(\d+)/m);
  if (!m) return null;
  return { key: m[1], value: Number(m[2]), on: Number(m[2]) === 1 };
}

// ---------- Focus (no public API: read Focus’s own database when allowed, change it through a Shortcut) ----------

function focusState() {
  if (FIXTURE) return FIXTURE.focus || { known: false };
  const dir = `${$.NSHomeDirectory().js}/Library/DoNotDisturb/DB`;
  const assertions = readJSON(`${dir}/Assertions.json`, null); // needs Full Disk Access
  if (!assertions || !Array.isArray(assertions.data)) return { known: false };
  const records = [];
  for (const d of assertions.data) if (d && Array.isArray(d.storeAssertionRecords)) records.push(...d.storeAssertionRecords);
  if (!records.length) return { known: true, on: false };
  const id = ((records[records.length - 1] || {}).assertionDetails || {}).assertionDetailsModeIdentifier || "";
  let name = "";
  const modes = readJSON(`${dir}/ModeConfigurations.json`, null);
  try {
    const m = modes.data[0].modeConfigurations[id];
    name = m && m.mode && typeof m.mode.name === "string" ? m.mode.name : "";
  } catch (e) {
    name = "";
  }
  if (!name && id === "com.apple.donotdisturb.mode.default") name = "Do Not Disturb";
  return { known: true, on: true, name };
}

function focusChoicePath() {
  return `${dataDir()}/focus.json`;
}

// The Shortcut that toggles Focus: the Workflow’s Configuration wins, then the one picked in the list.
function focusShortcut() {
  const configured = clean(env("focus_shortcut", ""));
  if (configured) return { name: configured, configured: true };
  const saved = readObject(focusChoicePath()).shortcut;
  return typeof saved === "string" && clean(saved) ? { name: saved, configured: false } : null;
}

function shortcutNames() {
  if (FIXTURE) return FIXTURE.shortcuts || [];
  const r = spawn("/usr/bin/shortcuts", ["list"], 10);
  if (r.status !== 0) return null;
  return r.out.split("\n").filter((s) => s.trim());
}

// ---------- Text Input Sources ----------

let tisReady = false;
function tis() {
  if (!tisReady) {
    ObjC.import("Carbon");
    tisReady = true;
  }
}
function cfObject(ref) {
  if (!ref) return null;
  const o = ObjC.castRefToObject(ref);
  return !o || o.isNil() ? null : o;
}
function tisProp(src, key) {
  const v = cfObject($.TISGetInputSourceProperty(src, key));
  return v ? ObjC.deepUnwrap(v) : null;
}

// Enabled keyboard layouts and input modes, as in the menu bar’s Input menu.
function realInputSources() {
  tis();
  const list = cfObject($.TISCreateInputSourceList($(), false));
  const out = [];
  if (!list) return { sources: out, current: null, handles: new Map() };
  const handles = new Map();
  for (let i = 0; i < list.count; i++) {
    const s = list.objectAtIndex(i);
    if (tisProp(s, $.kTISPropertyInputSourceCategory) !== "TISCategoryKeyboardInputSource") continue;
    if (tisProp(s, $.kTISPropertyInputSourceIsSelectCapable) !== true) continue;
    const type = tisProp(s, $.kTISPropertyInputSourceType) || "";
    if (type === "TISTypeKeyboardInputMethodModeEnabled") continue; // the parent of its modes
    const id = tisProp(s, $.kTISPropertyInputSourceID);
    if (!id || handles.has(id)) continue;
    handles.set(id, s);
    out.push({ id, name: tisProp(s, $.kTISPropertyLocalizedName) || id, type });
  }
  const cur = cfObject($.TISCopyCurrentKeyboardInputSource());
  const curId = cur ? tisProp(cur, $.kTISPropertyInputSourceID) : null;
  return { sources: out, current: curId, handles };
}

function inputSources() {
  if (FIXTURE) {
    const f = FIXTURE.input || { sources: [], current: null };
    return { sources: f.sources || [], current: f.current || null, handles: new Map() };
  }
  return realInputSources();
}

function selectInputSource(id, handles) {
  if (DRY) return dry(`TISSelectInputSource(${id})`) || true;
  const s = handles.get(id);
  return !!s && $.TISSelectInputSource(s) === 0;
}

// ---------- volumes ----------

const VOLUME_KEYS = ["NSURLVolumeNameKey", "NSURLVolumeIsEjectableKey", "NSURLVolumeIsRemovableKey", "NSURLVolumeIsInternalKey",
  "NSURLVolumeIsLocalKey", "NSURLVolumeIsBrowsableKey", "NSURLVolumeTotalCapacityKey", "NSURLVolumeAvailableCapacityKey",
  "NSURLVolumeLocalizedFormatDescriptionKey", "NSURLVolumeIsRootFileSystemKey"];

// `mount` lines: "<device> on <mount point> (<type>, <flags…>)". The device never contains " on ".
function parseMount(text) {
  const map = new Map();
  for (const line of String(text).split("\n")) {
    const m = line.match(/^(.+?) on (\/.*) \(([^()]*)\)$/);
    if (m) map.set(m[2], { device: m[1], flags: m[3].split(",").map((f) => f.trim()) });
  }
  return map;
}

function realVolumes() {
  const mounts = parseMount(spawn("/sbin/mount", [], 5).out);
  const urls = FM.mountedVolumeURLsIncludingResourceValuesForKeysOptions($(VOLUME_KEYS), 2 /* skip hidden */);
  const list = [];
  if (urls.isNil()) return list;
  for (let i = 0; i < urls.count; i++) {
    const u = urls.objectAtIndex(i);
    const vals = u.resourceValuesForKeysError($(VOLUME_KEYS), $());
    if (vals.isNil()) continue;
    const g = (k) => {
      const v = vals.objectForKey(k);
      return v.isNil() ? undefined : ObjC.unwrap(v);
    };
    const path = u.path.js;
    const m = mounts.get(path) || { device: "", flags: [] };
    list.push({
      path, name: g("NSURLVolumeNameKey") || path.split("/").pop(), device: m.device,
      ejectable: !!g("NSURLVolumeIsEjectableKey"), removable: !!g("NSURLVolumeIsRemovableKey"),
      internal: g("NSURLVolumeIsInternalKey"), local: g("NSURLVolumeIsLocalKey") !== false,
      browsable: g("NSURLVolumeIsBrowsableKey") !== false, root: !!g("NSURLVolumeIsRootFileSystemKey"),
      size: Number(g("NSURLVolumeTotalCapacityKey") || 0), free: Number(g("NSURLVolumeAvailableCapacityKey") || 0),
      format: g("NSURLVolumeLocalizedFormatDescriptionKey") || "", readonly: m.flags.includes("read-only"),
    });
  }
  return list;
}

// Volumes Finder would show an Eject button for, grouped by disk (a USB drive with two partitions
// is ejected as one). Network shares are unmounted one by one.
function ejectables() {
  const all = FIXTURE ? FIXTURE.volumes || [] : realVolumes();
  const vols = all.filter((v) => v && typeof v.path === "string" && v.path !== "/" && !v.root && v.browsable !== false &&
    !v.path.startsWith("/System/Volumes/") && (v.ejectable || v.removable || v.internal === false || v.local === false));
  const groups = new Map();
  for (const v of vols) {
    const m = String(v.device || "").match(/^\/dev\/(disk\d+)/);
    v.disk = m ? m[1] : null;
    v.network = v.local === false || /^(\/\/|afp_|smb|nfs|webdav|https?:)/i.test(String(v.device || "")) || (!m && !!v.device);
    const key = v.disk && !v.network ? v.disk : `path:${v.path}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return [...groups.values()];
}

function stillMounted(path) {
  if (FIXTURE) return false;
  return FM.fileExistsAtPath(path) && realVolumes().some((v) => v.path === path);
}

// diskutil explains a busy disk as "dissented by PID 123 (/path/to/app)"; name the app.
function blockers(text) {
  const names = [];
  const re = /dissented by PID (\d+)(?: \(([^)]*)\))?/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    let name = m[2] ? m[2].split("/").pop() : "";
    if (!name && !FIXTURE) name = processCommand(Number(m[1])).split("/").pop();
    const label = name ? `${name} (PID ${m[1]})` : `PID ${m[1]}`;
    if (!names.includes(label)) names.push(label);
  }
  return names;
}

function diskutil(args) {
  if (FIXTURE) {
    dry(["/usr/sbin/diskutil", ...args].map(shellQuote).join(" "));
    const canned = (FIXTURE.diskutil || {})[args.join(" ")];
    return canned ? { status: canned.status || 0, out: canned.out || "", err: canned.err || "" } : { status: 0, out: "", err: "" };
  }
  return exec("/usr/sbin/diskutil", args, 60);
}

// Eject one group; returns {ok, name, why}
function ejectGroup(group, force, onlyPath) {
  const first = group[0];
  const name = clean(onlyPath ? (group.find((v) => v.path === onlyPath) || first).name : group.map((v) => v.name).join(", "));
  let r;
  if (onlyPath) {
    r = diskutil(force ? ["unmount", "force", onlyPath] : ["unmount", onlyPath]);
  } else if (first.disk && !first.network) {
    if (force) {
      r = diskutil(["unmountDisk", "force", first.disk]);
      if (r.status === 0) r = diskutil(["eject", first.disk]);
    } else r = diskutil(["eject", first.disk]);
  } else {
    r = diskutil(force ? ["unmount", "force", first.path] : ["unmount", first.path]);
  }
  const text = `${r.out}\n${r.err}`;
  // diskutil can exit 0 while a volume stays mounted: check, so a busy disk is never reported as ejected
  const left = DRY ? [] : group.filter((v) => (!onlyPath || v.path === onlyPath) && stillMounted(v.path));
  if (r.status === 0 && !left.length) return { ok: true, name };
  const who = blockers(text);
  let why;
  if (who.length) why = `in use by ${who.join(", ")}`;
  else if (/timed out/.test(r.err)) why = "diskutil didn’t answer";
  else why = oneLine(text.replace(/^\s*(Volume|Disk|Unmount)[^\n]*?failed[^\n]*?:\s*/im, "").split("\n").filter((l) => l.trim()).pop() || "it’s in use", 100);
  return { ok: false, name, why };
}

// ---------- Keep Awake (caffeinate) ----------

function awakePath() {
  return `${dataDir()}/awake.json`;
}

function awakeState() {
  const s = readObject(awakePath());
  const pid = Number(s.pid);
  if (!(pid > 0) || !processAlive(pid)) return null;
  const until = Number(s.until) || 0;
  const now = nowMs();
  if (until && until <= now) return null;
  return { pid, until, left: until ? (until - now) / 60000 : null };
}

// "45", "45m", "1h", "1.5h", "1h30", "1h 30m", "1:30", "2 hours" → minutes; null if not a duration
function parseDuration(q) {
  const s = fold(q).trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours)(?: ?(\d+) ?(m|min|mins|minute|minutes)?)?$/);
  if (m) return Math.round(Number(m[1]) * 60 + (m[3] ? Number(m[3]) : 0));
  m = s.match(/^(\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes)?$/);
  if (m) return Math.round(Number(m[1]));
  return null;
}

const MAX_AWAKE = 7 * 24 * 60;

function awakeStart(minutes) {
  awakeStop(true);
  const display = boolish(env("awake_display", "1"), true);
  const args = ["/usr/bin/caffeinate", display ? "-di" : "-i"];
  if (minutes) args.push("-t", String(minutes * 60));
  let pid;
  if (DRY) {
    dry(args.join(" "));
    pid = FIXTURE && FIXTURE.nextPid ? Number(FIXTURE.nextPid) : 0;
  } else pid = spawnDetached(args);
  if (!DRY && !pid) return "Couldn’t start caffeinate";
  writeJSON(awakePath(), { pid, until: minutes ? nowMs() + minutes * 60000 : 0, started: nowMs() });
  return minutes ? `☕ Keeping your Mac awake for ${fmtMinutes(minutes)}` : "☕ Keeping your Mac awake until you stop it";
}

function awakeStop(quiet) {
  const s = readObject(awakePath());
  const pid = Number(s.pid);
  removeFile(awakePath());
  // Only ever stop our own caffeinate: the pid must still belong to a caffeinate process.
  if (pid > 0 && processAlive(pid) && /(^|\/)caffeinate$/.test(processCommand(pid))) {
    exec("/bin/kill", [String(pid)]);
    return quiet ? undefined : "💤 Your Mac can sleep again";
  }
  return quiet ? undefined : "Keep Awake was already off";
}

// ======================================================================
// Rows

// Each toggle row: {id, name, syn, row()} where row() reads the state only when the row survives the
// query filter, so a keystroke never pays for readers it doesn’t show.

// ⌘↩ acts and reopens Alfred on the same query, to flip several toggles in a row
let QUERY = "";
function reopenArgs() {
  return { reopen: true, query: QUERY };
}

function toggleItem(id, name, on, ico, extra = {}) {
  const verb = on ? "Turn off" : "Turn on";
  const title = `${name}: ${on ? "On ✓" : "Off"}`;
  const arg = action("toggle", { id, value: !on });
  return Object.assign({
    uid: id, title, subtitle: `↩ ${verb}`, arg, icon: icon(on ? ico : `${ico}_off`),
    mods: {
      cmd: { subtitle: `${verb} and keep this list open`, arg: action("toggle", { id, value: !on, ...reopenArgs() }), valid: true },
    },
  }, extra);
}

function withSubtitle(item, note) {
  if (note) item.subtitle = `${item.subtitle} · ${note}`;
  return item;
}

const FINDER_NOTE = "Restarts Finder: let copies finish first";

const ROWS = [
  {
    id: "dark", name: "Dark Mode", syn: "appearance theme light night",
    row() {
      const on = pref("NSGlobalDomain", "AppleInterfaceStyle") === "Dark";
      const auto = boolish(pref("NSGlobalDomain", "AppleInterfaceStyleSwitchesAutomatically"), false);
      return withSubtitle(toggleItem("dark", "Dark Mode", on, "dark"), auto ? "Appearance is Auto" : "");
    },
  },
  {
    id: "nightshift", name: "Night Shift", syn: "warm colour color blue light night light",
    row() {
      const s = nightShiftState();
      if (!s) return null;
      const note = s.mode === 1 ? "Scheduled sunset to sunrise" : s.mode === 2 ? `Scheduled ${hm(s.from)}–${hm(s.to)}` : "";
      return withSubtitle(toggleItem("nightshift", "Night Shift", !!s.on, "nightshift"), s.on && note ? `${note}, back on schedule later` : note);
    },
  },
  {
    id: "truetone", name: "True Tone", syn: "display colour color ambient",
    row() {
      const s = trueToneState();
      return s ? toggleItem("truetone", "True Tone", !!s.on, "truetone") : null;
    },
  },
  {
    id: "focus", name: "Focus", syn: "do not disturb dnd notifications silence",
    row() {
      return focusRow();
    },
  },
  {
    id: "lowpower", name: "Low Power Mode", syn: "battery energy saver power",
    row() {
      const s = lowPowerState();
      if (!s) return null;
      const it = toggleItem("lowpower", "Low Power Mode", s.on, "lowpower");
      it.subtitle += " · Asks for an administrator password";
      if (s.key === "powermode" && s.value === 2) it.subtitle = "High Power Mode is on · ↩ Switch to Low Power Mode · Asks for an administrator password";
      return it;
    },
  },
  {
    id: "awake", name: "Keep Awake", syn: "caffeinate caffeine coffee amphetamine sleep insomnia",
    row() {
      return awakeRow();
    },
  },
  {
    id: "desktop", name: "Desktop Icons", syn: "desktop files clean hide show",
    row() {
      const s = desktopIconsState();
      return withSubtitle(toggleItem("desktop", "Desktop Icons", s.shown, "desktop"), s.needsFinder ? FINDER_NOTE : "");
    },
  },
  {
    id: "widgets", name: "Desktop Widgets", syn: "desktop widgets hide show",
    row() {
      if (macosMajor() < 14) return null;
      const hidden = boolish(pref("com.apple.WindowManager", "StandardHideWidgets"), false);
      return toggleItem("widgets", "Desktop Widgets", !hidden, "widgets");
    },
  },
  {
    id: "hidden", name: "Hidden Files", syn: "finder dotfiles invisible show all",
    row() {
      const on = boolish(pref("com.apple.finder", "AppleShowAllFiles"), false);
      return withSubtitle(toggleItem("hidden", "Hidden Files", on, "hidden"), FINDER_NOTE);
    },
  },
  {
    id: "dockhide", name: "Dock Auto-hide", syn: "dock autohide hide hiding",
    row() {
      return toggleItem("dockhide", "Dock Auto-hide", boolish(pref("com.apple.dock", "autohide"), false), "dock");
    },
  },
  {
    id: "magnify", name: "Dock Magnification", syn: "dock magnify zoom",
    row() {
      return toggleItem("magnify", "Dock Magnification", boolish(pref("com.apple.dock", "magnification"), false), "magnify");
    },
  },
  {
    id: "position", name: "Dock Position", syn: "dock position edge left right bottom orientation",
    row() {
      const cur = dockPosition();
      return {
        uid: "position", title: `Dock Position: ${POSITIONS.get(cur)}`, subtitle: "↩ Choose Bottom, Left or Right",
        valid: false, autocomplete: "dock position", icon: icon("position"),
      };
    },
  },
  {
    id: "menubar", name: "Menu Bar Auto-hide", syn: "menubar menu bar autohide hide",
    row() {
      return toggleItem("menubar", "Menu Bar Auto-hide", boolish(pref("NSGlobalDomain", "_HIHideMenuBar"), false), "menubar");
    },
  },
  {
    id: "input", name: "Input Source", syn: "keyboard layout language input source switch",
    row() {
      return inputRow();
    },
  },
  {
    id: "eject", name: "Eject", syn: "eject disk disks drive usb unmount volume external",
    rows() {
      return ejectMainRows();
    },
  },
  {
    id: "screensaver", name: "Start Screen Saver", syn: "screensaver",
    row() {
      return { uid: "screensaver", title: "Start Screen Saver", subtitle: "↩ Start it now", arg: action("screensaver"), icon: icon("screensaver") };
    },
  },
  {
    id: "lock", name: "Lock Screen", syn: "lock screen away",
    row() {
      return { uid: "lock", title: "Lock Screen", subtitle: "↩ Lock your Mac", arg: action("lock"), icon: icon("lock") };
    },
  },
  {
    id: "displaysleep", name: "Sleep Displays", syn: "display screen off monitor sleep",
    row() {
      return { uid: "displaysleep", title: "Sleep Displays", subtitle: "↩ Turn the displays off (your Mac keeps running)", arg: action("displaysleep"), icon: icon("displaysleep") };
    },
  },
  {
    id: "hideall", name: "Hide All Apps", syn: "hide apps windows clear show desktop",
    row() {
      return { uid: "hideall", title: "Hide All Apps", subtitle: "↩ Hide every app’s windows", arg: action("hide", { others: false }), icon: icon("hideall") };
    },
  },
  {
    id: "hideothers", name: "Hide Other Apps", syn: "hide others apps windows focus",
    row() {
      return { uid: "hideothers", title: "Hide Other Apps", subtitle: "↩ Hide every app except the frontmost one", arg: action("hide", { others: true }), icon: icon("hideothers") };
    },
  },
];

function hm(pair) {
  const [h, m] = Array.isArray(pair) ? pair : [0, 0];
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Desktop icons: Finder’s CreateDesktop everywhere; macOS 14 and 15 also have "Show Items on Desktop"
// (WindowManager StandardHideDesktopIcons), which hides them without restarting Finder.
function desktopIconsState() {
  const create = boolish(pref("com.apple.finder", "CreateDesktop"), true);
  const wm = macosMajor() >= 14 && macosMajor() <= 15;
  const wmHidden = wm && boolish(pref("com.apple.WindowManager", "StandardHideDesktopIcons"), false);
  return { shown: create && !wmHidden, create, wm, wmHidden, needsFinder: !wm || !create };
}

const POSITIONS = new Map([["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]]);
function dockPosition() {
  const p = String(pref("com.apple.dock", "orientation") || "bottom").toLowerCase();
  return POSITIONS.has(p) ? p : "bottom";
}

function focusRow() {
  const s = focusState();
  const sc = focusShortcut();
  const title = !s.known ? "Focus" : s.on ? `Focus: On ✓${s.name ? ` (${clean(s.name)})` : ""}` : "Focus: Off";
  const ico = s.known && !s.on ? "focus_off" : "focus";
  if (!sc) {
    return {
      uid: "focus", title, subtitle: "↩ Pick the Shortcut that turns Focus on and off", valid: false, autocomplete: "focus ", icon: icon(ico),
    };
  }
  const name = oneLine(sc.name, 60);
  return {
    uid: "focus", title, subtitle: `↩ Run “${name}” · ⇥ Choose another Shortcut`, arg: action("focus", { name: sc.name }),
    autocomplete: "focus ", icon: icon(ico),
    mods: { cmd: { subtitle: `Run “${name}” and keep this list open`, arg: action("focus", { name: sc.name, ...reopenArgs() }), valid: true } },
  };
}

function awakeRow() {
  const s = awakeState();
  if (!s) {
    return { uid: "awake", title: "Keep Awake: Off", subtitle: "↩ Keep your Mac awake for a while", valid: false, autocomplete: "awake ", icon: icon("awake_off") };
  }
  const left = s.left === null ? "until you stop it" : `${fmtMinutes(Math.ceil(s.left))} left`;
  return {
    uid: "awake", title: `Keep Awake: On ✓ (${left})`, subtitle: "↩ Stop · ⇥ Choose another duration", arg: action("awake-stop"),
    autocomplete: "awake ", icon: icon("awake"),
  };
}

function inputRow() {
  const { sources, current } = inputSources();
  const cur = sources.find((s) => s.id === current);
  const title = `Input Source: ${cur ? clean(cur.name) : "Unknown"}`;
  if (sources.length < 2) {
    return {
      uid: "input", title, subtitle: "Only one input source is enabled · ↩ Add more in System Settings",
      arg: action("open", { url: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension" }), icon: icon("keyboard"),
    };
  }
  const i = sources.findIndex((s) => s.id === current);
  const next = sources[(i + 1) % sources.length];
  return {
    uid: "input", title, subtitle: `↩ Switch to ${clean(next.name)} · ⇥ All input sources`, arg: action("input", { id: next.id }),
    autocomplete: "input ", icon: icon("keyboard"),
  };
}

function ejectMainRows() {
  const groups = ejectables();
  if (!groups.length) return [];
  const names = groups.map((g) => clean(g.map((v) => v.name).join(", ")));
  return [
    {
      uid: "ejectall", title: groups.length === 1 ? `Eject ${names[0]}` : `Eject All (${groups.length} disks)`,
      subtitle: groups.length === 1 ? "↩ Eject · ⇥ Pick a disk" : `↩ Eject ${oneLine(names.join(", "), 80)} · ⇥ Pick one`,
      arg: action("eject-all"), autocomplete: "eject ", icon: icon("eject"),
      mods: { alt: { subtitle: "Force eject, even when an app is using them (unsaved changes may be lost)", arg: action("eject-all", { force: true }), valid: true } },
    },
  ];
}

// ---------- matching ----------

// Fuzzy score of a query word against a row: word-start in the name beats word-start in a synonym,
// which beats a substring, which beats the letters in order ("dm" → Dark Mode). 0 = no match.
function wordScore(w, name, syn) {
  const nameWords = name.split(/[\s:-]+/);
  if (nameWords.some((t) => t.startsWith(w))) return 4;
  if (syn.split(/\s+/).some((t) => t.startsWith(w))) return 3;
  if (name.includes(w) || syn.includes(w)) return 2;
  // initials: "dm" → Dark Mode, "mba" → Menu Bar Auto-hide
  const initials = nameWords.map((t) => t[0] || "").join("");
  if (w.length > 1 && initials.startsWith(w)) return 3.5;
  let i = 0;
  for (const ch of name) if (ch === w[i]) i++;
  return i === w.length ? 1 : 0;
}

function rowScore(words, row) {
  const name = fold(row.name);
  const syn = fold(row.syn || "");
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, name, syn);
    if (!s) return 0;
    total += s;
  }
  return total;
}

// ---------- views ----------

function mainItems(query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const scored = ROWS.map((r, i) => ({ r, i, s: words.length ? rowScore(words, r) : 1 })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const items = [];
  for (const { r } of scored) {
    try {
      if (r.rows) items.push(...r.rows());
      else {
        const it = r.row();
        if (it) items.push(it);
      }
    } catch (e) {
      items.push(info(`Couldn’t read ${r.name}`, oneLine(e.message || e), "error", { uid: r.id }));
    }
  }
  if (!items.length) return [info("No matching toggle", "Try “dark”, “dock”, “eject”, “awake” or “input”", "info", { uid: "none" })];
  return items;
}

function ejectItems(rest) {
  const groups = ejectables();
  if (!groups.length) return [info("No disks to eject", "External drives, disk images and network shares appear here", "eject", { uid: "nodisk" })];
  const words = fold(rest).split(/\s+/).filter(Boolean);
  const items = [];
  if (!words.length && groups.length > 1) items.push(ejectMainRows()[0]);
  for (const g of groups) {
    const others = g.length > 1;
    for (const v of g) {
      if (words.length && !words.every((w) => fold(`${v.name} ${v.format} ${v.path}`).includes(w))) continue;
      const name = clean(v.name);
      const details = [v.network ? "Network share" : v.format ? clean(v.format) : "", v.size ? `${fmtBytes(v.free)} free of ${fmtBytes(v.size)}` : ""].filter(Boolean).join(" · ");
      const also = others ? ` (with ${oneLine(g.filter((x) => x !== v).map((x) => x.name).join(", "), 60)})` : "";
      const it = {
        uid: `vol:${v.path}`, title: name, subtitle: `↩ Eject${also}${details ? ` · ${details}` : ""}`,
        arg: action("eject", { path: v.path }), icon: icon(v.network ? "network" : v.readonly && v.ejectable && !v.removable ? "image" : "disk"),
        type: "file:skipcheck", quicklookurl: v.path, text: { copy: v.path, largetype: name },
        mods: {
          alt: { subtitle: "Force eject, even when an app is using it (unsaved changes may be lost)", arg: action("eject", { path: v.path, force: true }), valid: true },
          cmd: { subtitle: "Reveal in Finder", arg: action("reveal", { path: v.path }), valid: true },
        },
      };
      if (others) it.mods.ctrl = { subtitle: `Unmount only ${name}, keep the rest of the disk`, arg: action("eject", { path: v.path, only: true }), valid: true };
      items.push(it);
    }
  }
  return items.length ? items : [info("No matching disk", "", "eject", { uid: "nodisk" })];
}

function inputItems(rest) {
  const { sources, current } = inputSources();
  if (!sources.length) return [info("Couldn’t read the input sources", "", "error", { uid: "noinput" })];
  const words = fold(rest).split(/\s+/).filter(Boolean);
  const items = sources
    .filter((s) => !words.length || words.every((w) => fold(`${s.name} ${s.id}`).includes(w)))
    .map((s) => ({
      uid: `input:${s.id}`, title: `${clean(s.name)}${s.id === current ? " ✓" : ""}`,
      subtitle: s.id === current ? "Current input source" : "↩ Switch to this input source", arg: action("input", { id: s.id }),
      icon: icon(/InputMode|InputMethod/.test(s.type) ? "globe" : "keyboard"),
    }));
  items.push({
    uid: "input:settings", title: "Keyboard Settings…", subtitle: "↩ Add or remove input sources",
    arg: action("open", { url: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension" }), icon: icon("settings"),
  });
  return items;
}

const AWAKE_PRESETS = [15, 30, 60, 120, 240];

function awakeItems(rest) {
  const s = awakeState();
  const items = [];
  if (s) {
    const left = s.left === null ? "until you stop it" : `${fmtMinutes(Math.ceil(s.left))} left`;
    items.push({ uid: "awake:stop", title: "Stop Keeping Awake", subtitle: `On ✓ (${left}) · ↩ Let your Mac sleep again`, arg: action("awake-stop"), icon: icon("stop") });
  }
  const r = String(rest).trim();
  const min = r ? parseDuration(r) : null;
  const add = (m) => items.push({
    uid: `awake:${m}`, title: m ? `Keep Awake for ${fmtMinutes(m)}` : "Keep Awake Until Stopped",
    subtitle: s ? "↩ Replace the current timer" : "↩ Start", arg: action("awake", { minutes: m }), icon: icon("awake"),
  });
  if (r && min === null) {
    if (/^(on|forever|indefinitely|always|until|stop|off)/.test(fold(r))) {
      if (/^(stop|off)/.test(fold(r))) return items.length ? items : [info("Keep Awake is off", "", "awake_off", { uid: "awake:off" })];
      add(0);
      return items;
    }
    items.push(info("Type a duration", "Like 45, 90m, 2h or 1:30", "info", { uid: "awake:help" }));
    return items;
  }
  if (min !== null) {
    if (min < 1 || min > MAX_AWAKE) return items.concat(info("Choose between 1 minute and 7 days", "", "info", { uid: "awake:range" }));
    add(min);
    return items;
  }
  AWAKE_PRESETS.forEach(add);
  add(0);
  return items;
}

function focusItems(rest) {
  const items = [];
  const sc = focusShortcut();
  const row = focusRow();
  if (sc) items.push(row);
  const names = shortcutNames();
  if (names === null) return items.concat(info("Couldn’t list your Shortcuts", "", "error", { uid: "focus:error" }));
  const words = fold(rest).split(/\s+/).filter(Boolean);
  const focusish = (n) => /focus|disturb|\bdnd\b|konzentr|concentr|nicht st|ne pas d/i.test(n);
  const list = names
    .filter((n) => !words.length || words.every((w) => fold(n).includes(w)))
    .sort((a, b) => Number(focusish(b)) - Number(focusish(a)))
    .slice(0, 50);
  for (const n of list) {
    const chosen = sc && sc.name === n;
    items.push({
      uid: `focus:${n}`, title: `${oneLine(n, 80)}${chosen ? " ✓" : ""}`,
      subtitle: sc && sc.configured ? "↩ Run this Shortcut (the one in the Workflow’s Configuration is used for Focus)" : "↩ Run it and use it for Focus from now on",
      arg: action("focus", { name: n, remember: !(sc && sc.configured) }), icon: icon("shortcut"),
    });
  }
  if (!names.some(focusish)) {
    items.push({
      uid: "focus:create", title: "Create a Focus Shortcut", subtitle: "↩ Open Shortcuts, add “Set Focus” and choose Toggle",
      arg: action("open", { url: "shortcuts://create-shortcut" }), icon: icon("shortcut"),
    });
  }
  return items;
}

function positionItems() {
  const cur = dockPosition();
  return [...POSITIONS].map(([k, label]) => ({
    uid: `position:${k}`, title: `${label}${k === cur ? " ✓" : ""}`, subtitle: k === cur ? "Current Dock position" : `↩ Move the Dock to the ${label.toLowerCase()}`,
    arg: action("position", { value: k }), icon: icon("position"),
    mods: { cmd: { subtitle: "Move it and keep this list open", arg: action("position", { value: k, ...reopenArgs() }), valid: true } },
  }));
}

// First word(s) of the query that open a sub-list; the rest filters it.
const VIEWS = [
  [/^(eject|unmount|disks?|drives?|volumes?)(?:\s+(.*))?$/, ejectItems],
  [/^(input|inputs|keyboard|kbd|language|sources?)(?:\s+(.*))?$/, inputItems],
  [/^(awake|caffeinate|caffeine|coffee|amphetamine)(?:\s+(.*))?$/, awakeItems],
  [/^(focus|dnd)(?:\s+(.*))?$/, focusItems],
  [/^(dock\s+position|position)(?:\s+(.*))?$/, positionItems],
];

function listItems(query) {
  const q = String(query).trim();
  QUERY = q;
  for (const [re, fn] of VIEWS) {
    const m = q.match(re) || fold(q).match(re);
    if (m) return fn(m[2] || "");
  }
  return mainItems(q);
}

// ======================================================================
// Actions

const NAMES = { dark: "Dark Mode", nightshift: "Night Shift", truetone: "True Tone", lowpower: "Low Power Mode", desktop: "Desktop Icons",
  widgets: "Desktop Widgets", hidden: "Hidden Files", dockhide: "Dock Auto-hide", magnify: "Dock Magnification", menubar: "Menu Bar Auto-hide" };

function onOff(id, v) {
  return `${NAMES[id]} ${v ? "on" : "off"}`;
}

function toggle(id, value) {
  const v = !!value;
  switch (id) {
    case "dark": {
      const err = systemEvents(`dark mode = ${v}`, (se) => {
        se.appearancePreferences.darkMode = v;
      });
      if (err) return notAllowed(err) ? automationMessage("Dark Mode") : `Couldn’t change Dark Mode: ${oneLine(err.error)}`;
      return `${v ? "🌙" : "☀️"} ${onOff(id, v)}`;
    }
    case "nightshift": {
      if (DRY) dry(`CBBlueLightClient setEnabled:${v}`);
      else {
        const c = blueLightClient();
        if (!c || !c.setEnabled(v)) return "Couldn’t change Night Shift";
      }
      return `🌇 ${onOff(id, v)}`;
    }
    case "truetone": {
      if (DRY) dry(`CBTrueToneClient setEnabled:${v}`);
      else {
        trueToneState();
        if (!trueToneClient || !trueToneClient.setEnabled(v)) return "Couldn’t change True Tone";
      }
      return `🔆 ${onOff(id, v)}`;
    }
    case "lowpower": return lowPowerSet(v);
    case "desktop": {
      const s = desktopIconsState();
      if (v) {
        if (s.wmHidden) defaultsWrite("com.apple.WindowManager", "StandardHideDesktopIcons", false);
        if (!s.create) {
          defaultsWrite("com.apple.finder", "CreateDesktop", true);
          restartFinder();
        }
      } else if (s.wm) {
        defaultsWrite("com.apple.WindowManager", "StandardHideDesktopIcons", true); // no Finder restart needed
      } else {
        defaultsWrite("com.apple.finder", "CreateDesktop", false);
        restartFinder();
      }
      return `🖥 ${onOff(id, v)}`;
    }
    case "widgets":
      defaultsWrite("com.apple.WindowManager", "StandardHideWidgets", !v);
      return `🧩 ${onOff(id, v)}`;
    case "hidden":
      defaultsWrite("com.apple.finder", "AppleShowAllFiles", v);
      restartFinder();
      return `${v ? "👁" : "🙈"} ${onOff(id, v)}`;
    case "dockhide":
    case "magnify": {
      const prop = id === "dockhide" ? "autohide" : "magnification";
      const err = systemEvents(`dock preferences ${prop} = ${v}`, (se) => {
        se.dockPreferences[prop] = v;
      });
      if (err) {
        if (!notAllowed(err)) return `Couldn’t change ${NAMES[id]}: ${oneLine(err.error)}`;
        // Without Automation permission: write the preference and restart the Dock (it flickers once)
        defaultsWrite("com.apple.dock", prop, v);
        restartDock();
      }
      return `⚓️ ${onOff(id, v)}`;
    }
    case "menubar": {
      const err = systemEvents(`dock preferences autohide menu bar = ${v}`, (se) => {
        se.dockPreferences.autohideMenuBar = v;
      });
      if (err) return notAllowed(err) ? automationMessage("the menu bar") : `Couldn’t change the menu bar: ${oneLine(err.error)}`;
      return `${onOff(id, v)}`;
    }
    default:
      return "Unknown toggle";
  }
}

// Low Power Mode is a system-wide pmset setting: macOS asks for an administrator in its own dialog,
// which names what is being changed. Nothing runs with sudo, and Cancel changes nothing.
function lowPowerSet(v) {
  const s = lowPowerState();
  if (!s) return "Low Power Mode isn’t available on this Mac";
  const key = s.key === "powermode" ? "powermode" : "lowpowermode";
  const cmd = `/usr/bin/pmset -a ${key} ${v ? 1 : 0}`;
  const prompt = `System Toggles wants to turn ${v ? "on" : "off"} Low Power Mode (pmset ${key} ${v ? 1 : 0}).`;
  if (DRY) {
    dry(`do shell script ${JSON.stringify(cmd)} with prompt ${JSON.stringify(prompt)} with administrator privileges`);
    return `🔋 ${onOff("lowpower", v)}`;
  }
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  try {
    app.doShellScript(cmd, { administratorPrivileges: true, withPrompt: prompt });
  } catch (e) {
    if (e.errorNumber === -128) return "Low Power Mode unchanged";
    return `Couldn’t change Low Power Mode: ${oneLine(e.message || e)}`;
  }
  return `🔋 ${onOff("lowpower", v)}`;
}

function positionSet(value) {
  if (!POSITIONS.has(value)) return "Unknown Dock position";
  const err = systemEvents(`dock preferences screen edge = ${value}`, (se) => {
    se.dockPreferences.screenEdge = value;
  });
  if (err) {
    if (!notAllowed(err)) return `Couldn’t move the Dock: ${oneLine(err.error)}`;
    if (DRY) dry(`defaults write com.apple.dock orientation ${value}`);
    else spawn("/usr/bin/defaults", ["write", "com.apple.dock", "orientation", "-string", value]);
    restartDock();
  }
  return `⚓️ Dock moved to the ${value}`;
}

function focusRun(name, remember) {
  name = String(name || "");
  if (!clean(name)) return "Pick a Focus Shortcut first";
  if (remember) writeJSON(focusChoicePath(), { shortcut: name });
  const r = exec("/usr/bin/shortcuts", ["run", "--", name], 30);
  if (r.status !== 0) return `Couldn’t run the Shortcut “${oneLine(name, 60)}”${r.err ? `: ${oneLine(r.err, 80)}` : ""}`;
  return undefined; // the Shortcut’s own Focus change is the feedback
}

function lock() {
  if (DRY) return dry("SACLockScreenImmediate()");
  const b = $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/login.framework");
  if (!b.isNil() && b.load) {
    ObjC.bindFunction("SACLockScreenImmediate", ["int", []]);
    $.SACLockScreenImmediate();
    return undefined;
  }
  return "Couldn’t lock the screen";
}

function hideApps(others) {
  ObjC.import("AppKit");
  const ws = $.NSWorkspace.sharedWorkspace;
  const front = ws.frontmostApplication;
  const frontPid = front.isNil() ? -1 : Number(front.processIdentifier);
  const apps = FIXTURE ? (FIXTURE.apps || []) : [];
  if (!FIXTURE) {
    const running = ws.runningApplications;
    for (let i = 0; i < running.count; i++) {
      const a = running.objectAtIndex(i);
      if (Number(a.activationPolicy) !== 0 || a.hidden) continue; // regular apps with windows only
      apps.push({ pid: Number(a.processIdentifier), name: a.localizedName.isNil() ? "" : a.localizedName.js, ref: a });
    }
  }
  const frontId = FIXTURE ? FIXTURE.frontPid : frontPid;
  let n = 0;
  for (const a of apps) {
    if (others && a.pid === frontId) continue;
    if (a.pid === Number($.NSProcessInfo.processInfo.processIdentifier)) continue;
    if (DRY) dry(`hide ${a.name}`);
    else a.ref.hide;
    n++;
  }
  return n ? undefined : "No apps to hide";
}

function ejectAction(a) {
  const groups = ejectables();
  const path = typeof a.path === "string" ? a.path : "";
  const group = groups.find((g) => g.some((v) => v.path === path));
  if (!group) return "That disk isn’t mounted any more";
  const r = ejectGroup(group, !!a.force, a.only ? path : null);
  return r.ok ? `⏏ Ejected ${r.name}` : `Couldn’t eject ${r.name}: ${r.why}. Quit that app, or press ⌥↩ to force it.`;
}

function ejectAll(force) {
  const groups = ejectables();
  if (!groups.length) return "No disks to eject";
  const done = [];
  const failed = [];
  for (const g of groups) {
    const r = ejectGroup(g, force);
    if (r.ok) done.push(r.name);
    else failed.push(`${r.name} (${r.why})`);
  }
  if (!failed.length) return `⏏ Ejected ${done.join(", ")}`;
  return `${done.length ? `⏏ Ejected ${done.join(", ")}. ` : ""}Couldn’t eject ${failed.join(", ")}.`;
}

function reveal(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return "Invalid action";
  if (DRY) return dry(`reveal ${path}`);
  ObjC.import("AppKit");
  $.NSWorkspace.sharedWorkspace.selectFileInFileViewerRootedAtPath(path, "");
  return undefined;
}

function act(json) {
  let a;
  try {
    a = JSON.parse(json);
  } catch (e) {
    return "Invalid action";
  }
  // args come from this workflow’s own rows, but keep a hand-edited or stale one harmless
  if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.op !== "string") return "Invalid action";
  let msg;
  switch (a.op) {
    case "toggle":
      if (!Object.prototype.hasOwnProperty.call(NAMES, a.id) || typeof a.value !== "boolean") return "Invalid action";
      msg = toggle(a.id, a.value);
      break;
    case "position": msg = positionSet(String(a.value)); break;
    case "focus": msg = focusRun(a.name, !!a.remember); break;
    case "input": {
      const { sources, handles } = inputSources();
      const s = sources.find((x) => x.id === a.id);
      if (!s) return "That input source isn’t enabled any more";
      msg = selectInputSource(s.id, handles) ? `⌨️ ${clean(s.name)}` : `Couldn’t switch to ${clean(s.name)}`;
      break;
    }
    case "awake": {
      const m = a.minutes;
      if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || m > MAX_AWAKE) return "Invalid action";
      msg = awakeStart(m);
      break;
    }
    case "awake-stop": msg = awakeStop(false); break;
    case "eject": msg = ejectAction(a); break;
    case "eject-all": msg = ejectAll(!!a.force); break;
    case "reveal": msg = reveal(a.path); break;
    case "screensaver": msg = exec("/usr/bin/open", ["-b", "com.apple.ScreenSaver.Engine"]).status === 0 ? undefined : "Couldn’t start the screen saver"; break;
    case "lock": msg = lock(); break;
    case "displaysleep": msg = exec("/usr/bin/pmset", ["displaysleepnow"]).status === 0 ? undefined : "Couldn’t put the displays to sleep"; break;
    case "hide": msg = hideApps(!!a.others); break;
    case "open": openURL(String(a.url || "")); msg = undefined; break;
    default: return "Unknown action";
  }
  if (a.reopen === true) {
    if (!DRY) $.NSThread.sleepForTimeInterval(0.3); // let the change settle so the list shows the new state
    alfredSearch(`${keyword()} ${typeof a.query === "string" ? a.query : ""}`);
  }
  return msg;
}

// ======================================================================

function run(argv) {
  const [cmd, query = ""] = argv;
  if (cmd === "act") {
    let msg;
    try {
      msg = act(query);
    } catch (e) {
      msg = `Couldn’t do that: ${oneLine(e.message || e)}`;
    }
    // Nothing to say prints nothing at all (not even a newline), so the Notification object's
    // "only show if populated" stays silent.
    return [...dryCalls.map((c) => `DRY RUN: ${c}`), msg].filter(Boolean).join("\n") || undefined;
  }
  if (cmd !== "list") return output([info(`Unknown command: ${cmd}`, "", "error")]);
  try {
    return output(listItems(String(query)));
  } catch (e) {
    return output([info("Something went wrong", oneLine(e.message || e), "error")]);
  }
}
