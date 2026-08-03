import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { DEFAULT_OCR_MODEL, DEFAULT_AUDIO_MODEL } from "./args.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".mistral-ocr.json");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TypeConfig {
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

export interface CliConfig extends TypeConfig {
  downloadDir?: string;
  allowedDirs?: string;
  pdf?: TypeConfig;
  docx?: TypeConfig;
  img?: TypeConfig;
  audio?: TypeConfig;
}

export const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), "Downloads");

export type FileTypeKey = "pdf" | "docx" | "img" | "audio";
export const FILE_TYPES: FileTypeKey[] = ["pdf", "docx", "img", "audio"];

export const BUILT_IN_DEFAULTS: Required<Omit<TypeConfig, "apiKey">> = {
  outputFormat: "txt",
  model: DEFAULT_OCR_MODEL,
  audioModel: DEFAULT_AUDIO_MODEL,
  extractHeader: true,
  extractFooter: true,
  clean: false,
  keepImgs: false,
  embedImgs: false,
  dropImgs: false,
  forceOcr: false,
};

// ── Key metadata for validation ────────────────────────────────────────────────

const BOOL_KEYS = new Set(["extractHeader", "extractFooter", "clean", "keepImgs", "embedImgs", "dropImgs", "forceOcr"]);
const STRING_KEYS = new Set(["model", "audioModel", "apiKey", "downloadDir", "allowedDirs"]);
const ENUM_KEYS: Record<string, string[]> = { outputFormat: ["md", "txt"] };
const GLOBAL_ONLY_KEYS = new Set(["downloadDir", "allowedDirs"]);
export const ALL_SETTING_KEYS = new Set([...BOOL_KEYS, ...STRING_KEYS, ...Object.keys(ENUM_KEYS)]);

// ── Load / save ────────────────────────────────────────────────────────────────

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

async function saveConfig(config: CliConfig, configPath: string): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ── Resolve merged config for a given file type ────────────────────────────────

export function resolveConfig(config: CliConfig, type?: FileTypeKey): TypeConfig {
  const global_: TypeConfig = { ...BUILT_IN_DEFAULTS, ...config };
  // Strip type sections from global
  for (const t of FILE_TYPES) delete (global_ as any)[t];
  if (!type) return global_;
  return { ...global_, ...(config[type] ?? {}) };
}

// ── Parse a value string into the correct JS type ─────────────────────────────

function parseValue(key: string, value: string): unknown {
  if (!ALL_SETTING_KEYS.has(key)) {
    console.error(`Unknown key: '${key}'`);
    console.error(`Valid keys: ${[...ALL_SETTING_KEYS].join(", ")}`);
    process.exit(1);
  }
  if (BOOL_KEYS.has(key)) {
    if (!["true", "false", "1", "0", "yes", "no"].includes(value.toLowerCase())) {
      console.error(`'${key}' expects a boolean: true/false, 1/0, yes/no`);
      process.exit(1);
    }
    return ["true", "1", "yes"].includes(value.toLowerCase());
  }
  if (ENUM_KEYS[key]) {
    if (!ENUM_KEYS[key].includes(value)) {
      console.error(`'${key}' must be one of: ${ENUM_KEYS[key].join(", ")}`);
      process.exit(1);
    }
    return value;
  }
  return value; // string
}

// ── Subcommand handlers ────────────────────────────────────────────────────────

export async function cmdInit(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  try {
    await fs.access(configPath);
    console.log(`Config already exists at: ${configPath}`);
    console.log(`Use 'ocr config show' to view or 'ocr config set <key> <value>' to update.`);
    return;
  } catch { /* create it */ }

  await saveConfig({ ...BUILT_IN_DEFAULTS }, configPath);
  console.log(`Config created: ${configPath}`);
}

export async function cmdShow(type: FileTypeKey | undefined, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = await loadConfig(configPath);
  const section: TypeConfig = type ? (config[type] ?? {}) : config;
  const resolved = resolveConfig(config, type);

  const label = type ? `${type} section` : "global";
  const hasFile = Object.keys(config).length > 0;
  console.log(`Config: ${configPath}${hasFile ? "" : " (not found)"}`);
  console.log(`\nActive ${label} values:`);

  for (const [key, defaultVal] of Object.entries(BUILT_IN_DEFAULTS)) {
    const inSection = key in section;
    const inGlobal = !type && key in config;
    const val = (resolved as any)[key];
    const tag = inSection || inGlobal ? "← config" : "(default)";
    console.log(`  ${key}: ${JSON.stringify(val)}  ${tag}`);
  }

  if (!type) {
    const dlTag = "downloadDir" in config ? "← config" : "(default)";
    console.log(`  downloadDir: ${JSON.stringify(config.downloadDir ?? DEFAULT_DOWNLOAD_DIR)}  ${dlTag}`);
    const adTag = "allowedDirs" in config ? "← config" : "(not set — URL output always goes to cwd)";
    console.log(`  allowedDirs: ${JSON.stringify(config.allowedDirs ?? "")}  ${adTag}`);

    console.log(`\nPer-type overrides:`);
    for (const t of FILE_TYPES) {
      const s = config[t];
      if (s && Object.keys(s).length > 0) {
        console.log(`  ${t}: ${JSON.stringify(s)}`);
      }
    }
  }
}

export async function cmdSet(type: FileTypeKey | undefined, key: string, value: string, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  if (type && GLOBAL_ONLY_KEYS.has(key)) {
    console.error(`'${key}' is a global-only setting — use: ocr config set ${key} <value>`);
    process.exit(1);
  }
  const parsed = parseValue(key, value);
  const config = await loadConfig(configPath);

  if (type) {
    config[type] = config[type] ?? {};
    (config[type] as any)[key] = parsed;
  } else {
    (config as any)[key] = parsed;
  }

  await saveConfig(config, configPath);
  const scope = type ? `${type}.${key}` : key;
  console.log(`Set ${scope} = ${JSON.stringify(parsed)}`);
}

export async function cmdRemove(type: FileTypeKey | undefined, key: string, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  if (!ALL_SETTING_KEYS.has(key)) {
    console.error(`Unknown key: '${key}'`);
    process.exit(1);
  }
  if (type && GLOBAL_ONLY_KEYS.has(key)) {
    console.error(`'${key}' is a global-only setting — use: ocr config remove ${key}`);
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const section: any = type ? config[type] : config;

  if (!section || !(key in section)) {
    console.log(`'${type ? `${type}.` : ""}${key}' is not set — already using default.`);
    return;
  }

  delete section[key];
  await saveConfig(config, configPath);
  const defaultVal = key === "downloadDir" ? DEFAULT_DOWNLOAD_DIR
    : key === "allowedDirs" ? "(not set — URL output always goes to cwd)"
    : (BUILT_IN_DEFAULTS as any)[key];
  console.log(`Removed '${type ? `${type}.` : ""}${key}' — reverts to: ${JSON.stringify(defaultVal)}`);
}

// ── Main config command dispatcher ─────────────────────────────────────────────

export async function runConfigCommand(argv: string[], configPath: string): Promise<void> {
  // argv is everything after "config"
  // Patterns:
  //   config init
  //   config show
  //   config set <key> <value>
  //   config remove <key>
  //   config <type> show
  //   config <type> set <key> <value>
  //   config <type> remove <key>

  const isType = (s: string): s is FileTypeKey => FILE_TYPES.includes(s as FileTypeKey);

  let type: FileTypeKey | undefined;
  let rest = argv;

  if (rest.length > 0 && isType(rest[0])) {
    type = rest[0] as FileTypeKey;
    rest = rest.slice(1);
  }

  const cmd = rest[0];

  if (!cmd || cmd === "show") {
    return cmdShow(type, configPath);
  }
  if (cmd === "init") {
    if (type) { console.error("'init' is global only — use: ocr config init"); process.exit(1); }
    return cmdInit(configPath);
  }
  if (cmd === "set") {
    const [key, value] = rest.slice(1);
    if (!key || value === undefined) {
      console.error(`Usage: ocr config ${type ? type + " " : ""}set <key> <value>`);
      console.error(`Valid keys: ${[...ALL_SETTING_KEYS].join(", ")}`);
      process.exit(1);
    }
    return cmdSet(type, key, value, configPath);
  }
  if (cmd === "remove") {
    const [key] = rest.slice(1);
    if (!key) {
      console.error(`Usage: ocr config ${type ? type + " " : ""}remove <key>`);
      process.exit(1);
    }
    return cmdRemove(type, key, configPath);
  }

  console.error(`Unknown config command: '${cmd}'`);
  console.error(`Commands: init, show, set <key> <value>, remove <key>`);
  console.error(`Types: ${FILE_TYPES.join(", ")}`);
  process.exit(1);
}
