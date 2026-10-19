export { DEFAULT_OCR_LANG } from "../shared/convert.js";
import { DEFAULT_OCR_LANG } from "../shared/convert.js";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus", ".webm", ".mp4", ".mpeg",
]);

export const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
]);

export interface CliArgs {
  input?: string;
  url?: string;
  /** Base URL of the docling-api Worker. */
  baseUrl?: string;
  apiKey?: string;
  pages?: string;
  clean: boolean;
  toTxt: boolean;
  keepImgs: boolean;
  embedImgs: boolean;
  dropImgs: boolean;
  mdOnly: boolean;
  audioOnly: boolean;
  forceOcr: boolean;
  /** OCR languages in order of preference. */
  ocrLang: string[];
  /** Spoken language of audio, e.g. "ar". Empty lets Whisper detect it. */
  language?: string;
  outputPath?: string;
}

export function printHelp(): void {
  console.log(`
Docling CLI: documents, images and audio via your own Docling API

USAGE:
  docling <file|directory>
  docling <url>
  docling --url <url>
  ocr <file|directory>          (same command)

DOCUMENT OPTIONS:
  Supported:            PDF, DOCX, DOC, PPTX, XLSX, XLS, images
  --md                  Output markdown (default: plain text)
  --txt                 Output plain text (explicit default)
  --pages <spec>        Pages to process, e.g. "1,8,9,11-20"
                        (PDF only; Docling converts the span from the first
                        to the last page and the rest is dropped locally)
  --force-ocr           OCR every page even when it has a text layer
  --ocr-lang <list>     OCR languages, comma separated (default: ${DEFAULT_OCR_LANG})
  --clean               Clean repetitive markdown headers (--md only)
  --embed-imgs          Embed images as base64 data URIs in the markdown
  --imgs                Keep Docling's "<!-- image -->" markers
  --drop-imgs           Remove image markers (default)

MARKDOWN OPTIONS:
  docling file.md           Convert markdown to plain text (no API call needed)
  --md-only                 Directory mode: only convert .md files

AUDIO OPTIONS:
  --audio               Directory mode: only transcribe audio files, skip all others
  --language <code>     Spoken language, e.g. ar or en (default: auto-detect)
  Supported formats:    mp3 wav m4a ogg flac opus webm mp4 mpeg (up to 25 MB)

CONNECTION:
  --base-url <url>      Docling API URL (overrides DOCLING_URL)
  --api-key <key>       Docling API key (overrides DOCLING_API_KEY)
  docling --usage       Show this month's container time against the budget

SHARED OPTIONS:
  --output <path>       Output file path (single-file/URL mode only)
  --help, -h            Show this help message

URL OUTPUT:
  URL downloads save to current dir by default.
  Restrict to allowed dirs:  docling config set allowedDirs "~/projects,~/work"
    (if cwd is not in the list, output goes to downloadDir instead)
  Change fallback dir:       docling config set downloadDir ~/Downloads
  Override per-call:         --output <path>

CONFIG:
  docling config init                   Create ~/.docling-cli.json with defaults
  docling config show                   Show current global config
  docling config set <key> <value>      Set a global default
  docling config remove <key>           Remove a global override (revert to default)
  docling config <type> show            Show per-type config (pdf|docx|img|audio)
  docling config <type> set <key> <v>   Set a per-type default
  docling config <type> remove <key>    Remove a per-type override
  --config <path>                       Use a custom config file path

  Use --no-* to override a config boolean back to false:
  --no-clean, --no-imgs, --no-embed-imgs, --no-drop-imgs, --no-force-ocr
`);
}

export interface ParsedConfig {
  outputFormat?: "md" | "txt";
  clean?: boolean;
  keepImgs?: boolean;
  embedImgs?: boolean;
  dropImgs?: boolean;
  forceOcr?: boolean;
  ocrLang?: string;
  language?: string;
  baseUrl?: string;
  apiKey?: string;
}

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseArgs(argv: string[], config: ParsedConfig = {}): CliArgs {
  const args: CliArgs = {
    clean:      config.clean     ?? false,
    toTxt:      (config.outputFormat ?? "txt") === "txt",
    keepImgs:   config.keepImgs  ?? false,
    embedImgs:  config.embedImgs ?? false,
    dropImgs:   config.dropImgs  ?? false,
    mdOnly:     false,
    audioOnly:  false,
    forceOcr:   config.forceOcr  ?? false,
    ocrLang:    splitList(config.ocrLang ?? DEFAULT_OCR_LANG),
    ...(config.language && { language: config.language }),
    ...(config.baseUrl && { baseUrl: config.baseUrl }),
    ...(config.apiKey && { apiKey: config.apiKey }),
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      case "--url":           args.url = argv[++i]; break;
      case "--base-url":      args.baseUrl = argv[++i]; break;
      case "--api-key":       args.apiKey = argv[++i]; break;
      case "--pages":         args.pages = argv[++i]; break;
      case "--ocr-lang":      args.ocrLang = splitList(argv[++i] ?? ""); break;
      case "--language":      args.language = argv[++i]; break;
      case "--clean":         args.clean = true; break;
      case "--no-clean":      args.clean = false; break;
      case "--md":            args.toTxt = false; break;
      case "--txt":           args.toTxt = true; break;
      case "--imgs":          args.keepImgs = true; break;
      case "--no-imgs":       args.keepImgs = false; break;
      case "--embed-imgs":    args.embedImgs = true; break;
      case "--no-embed-imgs": args.embedImgs = false; break;
      case "--drop-imgs":     args.dropImgs = true; break;
      case "--no-drop-imgs":  args.dropImgs = false; break;
      case "--md-only":       args.mdOnly = true; break;
      case "--audio":         args.audioOnly = true; break;
      case "--force-ocr":     args.forceOcr = true; break;
      case "--no-force-ocr":  args.forceOcr = false; break;
      case "--config":        i++; break; // already consumed before parseArgs
      case "--usage":         break;      // handled in index.ts
      case "--output":        args.outputPath = argv[++i]; break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        if (arg.startsWith("http://") || arg.startsWith("https://")) {
          if (!args.url) args.url = arg;
        } else if (!args.input) {
          args.input = arg;
        }
    }
    i++;
  }

  return args;
}
