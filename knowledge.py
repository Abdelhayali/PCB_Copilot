"""Project knowledge folders: read design docs, guides and datasheets so the AI can use them.

Only document-like files are read (text, markdown, code, PDF, DOCX); hidden folders, .git,
node_modules etc. are skipped, and nothing outside the chosen folder is ever opened.
Extracted text is cached per file (by path + mtime + size).
"""
import os
import re
import threading

TEXT_EXT = {".md", ".markdown", ".txt", ".rst", ".adoc", ".json", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".ini",
            ".cfg", ".h", ".hpp", ".c", ".cpp", ".ino", ".py", ".js", ".ts", ".html", ".htm", ".xml", ".net", ".log"}
DOC_EXT = {".pdf", ".docx"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "build", "dist", ".idea", ".vscode"}
MAX_FILES, MAX_BYTES, MAX_CHARS = 400, 25_000_000, 400_000
_cache, _lock = {}, threading.Lock()


def _root(path):
    if not path or not str(path).strip():
        raise ValueError("No knowledge folder set")
    root = os.path.realpath(os.path.expanduser(str(path).strip().strip('"')))
    if not os.path.isdir(root):
        raise FileNotFoundError(f"Folder not found: {path}")
    return root


def _files(root):
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        for f in sorted(files):
            ext = os.path.splitext(f)[1].lower()
            if f.startswith(".") or (ext not in TEXT_EXT and ext not in DOC_EXT):
                continue
            full = os.path.join(dirpath, f)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size <= MAX_BYTES:
                out.append((os.path.relpath(full, root).replace("\\", "/"), full, size))
            if len(out) >= MAX_FILES:
                return out
    return out


def _extract(full):
    st = os.stat(full)
    key = (full, st.st_mtime, st.st_size)
    with _lock:
        if key in _cache:
            return _cache[key]
    ext = os.path.splitext(full)[1].lower()
    try:
        if ext == ".pdf":
            import pypdf
            reader = pypdf.PdfReader(full)
            text = "\n\n".join(f"[page {i + 1}]\n" + (p.extract_text() or "") for i, p in enumerate(reader.pages[:300]))
        elif ext == ".docx":
            import docx
            d = docx.Document(full)
            text = "\n".join(p.text for p in d.paragraphs)
            for t in d.tables:
                for row in t.rows:
                    text += "\n" + " | ".join(c.text.strip() for c in row.cells)
        else:
            with open(full, "rb") as fh:
                text = fh.read(MAX_BYTES).decode("utf-8", errors="replace")
    except Exception as e:  # unreadable / encrypted documents
        text = f"(could not extract text: {e})"
    text = re.sub(r"[ \t]+\n", "\n", text)[:MAX_CHARS]
    with _lock:
        _cache[key] = text
    return text


def _safe(root, rel):
    full = os.path.realpath(os.path.join(root, rel or ""))
    if not (full == root or full.startswith(root + os.sep)) or not os.path.isfile(full):
        raise FileNotFoundError(f"No such file in the knowledge folder: {rel}")
    return full


def list_files(path):
    root = _root(path)
    files = []
    for rel, full, size in _files(root):
        files.append({"file": rel, "size": size, "chars": len(_extract(full))})
    return {"folder": root, "files": files}


def read_file(path, rel, offset=0, length=20000):
    root = _root(path)
    text = _extract(_safe(root, rel))
    offset, length = max(0, int(offset or 0)), max(500, min(int(length or 20000), 60000))
    chunk = text[offset:offset + length]
    return {"file": rel, "offset": offset, "total_chars": len(text), "more": offset + length < len(text), "text": chunk}


def search(path, query, limit=12):
    root = _root(path)
    terms = [t for t in re.findall(r"\w[\w.+-]*", (query or "").lower()) if len(t) > 1]
    if not terms:
        raise ValueError("Empty query")
    hits = []
    for rel, full, _ in _files(root):
        text = _extract(full)
        low = text.lower()
        for m in re.finditer(re.escape(terms[0]), low):
            a, b = max(0, m.start() - 300), min(len(text), m.end() + 500)
            window = low[a:b]
            score = sum(window.count(t) for t in terms) + 3 * sum(t in window for t in terms)
            hits.append((score, rel, a, text[a:b]))
            if len(hits) > 4000:
                break
    hits.sort(key=lambda h: -h[0])
    out, seen = [], set()
    for score, rel, a, snip in hits:
        k = (rel, a // 800)
        if k in seen:
            continue
        seen.add(k)
        out.append({"file": rel, "offset": a, "score": score, "snippet": snip.strip()})
        if len(out) >= int(limit or 12):
            break
    return {"query": query, "results": out}


def digest(path, budget=24000):
    """Index of all files + the full text of small files, for the AI's system prompt."""
    root = _root(path)
    files = _files(root)
    index, parts, used = [], [], 0
    for rel, full, size in files:
        text = _extract(full)
        index.append(f"- {rel} ({len(text):,} chars)")
    for rel, full, size in sorted(files, key=lambda f: len(_extract(f[1]))):
        text = _extract(full)
        if used + len(text) > budget:
            continue
        parts.append(f"=== {rel} ===\n{text.strip()}")
        used += len(text)
    return {"folder": root, "files": len(files), "index": "\n".join(index), "included": "\n\n".join(parts), "included_chars": used}
