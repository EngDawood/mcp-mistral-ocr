"""
PDF splitter service.

Exists because Mistral OCR refuses documents over 50 MB, and a Cloudflare Worker
cannot split one itself: every JS PDF library has to parse the whole file into
memory, and the isolate is capped at 128 MB. A container has real memory and real
disk, so the split happens here and the Worker only ever streams the parts out.

Splitting is delegated to qpdf rather than a Python library — it is C++, handles
damaged and unusually structured PDFs without complaint, and never holds the whole
document in memory.

Protocol (all JSON, no auth — reachable only through the container binding):

    POST   /split               {url, pages?, targetBytes?, maxPartBytes?, maxSourceBytes?}
                                -> {jobId}   work continues in the background
    GET    /status/<jobId>      -> {state, ...progress | parts | error}
    GET    /part/<jobId>/<n>    -> the part's bytes (application/pdf)
    DELETE /job/<jobId>         -> discard the job's directory
    GET    /health              -> {ok: true}

`/split` returns immediately and reports progress through `/status` so the caller
never holds a multi-minute connection open.
"""

import json
import math
import os
import re
import shutil
import subprocess
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
JOBS_ROOT = "/tmp/jobs"

# Mistral's own document ceiling. Parts are aimed well under it so that a run of
# image-heavy pages cannot push one over.
MISTRAL_MAX_BYTES = 50 * 1024 * 1024
DEFAULT_TARGET_BYTES = 30 * 1024 * 1024
# Mistral also caps a single document at 1,000 pages.
MISTRAL_MAX_PAGES = 1000
# A ceiling on the source download, so a mistyped link to something enormous
# cannot fill the container's disk.
DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024

# Some origins refuse unfamiliar clients outright. We are fetching a link the
# user explicitly handed us, so present as an ordinary browser — the same
# reasoning as the Worker's own proxy.
BROWSER_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "accept": "*/*",
}

_jobs = {}
_jobs_lock = threading.Lock()


def _set(job_id, **fields):
    with _jobs_lock:
        _jobs.setdefault(job_id, {}).update(fields)


def _get(job_id):
    with _jobs_lock:
        state = _jobs.get(job_id)
        return dict(state) if state else None


def parse_page_spec(spec):
    """Mirror of parsePageSpec in src/shared/utils.ts — 1-based, inclusive ranges."""
    pages = set()
    for raw in spec.split(","):
        part = raw.strip()
        if not part:
            continue
        if "-" in part:
            if part.startswith("-"):
                raise ValueError("Page numbers must be positive (got '%s')" % part)
            a, _, b = part.partition("-")
            try:
                start, end = int(a.strip()), int(b.strip())
            except ValueError:
                raise ValueError("Invalid page range: '%s'" % part)
            if start < 1 or end < 1:
                raise ValueError("Page numbers must be positive (got %d-%d)" % (start, end))
            if start > end:
                raise ValueError("Invalid page range: %d-%d (start must be <= end)" % (start, end))
            pages.update(range(start, end + 1))
        else:
            try:
                num = int(part)
            except ValueError:
                raise ValueError("Invalid page number: '%s'" % part)
            if num < 1:
                raise ValueError("Invalid page number: '%s'" % part)
            pages.add(num)
    return pages


def qpdf_page_argument(pages):
    """Collapse a sorted page list into qpdf's range syntax: [1,2,3,7] -> '1-3,7'."""
    groups = []
    start = prev = pages[0]
    for page in pages[1:]:
        if page == prev + 1:
            prev = page
            continue
        groups.append((start, prev))
        start = prev = page
    groups.append((start, prev))
    return ",".join(str(a) if a == b else "%d-%d" % (a, b) for a, b in groups)


def download(url, dest, max_bytes, job_id):
    request = urllib.request.Request(url, headers=BROWSER_HEADERS)
    with urllib.request.urlopen(request, timeout=120) as response:
        declared = response.headers.get("content-length")
        total = int(declared) if declared and declared.isdigit() else None
        if total is not None and total > max_bytes:
            raise ValueError("The file is %d bytes, over the %d byte limit." % (total, max_bytes))
        written = 0
        with open(dest, "wb") as handle:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                written += len(block)
                if written > max_bytes:
                    # Content-length can be absent or a lie; enforce it as we go.
                    raise ValueError("The download exceeded the %d byte limit." % max_bytes)
                handle.write(block)
                _set(job_id, downloaded=written, downloadTotal=total)
    if written == 0:
        raise ValueError("The link returned an empty file.")
    return written


def page_count(path):
    result = subprocess.run(
        ["qpdf", "--show-npages", path],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise ValueError(qpdf_message(result))
    return int(result.stdout.strip())


def write_part(source, pages, dest):
    result = subprocess.run(
        [
            "qpdf",
            source,
            "--pages",
            source,
            qpdf_page_argument(pages),
            "--",
            # Object streams shrink the part, which buys headroom under the 50 MB cap.
            "--object-streams=generate",
            dest,
        ],
        capture_output=True,
        text=True,
        timeout=900,
    )
    # qpdf exits 3 on warnings ("operation succeeded with warnings"), which is
    # routine for scanned documents and still produces a valid file.
    if result.returncode not in (0, 3):
        raise ValueError(qpdf_message(result))
    return os.path.getsize(dest)


def qpdf_message(result):
    text = (result.stderr or result.stdout or "").strip()
    first = text.splitlines()[0] if text else "qpdf failed with code %d" % result.returncode
    if "invalid password" in first.lower() or "password" in first.lower():
        return "The PDF is password-protected, so it cannot be split."
    return first[:300]


def run_split(job_id, options):
    job_dir = os.path.join(JOBS_ROOT, job_id)
    source = os.path.join(job_dir, "source.pdf")
    try:
        os.makedirs(job_dir, exist_ok=True)

        max_source = int(options.get("maxSourceBytes") or DEFAULT_MAX_SOURCE_BYTES)
        _set(job_id, state="downloading")
        source_bytes = download(options["url"], source, max_source, job_id)

        _set(job_id, state="reading", sourceBytes=source_bytes)
        total_pages = page_count(source)
        if total_pages < 1:
            raise ValueError("That PDF reports zero pages.")

        missing = []
        spec = options.get("pages")
        if spec:
            wanted = sorted(parse_page_spec(spec))
            selected = [n for n in wanted if 1 <= n <= total_pages]
            missing = [n for n in wanted if n < 1 or n > total_pages]
        else:
            selected = list(range(1, total_pages + 1))

        if not selected:
            raise ValueError("That page range does not match any page in the document.")

        target = int(options.get("targetBytes") or DEFAULT_TARGET_BYTES)
        max_part = int(options.get("maxPartBytes") or MISTRAL_MAX_BYTES)
        bytes_per_page = max(1, source_bytes // total_pages)
        per_part = max(1, min(target // bytes_per_page, MISTRAL_MAX_PAGES))

        _set(
            job_id,
            state="splitting",
            totalPages=total_pages,
            selected=len(selected),
            missing=missing,
            estimatedParts=math.ceil(len(selected) / per_part),
        )

        queue = [selected[i : i + per_part] for i in range(0, len(selected), per_part)]
        parts = []
        oversize = []
        scratch = os.path.join(job_dir, "scratch.pdf")

        while queue:
            chunk = queue.pop(0)
            size = write_part(source, chunk, scratch)

            # The page-count estimate is an average; a run of image-heavy pages can
            # still overshoot. Halve and retry rather than let Mistral reject it.
            if size > max_part and len(chunk) > 1:
                mid = math.ceil(len(chunk) / 2)
                queue.insert(0, chunk[mid:])
                queue.insert(0, chunk[:mid])
                continue

            if size > max_part:
                # A single page bigger than the cap cannot be divided further.
                oversize.append(chunk[0])
                os.remove(scratch)
                continue

            index = len(parts) + 1
            final = os.path.join(job_dir, "part-%d.pdf" % index)
            os.replace(scratch, final)
            parts.append(
                {
                    "index": index,
                    "first": chunk[0],
                    "last": chunk[-1],
                    "pages": len(chunk),
                    # first..last is not the whole story when the caller asked for a
                    # non-contiguous range like "1,5,90-95" — this labels what the
                    # part actually holds, so captions cannot overstate it.
                    "label": qpdf_page_argument(chunk),
                    "bytes": size,
                }
            )
            _set(job_id, parts=list(parts), completedParts=len(parts))

        if not parts:
            raise ValueError("Every page was too large to process on its own.")

        # The source is the biggest thing on disk and is no longer needed.
        os.remove(source)
        _set(
            job_id,
            state="done",
            parts=parts,
            oversize=oversize,
            totalPages=total_pages,
            missing=missing,
        )
    except Exception as error:  # noqa: BLE001 — the message is the product here
        _set(job_id, state="error", error=str(error) or error.__class__.__name__)
        shutil.rmtree(job_dir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # The default logger writes to stderr per request; container logs are noisy enough.
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})

        status = re.fullmatch(r"/status/([\w-]+)", self.path)
        if status:
            state = _get(status.group(1))
            if not state:
                return self._json(404, {"error": "unknown job"})
            return self._json(200, state)

        part = re.fullmatch(r"/part/([\w-]+)/(\d+)", self.path)
        if part:
            return self._send_part(part.group(1), int(part.group(2)))

        return self._json(404, {"error": "not found"})

    def _send_part(self, job_id, index):
        path = os.path.join(JOBS_ROOT, job_id, "part-%d.pdf" % index)
        if not os.path.isfile(path):
            return self._json(404, {"error": "unknown part"})

        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("content-type", "application/pdf")
        self.send_header("content-length", str(size))
        self.end_headers()
        with open(path, "rb") as handle:
            shutil.copyfileobj(handle, self.wfile, 1024 * 1024)

    def do_POST(self):
        if self.path != "/split":
            return self._json(404, {"error": "not found"})

        length = int(self.headers.get("content-length") or 0)
        try:
            options = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON body"})

        if not options.get("url"):
            return self._json(400, {"error": "url is required"})

        job_id = uuid.uuid4().hex
        _set(job_id, state="queued")
        threading.Thread(target=run_split, args=(job_id, options), daemon=True).start()
        return self._json(202, {"jobId": job_id})

    def do_DELETE(self):
        match = re.fullmatch(r"/job/([\w-]+)", self.path)
        if not match:
            return self._json(404, {"error": "not found"})
        job_id = match.group(1)
        shutil.rmtree(os.path.join(JOBS_ROOT, job_id), ignore_errors=True)
        with _jobs_lock:
            _jobs.pop(job_id, None)
        return self._json(200, {"ok": True})


if __name__ == "__main__":
    os.makedirs(JOBS_ROOT, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
