#!/usr/bin/env python3
"""StreamScope Agent — runs on the gaming PC.

Collects streaming logs into one archive and serves StreamScope plus that archive on the home network,
so every device (PC, phone, tablet) opening http://<pc>:<port>/ sees the same sessions and history.

Sources (all optional, see config.json):
  * Vibepollo/Sunshine session history via its web API (same files as the "export" button),
  * Steam Remote Play host log  (Steam\\logs\\streaming_log*.txt),
  * StreamLight/Moonlight client logs from a folder shared by the client PC (e.g. \\\\K12\\StreamLightLogs).

Python standard library only. Run:  python streamscope_agent.py   (or pythonw for no console window).
"""
import base64
import http.cookiejar
import json
import logging
import mimetypes
import os
import re
import shutil
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(AGENT_DIR)                 # repo root: index.html, css/, js/
CONFIG_PATH = os.environ.get("STREAMSCOPE_CONFIG") or os.path.join(AGENT_DIR, "config.json")

DEFAULTS = {
    "port": 8765,
    "bind": "0.0.0.0",
    "check_every_minutes": 0,   # 0 = no periodic checks: collect at start-up and on request; K12 logs via watcher
    "archive_dir": r"%LOCALAPPDATA%\StreamScope\archive",
    "vibepollo": {"enabled": True, "url": "https://localhost:47990", "username": "", "password": "", "max_sessions": 300, "import_dirs": []},
    "steam": {"enabled": True, "logs_dir": r"C:\Program Files (x86)\Steam\logs"},
    "client_logs": {"enabled": True, "dirs": []},
    "streamtweak": {"enabled": True, "path": r"%LOCALAPPDATA%\StreamTweak\sessions.json"},
}

log = logging.getLogger("streamscope")


def load_config():
    cfg = json.loads(json.dumps(DEFAULTS))
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8-sig") as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    cfg["archive_dir"] = os.path.expandvars(cfg["archive_dir"])
    cfg["vibepollo"]["import_dirs"] = [os.path.expandvars(d) for d in cfg["vibepollo"].get("import_dirs") or []]
    cfg["streamtweak"]["path"] = os.path.expandvars(cfg["streamtweak"].get("path") or "")
    return cfg


# ---------------------------------------------------------------- archive

class Archive:
    SUBDIRS = ("vibepollo", "steam", "client", "trace", "streamtweak", "manual")

    def __init__(self, root):
        self.root = root
        for s in self.SUBDIRS:
            os.makedirs(os.path.join(root, s), exist_ok=True)
        self.lock = threading.Lock()

    def path(self, file_id):
        """file_id is '<subdir>/<name>'; refuses anything that escapes the archive."""
        sub, _, name = file_id.partition("/")
        if sub not in self.SUBDIRS or not name or name != os.path.basename(name):
            raise ValueError("bad file id")
        return os.path.join(self.root, sub, name)

    def list(self):
        out = []
        for sub in self.SUBDIRS:
            d = os.path.join(self.root, sub)
            for name in sorted(os.listdir(d)):
                p = os.path.join(d, name)
                if os.path.isfile(p) and not name.endswith(".tmp"):
                    st = os.stat(p)
                    out.append({"id": f"{sub}/{name}", "name": name, "source": sub, "size": st.st_size, "mtime": int(st.st_mtime)})
        return out

    def write(self, sub, name, data):
        p = self.path(f"{sub}/{name}")
        tmp = p + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)

    def same(self, sub, name, size):
        try:
            return os.path.getsize(self.path(f"{sub}/{name}")) == size
        except OSError:
            return False

    # Small JSON documents shared by every device: saved-session history and UI prefs (ranges, hidden...).
    def read_doc(self, name, default):
        p = os.path.join(self.root, name)
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    def write_doc(self, name, value):
        with self.lock:
            p = os.path.join(self.root, name)
            with open(p + ".tmp", "w", encoding="utf-8") as f:
                json.dump(value, f, ensure_ascii=False)
            os.replace(p + ".tmp", p)


# ---------------------------------------------------------------- collectors

class Status:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {"last_run": None, "sources": {}}

    def set(self, source, ok, msg, **extra):
        with self.lock:
            self.data["sources"][source] = {"ok": ok, "msg": msg, "at": int(time.time()), **extra}

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.data))


def collect_steam(cfg, arc, status):
    d = cfg["logs_dir"]
    if not os.path.isdir(d):
        status.set("steam", False, f"brak folderu {d}")
        return
    copied = 0
    for fname in ("streaming_log.txt", "streaming_log.previous.txt"):
        src = os.path.join(d, fname)
        if not os.path.isfile(src):
            continue
        # Steam rotates streaming_log.txt into .previous.txt, so name archived copies after the file's first
        # timestamp: one archive file per log generation, updated in place while it grows.
        with open(src, "rb") as f:
            head = f.read(512).decode("utf-8", "replace")   # the log starts with blank lines
        m = re.search(r"\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]", head)
        stamp = "".join(m.groups()[:3]) + "-" + "".join(m.groups()[3:]) if m else "unknown"
        name = f"streaming_log-{stamp}.txt"
        size = os.path.getsize(src)
        if not arc.same("steam", name, size):
            with open(src, "rb") as f:
                arc.write("steam", name, f.read())
            copied += 1
    status.set("steam", True, f"OK, zaktualizowano {copied}" if copied else "OK, bez zmian")


CLIENT_RE = re.compile(r"^(StreamLight|Moonlight)-\d+\.log$", re.I)


def collect_client(cfg, arc, status):
    dirs = cfg.get("dirs") or []
    if not dirs:
        status.set("client", False, "nie ustawiono folderu z logami klienta (client_logs.dirs)")
        return
    copied, errors = 0, []
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError as e:
            errors.append(f"{d}: {e.strerror or e}")
            continue
        for name in names:
            if not CLIENT_RE.match(name):
                continue
            src = os.path.join(d, name)
            try:
                size = os.path.getsize(src)
                # A log still being written grows; copying again when the size changes keeps it current.
                if not arc.same("client", name, size):
                    shutil.copyfile(src, arc.path(f"client/{name}"))
                    copied += 1
            except OSError as e:
                errors.append(f"{name}: {e.strerror or e}")
    if errors:
        status.set("client", False, "; ".join(errors[:3]), copied=copied)
    else:
        status.set("client", True, f"OK, skopiowano {copied}" if copied else "OK, bez zmian")


# ---------------------------------------------------------------- StreamTweak

def collect_streamtweak(cfg, arc, status):
    """StreamTweak's session history (StreamLight telemetry + host load, ~600 points per session series).
    One growing JSON file on this PC; copied whenever it changes."""
    if not cfg.get("enabled", True):
        return
    p = cfg.get("path") or ""
    if not os.path.isfile(p):
        status.set("streamtweak", True, "nie znaleziono historii StreamTweak (pomijam)")
        return
    st = os.stat(p)
    dst = arc.path("streamtweak/sessions.json")
    if os.path.exists(dst) and os.path.getsize(dst) == st.st_size and os.path.getmtime(dst) >= st.st_mtime:
        status.set("streamtweak", True, "OK, bez zmian")
        return
    with open(p, "rb") as f:
        arc.write("streamtweak", "sessions.json", f.read())
    status.set("streamtweak", True, "OK, zaktualizowano")


# ---------------------------------------------------------------- Moonlight VRR diagnostic captures

def read_vrrtrace_rows(path):
    """Yield CSV rows (lists) from a Moonlight .vrrtrace: 'MLVRR1\\n' + blocks of
    [u32 LE length][Qt qCompress blob = u32 BE raw size + zlib stream] holding CSV text."""
    import csv, io, struct, zlib
    with open(path, "rb") as f:
        if f.read(7) != b"MLVRR1\n":
            raise ValueError("not a vrrtrace file")
        tail = ""
        while True:
            h = f.read(4)
            if len(h) < 4:
                break
            blob = f.read(struct.unpack("<I", h)[0])
            text = tail + zlib.decompress(blob[4:]).decode("utf-8", "replace")
            # Blocks may split a line; keep the unfinished end for the next block.
            cut = text.rfind("\n")
            tail = text[cut + 1:]
            yield from csv.reader(io.StringIO(text[:cut + 1]))
        if tail:
            yield from csv.reader(io.StringIO(tail))


def summarize_trace(paths, first_frame_unix):
    """Per-second client timeline from per-frame rows: frames received/presented/dropped, receive→present
    latency (p50/p95) and decode time. Trace clocks are monotonic µs; second 0 = first received frame."""
    per = {}
    lat_all, dec_all = [], []
    tot = {"frames": 0, "presented": 0, "dropped": 0}
    first = None
    footer_ok = True
    tot["lost"] = 0
    for p in paths:
        idx = None
        prev_frame = None      # frame numbers are consecutive; a jump means frames lost in the network
        for r in read_vrrtrace_rows(p):
            if not r:
                continue
            if r[0].startswith("#"):
                footer_ok = footer_ok and "rows_dropped=0" in ",".join(r)
                continue
            if r[0] == "trace_schema":
                idx = {k: i for i, k in enumerate(r)}
                continue
            if idx is None:
                continue
            g = lambda k: r[idx[k]] if k in idx and idx[k] < len(r) else ""
            rx = g("frame_receive_us")
            if not rx:
                continue
            rx = int(rx)
            if first is None or rx < first:
                first = rx
            b = per.setdefault(rx // 1_000_000, {"rx": 0, "pres": 0, "drop": 0, "lost": 0, "lat": [], "dec": []})
            b["rx"] += 1
            tot["frames"] += 1
            fr = g("frame")
            if fr:
                fr = int(fr)
                if prev_frame is not None and fr > prev_frame + 1:
                    b["lost"] += fr - prev_frame - 1
                    tot["lost"] += fr - prev_frame - 1
                prev_frame = fr if prev_frame is None else max(prev_frame, fr)
            pe = g("present_end_us")
            if pe and pe != "0":
                lat = (int(pe) - rx) / 1000.0
                if 0 <= lat < 1000:
                    b["pres"] += 1; b["lat"].append(lat); lat_all.append(lat); tot["presented"] += 1
            if g("dropped") not in ("", "0"):
                b["drop"] += 1; tot["dropped"] += 1
            ds, dc = g("decode_submit_us"), g("decode_complete_us")
            if ds and dc and ds != "0" and dc != "0":
                d = (int(dc) - int(ds)) / 1000.0
                if 0 <= d < 500:
                    b["dec"].append(d); dec_all.append(d)
    if first is None:
        return None
    def pct(a, p):
        if not a:
            return None
        a = sorted(a)
        return round(a[min(len(a) - 1, int(p * (len(a) - 1)))], 2)
    base = first // 1_000_000
    secs = sorted(per)
    return {
        "first_frame_unix": first_frame_unix,
        "t": [s - base for s in secs],
        "rx": [per[s]["rx"] for s in secs],
        "pres": [per[s]["pres"] for s in secs],
        "drop": [per[s]["drop"] for s in secs],
        "lost": [per[s]["lost"] for s in secs],
        "lat50": [pct(per[s]["lat"], 0.5) for s in secs],
        "lat95": [pct(per[s]["lat"], 0.95) for s in secs],
        "dec50": [pct(per[s]["dec"], 0.5) for s in secs],
        "totals": {**tot, "lat50": pct(lat_all, 0.5), "lat95": pct(lat_all, 0.95), "lat99": pct(lat_all, 0.99),
                   "dec50": pct(dec_all, 0.5), "seconds": len(secs), "complete": footer_ok},
    }


def _log_seconds(line):
    m = re.match(r"(\d+):(\d\d):(\d\d) - ", line)
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) if m else None


def collect_vrr(cfg, arc, status, state):
    """Moonlight 'VRR diagnostic capture' folders: <dir>/capture-info.json, Moonlight.log, *.vrrtrace.
    Finished captures become client/Moonlight-<epoch>.log (same format as Temp logs, so pairing with
    Vibepollo works unchanged) plus trace/Moonlight-<epoch>.json (per-second client timeline)."""
    dirs = cfg.get("vrr_dirs") or []
    if not dirs:
        return
    done = state.setdefault("vrr_captures", {})
    new, errors = 0, []
    for root in dirs:
        try:
            entries = os.listdir(root)
        except OSError as e:
            errors.append(f"{root}: {e.strerror or e}")
            continue
        for name in entries:
            cap = os.path.join(root, name)
            info_p = os.path.join(cap, "capture-info.json")
            if not os.path.isfile(info_p):
                continue
            try:
                with open(info_p, encoding="utf-8-sig") as f:
                    info = json.load(f)
                if not info.get("finished_utc"):
                    continue                      # still streaming: the capture is finalised at the end
                traces = sorted(os.path.join(cap, n) for n in os.listdir(cap) if n.endswith(".vrrtrace"))
                # "v2": summaries with lost-frame counts; bumping the prefix reprocesses older captures.
                sig = f"v2|{info['finished_utc']}|{sum(os.path.getsize(t) for t in traces)}"
                if done.get(name) == sig:
                    continue
                with open(os.path.join(cap, "Moonlight.log"), encoding="utf-8", errors="replace") as f:
                    log_text = f.read()
                lines = log_text.splitlines()
                started = datetime.fromisoformat(info["started_utc"].replace("Z", "+00:00")).timestamp()
                t_cap = next((_log_seconds(l) for l in lines if "VRR diagnostic capture" in l), None)
                t_cap = t_cap if t_cap is not None else next((_log_seconds(l) for l in lines if _log_seconds(l) is not None), 0)
                epoch = int(round(started - t_cap))   # unix time of log 00:00:00, like Moonlight-<unix>.log names
                t_video = next((_log_seconds(l) for l in lines if "Video stream is" in l or "Received first video packet" in l), t_cap)
                summary = summarize_trace(traces, epoch + t_video) if traces else None
                # Captures from one Moonlight run share (almost) the same epoch: the capture id keeps names unique.
                base = f"Moonlight-{epoch}-vrr-{name.split('-')[3] if name.count('-') >= 3 else name[-8:]}"
                arc.write("client", base + ".log", log_text.encode("utf-8"))
                if summary:
                    summary.update(schema="streamscope-client-trace", version=1, log=base + ".log", capture=info)
                    arc.write("trace", base + ".json", json.dumps(summary, separators=(",", ":")).encode("utf-8"))
                done[name] = sig
                new += 1
                log.info("vrr capture %s -> %s (%s frames)", name, base, summary["totals"]["frames"] if summary else 0)
            except (OSError, ValueError, KeyError) as e:
                errors.append(f"{name}: {e}")
    if errors:
        status.set("vrr", False, "; ".join(errors[:2]))
    else:
        status.set("vrr", True, f"OK, nowe sesje: {new}" if new else "OK, bez zmian")


class Vibepollo:
    """Minimal client for the Vibepollo/Sunshine web API, mirroring what its Stats page does."""

    def __init__(self, cfg):
        self.base = cfg["url"].rstrip("/")
        self.user, self.password = cfg.get("username", ""), cfg.get("password", "")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE          # the host's web UI uses a self-signed certificate
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(self.jar))
        self.logged_in = False
        self.basic = False

    def _req(self, method, path, body=None, params=None, headers=None, basic=False, timeout=30):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        req.add_header("X-Requested-With", "XMLHttpRequest")   # the panel's API expects its XHR marker
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if basic:
            token = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
            req.add_header("Authorization", "Basic " + token)
        with self.opener.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "null")

    def login(self):
        """Same flow as the panel: fetch a CSRF token, POST /api/auth/login, then ride the session cookie.
        Older Sunshine/Apollo builds without /api/auth fall back to /api/login and Basic auth."""
        if self.logged_in:
            return
        try:
            csrf = (self._req("GET", "/api/csrf-token") or {}).get("csrf_token", "")
            res = self._req("POST", "/api/auth/login", {"username": self.user, "password": self.password, "remember_me": True},
                            headers={"X-CSRF-Token": csrf} if csrf else None)
            if isinstance(res, dict) and res.get("status") is False:
                raise PermissionError(res.get("error") or "login failed")
            self.basic = False
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise PermissionError("login failed")
            if e.code != 404:
                raise
            try:
                self._req("POST", "/api/login", {"username": self.user, "password": self.password})
            except urllib.error.HTTPError as e2:
                if e2.code not in (404, 405):
                    raise
            self.basic = True
        self.logged_in = True

    def get(self, path, params=None, timeout=30):
        self.login()
        try:
            return self._req("GET", path, params=params, basic=self.basic, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 401:   # session cookie expired: log in again once
                self.logged_in = False
                self.login()
                return self._req("GET", path, params=params, basic=self.basic, timeout=timeout)
            raise

    def sessions(self, limit):
        out, offset, page = [], 0, 100
        while offset < limit:
            res = self.get("/api/history/sessions", {"limit": page, "offset": offset})
            batch = res.get("sessions", []) if isinstance(res, dict) else (res or [])
            out.extend(batch)
            if len(batch) < page:
                break
            offset += page
        return out

    def detail(self, uuid):
        """Like the panel: the normal view first; the full (untruncated) one only when the panel says data was
        cut. Building a full multi-hour session takes the server well over 30 s, hence the long timeout."""
        path = f"/api/history/sessions/{urllib.parse.quote(uuid)}"
        t0 = time.time()
        # Healthy sessions come back in seconds; some the panel never answers (and it stalls meanwhile),
        # so a moderate timeout plus skip-after-retries beats waiting minutes.
        d = self.get(path, timeout=150)
        full = isinstance(d, dict) and (d.get("samples_truncated") or d.get("events_truncated"))
        if full:
            try:
                d = self.get(path, {"full": "1"}, timeout=180)
            except (urllib.error.URLError, OSError) as e:
                # The panel can hang building very long sessions; keep the truncated view (flagged as such).
                log.warning("vibepollo session %s: full data unavailable (%s), keeping truncated view", uuid, e)
                full = False
        log.info("vibepollo session %s fetched in %.0f s%s", uuid, time.time() - t0, " (full)" if full else "")
        return d


def _sid(item):
    return item.get("uuid") or item.get("session_uuid") or item.get("id")


def merge_sessions(details):
    """Same merge as the Vibepollo UI when exporting a group of reconnects: one file, all samples/events."""
    details = sorted(details, key=lambda d: d.get("start_time_unix") or 0)
    base = dict(details[0])
    samples = sorted((s for d in details for s in (d.get("samples") or [])), key=lambda s: s.get("timestamp_unix", 0))
    events = sorted((e for d in details for e in (d.get("events") or [])), key=lambda e: e.get("timestamp_unix", 0))
    starts = [d["start_time_unix"] for d in details if d.get("start_time_unix")]
    ends = [d["end_time_unix"] for d in details if d.get("end_time_unix")]
    if starts:
        base["start_time_unix"] = min(starts)
    if ends:
        base["end_time_unix"] = max(ends)
    if starts and ends:
        base["duration_seconds"] = base["end_time_unix"] - base["start_time_unix"]
    base.update(samples=samples, events=events, total_samples=len(samples),
                samples_truncated=any(d.get("samples_truncated") for d in details),
                events_truncated=any(d.get("events_truncated") for d in details))
    return base


def export_name(d):
    """Identical to the Vibepollo UI export name, so manual exports and agent files dedupe in StreamScope."""
    app = re.sub(r"[^a-z0-9_-]+", "_", d.get("app_name") or "session", flags=re.I)[:40]
    t = datetime.fromtimestamp(d.get("start_time_unix") or time.time(), tz=timezone.utc)
    return f"sunshine-session-{app}-{t.strftime('%Y-%m-%dT%H-%M-%S')}.json"


GROUP_GAP = 120   # s between one session's end and the next start (same app) to treat them as one reconnect group


VIBE_FILE_RE = re.compile(r"^sunshine-session-.+\.json$", re.I)


def import_vibepollo_dirs(cfg, arc):
    """Older manual exports (e.g. Downloads) — the panel's history may not reach back that far."""
    n = 0
    for d in cfg.get("import_dirs") or []:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            # "(1)" copies of the same export are duplicates; StreamScope dedupes by content anyway.
            if VIBE_FILE_RE.match(name) and "(" not in name:
                src = os.path.join(d, name)
                if not os.path.exists(arc.path(f"vibepollo/{name}")):
                    shutil.copyfile(src, arc.path(f"vibepollo/{name}"))
                    n += 1
    return n


def collect_vibepollo(cfg, arc, status, state):
    imported = import_vibepollo_dirs(cfg, arc)
    if imported:
        log.info("imported %d exported Vibepollo files", imported)
    if not cfg.get("username"):
        status.set("vibepollo", False, "uzupełnij vibepollo.username i password w agent/config.json")
        return
    api = Vibepollo(cfg)
    try:
        items = api.sessions(int(cfg.get("max_sessions", 300)))
    except PermissionError:
        status.set("vibepollo", False, "złe dane logowania do panelu Vibepollo (sprawdź username/password w agent/config.json)")
        return
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:120]
        except Exception:
            pass
        status.set("vibepollo", False, "złe dane logowania do panelu Vibepollo" if e.code in (401, 403) else f"HTTP {e.code} {e.url.split('47990')[-1] if e.url else ''} {body}".strip())
        return
    except (urllib.error.URLError, OSError, ValueError) as e:
        status.set("vibepollo", False, f"panel Vibepollo niedostępny ({getattr(e, 'reason', e)}), ponowię za 2 min")
        state["vibepollo_incomplete"] = True   # e.g. agent started before Vibepollo after a reboot
        return

    finished = [i for i in items if _sid(i) and i.get("end_time_unix")]
    finished.sort(key=lambda i: i.get("start_time_unix") or 0)
    groups, cur = [], None
    for it in finished:
        if cur and it.get("app_name") == cur[-1].get("app_name") and (it.get("start_time_unix") or 0) - (cur[-1].get("end_time_unix") or 0) <= GROUP_GAP:
            cur.append(it)
        else:
            cur = [it]
            groups.append(cur)

    done = set(state.get("vibepollo_groups", []))
    fails = state.setdefault("vibepollo_failures", {})     # group key → failed attempts
    MAX_TRIES = 2
    RECENT = 7 * 86400   # newer sessions are never given up on: the panel only stalls now and then
    gkey = lambda g: ",".join(sorted(_sid(i) for i in g))
    # Sessions already in the archive (e.g. imported manual exports) need no download: same name = same session.
    for g in groups:
        if gkey(g) not in done and os.path.exists(arc.path("vibepollo/" + export_name({"app_name": g[0].get("app_name"), "start_time_unix": g[0].get("start_time_unix")}))):
            done.add(gkey(g))
    state["vibepollo_groups"] = sorted(done)
    pending = [g for g in reversed(groups) if gkey(g) not in done]                       # newest first
    recent = lambda g: (g[-1].get("end_time_unix") or 0) > time.time() - RECENT
    gives_up = lambda g: fails.get(gkey(g), 0) >= MAX_TRIES and not recent(g)
    todo = [g for g in pending if not gives_up(g)]
    skipped = len(pending) - len(todo)
    saved, failed_in_row, failed = 0, 0, 0
    for n, g in enumerate(todo, 1):
        status.set("vibepollo", True, f"pobieram sesje z panelu: {n}/{len(todo)}", sessions=len(finished))
        key = gkey(g)
        try:
            merged = merge_sessions([api.detail(_sid(i)) for i in g])
        except (urllib.error.URLError, OSError, ValueError) as e:
            first = g[0]
            when = datetime.fromtimestamp(first.get("start_time_unix") or 0).strftime("%Y-%m-%d %H:%M")
            log.warning("vibepollo session %s (%s %s) failed: %s", _sid(first), first.get("app_name"), when, e)
            fails[key] = fails.get(key, 0) + 1
            arc.write_doc("agent_state.json", state)
            failed += 1
            failed_in_row += 1
            if failed_in_row >= 2:   # the panel stalls after a hung request: stop now, the next cycle continues
                break
            continue
        failed_in_row = 0
        arc.write("vibepollo", export_name(merged), json.dumps(merged).encode("utf-8"))
        done.add(key)
        state["vibepollo_groups"] = sorted(done)
        arc.write_doc("agent_state.json", state)   # keep progress even if the agent is closed mid-way
        saved += 1
    left = len(todo) - saved
    skipped_all = skipped + sum(1 for g in todo if gives_up(g))
    note = f"; panel nie oddał {skipped_all} starszych sesji (pominięte, szczegóły w agent.log)" if skipped_all else ""
    if left > (skipped_all - skipped):
        status.set("vibepollo", True, f"pobrano {saved}, zostało {left - (skipped_all - skipped)} (ponowię za 2 min){note}", sessions=len(finished))
        state["vibepollo_incomplete"] = True
    else:
        state["vibepollo_incomplete"] = False
        status.set("vibepollo", True, (f"OK, nowe sesje: {saved}" if saved else "OK, bez nowych sesji") + note, sessions=len(finished))


class Collector(threading.Thread):
    """Runs a full collection at start-up, then only on request ("Pobierz nowe dane" / POST /api/collect).
    check_every_minutes > 0 re-enables periodic runs (the old poll_seconds is ignored). K12 logs additionally arrive via ShareWatcher."""

    RETRY_SECONDS = 120
    MAX_RETRIES = 5

    def __init__(self, cfg, arc, status):
        super().__init__(daemon=True)
        self.cfg, self.arc, self.status = cfg, arc, status
        self.wake = threading.Event()
        self.state = arc.read_doc("agent_state.json", {})
        self.lock = threading.Lock()          # one collection at a time (full run vs. watcher-triggered)
        self.done = threading.Condition()
        self.runs = 0                          # completed full runs, for callers that wait for one

    def run(self):
        poll = int(self.cfg.get("check_every_minutes") or 0) * 60
        retries = 0
        while True:
            self.run_once()
            # Vibepollo unreachable or sessions left: retry a few times on its own, then wait for the button.
            retry = self.state.get("vibepollo_incomplete") and retries < self.MAX_RETRIES
            retries = retries + 1 if retry else 0
            if self.state.get("vibepollo_incomplete") and not retry:
                with self.status.lock:
                    v = self.status.data["sources"].get("vibepollo")
                    if v:
                        v["msg"] = v["msg"].replace("ponowię za 2 min", "kliknij „Pobierz nowe dane”, żeby spróbować ponownie")
            wait = self.RETRY_SECONDS if retry else (max(15, poll) if poll > 0 else None)
            if self.wake.wait(wait):
                retries = 0
            self.wake.clear()

    def request_and_wait(self, timeout):
        """Ask for a full run and block until it finishes (or timeout). Returns True when it completed."""
        with self.done:
            # A run already in progress may have passed some sources: wait for the next complete one.
            target = self.runs + (2 if self.status.snapshot().get("running") else 1)
            self.wake.set()
            return self.done.wait_for(lambda: self.runs >= target, timeout)

    def run_once(self):
        with self.lock:
            with self.status.lock:
                self.status.data["running"] = True
            # Quick local sources first, so a slow Vibepollo download never delays Steam/K12 logs.
            for name, fn, section in (("steam", collect_steam, "steam"), ("client", collect_client, "client_logs"),
                                      ("vrr", collect_vrr, "client_logs"), ("streamtweak", collect_streamtweak, "streamtweak"),
                                      ("vibepollo", collect_vibepollo, "vibepollo")):
                c = self.cfg[section]
                if not c.get("enabled", True):
                    self.status.set(name, True, "wyłączone")
                    continue
                try:
                    if name in ("vibepollo", "vrr"):
                        fn(c, self.arc, self.status, self.state)
                    else:
                        fn(c, self.arc, self.status)
                except Exception as e:  # a broken source must never stop the others
                    log.exception("collector %s failed", name)
                    self.status.set(name, False, f"błąd: {e}")
            self.arc.write_doc("agent_state.json", self.state)
            with self.status.lock:
                self.status.data["last_run"] = int(time.time())
                self.status.data["running"] = False
        with self.done:
            self.runs += 1
            self.done.notify_all()

    def client_only(self):
        with self.lock:
            try:
                collect_client(self.cfg["client_logs"], self.arc, self.status)
                collect_vrr(self.cfg["client_logs"], self.arc, self.status, self.state)
                collect_streamtweak(self.cfg["streamtweak"], self.arc, self.status)
                self.arc.write_doc("agent_state.json", self.state)
            except Exception as e:
                log.exception("client collection failed")
                self.status.set("client", False, f"błąd: {e}")


class ShareWatcher(threading.Thread):
    """Event-driven copy of client logs: Windows reports changes in the shared K12 folder (SMB change
    notifications), e.g. when StreamLight starts (new log) or ends (log written), and the logs are copied
    shortly after. Nothing runs while the folder is quiet. Windows only; elsewhere it stays idle."""

    SETTLE = 20       # s after the first change before copying: lets StreamLight finish writing
    RETRY = 300       # s before reopening the watch when the share is unreachable (K12 off / asleep)

    def __init__(self, path, collector, status, key="watch"):
        super().__init__(daemon=True)
        self.path, self.collector, self.status, self.key = path, collector, status, key
        self.subtree = key == "vrr_watch"     # captures live in subfolders
        self.timer = None
        self.timer_lock = threading.Lock()

    def _changed(self):
        # Throttle, not debounce: busy Temp folders change constantly, but logs must still be copied.
        with self.timer_lock:
            if self.timer and self.timer.is_alive():
                return
            self.timer = threading.Timer(self.SETTLE, self.collector.client_only)
            self.timer.daemon = True
            self.timer.start()

    def run(self):
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateFileW.restype = wintypes.HANDLE
        k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        k32.ReadDirectoryChangesW.restype = wintypes.BOOL
        k32.ReadDirectoryChangesW.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD,
                                              ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID, wintypes.LPVOID]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        INVALID = wintypes.HANDLE(-1).value
        FILE_LIST_DIRECTORY, SHARE_ALL, OPEN_EXISTING, BACKUP_SEMANTICS = 0x1, 0x7, 3, 0x02000000
        NOTIFY = 0x1 | 0x8 | 0x10          # file name, size, last write
        buf = ctypes.create_string_buffer(64 * 1024)   # 64 KB is the maximum over SMB
        got = wintypes.DWORD()
        while True:
            h = k32.CreateFileW(self.path, FILE_LIST_DIRECTORY, SHARE_ALL, None, OPEN_EXISTING, BACKUP_SEMANTICS, None)
            if h in (None, INVALID):
                self.status.set(self.key, False, f"nie mogę obserwować {self.path} (K12 wyłączony?), ponowię za {self.RETRY // 60} min")
                time.sleep(self.RETRY)
                continue
            self.status.set(self.key, True, "obserwuję folder K12, nowe logi dochodzą same" if self.key == "watch" else "obserwuję folder diagnostyki VRR")
            self._changed()                   # catch up on anything written while we were not watching
            try:
                while k32.ReadDirectoryChangesW(h, buf, len(buf), self.subtree, NOTIFY, ctypes.byref(got), None, None):
                    self._changed()
            finally:
                k32.CloseHandle(h)
            self.status.set(self.key, False, f"przerwana obserwacja {self.path}, ponowię za {self.RETRY // 60} min")
            time.sleep(self.RETRY)


# ---------------------------------------------------------------- HTTP

STATIC_OK = re.compile(r"^/(index\.html|css/[\w.-]+\.css|js/[\w./-]+\.js)$")


def make_handler(arc, status, collector):
    class H(BaseHTTPRequestHandler):
        server_version = "StreamScopeAgent/" + VERSION
        # Keep-alive: with HTTP/1.0 every script is a new connection and Windows resets some of them
        # when the browser opens many at once. Every response sets Content-Length, so 1.1 is safe.
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, code, body=b"", ctype="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _body(self, limit=200 * 1024 * 1024):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                raise ValueError("too large")
            return self.rfile.read(n)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/api/info":
                info = status.snapshot()
                info.update(agent="StreamScope Agent", version=VERSION, host=socket.gethostname(), ip=lan_ip(), files=len(arc.list()), archive=arc.root,
                            check_every_minutes=int(collector.cfg.get("check_every_minutes") or 0))
                return self._send(200, info)
            if u.path == "/api/files":
                return self._send(200, arc.list())
            if u.path == "/api/file":
                try:
                    with open(arc.path(q.get("id", [""])[0]), "rb") as f:
                        return self._send(200, f.read(), "text/plain; charset=utf-8")
                except (ValueError, OSError):
                    return self._send(404, {"error": "not found"})
            if u.path in ("/api/history", "/api/prefs"):
                return self._send(200, arc.read_doc(u.path[5:] + ".json", [] if u.path == "/api/history" else {}))
            path = "/index.html" if u.path in ("/", "") else u.path
            if STATIC_OK.match(path):
                full = os.path.normpath(os.path.join(APP_DIR, path.lstrip("/")))
                if full.startswith(APP_DIR) and os.path.isfile(full):
                    with open(full, "rb") as f:
                        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
                        if ctype.startswith("text/") or ctype.endswith("javascript"):
                            ctype += "; charset=utf-8"
                        return self._send(200, f.read(), ctype)
            return self._send(404, {"error": "not found"})

        def do_PUT(self):
            u = urllib.parse.urlparse(self.path)
            if u.path in ("/api/history", "/api/prefs"):
                try:
                    value = json.loads(self._body(20 * 1024 * 1024).decode("utf-8"))
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                arc.write_doc(u.path[5:] + ".json", value)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/api/files":
                # Files dropped into StreamScope on any device are kept here, so every device sees them.
                name = os.path.basename(q.get("name", [""])[0]).strip()
                if not name or name.startswith("."):
                    return self._send(400, {"error": "bad name"})
                try:
                    arc.write("manual", name, self._body())
                except ValueError:
                    return self._send(413, {"error": "too large"})
                return self._send(200, {"ok": True, "id": f"manual/{name}"})
            if u.path == "/api/collect":
                if q.get("wait", ["0"])[0] == "1":
                    # "Pobierz nowe dane": answer when the run is over so the page can reload right away.
                    finished = collector.request_and_wait(timeout=900)
                    return self._send(200, {"ok": True, "finished": finished, **status.snapshot()})
                collector.wake.set()
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})

    return H


class ExclusiveServer(ThreadingHTTPServer):
    """One agent per port. HTTPServer sets SO_REUSEADDR, which on Windows lets several processes bind the
    same port at once (a second autostart copy would silently run alongside); take the port exclusively."""
    allow_reuse_address = False
    request_queue_size = 64      # default backlog (5) drops bursts of parallel requests
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def lan_ip():
    """Address of the interface that carries the default route (gethostbyname can return a VPN adapter)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))   # TEST-NET address: nothing is sent, it only selects the route
            return s.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())


def main():
    from logging.handlers import RotatingFileHandler
    handlers = [RotatingFileHandler(os.path.join(AGENT_DIR, "agent.log"), maxBytes=1_000_000, backupCount=2, encoding="utf-8")]
    if sys.stdout:   # None under pythonw (no console)
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    cfg = load_config()
    arc = Archive(cfg["archive_dir"])
    status = Status()
    collector = Collector(cfg, arc, status)
    # Bind first: if another agent already owns the port, exit before starting any watcher or download.
    try:
        srv = ExclusiveServer((cfg["bind"], int(cfg["port"])), make_handler(arc, status, collector))
    except OSError:
        log.info("StreamScope Agent already running on port %s; this copy exits", cfg["port"])
        return
    collector.start()
    if cfg["client_logs"].get("enabled", True):
        for d in cfg["client_logs"].get("dirs") or []:
            ShareWatcher(d, collector, status).start()
        for d in cfg["client_logs"].get("vrr_dirs") or []:
            ShareWatcher(d, collector, status, key="vrr_watch").start()
    ip = lan_ip()
    log.info("StreamScope Agent %s: http://%s:%s/  (archiwum: %s)", VERSION, ip, cfg["port"], arc.root)
    srv.serve_forever()


if __name__ == "__main__":
    main()
