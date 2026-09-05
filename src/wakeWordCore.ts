import { WakePhrase } from "./speechEngineInterface";

/**
 * Pure logic shared by the extension host and both speech engines.
 *
 * Nothing in this module touches the VS Code API, the filesystem, child
 * processes, or the microphone, so all of it is unit testable. Both engines
 * speak the same stdout protocol and normalise phrases the same way; keeping
 * one implementation here means a fix lands in both.
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

// -- Engine selection ---------------------------------------------------

export type EngineKind = "windows" | "sherpa";

/**
 * Map the `wakeWord.engine` setting plus the host platform to an engine.
 *
 * `auto` picks the built-in Windows engine on Windows and sherpa-onnx
 * everywhere else. An explicit choice is honoured as given.
 */
export function selectEngineKind(override: string, platform: string): EngineKind {
  if (override === "sherpa") {
    return "sherpa";
  }
  if (override === "windows") {
    return "windows";
  }
  return platform === "win32" ? "windows" : "sherpa";
}

// -- stdout protocol ----------------------------------------------------

export type EngineEvent =
  | { type: "ready" }
  | { type: "released" }
  | { type: "detected"; phrase: string; confidence: number }
  | { type: "error"; message: string }
  | { type: "debug"; message: string };

/**
 * Parse one line of an engine's stdout.
 *
 * Both engines emit the same protocol:
 *   READY
 *   DETECTED:<phrase>|<confidence>   (the suffix is optional)
 *   RELEASED
 *   ERROR:<message>
 *   DEBUG:<message>
 *
 * RELEASED is sent by the sherpa engine's child once the microphone has been
 * closed. The Windows engine has no equivalent: System.Speech holds the
 * device for the lifetime of the PowerShell process, so process exit is the
 * release confirmation there.
 *
 * Anything else (blank lines, stray output from a child's dependencies)
 * returns null and is ignored by the caller.
 *
 * `defaultConfidence` is used when a DETECTED line carries no `|<confidence>`
 * suffix or an unparseable one. The sherpa engine's child sends no suffix at
 * all and its caller discards the value; the Windows engine reports a real
 * score and passes 0 so a malformed line can never clear a threshold.
 */
export function parseEngineLine(
  line: string,
  defaultConfidence = 1.0
): EngineEvent | null {
  const trimmed = line.trim();

  if (trimmed === "READY") {
    return { type: "ready" };
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
 * Only the Windows engine produces a real score. sherpa-onnx's keyword
 * spotter applies its own threshold and returns nothing usable, so
 * SherpaEngine reports no confidence rather than a fabricated 1.0 that made
 * the two engines' logs look comparable when they are not. An absent or
 * non-finite value renders as nothing at all.
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

// -- PowerShell stderr --------------------------------------------------

/**
 * Extract readable error text from PowerShell's CLIXML stderr wrapper.
 * Falls back to the raw text with the CLIXML header stripped.
 */
export function parsePowerShellError(raw: string): string {
  const match = raw.match(/<S S="Error">(.+?)<\/S>/s);
  if (match) {
    return match[1].replace(/_x000D_/g, "").replace(/&#xA;/g, " ").trim();
  }
  return raw.replace(/#< CLIXML\s*/g, "").trim();
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
