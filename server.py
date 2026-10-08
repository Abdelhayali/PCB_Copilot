"""CircuitPilot dev server: serves the app and proxies local LLM servers.

    python server.py [port] [--allow-ports 8080,11434] [--password SECRET]

Requests to /llm-proxy/<port>/<path> are forwarded to http://127.0.0.1:<port>/<path>,
but only for ports in --allow-ports (default 8080). This lets the browser (and phones on
the LAN or through a tunnel) reach model servers that only listen on localhost or don't
send CORS headers.

--password (or env CP_PASSWORD) protects the whole site with a login page — use it when
exposing the server publicly (e.g. a Cloudflare tunnel).
"""
import argparse
import hashlib
import hmac
import http.server
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PROXY_RE = re.compile(r"^/llm-proxy/(\d{1,5})(/.*)?$")
HOP_HEADERS = {"host", "origin", "referer", "connection", "content-length", "accept-encoding",
               "cookie", "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cdn-loop",
               "x-forwarded-for", "x-forwarded-proto"}
ALLOWED_PORTS = {8080}
PASSWORD = None
LOGIN_PAGE = b"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>CircuitPilot</title><body style="background:#0f1216;color:#dfe5ec;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<form method=post action=/__login style="display:flex;flex-direction:column;gap:10px;width:260px">
<b style="font-size:18px">CircuitPilot</b><input type=password name=p placeholder=Password autofocus autocapitalize=off autocorrect=off autocomplete=current-password spellcheck=false
style="padding:9px;border-radius:8px;border:1px solid #2a313b;background:#161a20;color:inherit">
<button style="padding:9px;border-radius:8px;border:0;background:#5b8cff;color:#fff;font-weight:600">Enter</button>%s</form>"""


def token():
    return hashlib.sha256(("circuitpilot:" + PASSWORD).encode()).hexdigest()


class Handler(http.server.SimpleHTTPRequestHandler):
    def _authed(self):
        if not PASSWORD:
            return True
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "cp_auth" and hmac.compare_digest(v, token()):
                return True
        return False

    def _login(self, msg=b""):
        self._send(401, LOGIN_PAGE % msg, "text/html; charset=utf-8")

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def parse_request(self):
        ok = super().parse_request()
        if not ok:
            return False
        if self.command == "POST" and self.path == "/__login":
            n = int(self.headers.get("Content-Length") or 0)
            p = urllib.parse.parse_qs(self.rfile.read(n).decode()).get("p", [""])[0].strip()
            if PASSWORD and hmac.compare_digest(p.lower(), PASSWORD.lower()):
                self.send_response(303)
                self.send_header("Set-Cookie", f"cp_auth={token()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax")
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                super().end_headers()
            else:
                self._login(b"<span style='color:#ff5d5d'>Wrong password</span>")
            return False
        if not self._authed():
            self._login()
            return False
        return True
    def do_GET(self):
        if self.path == "/llm-proxy/_ping":
            return self._send(200, b'{"ok":true}', "application/json")
        if PROXY_RE.match(self.path.split("?")[0]):
            return self._proxy()
        super().do_GET()

    def do_POST(self):
        if PROXY_RE.match(self.path.split("?")[0]):
            return self._proxy()
        self._send(404, b"not found", "text/plain")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self):
        path, _, query = self.path.partition("?")
        port, rest = PROXY_RE.match(path).groups()
        if int(port) not in ALLOWED_PORTS:
            msg = (f'{{"error":{{"message":"Port {port} is not allowed by the proxy. '
                   f'Restart server.py with --allow-ports {port}"}}}}').encode()
            return self._send(403, msg, "application/json")
        url = f"http://127.0.0.1:{port}{rest or '/'}" + (f"?{query}" if query else "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:  # connection refused, timeout, ...
            msg = f'{{"error":{{"message":"Proxy could not reach {url}: {e}"}}}}'.encode()
            self._send(502, msg, "application/json")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="CircuitPilot server")
    ap.add_argument("port", nargs="?", type=int, default=5173)
    ap.add_argument("--allow-ports", default="8080", help="comma-separated local ports the LLM proxy may reach")
    ap.add_argument("--password", default=os.environ.get("CP_PASSWORD"), help="require this password (or env CP_PASSWORD)")
    ap.add_argument("--password-file", help="read the password from this file")
    a = ap.parse_args()
    ALLOWED_PORTS = {int(p) for p in a.allow_ports.split(",") if p.strip()}
    if a.password_file:
        with open(a.password_file, encoding="utf-8") as f:
            a.password = f.read().strip()
    PASSWORD = a.password or None
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"CircuitPilot on http://0.0.0.0:{a.port}  proxy ports: {sorted(ALLOWED_PORTS)}  "
          f"password: {'on' if PASSWORD else 'off'}", flush=True)
    http.server.ThreadingHTTPServer(("", a.port), Handler).serve_forever()
