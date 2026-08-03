export const DEFAULT_OCR_MODEL = "mistral-ocr-latest";
export const DEFAULT_AUDIO_MODEL = "voxtral-mini-latest";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus", ".webm", ".mp4", ".mpeg",
]);

export const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".xls",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
]);

export const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp",
  ".tiff": "image/tiff", ".tif": "image/tiff",
};

export interface CliArgs {
  input?: string;
  url?: string;
  model: string;
  audioModel: string;
  apiKey?: string;
  pages?: string;
  extractHeader: boolean;
  extractFooter: boolean;
  clean: boolean;
  toTxt: boolean;
  keepImgs: boolean;
  embedImgs: boolean;
  dropImgs: boolean;
  mdOnly: boolean;
  audioOnly: boolean;
  forceOcr: boolean;
  outputPath?: string;
}

export function printHelp(): void {
  console.log(`
Mistral OCR + Audio Transcription CLI

USAGE:
  mistral-ocr-cli <file|directory>
  mistral-ocr-cli <url>
  mistral-ocr-cli --url <url>

DOCUMENT / OCR OPTIONS:
  Supported:            PDF, DOCX, DOC, PPTX, XLSX, XLS
  --force-ocr           Use Mistral OCR for DOCX/DOC instead of native mammoth parser
                        (mammoth preserves links and tables; OCR may lose them)
  --md                  Output markdown (default: plain text)
  --txt                 Output plain text (explicit default)
  --pages <spec>        Pages to process, e.g. "1,8,9,11-20"
  --header <0|1>        Extract header content (default: 1)
  --footer <0|1>        Extract footer content (default: 1)
  --clean               Clean repetitive markdown headers (--md only)
  --imgs                Keep embedded images as markdown image refs instead of OCR-ing them
                        Default: images are OCR'd and their text is included inline
  --embed-imgs          Embed images as base64 data URIs inline in the markdown,
                        and add an OCR description caption below each image
  --drop-imgs           Drop images entirely: no image refs, no base64, no image OCR
                        (fastest and cheapest — text-only markdown)
  --model <n>           OCR model (default: ${DEFAULT_OCR_MODEL})

MARKDOWN OPTIONS:
  mistral-ocr-cli file.md   Convert markdown to plain text (no API call needed)
  --md-only                 Directory mode: only convert .md files, skip PDFs and audio

AUDIO OPTIONS:
  --audio               Directory mode: only transcribe audio files, skip all others
  --audio-model <n>     Transcription model (default: ${DEFAULT_AUDIO_MODEL})
  Supported formats:    mp3 wav m4a ogg flac opus webm mp4 mpeg

IMAGE OPTIONS:
  mistral-ocr-cli image.jpg/png/...  OCR an image file directly
  Supported formats:    jpg jpeg png gif webp bmp tiff

SHARED OPTIONS:
  --api-key <key>       Mistral API key (overrides MISTRAL_API_KEY env)
  --output <path>       Output file path (single-file/URL mode only)
  --help, -h            Show this help message

URL OUTPUT:
  URL downloads save to current dir by default.
  Restrict to allowed dirs:  ocr config set allowedDirs "~/projects,~/work"
    (if cwd is not in the list, output goes to downloadDir instead)
  Change fallback dir:       ocr config set downloadDir ~/Downloads
  Override per-call:         --output <path>

CONFIG:
  ocr config init                   Create ~/.mistral-ocr.json with defaults
  ocr config show                   Show current global config
  ocr config set <key> <value>      Set a global default
  ocr config remove <key>           Remove a global override (revert to default)
  ocr config <type> show            Show per-type config (pdf|docx|img|audio)
  ocr config <type> set <key> <v>   Set a per-type default
  ocr config <type> remove <key>    Remove a per-type override
  --config <path>                   Use a custom config file path

  Use --no-* to override a config boolean back to false:
  --no-clean, --no-imgs, --no-embed-imgs, --no-drop-imgs, --no-force-ocr,
  --no-header, --no-footer
`);
}

function parseBoolArg(value: string): boolean {
  const v = value.toLowerCase().trim();
  if (["0", "false", "no"].includes(v)) return false;
  if (["1", "true", "yes"].includes(v)) return true;
  throw new Error(`Invalid boolean value: '${value}' (expected: 0/1, false/true, no/yes)`);
}

export interface ParsedConfig {
  outputFormat?: "md" | "txt";
  model?: string;
  audioModel?: string;
  extractHeader?: boolean;
  extractFooter?: boolean;
  clean?: boolean;
  keepImgs?: boolean;
  embedImgs?: boolean;
  dropImgs?: boolean;
  forceOcr?: boolean;
  apiKey?: string;
}

export function parseArgs(argv: string[], config: ParsedConfig = {}): CliArgs {
  const args: CliArgs = {
    model:         config.model         ?? DEFAULT_OCR_MODEL,
    audioModel:    config.audioModel    ?? DEFAULT_AUDIO_MODEL,
    extractHeader: config.extractHeader ?? true,
    extractFooter: config.extractFooter ?? true,
    clean:         config.clean         ?? false,
    toTxt:         (config.outputFormat ?? "txt") === "txt",
    keepImgs:      config.keepImgs      ?? false,
    embedImgs:     config.embedImgs     ?? false,
    dropImgs:      config.dropImgs      ?? false,
    mdOnly:        false,
    audioOnly:     false,
    forceOcr:      config.forceOcr      ?? false,
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
      case "--model":         args.model = argv[++i]; break;
      case "--audio-model":   args.audioModel = argv[++i]; break;
      case "--api-key":       args.apiKey = argv[++i]; break;
      case "--pages":         args.pages = argv[++i]; break;
      case "--header":        args.extractHeader = parseBoolArg(argv[++i]); break;
      case "--footer":        args.extractFooter = parseBoolArg(argv[++i]); break;
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
      case "--no-header":     args.extractHeader = false; break;
      case "--no-footer":     args.extractFooter = false; break;
      case "--config":        i++; break; // already consumed before parseArgs
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
