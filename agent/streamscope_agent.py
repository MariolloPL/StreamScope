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
    "poll_seconds": 60,
    "archive_dir": r"%LOCALAPPDATA%\StreamScope\archive",
    "vibepollo": {"enabled": True, "url": "https://localhost:47990", "username": "", "password": "", "max_sessions": 300, "import_dirs": []},
    "steam": {"enabled": True, "logs_dir": r"C:\Program Files (x86)\Steam\logs"},
    "client_logs": {"enabled": True, "dirs": []},
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
    return cfg


# ---------------------------------------------------------------- archive

class Archive:
    SUBDIRS = ("vibepollo", "steam", "client", "manual")

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

    def _req(self, method, path, body=None, params=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.user:
            # Sunshine-family servers accept Basic auth on the API; the cookie from /api/login covers the rest.
            token = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
            req.add_header("Authorization", "Basic " + token)
        with self.opener.open(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8") or "null")

    def login(self):
        if self.logged_in:
            return
        try:
            self._req("POST", "/api/login", {"username": self.user, "password": self.password})
        except urllib.error.HTTPError as e:
            if e.code not in (404, 405):
                raise
        self.logged_in = True

    def get(self, path, params=None):
        self.login()
        try:
            return self._req("GET", path, params=params)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                self.logged_in = False
                self.login()
                return self._req("GET", path, params=params)
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
        return self.get(f"/api/history/sessions/{urllib.parse.quote(uuid)}", {"full": "1"})


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
    except urllib.error.HTTPError as e:
        status.set("vibepollo", False, "złe dane logowania do panelu Vibepollo" if e.code in (401, 403) else f"HTTP {e.code}")
        return
    except (urllib.error.URLError, OSError, ValueError) as e:
        status.set("vibepollo", False, f"panel Vibepollo niedostępny ({getattr(e, 'reason', e)})")
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
    saved = 0
    for g in groups:
        key = ",".join(sorted(_sid(i) for i in g))
        if key in done:
            continue
        try:
            merged = merge_sessions([api.detail(_sid(i)) for i in g])
        except (urllib.error.URLError, OSError, ValueError) as e:
            log.warning("vibepollo detail failed: %s", e)
            continue
        arc.write("vibepollo", export_name(merged), json.dumps(merged).encode("utf-8"))
        done.add(key)
        saved += 1
    state["vibepollo_groups"] = sorted(done)
    status.set("vibepollo", True, f"OK, nowe sesje: {saved}" if saved else "OK, bez nowych sesji", sessions=len(finished))


class Collector(threading.Thread):
    def __init__(self, cfg, arc, status):
        super().__init__(daemon=True)
        self.cfg, self.arc, self.status = cfg, arc, status
        self.wake = threading.Event()
        self.state = arc.read_doc("agent_state.json", {})

    def run(self):
        while True:
            self.run_once()
            self.wake.wait(max(15, int(self.cfg["poll_seconds"])))
            self.wake.clear()

    def run_once(self):
        for name, fn, section in (("vibepollo", collect_vibepollo, "vibepollo"), ("steam", collect_steam, "steam"), ("client", collect_client, "client_logs")):
            c = self.cfg[section]
            if not c.get("enabled", True):
                self.status.set(name, True, "wyłączone")
                continue
            try:
                if name == "vibepollo":
                    fn(c, self.arc, self.status, self.state)
                else:
                    fn(c, self.arc, self.status)
            except Exception as e:  # a broken source must never stop the others
                log.exception("collector %s failed", name)
                self.status.set(name, False, f"błąd: {e}")
        self.arc.write_doc("agent_state.json", self.state)
        with self.status.lock:
            self.status.data["last_run"] = int(time.time())


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
                info.update(agent="StreamScope Agent", version=VERSION, host=socket.gethostname(), files=len(arc.list()), archive=arc.root)
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
                collector.wake.set()
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})

    return H


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
    collector.start()
    ThreadingHTTPServer.request_queue_size = 64   # default backlog (5) drops bursts of parallel requests
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer((cfg["bind"], int(cfg["port"])), make_handler(arc, status, collector))
    ip = socket.gethostbyname(socket.gethostname())
    log.info("StreamScope Agent %s: http://%s:%s/  (archiwum: %s)", VERSION, ip, cfg["port"], arc.root)
    srv.serve_forever()


if __name__ == "__main__":
    main()
