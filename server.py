"""CircuitPilot dev server: serves the app and proxies local LLM servers.

    python server.py [port]        (default 5173, listens on all interfaces)

Requests to /llm-proxy/<port>/<path> are forwarded to http://127.0.0.1:<port>/<path>.
This lets the browser (and phones on the LAN) reach model servers that only listen on
localhost or don't send CORS headers, e.g. a local OpenAI-compatible server on :8080.
"""
import http.server
import os
import re
import sys
import urllib.error
import urllib.request

PROXY_RE = re.compile(r"^/llm-proxy/(\d{1,5})(/.*)?$")
HOP_HEADERS = {"host", "origin", "referer", "connection", "content-length", "accept-encoding"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

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
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    print(f"CircuitPilot on http://0.0.0.0:{port}  (LLM proxy: /llm-proxy/<port>/...)")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
