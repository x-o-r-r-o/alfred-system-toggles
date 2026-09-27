#!/usr/bin/env python3
"""End-to-end tests: run the Script Filter and actions the way Alfred does and validate the output.

State comes from JSON fixtures (ST_FIXTURE), which also force dry-run mode, so no test ever changes a
real setting, ejects a disk, starts caffeinate, runs a Shortcut, hides an app or locks the screen.
The RealSystem tests only read (ST_DRY_RUN=1) and never open the Focus list (the user's Shortcuts).
"""
import json, os, plistlib, subprocess, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TMP = tempfile.mkdtemp(prefix="system toggles test ")  # a space, like Alfred's data paths

NOW = 1790000000000

BASE = {
    "macos": 15,
    "prefs": {
        "NSGlobalDomain": {"AppleInterfaceStyle": "Dark", "_HIHideMenuBar": 0},
        "com.apple.finder": {},
        "com.apple.dock": {"autohide": 1, "orientation": "left"},
        "com.apple.WindowManager": {"StandardHideWidgets": 0},
    },
    "nightShift": {"on": False, "mode": 1, "from": [22, 0], "to": [7, 0]},
    "trueTone": {"on": True},
    "lowPower": {"key": "lowpowermode", "value": 0, "on": False},
    "focus": {"known": False},
    "shortcuts": ["Morning Routine", "Toggle Focus", "Log Water"],
    "input": {
        "sources": [
            {"id": "com.apple.keylayout.ABC", "name": "ABC", "type": "TISTypeKeyboardLayout"},
            {"id": "com.apple.keylayout.Russian", "name": "Russian", "type": "TISTypeKeyboardLayout"},
            {"id": "com.apple.inputmethod.SCIM.ITABC", "name": "Pinyin – Simplified", "type": "TISTypeKeyboardInputMode"},
        ],
        "current": "com.apple.keylayout.ABC",
    },
    "volumes": [
        {"path": "/", "name": "Macintosh HD", "device": "/dev/disk3s1s1", "root": True, "internal": True, "local": True},
        {"path": "/System/Volumes/Data", "name": "Data", "device": "/dev/disk3s5", "internal": True, "local": True, "ejectable": False},
        {"path": "/Volumes/Work Drive", "name": "Work Drive", "device": "/dev/disk4s1", "ejectable": True, "removable": True,
         "internal": False, "local": True, "size": 64000000000, "free": 12300000000, "format": "APFS"},
        {"path": "/Volumes/Photos", "name": "Photos", "device": "/dev/disk4s2", "ejectable": True, "removable": True,
         "internal": False, "local": True, "size": 500000000000, "free": 1000000000, "format": "ExFAT"},
        {"path": "/Volumes/Share", "name": "Share", "device": "//me@nas.local/Share", "ejectable": True, "internal": False, "local": False},
        {"path": "/Volumes/Hidden", "name": "Hidden", "device": "/dev/disk9s1", "ejectable": True, "browsable": False},
        {"path": "/Volumes/Internal2", "name": "Internal2", "device": "/dev/disk3s7", "internal": True, "local": True, "ejectable": False},
    ],
    "alive": [],
    "apps": [{"pid": 10, "name": "Safari"}, {"pid": 11, "name": "Mail"}, {"pid": 12, "name": "Finder"}],
    "frontPid": 10,
}


def fixture(**changes):
    f = json.loads(json.dumps(BASE))
    for k, v in changes.items():
        if k == "prefs":
            for dom, vals in v.items():
                f["prefs"].setdefault(dom, {}).update(vals)
        else:
            f[k] = v
    path = os.path.join(TMP, "fixture-%d.json" % abs(hash(json.dumps(f, sort_keys=True))))
    with open(path, "w") as fh:
        json.dump(f, fh, ensure_ascii=False)
    return path


def data_dir(name="default"):
    d = os.path.join(TMP, "data " + name)
    os.makedirs(d, exist_ok=True)
    return d


def call(args, fx=None, data=None, **env):
    e = dict(os.environ, alfred_workflow_data=data or data_dir(), ST_NOW=str(NOW))
    e.pop("ST_DRY_RUN", None)
    e.pop("ST_FIXTURE", None)
    for k in ("keyword_tog", "focus_shortcut", "awake_display"):
        e.pop(k, None)
    e.update(env)
    if fx is not False:
        e["ST_FIXTURE"] = fx or fixture()
    out = subprocess.run(["osascript", "-l", "JavaScript", "./toggles.js", *args], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out.stdout


def validate(data, user_text=False):
    assert isinstance(data.get("items"), list) and data["items"], data
    uids = set()
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
            json.loads(it["arg"])
        else:
            assert "arg" not in it or it.get("autocomplete") is not None, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, it
        assert it.get("uid"), it
        assert it["uid"] not in uids, it["uid"]
        uids.add(it["uid"])
        if not user_text:
            assert "'" not in it["title"] + it.get("subtitle", ""), it  # curly apostrophes only


def sf(query="", fx=None, user_text=False, **kw):
    raw = call(["list", query], fx, **kw)
    data = json.loads(raw)
    validate(data, user_text)
    return data["items"]


def act(a, fx=None, **kw):
    """Run an action; fixtures force dry-run, so this only prints what it would do."""
    return call(["act", a if isinstance(a, str) else json.dumps(a)], fx, **kw).rstrip("\n")


def find(items, prefix):
    for it in items:
        if it["title"].startswith(prefix):
            return it
    raise AssertionError("no row starting %r in %r" % (prefix, [i["title"] for i in items]))


def titles(items):
    return [i["title"] for i in items]


def arg(item, mod=None):
    return json.loads(item["mods"][mod]["arg"] if mod else item["arg"])


class ListTests(unittest.TestCase):
    def test_states(self):
        it = sf()
        t = titles(it)
        self.assertIn("Dark Mode: On ✓", t)
        self.assertIn("Night Shift: Off", t)
        self.assertIn("True Tone: On ✓", t)
        self.assertIn("Low Power Mode: Off", t)
        self.assertIn("Keep Awake: Off", t)
        self.assertIn("Desktop Icons: On ✓", t)
        self.assertIn("Desktop Widgets: On ✓", t)
        self.assertIn("Hidden Files: Off", t)
        self.assertIn("Dock Auto-hide: On ✓", t)
        self.assertIn("Dock Magnification: Off", t)
        self.assertIn("Dock Position: Left", t)
        self.assertIn("Menu Bar Auto-hide: Off", t)
        self.assertIn("Input Source: ABC", t)
        self.assertIn("Eject All (2 disks)", t)
        self.assertEqual(find(it, "Dark Mode")["uid"], "dark")
        self.assertEqual(arg(find(it, "Dark Mode")), {"op": "toggle", "id": "dark", "value": False})
        self.assertEqual(arg(find(it, "Hidden Files")), {"op": "toggle", "id": "hidden", "value": True})
        self.assertEqual(find(it, "Hidden Files")["icon"]["path"], "icons/hidden_off.png")

    def test_order_is_stable_and_uids_fixed(self):
        a, b = sf(), sf()
        self.assertEqual([i["uid"] for i in a], [i["uid"] for i in b])
        self.assertEqual(a[0]["uid"], "dark")

    def test_unsupported_rows_hidden(self):
        t = titles(sf(fx=fixture(nightShift=None, trueTone=None, lowPower=None, macos=13)))
        for gone in ("Night Shift", "True Tone", "Low Power Mode", "Desktop Widgets"):
            self.assertFalse(any(x.startswith(gone) for x in t), gone)

    def test_boolish_prefs(self):
        # defaults can hold "1", "true", "YES", 0, or strings; missing keys use macOS defaults
        fx = fixture(prefs={"com.apple.finder": {"AppleShowAllFiles": "YES", "CreateDesktop": "0"},
                            "com.apple.dock": {"autohide": "false", "magnification": True},
                            "NSGlobalDomain": {"_HIHideMenuBar": 1, "AppleInterfaceStyle": None}})
        t = titles(sf(fx=fx))
        self.assertIn("Hidden Files: On ✓", t)
        self.assertIn("Desktop Icons: Off", t)
        self.assertIn("Dock Auto-hide: Off", t)
        self.assertIn("Dock Magnification: On ✓", t)
        self.assertIn("Menu Bar Auto-hide: On ✓", t)
        self.assertIn("Dark Mode: Off", t)

    def test_unknown_dock_orientation_is_bottom(self):
        self.assertIn("Dock Position: Bottom", titles(sf(fx=fixture(prefs={"com.apple.dock": {"orientation": "top"}}))))

    def test_desktop_icons_macos_versions(self):
        # 14/15: hiding uses Show Items on Desktop, no Finder restart
        it = find(sf(fx=fixture(macos=14)), "Desktop Icons")
        self.assertNotIn("Restarts Finder", it["subtitle"])
        it = find(sf(fx=fixture(macos=26)), "Desktop Icons")
        self.assertIn("Restarts Finder", it["subtitle"])
        it = find(sf(fx=fixture(macos=15, prefs={"com.apple.WindowManager": {"StandardHideDesktopIcons": 1}})), "Desktop Icons")
        self.assertEqual(it["title"], "Desktop Icons: Off")

    def test_auto_appearance_and_schedule_notes(self):
        fx = fixture(prefs={"NSGlobalDomain": {"AppleInterfaceStyleSwitchesAutomatically": 1}},
                     nightShift={"on": True, "mode": 2, "from": [21, 30], "to": [6, 5]})
        it = sf(fx=fx)
        self.assertIn("Appearance is Auto", find(it, "Dark Mode")["subtitle"])
        self.assertIn("21:30–06:05", find(it, "Night Shift")["subtitle"])

    def test_high_power_mode(self):
        it = find(sf(fx=fixture(lowPower={"key": "powermode", "value": 2, "on": False})), "Low Power Mode")
        self.assertIn("High Power Mode", it["subtitle"])
        self.assertIn("administrator", it["subtitle"])

    def test_cmd_keeps_list_open_with_query(self):
        it = find(sf("dark"), "Dark Mode")
        self.assertEqual(arg(it, "cmd"), {"op": "toggle", "id": "dark", "value": False, "reopen": True, "query": "dark"})


class FilterTests(unittest.TestCase):
    def test_fuzzy(self):
        self.assertEqual(sf("dark")[0]["uid"], "dark")
        self.assertEqual(sf("dm")[0]["uid"], "dark")  # initials
        self.assertEqual(sf("insomnia")[0]["uid"], "awake")  # synonym
        self.assertEqual(sf("caffeine")[0]["uid"], "awake:15")  # opens the durations
        self.assertEqual(sf("mba")[0]["uid"], "menubar")
        self.assertEqual(sf("hdn fl")[0]["uid"], "hidden")  # letters in order
        self.assertEqual(sf("DÖCK pos")[0]["uid"], "position")  # case and accents
        self.assertEqual(sf("  night  ")[0]["uid"], "nightshift")

    def test_no_match_and_odd_input(self):
        self.assertEqual(sf("zzzq")[0]["title"], "No matching toggle")
        for q in ("constructor", "__proto__", "\"'`$(rm -rf ~)", "a\nb", "‮dark", "🙂"):
            sf(q)

    def test_filter_skips_readers(self):
        # a failing reader only matters when its row is shown
        fx = fixture(input="broken")
        self.assertEqual(sf("dark", fx=fx)[0]["uid"], "dark")


class EjectTests(unittest.TestCase):
    def test_list_groups_and_filters(self):
        it = sf("eject")
        t = titles(it)
        self.assertEqual(t[0], "Eject All (2 disks)")
        self.assertEqual(t[1:], ["Work Drive", "Photos", "Share"])  # no root, system, hidden or internal volumes
        wd = find(it, "Work Drive")
        self.assertIn("with Photos", wd["subtitle"])
        self.assertIn("12.3 GB free of 64 GB", wd["subtitle"])
        self.assertIn("ctrl", wd["mods"])
        self.assertNotIn("ctrl", find(it, "Share")["mods"])
        self.assertEqual(find(it, "Share")["icon"]["path"], "icons/network.png")
        self.assertEqual(wd["type"], "file:skipcheck")
        self.assertEqual(titles(sf("eject phot")), ["Photos"])
        self.assertEqual(sf("unmount zzz")[0]["title"], "No matching disk")

    def test_none(self):
        it = sf("eject", fx=fixture(volumes=[]))
        self.assertEqual(it[0]["title"], "No disks to eject")
        self.assertFalse(any(x.startswith("Eject") for x in titles(sf(fx=fixture(volumes=[])))))

    def test_single_disk_title(self):
        vols = [v for v in BASE["volumes"] if v["name"] == "Share"]
        self.assertIn("Eject Share", titles(sf(fx=fixture(volumes=vols))))

    def test_eject_commands(self):
        out = act({"op": "eject", "path": "/Volumes/Photos"})
        self.assertIn("DRY RUN: /usr/sbin/diskutil eject disk4", out)
        self.assertIn("Ejected Work Drive, Photos", out)
        out = act({"op": "eject", "path": "/Volumes/Photos", "only": True})
        self.assertIn("diskutil unmount /Volumes/Photos", out)
        out = act({"op": "eject", "path": "/Volumes/Share"})
        self.assertIn("diskutil unmount /Volumes/Share", out)
        out = act({"op": "eject", "path": "/Volumes/Photos", "force": True})
        self.assertIn("diskutil unmountDisk force disk4", out)
        self.assertIn("diskutil eject disk4", out)
        out = act({"op": "eject-all"})
        self.assertIn("Ejected Work Drive, Photos, Share", out)

    def test_busy_disk_names_the_app(self):
        fx = fixture(diskutil={"eject disk4": {"status": 1, "err": "Unmount of disk4 failed: at least one volume could not be unmounted\n"
                                                                  "Unmount was dissented by PID 812 (/System/Applications/Preview.app/Contents/MacOS/Preview)"}})
        out = act({"op": "eject", "path": "/Volumes/Work Drive"}, fx)
        self.assertIn("Couldn’t eject Work Drive, Photos: in use by Preview (PID 812)", out)
        self.assertIn("⌥↩", out)
        out = act({"op": "eject-all"}, fx)
        self.assertIn("Ejected Share", out)
        self.assertIn("Couldn’t eject Work Drive, Photos (in use by Preview (PID 812))", out)

    def test_busy_without_pid(self):
        fx = fixture(diskutil={"unmount /Volumes/Share": {"status": 1, "err": "Unmount failed for /Volumes/Share\n"}})
        self.assertIn("Couldn’t eject Share:", act({"op": "eject", "path": "/Volumes/Share"}, fx))

    def test_gone_and_injection(self):
        self.assertEqual(act({"op": "eject", "path": "/Volumes/Nope"}), "That disk isn’t mounted any more")
        self.assertEqual(act({"op": "eject", "path": "; rm -rf ~"}), "That disk isn’t mounted any more")
        self.assertEqual(act({"op": "eject", "path": 5}), "That disk isn’t mounted any more")
        self.assertEqual(act({"op": "eject-all"}, fixture(volumes=[])), "No disks to eject")

    def test_odd_names(self):
        vols = [{"path": "/Volumes/It's \"x\"\n$(id)", "name": "It's \"x\"\n$(id)‮", "device": "/dev/disk5s1", "ejectable": True}]
        it = sf("eject", fx=fixture(volumes=vols), user_text=True)
        self.assertEqual(it[0]["title"], "It's \"x\" $(id)")  # control and bidi characters stripped for display
        out = act(json.loads(it[0]["arg"]), fixture(volumes=vols))
        self.assertIn("diskutil eject disk5", out)


class InputTests(unittest.TestCase):
    def test_row_switches_to_next(self):
        it = find(sf(), "Input Source")
        self.assertEqual(arg(it), {"op": "input", "id": "com.apple.keylayout.Russian"})
        self.assertEqual(it["autocomplete"], "input ")
        fx = fixture(input=dict(BASE["input"], current="com.apple.inputmethod.SCIM.ITABC"))
        self.assertEqual(arg(find(sf(fx=fx), "Input Source"))["id"], "com.apple.keylayout.ABC")  # wraps around

    def test_list(self):
        it = sf("input")
        self.assertEqual(titles(it), ["ABC ✓", "Russian", "Pinyin – Simplified", "Keyboard Settings…"])
        self.assertEqual(it[2]["icon"]["path"], "icons/globe.png")
        self.assertEqual(titles(sf("keyboard russ")), ["Russian", "Keyboard Settings…"])

    def test_select(self):
        self.assertEqual(act({"op": "input", "id": "com.apple.keylayout.Russian"}),
                         "DRY RUN: TISSelectInputSource(com.apple.keylayout.Russian)\n⌨️ Russian")
        self.assertEqual(act({"op": "input", "id": "nope"}), "That input source isn’t enabled any more")

    def test_single_source(self):
        fx = fixture(input={"sources": BASE["input"]["sources"][:1], "current": "com.apple.keylayout.ABC"})
        it = find(sf(fx=fx), "Input Source")
        self.assertIn("Only one input source", it["subtitle"])
        self.assertEqual(arg(it)["op"], "open")


class AwakeTests(unittest.TestCase):
    def test_durations(self):
        it = sf("awake")
        self.assertEqual(titles(it), ["Keep Awake for 15 min", "Keep Awake for 30 min", "Keep Awake for 1 h", "Keep Awake for 2 h",
                                      "Keep Awake for 4 h", "Keep Awake Until Stopped"])
        for q, m in (("45", 45), ("90m", 90), ("1h30", 90), ("1h 30m", 90), ("1:30", 90), ("2 hours", 120), ("1.5h", 90), ("20 min", 20)):
            self.assertEqual(arg(sf("awake " + q)[0]), {"op": "awake", "minutes": m}, q)
        self.assertEqual(sf("coffee forever")[0]["title"], "Keep Awake Until Stopped")
        self.assertEqual(sf("awake soon")[0]["title"], "Type a duration")
        self.assertEqual(sf("awake 0")[0]["title"], "Choose between 1 minute and 7 days")
        self.assertEqual(sf("awake 99999")[0]["title"], "Choose between 1 minute and 7 days")

    def test_start_state_stop(self):
        d = data_dir("awake")
        fx = fixture(nextPid=4242, alive=[4242])
        out = act({"op": "awake", "minutes": 30}, fx, data=d)
        self.assertEqual(out, "DRY RUN: /usr/bin/caffeinate -di -t 1800\n☕ Keeping your Mac awake for 30 min")
        it = find(sf(fx=fx, data=d, ST_NOW=str(NOW + 7 * 60000)), "Keep Awake")
        self.assertEqual(it["title"], "Keep Awake: On ✓ (23 min left)")
        self.assertEqual(arg(it), {"op": "awake-stop"})
        self.assertEqual(sf("awake", fx=fx, data=d)[0]["title"], "Stop Keeping Awake")
        # expired, or the process is gone: off
        self.assertEqual(find(sf(fx=fx, data=d, ST_NOW=str(NOW + 31 * 60000)), "Keep Awake")["title"], "Keep Awake: Off")
        self.assertEqual(find(sf(fx=fixture(alive=[]), data=d), "Keep Awake")["title"], "Keep Awake: Off")
        out = act({"op": "awake-stop"}, fx, data=d)
        self.assertEqual(out, "DRY RUN: /bin/kill 4242\n💤 Your Mac can sleep again")
        self.assertEqual(act({"op": "awake-stop"}, fx, data=d), "Keep Awake was already off")

    def test_restart_replaces_and_display_setting(self):
        d = data_dir("awake2")
        fx = fixture(nextPid=4242, alive=[4242])
        act({"op": "awake", "minutes": 0}, fx, data=d)
        self.assertIn("until you stop it", find(sf(fx=fx, data=d), "Keep Awake")["title"])
        out = act({"op": "awake", "minutes": 60}, fx, data=d, awake_display="0")
        self.assertEqual(out.split("\n")[:2], ["DRY RUN: /bin/kill 4242", "DRY RUN: /usr/bin/caffeinate -i -t 3600"])

    def test_never_kills_a_reused_pid(self):
        d = data_dir("awake3")
        with open(os.path.join(d, "awake.json"), "w") as f:
            json.dump({"pid": 1, "until": 0}, f)
        # pid 1 isn't in the fixture's alive list → treated as gone, nothing killed
        self.assertEqual(act({"op": "awake-stop"}, data=d), "Keep Awake was already off")

    def test_corrupt_state(self):
        d = data_dir("awake4")
        for bad in ("{", "null", "[1]", '{"pid":"x"}'):
            with open(os.path.join(d, "awake.json"), "w") as f:
                f.write(bad)
            self.assertEqual(find(sf(data=d), "Keep Awake")["title"], "Keep Awake: Off")

    def test_invalid(self):
        for m in (-1, 1.5, "30", 99999, None):
            self.assertEqual(act({"op": "awake", "minutes": m}), "Invalid action")


class FocusTests(unittest.TestCase):
    def test_pick_then_remember(self):
        d = data_dir("focus")
        it = find(sf(data=d), "Focus")
        self.assertEqual(it["autocomplete"], "focus ")
        self.assertIs(it["valid"], False)
        it = sf("focus", data=d)
        self.assertEqual(it[0]["title"], "Toggle Focus")  # focus-like names first
        self.assertNotIn("Create a Focus Shortcut", titles(it))
        out = act(json.loads(it[0]["arg"]), data=d)
        self.assertEqual(out, "DRY RUN: /usr/bin/shortcuts run -- 'Toggle Focus'")
        row = find(sf(data=d), "Focus")
        self.assertEqual(arg(row), {"op": "focus", "name": "Toggle Focus"})
        self.assertEqual(sf("focus", data=d)[1]["title"], "Toggle Focus ✓")

    def test_configured_wins_and_state(self):
        fx = fixture(focus={"known": True, "on": True, "name": "Work"})
        row = find(sf(fx=fx, focus_shortcut="Morning Routine"), "Focus")
        self.assertEqual(row["title"], "Focus: On ✓ (Work)")
        self.assertEqual(arg(row)["name"], "Morning Routine")
        self.assertEqual(find(sf(fx=fixture(focus={"known": True, "on": False})), "Focus")["title"], "Focus: Off")

    def test_create_hint_and_errors(self):
        it = sf("focus", fx=fixture(shortcuts=[]))
        self.assertEqual(it[-1]["title"], "Create a Focus Shortcut")
        self.assertEqual(act({"op": "focus", "name": "  "}), "Pick a Focus Shortcut first")
        out = act({"op": "focus", "name": "-h; rm -rf ~"})
        self.assertIn("shortcuts run -- '-h; rm -rf ~'", out)


class ToggleActionTests(unittest.TestCase):
    def test_system_events_toggles(self):
        self.assertEqual(act({"op": "toggle", "id": "dark", "value": False}), "DRY RUN: System Events: dark mode = false\n☀️ Dark Mode off")
        self.assertIn("dock preferences autohide = true", act({"op": "toggle", "id": "dockhide", "value": True}))
        self.assertIn("dock preferences magnification = false", act({"op": "toggle", "id": "magnify", "value": False}))
        self.assertIn("autohide menu bar = true", act({"op": "toggle", "id": "menubar", "value": True}))
        self.assertIn("screen edge = right", act({"op": "position", "value": "right"}))
        self.assertEqual(act({"op": "position", "value": "top"}), "Unknown Dock position")

    def test_finder_toggles(self):
        out = act({"op": "toggle", "id": "hidden", "value": True})
        self.assertEqual(out.split("\n")[:2], ["DRY RUN: /usr/bin/defaults write com.apple.finder AppleShowAllFiles -bool true",
                                               "DRY RUN: /usr/bin/killall Finder"])
        out = act({"op": "toggle", "id": "desktop", "value": False}, fixture(macos=26))
        self.assertIn("CreateDesktop -bool false", out)
        self.assertIn("killall Finder", out)
        out = act({"op": "toggle", "id": "desktop", "value": False}, fixture(macos=14))
        self.assertIn("StandardHideDesktopIcons -bool true", out)
        self.assertNotIn("killall", out)
        # showing again undoes whichever setting hid them
        fx = fixture(macos=15, prefs={"com.apple.finder": {"CreateDesktop": False}, "com.apple.WindowManager": {"StandardHideDesktopIcons": True}})
        out = act({"op": "toggle", "id": "desktop", "value": True}, fx)
        self.assertIn("StandardHideDesktopIcons -bool false", out)
        self.assertIn("CreateDesktop -bool true", out)
        self.assertIn("killall Finder", out)
        self.assertIn("StandardHideWidgets -bool true", act({"op": "toggle", "id": "widgets", "value": False}))

    def test_brightness_clients(self):
        self.assertEqual(act({"op": "toggle", "id": "nightshift", "value": True}), "DRY RUN: CBBlueLightClient setEnabled:true\n🌇 Night Shift on")
        self.assertIn("CBTrueToneClient setEnabled:false", act({"op": "toggle", "id": "truetone", "value": False}))

    def test_low_power_uses_labelled_admin_prompt(self):
        out = act({"op": "toggle", "id": "lowpower", "value": True})
        self.assertIn('do shell script "/usr/bin/pmset -a lowpowermode 1" with prompt "System Toggles wants to turn on Low Power Mode', out)
        self.assertIn("with administrator privileges", out)
        self.assertNotIn("sudo", out)
        out = act({"op": "toggle", "id": "lowpower", "value": False}, fixture(lowPower={"key": "powermode", "value": 1, "on": True}))
        self.assertIn("pmset -a powermode 0", out)
        self.assertEqual(act({"op": "toggle", "id": "lowpower", "value": True}, fixture(lowPower=None)),
                         "Low Power Mode isn’t available on this Mac")

    def test_reopen(self):
        out = act({"op": "toggle", "id": "dark", "value": True, "reopen": True, "query": "da"}, keyword_tog="sys")
        self.assertIn('DRY RUN: Alfred search "sys da"', out)
        out = act({"op": "toggle", "id": "dark", "value": True, "reopen": True, "query": "da"}, keyword_tog="  ")
        self.assertIn('Alfred search "tog da"', out)

    def test_screen_and_apps(self):
        self.assertEqual(act({"op": "screensaver"}), "DRY RUN: /usr/bin/open -b com.apple.ScreenSaver.Engine")
        self.assertEqual(act({"op": "lock"}), "DRY RUN: SACLockScreenImmediate()")
        self.assertEqual(act({"op": "displaysleep"}), "DRY RUN: /usr/bin/pmset displaysleepnow")
        self.assertEqual(act({"op": "hide", "others": False}), "DRY RUN: hide Safari\nDRY RUN: hide Mail\nDRY RUN: hide Finder")
        self.assertEqual(act({"op": "hide", "others": True}), "DRY RUN: hide Mail\nDRY RUN: hide Finder")
        self.assertEqual(act({"op": "hide", "others": True}, fixture(apps=[])), "No apps to hide")

    def test_open_only_known_schemes(self):
        self.assertEqual(act({"op": "open", "url": "shortcuts://create-shortcut"}), "DRY RUN: open shortcuts://create-shortcut")
        self.assertEqual(act({"op": "open", "url": "file:///etc/passwd"}), "")
        self.assertEqual(act({"op": "reveal", "path": "relative"}), "Invalid action")

    def test_invalid_actions(self):
        for a in ("", "nope", "[]", "null", '{"op":5}', '{"op":"toggle","id":"__proto__","value":true}',
                  '{"op":"toggle","id":"dark","value":"false"}', '{"op":"toggle","id":"constructor","value":true}'):
            self.assertIn(act(a), ("Invalid action",), a)
        self.assertEqual(act({"op": "nope"}), "Unknown action")

    def test_every_listed_arg_runs(self):
        # every actionable row of every view produces a valid action in dry run
        for q in ("", "eject", "input", "awake", "focus", "position"):
            for it in sf(q):
                for a in [it.get("arg")] + [m["arg"] for m in (it.get("mods") or {}).values()]:
                    if a:
                        out = act(a)
                        self.assertNotIn("Invalid action", out, (q, a))
                        self.assertNotIn("Unknown", out, (q, a))


class SafetyTests(unittest.TestCase):
    def test_fixture_forces_dry_run_even_if_env_says_otherwise(self):
        out = act({"op": "toggle", "id": "dark", "value": False}, ST_DRY_RUN="0")
        self.assertTrue(out.startswith("DRY RUN:"))

    def test_silent_success_prints_nothing(self):
        raw = call(["act", json.dumps({"op": "open", "url": "file:///x"})])
        self.assertEqual(raw, "")


class RealSystemTests(unittest.TestCase):
    """Read-only against this Mac: ST_DRY_RUN=1, no fixture. Never opens the Focus list."""

    def real(self, query):
        raw = call(["list", query], False, ST_DRY_RUN="1")
        data = json.loads(raw)
        validate(data)
        return data["items"]

    def test_main_list_reads_and_is_fast(self):
        self.real("")  # warm up
        start = time.time()
        it = self.real("")
        elapsed = time.time() - start
        self.assertTrue(any(i["title"].startswith("Dark Mode: ") for i in it))
        self.assertTrue(any(i["title"].startswith("Input Source: ") for i in it))
        self.assertLess(elapsed, 1.0)  # ~0.2 s here; generous for loaded CI machines

    def test_views(self):
        self.assertTrue(self.real("eject"))
        self.assertTrue(self.real("input"))
        self.assertTrue(self.real("position"))

    def test_real_dry_actions(self):
        out = call(["act", json.dumps({"op": "toggle", "id": "dark", "value": True})], False, ST_DRY_RUN="1")
        self.assertTrue(out.startswith("DRY RUN: System Events"))


class BuildTests(unittest.TestCase):
    def test_plist(self):
        subprocess.run(["python3", os.path.join(ROOT, "tools", "build.py"), "--check"], check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            info = plistlib.load(f)
        self.assertEqual(info["bundleid"], "io.github.x-o-r-r-o.system-toggles")
        sf_obj = [o for o in info["objects"] if o["type"] == "alfred.workflow.input.scriptfilter"][0]
        self.assertEqual(sf_obj["config"]["keyword"], "{var:keyword_tog}")
        self.assertIn("## Usage", info["readme"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
