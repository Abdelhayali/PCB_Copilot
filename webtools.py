"""Web access for the AI: search (DuckDuckGo, or Brave Search with an API key) and fetch pages / PDFs as text.

Only public http(s) addresses are fetched: private, loopback and link-local hosts are refused on every
redirect hop, so the AI cannot be steered into the local network.
"""
import html
import io
import ipaddress
import json
import re
import socket
import threading
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 CircuitPilot"
MAX_BYTES = 15_000_000
_cache, _lock = {}, threading.Lock()


# ---------------------------------------------------------------- safety
def _public(host):
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError(f"Cannot resolve {host}: {e}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError(f"Refusing to fetch {host}: it resolves to a private/local address ({ip})")
    return True


def _check_url(url):
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("Only public http(s) URLs can be fetched")
    _public(u.hostname)
    return u


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirect)


def _get(url, data=None, headers=None, timeout=20):
    _check_url(url)
    h = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/pdf,application/json,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "en"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method="POST" if data else "GET")
    with _opener.open(req, timeout=timeout) as r:
        body = r.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("Document larger than 15 MB")
        return r.geturl(), r.headers.get("Content-Type", ""), body


# ---------------------------------------------------------------- search
class _DDG(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results, self.cur, self.field = [], None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "")
        if tag == "a" and "result__a" in cls:
            self.cur = {"title": "", "url": a.get("href", ""), "snippet": ""}
            self.results.append(self.cur)
            self.field = "title"
        elif tag in ("a", "div") and "result__snippet" in cls and self.cur is not None:
            self.field = "snippet"

    def handle_endtag(self, tag):
        if tag in ("a", "div"):
            self.field = None

    def handle_data(self, data):
        if self.cur is not None and self.field:
            self.cur[self.field] += data


def _clean_ddg_url(u):
    if u.startswith("//"):
        u = "https:" + u
    p = urllib.parse.urlparse(u)
    if p.netloc.endswith("duckduckgo.com") and p.path.startswith("/l/"):
        q = urllib.parse.parse_qs(p.query).get("uddg")
        if q:
            return q[0]
    return u


def search(query, n=8, brave_key=None):
    query = (query or "").strip()
    if not query:
        raise ValueError("Empty query")
    n = max(1, min(int(n or 8), 20))
    if brave_key:
        _, _, body = _get("https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({"q": query, "count": n}),
                          headers={"X-Subscription-Token": brave_key, "Accept": "application/json"})
        j = json.loads(body.decode("utf-8"))
        res = [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": re.sub(r"<[^>]+>", "", r.get("description", ""))} for r in (j.get("web") or {}).get("results", [])]
        return {"engine": "brave", "query": query, "results": res[:n]}
    _, _, body = _get("https://html.duckduckgo.com/html/", data=urllib.parse.urlencode({"q": query}).encode())
    p = _DDG()
    p.feed(body.decode("utf-8", errors="replace"))
    res = []
    for r in p.results:
        url = _clean_ddg_url(r["url"])
        if not url.startswith("http") or "duckduckgo.com/y.js" in url:
            continue  # ads
        res.append({"title": " ".join(r["title"].split()), "url": url, "snippet": " ".join(html.unescape(r["snippet"]).split())})
        if len(res) >= n:
            break
    return {"engine": "duckduckgo", "query": query, "results": res}


# ---------------------------------------------------------------- fetch → readable text
class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe", "template"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "ul", "ol", "pre", "blockquote"}

    def __init__(self):
        super().__init__()
        self.out, self.skip, self.title, self.in_title = [], 0, "", False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag in ("td", "th"):
            self.out.append(" | ")
        if tag in ("h1", "h2", "h3"):
            self.out.append("\n## ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self.in_title = False
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.out.append(data)


def _to_text(ctype, body):
    ctype = ctype.lower()
    if "pdf" in ctype or body[:5] == b"%PDF-":
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(body))
        pages = [f"[page {i + 1}]\n" + (pg.extract_text() or "") for i, pg in enumerate(reader.pages[:200])]
        meta = reader.metadata or {}
        return (str(meta.get("/Title") or ""), "\n\n".join(pages), "application/pdf")
    text = body.decode("utf-8", errors="replace")
    if "html" in ctype or text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        p = _Text()
        p.feed(text)
        t = html.unescape("".join(p.out))
        t = re.sub(r"[ \t\r\f\v]+", " ", t)
        t = re.sub(r"\n## *(?=\n)", "", t)  # empty headings
        t = re.sub(r"\n\s*\n\s*(\n\s*)+", "\n\n", t)
        return (" ".join(p.title.split()), t.strip(), "text/html")
    return ("", text, ctype or "text/plain")


def fetch(url, offset=0, length=12000):
    url = (url or "").strip()
    if not re.match(r"^https?://", url):
        url = "https://" + url
    offset, length = max(0, int(offset or 0)), max(1000, min(int(length or 12000), 40000))
    with _lock:
        hit = _cache.get(url)
    if not hit or time.time() - hit["t"] > 1800:
        final, ctype, body = _get(url)
        title, text, kind = _to_text(ctype, body)
        if kind == "text/html" and len(text) < 600:
            # thin wrapper pages (e.g. LCSC datasheet viewers): follow the embedded PDF
            raw = body.decode("utf-8", errors="replace")
            pdfs = [u if u.startswith("http") else "https:" + u for u in re.findall(r'(?:https?:)?//[^"\'\s<>]+?\.pdf(?:\?[^"\'\s<>]*)?', raw)]
            pdfs = [u for u in pdfs if u.split("?")[0] != final.split("?")[0] and "viewer.html" not in u]
            if pdfs:
                final, ctype, body = _get(html.unescape(pdfs[0]))
                title, text, kind = _to_text(ctype, body)
        hit = {"t": time.time(), "url": final, "title": title, "text": text, "type": kind}
        with _lock:
            _cache[url] = hit
            if len(_cache) > 60:
                _cache.pop(next(iter(_cache)))
    t = hit["text"]
    return {"url": hit["url"], "title": hit["title"], "content_type": hit["type"], "total_chars": len(t), "offset": offset,
            "more": offset + length < len(t), "text": t[offset:offset + length]}
