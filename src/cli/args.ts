export const DEFAULT_OCR_MODEL = "mistral-ocr-latest";
export const DEFAULT_AUDIO_MODEL = "voxtral-mini-latest";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus", ".webm", ".mp4", ".mpeg",
]);

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
  outputPath?: string;
}

export function printHelp(): void {
  console.log(`
Mistral OCR + Audio Transcription CLI

USAGE:
  mistral-ocr-cli <file.pdf|audio|directory>
  mistral-ocr-cli --url <pdf-url>

PDF / OCR OPTIONS:
  --md                  Output markdown (default: plain text)
  --txt                 Output plain text (explicit default)
  --pages <spec>        Pages to process, e.g. "1,8,9,11-20"
  --header <0|1>        Extract header content (default: 1)
  --footer <0|1>        Extract footer content (default: 1)
  --clean               Clean repetitive markdown headers (--md only)
  --model <name>        OCR model (default: ${DEFAULT_OCR_MODEL})

AUDIO OPTIONS:
  --audio-model <name>  Transcription model (default: ${DEFAULT_AUDIO_MODEL})
  Supported formats:    mp3 wav m4a ogg flac opus webm mp4 mpeg

SHARED OPTIONS:
  --api-key <key>       Mistral API key (overrides MISTRAL_API_KEY env)
  --output <path>       Output file path (single-file/URL mode only)
  --help, -h            Show this help message
`);
}

function parseBoolArg(value: string): boolean {
  const v = value.toLowerCase().trim();
  if (["0", "false", "no"].includes(v)) return false;
  if (["1", "true", "yes"].includes(v)) return true;
  throw new Error(`Invalid boolean value: '${value}' (expected: 0/1, false/true, no/yes)`);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: DEFAULT_OCR_MODEL,
    audioModel: DEFAULT_AUDIO_MODEL,
    extractHeader: true,
    extractFooter: true,
    clean: false,
    toTxt: true,
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
      case "--url":         args.url = argv[++i]; break;
      case "--model":       args.model = argv[++i]; break;
      case "--audio-model": args.audioModel = argv[++i]; break;
      case "--api-key":     args.apiKey = argv[++i]; break;
      case "--pages":       args.pages = argv[++i]; break;
      case "--header":      args.extractHeader = parseBoolArg(argv[++i]); break;
      case "--footer":      args.extractFooter = parseBoolArg(argv[++i]); break;
      case "--clean":       args.clean = true; break;
      case "--md":          args.toTxt = false; break;
      case "--txt":         args.toTxt = true; break;
      case "--output":      args.outputPath = argv[++i]; break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        if (!args.input) args.input = arg;
    }
    i++;
  }

  return args;
}
