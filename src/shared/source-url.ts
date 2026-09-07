/**
 * Share-link normalisation.
 *
 * Every surface accepts a pasted link, and the links people actually paste —
 * Google Drive, Google Docs, Dropbox, GitHub — point at an HTML viewer page
 * rather than the file. Fetching one yields markup, not a document, so the
 * link has to be rewritten to its direct-download form first.
 *
 * Anything unrecognised passes through untouched.
 *
 * Pure and synchronous by design. A third-party resolver API was considered
 * and rejected: it only extracted the file id and rebuilt the same URL these
 * regexes produce, while the filename and size it reported are already in the
 * content-disposition and content-length headers of the fetch each caller
 * makes anyway. It would have added a network hop, an availability
 * dependency, and would have handed a third party a working "anyone with the
 * link" credential for every document processed.
 */

export type SourceProvider = "google-drive" | "google-docs" | "dropbox" | "github";

export interface NormalizedSource {
  /** Direct-download URL, or the input unchanged when nothing matched. */
  url: string;
  /** Suggested filename, when the URL shape reveals one. */
  fileName?: string;
  /** Set only when a rewrite happened, for provider-specific error messages. */
  provider?: SourceProvider;
}

/** Google Docs editor URLs, and the export path that yields a PDF for each. */
const DOCS_EXPORTS: Array<{ re: RegExp; export: (id: string) => string }> = [
  {
    re: /^https?:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{10,})/i,
    export: (id) => `https://docs.google.com/document/d/${id}/export?format=pdf`,
  },
  {
    re: /^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{10,})/i,
    export: (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=pdf`,
  },
  {
    // Slides uses a path segment where Docs and Sheets use a query parameter.
    re: /^https?:\/\/docs\.google\.com\/presentation\/d\/([A-Za-z0-9_-]{10,})/i,
    export: (id) => `https://docs.google.com/presentation/d/${id}/export/pdf`,
  },
];

/**
 * Pull the file id out of any Drive URL shape.
 *
 * Covers /file/d/<id>/view, /open?id=<id>, /uc?id=<id> and the bare /d/<id>
 * form some share dialogs produce.
 */
export function extractDriveId(url: string): string | null {
  const byPath = url.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/);
  if (byPath) return byPath[1];
  try {
    const id = new URL(url).searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  } catch {
    /* not a parseable URL */
  }
  return null;
}

/** Build the Drive direct-download URL. */
export function rewriteDriveUrl(id: string): string {
  // confirm=t matters: without it, files past roughly 100 MB answer with the
  // virus-scan interstitial as HTML instead of the file.
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
}

function isDriveUrl(url: string): boolean {
  return (
    /^https?:\/\/(?:drive|docs)\.google\.com\//i.test(url) &&
    !DOCS_EXPORTS.some((d) => d.re.test(url))
  );
}

/** Rewrite a share link to its direct-download form. */
export function normalizeSourceUrl(input: string): NormalizedSource {
  const url = input.trim();

  // ── Google Docs / Sheets / Slides → PDF export ───────────────────────────
  for (const doc of DOCS_EXPORTS) {
    const m = url.match(doc.re);
    if (m) {
      // No filename: the export endpoint reports the real title in
      // content-disposition, which beats anything we could invent here.
      return { url: doc.export(m[1]), provider: "google-docs" };
    }
  }

  // ── Google Drive → direct download ───────────────────────────────────────
  if (isDriveUrl(url)) {
    const id = extractDriveId(url);
    if (id) return { url: rewriteDriveUrl(id), provider: "google-drive" };
    return { url, provider: "google-drive" };
  }

  // ── Dropbox → force the file rather than the preview page ────────────────
  if (/^https?:\/\/(?:www\.)?dropbox\.com\//i.test(url)) {
    try {
      const u = new URL(url);
      u.searchParams.set("dl", "1");
      return { url: u.toString(), fileName: basenameOf(u.pathname), provider: "dropbox" };
    } catch {
      /* fall through unchanged */
    }
  }

  // ── GitHub blob → raw ────────────────────────────────────────────────────
  const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (gh) {
    const [, owner, repo, rest] = gh;
    const clean = rest.split("?")[0];
    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${clean}`,
      fileName: basenameOf(clean),
      provider: "github",
    };
  }

  return { url };
}

/**
 * Read a filename out of a content-disposition header.
 *
 * The direct-download URLs above carry no filename in the path, so this header
 * is usually the only place the real name appears — and the extension is what
 * Mistral uses to infer the document type.
 */
export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;

  // RFC 5987 form wins when present: filename*=UTF-8''name.pdf
  const ext = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (ext) {
    try {
      return decodeURIComponent(ext[1].trim());
    } catch {
      return ext[1].trim();
    }
  }

  const plain = header.match(/filename\s*=\s*"([^"]+)"/i) ?? header.match(/filename\s*=\s*([^;]+)/i);
  const name = plain?.[1]?.trim();
  return name || undefined;
}

/** Last path segment, decoded, only when it looks like a filename. */
function basenameOf(pathname: string): string | undefined {
  const base = pathname.split("/").filter(Boolean).pop();
  if (!base || !base.includes(".")) return undefined;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}
