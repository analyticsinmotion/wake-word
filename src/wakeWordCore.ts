import { StringDecoder } from "string_decoder";
import { WakePhrase } from "./speechEngineInterface";

/**
 * Pure logic shared by the extension host and the speech engine.
 *
 * Nothing in this module touches the VS Code API, the filesystem, child
 * processes, or the microphone, so all of it is unit testable.
 */

/** Minimum gap between two accepted detections of any phrase. */
export const DETECTION_DEBOUNCE_MS = 3000;

/** Bounds enforced on `wakeWord.confidenceThreshold`. */
export const MIN_THRESHOLD = 0.1;
export const MAX_THRESHOLD = 0.9;
export const DEFAULT_THRESHOLD = 0.3;

// -- Phrases ------------------------------------------------------------

/**
 * Normalise a route's `phrase` field to a list of comparable strings.
 *
 * Accepts a single phrase or an array of aliases. Values that are not strings
 * are discarded rather than thrown on: `wakeWord.routes` is user-edited JSON
 * and VS Code does not enforce the contributed schema, so a number or null in
 * the array must not take the extension down on activation.
 */
export function normalizePhrases(phrase: unknown): string[] {
  const arr = Array.isArray(phrase) ? phrase : [phrase];
  const out: string[] = [];
  for (const p of arr) {
    if (typeof p !== "string") {
      continue;
    }
    const normalised = p.toLowerCase().trim();
    if (normalised.length > 0) {
      out.push(normalised);
    }
  }
  return out;
}

/** Find the route whose phrase list contains an already-normalised phrase. */
export function matchRoute(
  routes: readonly WakePhrase[],
  detected: string
): WakePhrase | undefined {
  const needle = detected.toLowerCase().trim();
  if (needle.length === 0) {
    return undefined;
  }
  return routes.find((r) => normalizePhrases(r.phrase).includes(needle));
}

// -- Routes -------------------------------------------------------------

/** A route is usable only if it has at least one phrase, a label, and a command. */
export function isValidRoute(route: WakePhrase | undefined | null): boolean {
  if (!route || typeof route !== "object") {
    return false;
  }
  return (
    normalizePhrases(route.phrase).length > 0 &&
    typeof route.label === "string" &&
    route.label.trim().length > 0 &&
    typeof route.command === "string" &&
    route.command.trim().length > 0
  );
}

/** Drop routes that cannot be acted on. */
export function filterValidRoutes(routes: readonly WakePhrase[]): WakePhrase[] {
  if (!Array.isArray(routes)) {
    return [];
  }
  return routes.filter((r) => isValidRoute(r));
}

/**
 * Pick the routing table to start with: the user's valid routes if they have
 * any, otherwise the built-in defaults.
 */
export function resolveRoutes(
  userRoutes: readonly WakePhrase[],
  defaults: readonly WakePhrase[]
): WakePhrase[] {
  const valid = filterValidRoutes(userRoutes);
  return valid.length > 0 ? valid : [...defaults];
}

// -- Threshold ----------------------------------------------------------

/**
 * Clamp a configured confidence threshold into the supported range.
 * Non-numeric, NaN, and zero values fall back to `fallback`.
 */
export function clampThreshold(
  value: unknown,
  fallback: number = DEFAULT_THRESHOLD
): number {
  const numeric = Number(value) || fallback;
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, numeric));
}

// -- Debounce -----------------------------------------------------------

/**
 * True when a detection arrives too soon after the previous accepted one.
 *
 * `lastDetectionTime` of 0 means "no detection yet" and never debounces.
 */
export function shouldDebounce(
  now: number,
  lastDetectionTime: number,
  windowMs: number = DETECTION_DEBOUNCE_MS
): boolean {
  return now - lastDetectionTime < windowMs;
}

// -- Retired settings ---------------------------------------------------

/**
 * Logged when settings.json still carries `wakeWord.engine: "windows"`.
 *
 * 0.13.0 removed the setting along with the engine it selected. VS Code
 * ignores a setting nothing contributes, so the stale value does no harm,
 * but a user who chose that engine deliberately should be told where it went.
 */
export const RETIRED_ENGINE_NOTICE =
  "The 'windows' engine has been retired. Wake Word now uses the sherpa-onnx " +
  "engine on all platforms. You can remove wakeWord.engine from your settings.";

/**
 * The notice for a leftover `wakeWord.engine` value, or null when there is
 * nothing to say. Only `windows` gets one: `auto` and `sherpa` already
 * describe what runs now.
 */
export function retiredEngineNotice(value: unknown): string | null {
  return value === "windows" ? RETIRED_ENGINE_NOTICE : null;
}

// -- stdout protocol ----------------------------------------------------

export type EngineEvent =
  | { type: "ready" }
  | { type: "paused" }
  | { type: "released" }
  | { type: "detected"; phrase: string; confidence: number }
  | { type: "error"; message: string }
  | { type: "debug"; message: string };

/**
 * Parse one line of the engine's stdout.
 *
 * The protocol:
 *   READY
 *   DETECTED:<phrase>|<confidence>   (the suffix is optional)
 *   PAUSED
 *   RELEASED
 *   ERROR:<message>
 *   DEBUG:<message>
 *
 * PAUSED is sent once a `pause` command has closed the microphone and the
 * process is waiting, models loaded, for `resume`; RELEASED once `stop` has
 * closed it for good.
 *
 * Anything else (blank lines, stray output from a child's dependencies)
 * returns null and is ignored by the caller.
 *
 * `defaultConfidence` is used when a DETECTED line carries no `|<confidence>`
 * suffix or an unparseable one. The engine's child sends no suffix at all and
 * SherpaEngine discards the value; a caller that acts on scores should pass 0
 * so a malformed line can never clear a threshold.
 */
export function parseEngineLine(
  line: string,
  defaultConfidence = 1.0
): EngineEvent | null {
  const trimmed = line.trim();

  if (trimmed === "READY") {
    return { type: "ready" };
  }
  if (trimmed === "PAUSED") {
    return { type: "paused" };
  }
  if (trimmed === "RELEASED") {
    return { type: "released" };
  }
  if (trimmed.startsWith("DEBUG:")) {
    return { type: "debug", message: trimmed.substring(6) };
  }
  if (trimmed.startsWith("ERROR:")) {
    return { type: "error", message: trimmed.substring(6) };
  }
  if (trimmed.startsWith("DETECTED:")) {
    const payload = trimmed.substring(9);
    const sepIndex = payload.lastIndexOf("|");
    const phrase = (sepIndex >= 0 ? payload.substring(0, sepIndex) : payload)
      .toLowerCase()
      .trim();
    const parsed = sepIndex >= 0 ? parseFloat(payload.substring(sepIndex + 1)) : NaN;
    return {
      type: "detected",
      phrase,
      confidence: isNaN(parsed) ? defaultConfidence : parsed,
    };
  }

  return null;
}

/**
 * Render the confidence suffix for a detection log line.
 *
 * sherpa-onnx's keyword spotter applies its own threshold and returns
 * nothing usable, so SherpaEngine reports no confidence rather than a
 * fabricated 1.0 that read like a real score. An absent or non-finite value
 * renders as nothing at all.
 */
export function formatConfidence(confidence: number | undefined): string {
  if (typeof confidence !== "number" || !isFinite(confidence)) {
    return "";
  }
  return ` (confidence: ${confidence.toFixed(2)})`;
}

/**
 * Split a stdout chunk into complete lines, returning the trailing partial
 * line so the caller can carry it into the next chunk.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() || "";
  return { lines: parts, rest };
}

/**
 * Build a stdout 'data' handler that hands `onLine` every complete line, in
 * order, however the output was chunked.
 *
 * A pipe delivers chunks, not lines: one chunk can hold several lines and one
 * line can arrive in pieces. Looking for a verb in each chunk on its own
 * misses one split across two chunks, which left a RELEASED unseen and the
 * release to run out its timeout. The decoder keeps a multi-byte character
 * that straddles two chunks intact, which per-chunk toString() does not.
 */
export function createLineReader(
  onLine: (line: string) => void
): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const split = splitLines(buffer);
    buffer = split.rest;
    for (const line of split.lines) {
      onLine(line);
    }
  };
}

// -- Session statistics -------------------------------------------------

/**
 * Counters the extension host keeps for one listening session and writes to
 * the output channel as a single line on deactivation. No telemetry, no
 * network, no storage: the line exists so a user can see how the extension
 * behaved over a day without reading the whole log.
 */
export interface SessionStats {
  detections: number;
  detectionsByPhrase: Map<string, number>;
  errors: number;
  engineStarts: number;
  cooldowns: number;
  /** Epoch milliseconds at which the counters were created. */
  startedAt: number;
}

export function createSessionStats(startedAt: number = Date.now()): SessionStats {
  return {
    detections: 0,
    detectionsByPhrase: new Map(),
    errors: 0,
    engineStarts: 0,
    cooldowns: 0,
    startedAt,
  };
}

/** Count one accepted detection against its route label. */
export function recordDetection(stats: SessionStats, label: string): void {
  stats.detections++;
  stats.detectionsByPhrase.set(label, (stats.detectionsByPhrase.get(label) ?? 0) + 1);
}

/** Whole minutes since the counters were created. Never negative. */
export function sessionDurationMinutes(stats: SessionStats, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - stats.startedAt) / 60_000));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Render the session summary line:
 *
 *   Session: 342min, 14 detections (Claude: 8, Copilot: 4, Terminal: 2),
 *   0 errors, 17 engine starts, 14 cooldowns
 *
 * Phrases are listed most-detected first, ties in the order first heard.
 * The breakdown is omitted entirely when nothing was detected.
 */
export function formatSessionStats(stats: SessionStats, now: number = Date.now()): string {
  const breakdown = Array.from(stats.detectionsByPhrase.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label}: ${count}`)
    .join(", ");

  return (
    `Session: ${sessionDurationMinutes(stats, now)}min, ` +
    plural(stats.detections, "detection") +
    (breakdown ? ` (${breakdown})` : "") +
    `, ${plural(stats.errors, "error")}` +
    `, ${plural(stats.engineStarts, "engine start")}` +
    `, ${plural(stats.cooldowns, "cooldown")}`
  );
}

// -- Phrase confirmation ------------------------------------------------

/** How long a first detection waits for the second one that confirms it. */
export const CONFIRMATION_WINDOW_MS = 5000;

/** The first of the two detections `wakeWord.confirmationMode` requires. */
export interface PendingConfirmation {
  /** Route label of the phrase heard. */
  phrase: string;
  /** Epoch milliseconds of that detection. */
  time: number;
}

export interface ConfirmationResult {
  /** True when the caller should act on this detection. */
  confirmed: boolean;
  /** State to carry to the next detection. Null once confirmed or when off. */
  pending: PendingConfirmation | null;
}

/**
 * Decide whether a detection that has already passed the debounce guard
 * should fire now or be held for a second hearing.
 *
 * With confirmation off every detection fires and nothing is held. With it
 * on, the first hearing of a phrase is held while the engine keeps
 * listening; the same phrase heard again within `windowMs` confirms it. A
 * different phrase replaces the held one and starts its own window. A held
 * phrase older than the window is discarded and the new hearing becomes the
 * first.
 *
 * The debounce guard runs first, so the engine repeating one utterance
 * cannot confirm itself: the second hearing has to be a second utterance,
 * which means it lands between DETECTION_DEBOUNCE_MS and `windowMs` after
 * the first.
 */
export function evaluateConfirmation(
  enabled: boolean,
  pending: PendingConfirmation | null,
  label: string,
  now: number,
  windowMs: number = CONFIRMATION_WINDOW_MS
): ConfirmationResult {
  if (!enabled) {
    return { confirmed: true, pending: null };
  }
  if (pending && pending.phrase === label && now - pending.time <= windowMs) {
    return { confirmed: true, pending: null };
  }
  return { confirmed: false, pending: { phrase: label, time: now } };
}

/** Status bar text while a first detection waits for its second. */
export function formatConfirmationStatus(label: string): string {
  return `$(question) Wake: Confirm "${label}"`;
}

// -- Handoff ------------------------------------------------------------

/** How listening resumes after a route hands the microphone off. */
export type HandoffMode = "timer" | "manual";

/**
 * Resolve a route's `handoff` field.
 *
 * `timer` resumes after the cooldown, which is what every version before
 * 0.11.0 did, and is the default. `manual` leaves listening paused until
 * the user resumes it from the status bar or the Enable command. Anything
 * else, a missing value, a wrong-typed one, or a case variant, is `timer`:
 * settings.json is not validated against the contributed schema, and an
 * unrecognised value must fall back to the behaviour the user already knows.
 */
export function resolveHandoff(handoff: unknown): HandoffMode {
  return handoff === "manual" ? "manual" : "timer";
}

// -- Calibration --------------------------------------------------------

/** How long the Calibrate command listens for. */
export const CALIBRATION_DURATION_MS = 15_000;

/** One detection heard during a calibration run. */
export interface CalibrationDetection {
  /** Route label of the phrase heard. */
  label: string;
  /** Engine score. Absent for the sherpa engine; see formatConfidence. */
  confidence?: number;
  /** Milliseconds after the listening window opened. */
  time: number;
}

export interface CalibrationReport {
  /** Lines for the output channel, in order. */
  lines: string[];
  /** One line for the notification. */
  summary: string;
}

function hasConfidence(confidence: number | undefined): confidence is number {
  return typeof confidence === "number" && isFinite(confidence);
}

/**
 * Render the result of a calibration run: every detection with its time
 * and score, then a per-phrase summary with the count, the average score,
 * and the lowest score, which is the one closest to the threshold.
 *
 * The sherpa engine reports no score, so its detections render with no
 * confidence and its summary has counts only, with one note saying why.
 * `durationMs` is how long the window was actually open, which is less
 * than CALIBRATION_DURATION_MS when the run was cancelled.
 */
export function formatCalibrationReport(
  detections: readonly CalibrationDetection[],
  durationMs: number
): CalibrationReport {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const window = plural(seconds, "second");
  const lines: string[] = ["=== Calibration Results ==="];

  if (detections.length === 0) {
    lines.push(`No phrases detected in ${window}.`);
    lines.push(
      "Try: speak closer to the microphone, reduce background noise, or lower wakeWord.confidenceThreshold."
    );
    lines.push("=== End Calibration ===");
    return {
      lines,
      summary:
        `Wake Word: No phrases detected in ${window}. ` +
        "Try speaking closer to the microphone or lowering the confidence threshold.",
    };
  }

  for (const d of detections) {
    lines.push(`  ${(d.time / 1000).toFixed(1)}s: "${d.label}"${formatConfidence(d.confidence)}`);
  }

  const byLabel = new Map<string, CalibrationDetection[]>();
  for (const d of detections) {
    const list = byLabel.get(d.label) ?? [];
    list.push(d);
    byLabel.set(d.label, list);
  }

  lines.push("Summary:");
  for (const [label, list] of byLabel) {
    const scores = list.map((d) => d.confidence).filter(hasConfidence);
    let line = `  "${label}": ${plural(list.length, "detection")}`;
    if (scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      line += `, avg confidence: ${avg.toFixed(2)}, min: ${Math.min(...scores).toFixed(2)}`;
    }
    lines.push(line);
  }

  if (detections.some((d) => !hasConfidence(d.confidence))) {
    lines.push(
      "Note: the sherpa engine reports no confidence score. The threshold is applied inside the keyword spotter."
    );
  }
  lines.push("=== End Calibration ===");

  return {
    lines,
    summary:
      `Wake Word: ${plural(detections.length, "detection")} in ${window}. ` +
      "Check the Wake Word output channel for details.",
  };
}

// -- Handoff ordering ---------------------------------------------------

/** What became of a detection's handoff. See releaseThenFire(). */
export type HandoffOutcome =
  | { kind: "fired" }
  | { kind: "superseded" }
  | { kind: "failed"; error: unknown };

/**
 * Hand the microphone over: release it, then fire the route's command.
 *
 * `release` settles once the engine has confirmed the microphone is closed,
 * or has forced it closed, and never rejects. The command fires only after
 * that, so an assistant that opens the microphone the moment it is focused
 * never finds it still held.
 *
 * `isCurrent` is asked once the release has settled. Waiting opens a window,
 * up to the engine's pause timeout, in which the user can disable listening
 * or start it again, and either of those settles the release early. A
 * handoff overtaken like that fires nothing: otherwise a Disable in that
 * window would be followed by the command and then by a cooldown that turns
 * listening back on.
 *
 * A command that throws or rejects is reported as `failed` rather than
 * thrown, so the caller has one place to resume listening.
 */
export async function releaseThenFire(
  release: () => Promise<void>,
  isCurrent: () => boolean,
  fire: () => PromiseLike<unknown>
): Promise<HandoffOutcome> {
  await release();
  if (!isCurrent()) {
    return { kind: "superseded" };
  }
  try {
    await fire();
    return { kind: "fired" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

// -- Phrase checks ------------------------------------------------------

/** Phrases shorter than this many characters draw a warning. */
export const SHORT_PHRASE_LENGTH = 4;

/**
 * Words that make poor wake phrases on their own: they turn up constantly in
 * ordinary speech, so a route listening for one fires by accident.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  "yes", "no", "ok", "okay", "hello", "hi", "hey",
  "stop", "start", "go", "run", "open", "close",
  "the", "a", "an", "is", "it", "on", "off",
]);

/** A phrase that will work, but badly. */
export interface PhraseWarning {
  /** Label of the route the phrase belongs to. */
  label: string;
  /** The phrase, normalised as the engine hears it. */
  phrase: string;
  warning: string;
}

/**
 * Warn about phrases that are likely to detect poorly: single words, very
 * short phrases, and common words on their own.
 *
 * These are warnings, not errors. A user may have a good reason for a short
 * phrase in a quiet room, so nothing is rejected. One phrase can draw more
 * than one warning ("hi" is a single word, short, and common), and every
 * alias of a route is checked on its own. Phrases are normalised first, so
 * a blank alias or a non-string is skipped exactly as the engine skips it.
 */
export function validatePhraseQuality(routes: readonly WakePhrase[]): PhraseWarning[] {
  const warnings: PhraseWarning[] = [];

  for (const route of routes) {
    for (const phrase of normalizePhrases(route.phrase)) {
      const words = phrase.split(/\s+/);
      const warn = (warning: string): void => {
        warnings.push({ label: route.label, phrase, warning });
      };

      if (words.length === 1) {
        const example = phrase === "hey" ? "hey computer" : `hey ${phrase}`;
        warn(
          `"${phrase}" is a single word. Single words cause more false positives. ` +
            `Consider a two-word phrase like "${example}".`
        );
      }
      if (phrase.length < SHORT_PHRASE_LENGTH) {
        warn(
          `"${phrase}" is very short (${plural(phrase.length, "character")}). ` +
            "Short phrases are harder to detect reliably."
        );
      }
      if (words.length === 1 && COMMON_WORDS.has(phrase)) {
        warn(`"${phrase}" is a very common word and will likely trigger frequently by accident.`);
      }
    }
  }

  return warnings;
}

/** Two routes whose phrases the engine may confuse. */
export interface PhraseCollision {
  routeA: string;
  phraseA: string;
  routeB: string;
  phraseB: string;
  reason: string;
}

/**
 * Find phrases on different routes that clash: the same phrase twice, or one
 * phrase contained in another.
 *
 * An exact duplicate means the later route can never fire, because a
 * detection goes to the first route whose phrases match. A contained phrase
 * ("claude" inside "hey claude") means the shorter one can be heard when the
 * longer one is said. Aliases on the same route are not compared: whichever
 * is heard, the same command runs. Comparison is on normalised phrases, so
 * it ignores case and surrounding whitespace.
 */
export function detectPhraseCollisions(routes: readonly WakePhrase[]): PhraseCollision[] {
  const entries: Array<{ route: number; label: string; phrase: string }> = [];
  routes.forEach((route, index) => {
    for (const phrase of new Set(normalizePhrases(route.phrase))) {
      entries.push({ route: index, label: route.label, phrase });
    }
  });

  const contained = (short: { label: string; phrase: string }, long: { label: string; phrase: string }): string =>
    `"${short.phrase}" (${short.label}) is contained within "${long.phrase}" (${long.label}). ` +
    "The shorter phrase may trigger when the longer one is spoken.";

  const collisions: PhraseCollision[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.route === b.route) {
        continue;
      }

      let reason: string | null = null;
      if (a.phrase === b.phrase) {
        reason =
          `"${a.label}" and "${b.label}" both use "${a.phrase}". ` +
          `Only "${a.label}" can fire: a detection goes to the first matching route.`;
      } else if (a.phrase.includes(b.phrase)) {
        reason = contained(b, a);
      } else if (b.phrase.includes(a.phrase)) {
        reason = contained(a, b);
      }

      if (reason) {
        collisions.push({
          routeA: a.label,
          phraseA: a.phrase,
          routeB: b.label,
          phraseB: b.phrase,
          reason,
        });
      }
    }
  }

  return collisions;
}

/**
 * What the phrase checks depend on, as one comparable string: each route's
 * label and normalised phrases. The extension reports the checks again only
 * when this changes, so a resume, a restart, or a window taking over the
 * lock does not repeat a warning, and neither does editing a route's command
 * or cooldown.
 */
export function phraseChecksKey(routes: readonly WakePhrase[]): string {
  return JSON.stringify(routes.map((r) => [r.label, normalizePhrases(r.phrase)]));
}

/** One output channel line per warning and per collision, warnings first. */
export function formatPhraseChecks(
  warnings: readonly PhraseWarning[],
  collisions: readonly PhraseCollision[]
): string[] {
  return [
    ...warnings.map((w) => `Phrase warning (${w.label}): ${w.warning}`),
    ...collisions.map((c) => `Phrase collision: ${c.reason}`),
  ];
}

/** The notification shown when the checks found anything. */
export function formatPhraseChecksSummary(count: number): string {
  return `Wake Word: ${plural(count, "phrase warning")} found. Check the output channel for details.`;
}

// -- Diagnostics --------------------------------------------------------

/** The oldest Node.js major version the engine process is supported on. */
export const MIN_ENGINE_NODE_MAJOR = 22;

/**
 * A note for a `node --version` string older than MIN_ENGINE_NODE_MAJOR, or
 * nothing. Anything that does not parse as a version, such as the reason the
 * probe could not run, gets no note.
 */
export function nodeVersionNote(version: string): string {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (!match || Number(match[1]) >= MIN_ENGINE_NODE_MAJOR) {
    return "";
  }
  return ` (Wake Word requires ${MIN_ENGINE_NODE_MAJOR} or later)`;
}

/**
 * Replace the user's home directory with `~` wherever it appears in `text`.
 *
 * Diagnostics are meant to be pasted into an issue, and paths under the home
 * directory (the model's global storage, a Node.js installed per user) carry
 * the account name. Only whole path segments match, so `/home/ann` does not
 * eat the start of `/home/anna`. A root or drive-only home would match every
 * path and is left alone.
 */
export function redactHome(text: string, homeDir: string, caseInsensitive: boolean): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length < 3) {
    return text;
  }
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped + "(?=[\\\\/]|$)", caseInsensitive ? "gi" : "g"), "~");
}

/** Everything Show Diagnostics reports, gathered by the extension host. */
export interface DiagnosticsInput {
  extensionVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  /** `vscode.env.appName`: the editor product the extension is running in. */
  editorName: string;
  vscodeVersion: string;
  hostNodeVersion: string;
  engineNodePath: string;
  /** `node --version` from the engine's executable, or why it could not run. */
  engineNodeVersion: string;
  /** What the extension is doing, in words. */
  state: string;
  isListening: boolean;
  isPaused: boolean;
  modelName: string;
  modelDir: string;
  modelPresent: boolean;
  modelSha256: string;
  audioDevice: string;
  threshold: number;
  cooldownSeconds: number;
  confirmationMode: boolean;
  pauseOnFocusLoss: boolean;
  enableOnStartup: boolean;
  routes: readonly WakePhrase[];
  usingDefaultRoutes: boolean;
  /** Lines from formatPhraseChecks(). */
  phraseChecks: readonly string[];
  /** Line from describeLock(). */
  lock: string;
  sessionStats: SessionStats;
  now: number;
  /** Replaced by `~` in every line. See redactHome(). */
  homeDir: string;
}

/**
 * Render the Show Diagnostics report, one line per fact.
 *
 * The report holds versions, settings, routes, and state: no audio, and no
 * account name, because the home directory is redacted from every line.
 */
export function formatDiagnostics(input: DiagnosticsInput): string[] {
  const onOff = (value: boolean): string => (value ? "on" : "off");

  const lines = [
    "=== Wake Word Diagnostics ===",
    `Version: ${input.extensionVersion}`,
    `Platform: ${input.platform} ${input.arch} (${input.osRelease})`,
    `VS Code: ${input.vscodeVersion} (${input.editorName})`,
    `Node.js (extension host): ${input.hostNodeVersion}`,
    `Node.js (engine): ${input.engineNodePath} (${input.engineNodeVersion})${nodeVersionNote(input.engineNodeVersion)}`,
    "Engine: sherpa-onnx",
    `State: ${input.state}`,
    `Listening: ${input.isListening}`,
    `Paused: ${input.isPaused}`,
    `Model: ${input.modelName} (${input.modelPresent ? "downloaded" : "not downloaded"})`,
    `Model dir: ${input.modelDir}`,
    `Model SHA-256: ${input.modelSha256.substring(0, 16)}...`,
    `Audio device: ${input.audioDevice || "(system default)"}`,
    `Threshold: ${input.threshold}`,
    `Cooldown: ${input.cooldownSeconds}s`,
    `Confirmation mode: ${onOff(input.confirmationMode)}`,
    `Pause on focus loss: ${onOff(input.pauseOnFocusLoss)}`,
    `Enable on startup: ${onOff(input.enableOnStartup)}`,
    `Routes: ${input.routes.length}${input.usingDefaultRoutes ? " (defaults)" : ""}`,
  ];

  for (const route of input.routes) {
    const handoff = resolveHandoff(route.handoff);
    const cooldown =
      handoff === "timer" && typeof route.cooldownSeconds === "number" ? `, ${route.cooldownSeconds}s` : "";
    lines.push(
      `  "${route.label}" [${normalizePhrases(route.phrase).join(", ")}] -> ${route.command} (${handoff}${cooldown})`
    );
  }

  if (input.phraseChecks.length === 0) {
    lines.push("Phrase checks: no warnings");
  } else {
    lines.push(`Phrase checks: ${plural(input.phraseChecks.length, "warning")}`);
    for (const line of input.phraseChecks) {
      lines.push(`  ${line}`);
    }
  }

  lines.push(`Lock: ${input.lock}`);
  lines.push(formatSessionStats(input.sessionStats, input.now));
  lines.push("=== End Diagnostics ===");

  return lines.map((line) => redactHome(line, input.homeDir, input.platform === "win32"));
}
