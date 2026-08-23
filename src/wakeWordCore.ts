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
  | { type: "detected"; phrase: string; confidence: number }
  | { type: "error"; message: string }
  | { type: "debug"; message: string };

/**
 * Parse one line of an engine's stdout.
 *
 * Both engines emit the same four-verb protocol:
 *   READY
 *   DETECTED:<phrase>|<confidence>
 *   ERROR:<message>
 *   DEBUG:<message>
 *
 * Anything else (blank lines, stray output from a child's dependencies)
 * returns null and is ignored by the caller.
 *
 * `defaultConfidence` is used when a DETECTED line carries no `|<confidence>`
 * suffix or an unparseable one. The sherpa engine's child always reports 1.0,
 * so it passes 1.0; the Windows engine reports a real score and passes 0 so a
 * malformed line can never clear a threshold.
 */
export function parseEngineLine(
  line: string,
  defaultConfidence = 1.0
): EngineEvent | null {
  const trimmed = line.trim();

  if (trimmed === "READY") {
    return { type: "ready" };
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
