/**
 * Prepaid page credits.
 *
 * One credit is one page. An image is one page. Audio has no pages at all —
 * Mistral bills transcription by duration — so it is charged per started minute
 * at AUDIO_CREDITS_PER_MINUTE, which absorbs the difference in what a minute of
 * speech costs versus a page of scan.
 *
 * Payment happens outside the bot. Nothing here talks to a payment provider;
 * the owner grants credits by hand once money has arrived by some other route.
 *
 * Storage lives in UserSession — this module is only the numbers and the rules,
 * kept separate from the object that persists them.
 */

/**
 * Most a single job may cost.
 *
 * Only enforceable where the page count is known before Mistral is billed,
 * which today means split jobs (the container counts with qpdf) and jobs whose
 * page range the user supplied. A whole document of unknown length cannot be
 * capped in advance — see the note on chargeable pages in jobs.ts.
 */
export const PER_JOB_CAP = 300;

/** Credits per started minute of audio. */
export const AUDIO_CREDITS_PER_MINUTE = 2;

/** How many past jobs /usage shows. Bounded so one account cannot grow forever. */
export const LEDGER_LIMIT = 20;

export interface Account {
  /** Credits remaining. May go negative for trusted users, or by one job's overrun. */
  balance: number;
  /** Total credits ever spent. Never reset, so /whois shows real history. */
  lifetime: number;
  /** Runs with no balance and is exempt from the per-job cap. Set by the owner. */
  trusted: boolean;
  /** Last seen, and the username at that point — the only user directory we keep. */
  lastSeen?: number;
  username?: string;
}

export interface LedgerEntry {
  at: number;
  cost: number;
  label: string;
}

export function emptyAccount(): Account {
  return { balance: 0, lifetime: 0, trusted: false };
}

/**
 * Credits for a completed audio job.
 *
 * Rounds up, so a 61-second clip costs two minutes. A job with no duration
 * (linked audio, where Telegram tells us nothing) still costs one minute rather
 * than nothing.
 */
export function audioCost(durationSeconds?: number): number {
  const minutes = Math.max(1, Math.ceil((durationSeconds ?? 0) / 60));
  return minutes * AUDIO_CREDITS_PER_MINUTE;
}

/** Whether this account may start a job at all. */
export function canStart(account: Account): boolean {
  return account.trusted || account.balance > 0;
}

/** Append to a user's ledger, keeping only the most recent LEDGER_LIMIT entries. */
export function appendLedger(
  ledger: LedgerEntry[],
  entry: LedgerEntry
): LedgerEntry[] {
  return [entry, ...ledger].slice(0, LEDGER_LIMIT);
}

export function describeAccount(account: Account): string {
  const lines = [
    `Balance: ${account.balance} credit${account.balance === 1 ? "" : "s"}`,
    `Used so far: ${account.lifetime}`,
  ];
  if (account.trusted) lines.push("Trusted — runs even at zero balance.");
  return lines.join("\n");
}

export function describeLedger(ledger: LedgerEntry[]): string {
  if (!ledger.length) return "No jobs yet.";
  return ledger
    .map((e) => {
      const when = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
      return `${when} · ${e.cost} · ${e.label}`;
    })
    .join("\n");
}
