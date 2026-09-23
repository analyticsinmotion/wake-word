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

/**
 * Bounds enforced on `wakeWord.confidenceThreshold`, and its default. The
 * value becomes every keyword line's trigger threshold in the engine, whose
 * config.rs repeats these numbers, and the package.json schema states them.
 */
export const MIN_THRESHOLD = 0.01;
export const MAX_THRESHOLD = 0.9;
export const DEFAULT_THRESHOLD = 0.05;

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

// -- Command availability -----------------------------------------------

/**
 * An installed extension as the availability check reads it, from
 * `vscode.extensions.all`, which lists the installed extensions that are
 * enabled. `packageJSON` is the extension's manifest: another publisher's
 * file, so nothing about its shape is assumed.
 */
export interface InstalledExtension {
  id: string;
  packageJSON: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ON_COMMAND = "onCommand:";

/**
 * The commands a manifest declares: each `contributes.commands` entry, and
 * each command named by an `onCommand:` activation event.
 *
 * Either makes a command runnable before its extension has started. Running
 * a command that is not registered raises its `onCommand:` activation event,
 * which the editor also raises for every contributed command, and the
 * extension registers its commands as it activates. `contributes.commands`
 * can be a single object rather than a list. Anything malformed is skipped,
 * never thrown on.
 */
export function manifestCommands(packageJSON: unknown): string[] {
  const commands: string[] = [];
  const manifest = isRecord(packageJSON) ? packageJSON : {};
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : {};
  const contributed = contributes.commands;
  for (const entry of Array.isArray(contributed) ? contributed : [contributed]) {
    if (isRecord(entry) && typeof entry.command === "string" && entry.command.length > 0) {
      commands.push(entry.command);
    }
  }
  const events = manifest.activationEvents;
  for (const event of Array.isArray(events) ? events : []) {
    if (typeof event === "string" && event.startsWith(ON_COMMAND) && event.length > ON_COMMAND.length) {
      commands.push(event.slice(ON_COMMAND.length));
    }
  }
  return commands;
}

/** Every command the extensions declare, each with the first extension that declares it. */
export function declaredCommands(extensions: readonly InstalledExtension[]): Map<string, string> {
  const declared = new Map<string, string>();
  for (const extension of extensions) {
    for (const command of manifestCommands(extension.packageJSON)) {
      if (!declared.has(command)) {
        declared.set(command, String(extension.id));
      }
    }
  }
  return declared;
}

/** What the availability check knows about the commands in this editor. */
export interface CommandSources {
  /** Commands registered now, from `vscode.commands.getCommands()`. */
  registered: ReadonlySet<string>;
  /** Commands the installed, enabled extensions declare, with the extension that declares each. */
  declared: ReadonlyMap<string, string>;
  /** Identifiers of the installed, enabled extensions, lower-cased. */
  installed: ReadonlySet<string>;
}

export function commandSources(
  registered: Iterable<string>,
  extensions: readonly InstalledExtension[]
): CommandSources {
  return {
    registered: new Set(registered),
    declared: declaredCommands(extensions),
    installed: new Set(extensions.map((extension) => String(extension.id).toLowerCase())),
  };
}

/**
 * How a command is available: registered already, declared by an installed
 * extension that has not registered it yet, or neither. Command IDs are
 * compared exactly, as the editor compares them.
 */
export type CommandStatus = "registered" | "declared" | "missing";

export function commandStatus(command: string, sources: CommandSources): CommandStatus {
  if (sources.registered.has(command)) {
    return "registered";
  }
  return sources.declared.has(command) ? "declared" : "missing";
}

/** What provides a missing command, where that is known. */
export type CommandProvider =
  | {
      kind: "extension";
      id: string;
      name: string;
      /** Installed and enabled, but not declaring the command. */
      installed: boolean;
    }
  | { kind: "editor" }
  | { kind: "unknown" };

/**
 * The providers of the default routes' commands, by command prefix:
 * `claude-vscode.` commands come from the Claude Code extension, and
 * `workbench.` commands are the editor's own.
 */
const KNOWN_PROVIDERS: ReadonlyArray<{
  prefix: string;
  provider: { kind: "extension"; id: string; name: string } | { kind: "editor" };
}> = [
  { prefix: "claude-vscode.", provider: { kind: "extension", id: "anthropic.claude-code", name: "Claude Code" } },
  { prefix: "workbench.", provider: { kind: "editor" } },
];

/**
 * What provides `command`, from the fixed list above. An extension on that
 * list can be installed and still not declare the command, when the command
 * ID is mistyped, so the result says whether it is installed.
 */
export function commandProvider(command: string, installed: ReadonlySet<string>): CommandProvider {
  const known = KNOWN_PROVIDERS.find((entry) => command.startsWith(entry.prefix));
  if (!known) {
    return { kind: "unknown" };
  }
  if (known.provider.kind === "editor") {
    return { kind: "editor" };
  }
  return { ...known.provider, installed: installed.has(known.provider.id) };
}

/**
 * Why a route is not listened for. A value of its own rather than a flag on
 * the route, so a route that is off for any other reason is never taken for
 * one whose command is missing, and both can hold at once.
 */
export type SetAsideReason = "action-missing";

/**
 * A route that is not listened for, and why. Held in memory only: the
 * extension never writes it to settings, which Settings Sync would carry to
 * other machines, where the command can be there.
 */
export interface SetAsideRoute {
  /** The route as configured. */
  route: WakePhrase;
  label: string;
  /** One of the built-in default routes, rather than one from wakeWord.routes. */
  isDefault: boolean;
  command: string;
  reason: SetAsideReason;
  /** What provides the command, where that is known. */
  provider: CommandProvider;
}

/** A listened route whose command is declared by an extension that has not registered it yet. */
export interface DeclaredOnlyRoute {
  label: string;
  command: string;
  /** The extension that declares the command. */
  extension: string;
}

export interface RouteAvailability {
  /** The routes to listen for, in their configured order. */
  listened: WakePhrase[];
  /** The routes set aside because their command is missing, in their configured order. */
  setAside: SetAsideRoute[];
  /** Listened routes that count as available only through a declaration. */
  declaredOnly: DeclaredOnlyRoute[];
}

/**
 * Split the routes into the ones to listen for and the ones whose command
 * is not available in this editor.
 *
 * A command is available when it is registered, or when an installed,
 * enabled extension declares it (see manifestCommands()). The second half is
 * not optional: `getCommands()` lists only registered commands, an extension
 * registers its commands as it activates, and one that activates on
 * `onStartupFinished`, as this extension does, may not have started when
 * the check runs. Running a declared command starts its extension first, so
 * such a route works and is listened for.
 *
 * `defaults` identifies the built-in routes, by identity: resolveRoutes()
 * returns those objects themselves. With no sources, because the command
 * list could not be read, every route is listened for rather than setting
 * aside routes that may work.
 */
export function checkRouteAvailability(
  routes: readonly WakePhrase[],
  defaults: readonly WakePhrase[],
  sources: CommandSources | null
): RouteAvailability {
  const availability: RouteAvailability = { listened: [], setAside: [], declaredOnly: [] };
  for (const route of routes) {
    const status = sources ? commandStatus(route.command, sources) : "registered";
    if (sources && status === "missing") {
      availability.setAside.push({
        route,
        label: route.label,
        isDefault: defaults.includes(route),
        command: route.command,
        reason: "action-missing",
        provider: commandProvider(route.command, sources.installed),
      });
      continue;
    }
    availability.listened.push(route);
    if (sources && status === "declared") {
      availability.declaredOnly.push({
        label: route.label,
        command: route.command,
        extension: sources.declared.get(route.command) ?? "",
      });
    }
  }
  return availability;
}

/** A set-aside route's identity when sets of them are compared: label, command, and reason. */
function setAsideEntry(label: string, command: string, reason: string): string {
  return JSON.stringify([label, command, reason]);
}

function entryOf(setAside: SetAsideRoute): string {
  return setAsideEntry(setAside.label, setAside.command, setAside.reason);
}

/**
 * The set-aside routes as one comparable string, whatever their order. The
 * extension compares it with the one for the routes the engine was started
 * with, to tell whether which routes are listened for has changed.
 */
export function setAsideKey(setAside: readonly SetAsideRoute[]): string {
  return [...new Set(setAside.map(entryOf))].sort().join("\n");
}

/**
 * Why a set-aside route's command is missing, naming what provides it where
 * that is known.
 */
export function describeMissingCommand(setAside: Pick<SetAsideRoute, "command" | "provider">): string {
  const { command, provider } = setAside;
  switch (provider.kind) {
    case "extension":
      return provider.installed
        ? `${provider.name} (${provider.id}) is installed but does not provide ${command}`
        : `${command} needs ${provider.name} (${provider.id}), which is not installed or is disabled`;
    case "editor":
      return `${command} is not available in this editor`;
    case "unknown":
      return `no installed extension provides ${command}`;
  }
}

/**
 * The set-aside routes the user was last told about, as kept in the
 * extension's global state: one `[label, command, reason]` triple each.
 * Global state stays on this machine unless an extension asks for a key to
 * be synchronised, which this one never does.
 */
export type ToldSetAside = Array<[string, string, string]>;

/** The entries of a remembered value. Anything unreadable, such as a value of another shape, counts as nothing told. */
function toldEntries(told: unknown): Set<string> {
  const entries = new Set<string>();
  for (const item of Array.isArray(told) ? told : []) {
    if (Array.isArray(item) && item.length === 3 && item.every((part) => typeof part === "string")) {
      entries.add(setAsideEntry(item[0], item[1], item[2]));
    }
  }
  return entries;
}

function sameEntries(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

/** One output channel line. */
export interface ReportLine {
  level: "info" | "warn";
  text: string;
}

/** What to say about one availability check. See planAvailabilityReport(). */
export interface AvailabilityReport {
  /** Output channel lines, in order. */
  lines: ReportLine[];
  /** The notification to show, or null for none. */
  notification: string | null;
  /** The value to remember in global state as told, or null when the remembered one already matches. */
  told: ToldSetAside | null;
}

function listItem(setAside: SetAsideRoute): string {
  return `"${setAside.label}": ${describeMissingCommand(setAside)}.`;
}

/** The notification for routes newly set aside while others are still listened for. */
export function formatSetAsideNotification(setAside: readonly SetAsideRoute[]): string {
  if (setAside.length === 1) {
    return (
      `Wake Word is not listening for "${setAside[0].label}": ${describeMissingCommand(setAside[0])}. ` +
      "It comes back once the command is available."
    );
  }
  return (
    `Wake Word is not listening for ${setAside.length} routes whose commands are missing. ` +
    `${setAside.map(listItem).join(" ")} They come back once their commands are available.`
  );
}

/** The notification when every route is set aside, so nothing is listened for. */
export function formatNothingToListenFor(setAside: readonly SetAsideRoute[]): string {
  return (
    "Wake Word is not listening: none of the routes' commands are available in this editor. " +
    `${setAside.map(listItem).join(" ")} Listening starts once a route's command is available.`
  );
}

/**
 * Decide what to say about an availability check.
 *
 * The output channel gets a line for each route newly set aside and each one
 * back, and for each route newly counted as available only through a
 * declaration, compared with the previous check of this session (`previous`,
 * null before the first, so every session's log explains the routes set
 * aside at its first check). It also gets a line whenever nothing can be
 * listened for at all.
 *
 * A notification is raised only for a route set aside that the user has not
 * already been told about (`told`, the value remembered in global state), so
 * it is not repeated on every start or across restarts, and a route coming
 * back raises none. When every route is set aside the notification says so,
 * and `explicit`, set when the user asked to listen, raises it even if they
 * were told before: their request would otherwise do nothing they can see.
 */
export function planAvailabilityReport(
  availability: RouteAvailability,
  previous: Pick<RouteAvailability, "setAside" | "declaredOnly"> | null,
  told: unknown,
  explicit: boolean
): AvailabilityReport {
  const lines: ReportLine[] = [];
  const before = new Set((previous?.setAside ?? []).map(entryOf));
  const now = new Set(availability.setAside.map(entryOf));

  for (const setAside of availability.setAside) {
    if (!before.has(entryOf(setAside))) {
      lines.push({
        level: "warn",
        text:
          `Route "${setAside.label}" set aside: ${describeMissingCommand(setAside)}. ` +
          "Its phrases are not listened for until the command is available.",
      });
    }
  }
  // Back means listened for again, not merely gone: a route removed from the
  // settings is neither.
  const listened = new Set(availability.listened.map((route) => JSON.stringify([route.label, route.command])));
  for (const setAside of previous?.setAside ?? []) {
    if (!now.has(entryOf(setAside)) && listened.has(JSON.stringify([setAside.label, setAside.command]))) {
      lines.push({ level: "info", text: `Route "${setAside.label}" is back: ${setAside.command} is available again.` });
    }
  }
  const declaredBefore = new Set((previous?.declaredOnly ?? []).map((route) => JSON.stringify(route)));
  for (const route of availability.declaredOnly) {
    if (declaredBefore.has(JSON.stringify(route))) {
      continue;
    }
    lines.push({
      level: "info",
      text:
        `Route "${route.label}": ${route.command} is not registered yet, but ${route.extension} declares it, ` +
        "so the route is listened for.",
    });
  }

  const nothingToListenFor = availability.listened.length === 0 && availability.setAside.length > 0;
  if (nothingToListenFor) {
    lines.push({
      level: "warn",
      text: "Not listening: none of the routes' commands are available in this editor. " +
        "Listening starts once a route's command is available.",
    });
  }

  const toldBefore = toldEntries(told);
  const untold = availability.setAside.filter((setAside) => !toldBefore.has(entryOf(setAside)));
  let notification: string | null = null;
  if (nothingToListenFor) {
    if (explicit || untold.length > 0) {
      notification = formatNothingToListenFor(availability.setAside);
    }
  } else if (untold.length > 0) {
    notification = formatSetAsideNotification(untold);
  }

  return {
    lines,
    notification,
    told: sameEntries(toldBefore, now)
      ? null
      : availability.setAside.map((setAside): [string, string, string] => [
          setAside.label,
          setAside.command,
          setAside.reason,
        ]),
  };
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

/**
 * The threshold for a log line: the global setting, and how many routes
 * replace it with a `confidenceThreshold` of their own.
 *
 * Without the count, a line naming only the global value reads as though it
 * applied to every phrase, which it does not once a route carries its own.
 * The per-route values themselves are in the diagnostics report, one per
 * route.
 */
export function describeThreshold(threshold: number, routes: readonly WakePhrase[]): string {
  const own = routes.filter((r) => r && r.confidenceThreshold !== undefined).length;
  return own === 0 ? `${threshold}` : `${threshold} (overridden by ${plural(own, "route")})`;
}

// -- Settings that decide what the engine listens for -------------------

/**
 * What changed that decides what a running engine listens for, and that it
 * cannot pick up on its own.
 *
 * The routes and the threshold are read in startListening() and sent in the
 * engine's config line: the routes become its keyword lines, and the
 * threshold becomes every line's trigger value. `availability` is a change
 * in which routes' commands are available, found when an extension is
 * installed, removed, enabled or disabled: it changes which routes become
 * keyword lines. An engine already running was given the old ones, so any
 * of the three has to reach it through a start.
 *
 * `wakeWord.audioDevice` is not here: the engine is built with the
 * microphone it listens on, so that setting replaces the engine itself.
 */
export interface ListenSettingsChange {
  routes: boolean;
  threshold: boolean;
  availability: boolean;
}

/** What the extension is doing when a change arrives. */
export interface ListeningState {
  /** The engine holds the microphone. */
  listening: boolean;
  /** A start is in flight: the engine has not reported READY yet. */
  starting: boolean;
  /** The engine is paused: a handoff, a cooldown, or a focus-loss pause. */
  paused: boolean;
  /** A cooldown countdown is running. */
  cooldown: boolean;
  /** A manual handoff is waiting for the user to resume. */
  manualPause: boolean;
  /**
   * None of the routes' commands was available at the last start, so no
   * engine was started and the microphone is closed.
   */
  waiting: boolean;
}

/**
 * What to do about it.
 *
 * `restart` stops the engine and starts it again with the new settings.
 * `apply-on-resume` holds them until the paused engine resumes, which then
 * goes through a full start. `apply-when-started` holds them until the
 * start in flight reports READY, because that engine was given the old
 * ones. `start` checks the routes again while nothing is listened for,
 * which starts listening if a route's command is now available. `none`
 * leaves them for the next start to read.
 */
export type ListenSettingsAction = "none" | "restart" | "apply-on-resume" | "apply-when-started" | "start";

/**
 * Decide what a change to what the engine listens for does in the state the
 * extension is in.
 *
 * The rule that shapes this: a paused engine must not take the microphone
 * back because something changed. Paused means a handoff, and a handoff
 * means an assistant has the microphone. So every paused state defers, only
 * an engine that already holds the microphone restarts, and only an
 * extension waiting with no engine and no handoff starts one.
 *
 * A start in flight is checked before the paused flags because a resume
 * through startListening() leaves the engine paused until READY arrives:
 * the resume that would have consumed a deferral has already happened, so
 * deferring to it would drop the change. `apply-when-started` reopens no
 * microphone either, since it acts only once the engine is listening.
 */
export function decideListenSettingsChange(
  change: ListenSettingsChange,
  state: ListeningState
): ListenSettingsAction {
  if (!change.routes && !change.threshold && !change.availability) {
    return "none";
  }
  if (state.listening) {
    return "restart";
  }
  if (state.starting) {
    return "apply-when-started";
  }
  if (state.paused || state.cooldown || state.manualPause) {
    return "apply-on-resume";
  }
  if (state.waiting) {
    return "start";
  }
  // Off, in the error state, or standing by while another window listens.
  // The next start reads the settings itself.
  return "none";
}

/**
 * What changed, as the subject of a log line. At least one of them has,
 * since a line is only written for a change the extension acts on.
 */
export function describeListenSettingsChange(change: ListenSettingsChange): string {
  const subjects: string[] = [];
  if (change.routes) {
    subjects.push("routes");
  }
  if (change.threshold) {
    subjects.push("confidence threshold");
  }
  if (change.availability) {
    subjects.push("command availability");
  }
  const last = subjects.pop() ?? "";
  const text = subjects.length > 0 ? `${subjects.join(", ")} and ${last}` : last;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The output channel line for a settings change: what changed, and when it
 * will take effect. Null for a change the extension does not act on, which
 * is not worth a line.
 */
export function formatListenSettingsChange(
  change: ListenSettingsChange,
  action: ListenSettingsAction
): string | null {
  if (action === "none") {
    return null;
  }
  const subject = describeListenSettingsChange(change);
  if (action === "restart") {
    return `${subject} changed: restarting listening`;
  }
  if (action === "apply-on-resume") {
    return `${subject} changed while listening was paused: applied when listening resumes`;
  }
  if (action === "start") {
    return `${subject} changed while waiting for a route's command: checking the routes again`;
  }
  return `${subject} changed while the engine was starting: applied as soon as it is listening`;
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
 *   Session: 342min, 14 detections (Claude: 8, Chat: 4, Terminal: 2),
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

/**
 * Replace the user's home directory with `~` wherever it appears in `text`.
 *
 * Diagnostics are meant to be pasted into an issue, and paths under the home
 * directory (the model's global storage, the installed extension) carry the
 * account name. Only whole path segments match, so `/home/ann` does not
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
  /** The packaged engine binary the extension spawns. */
  engineBinaryPath: string;
  /** What the binary's self-test reported, or why it could not run. */
  engineBinaryStatus: string;
  /** What the extension is doing, in words. */
  state: string;
  isListening: boolean;
  isPaused: boolean;
  modelName: string;
  modelDir: string;
  modelPresent: boolean;
  modelSha256: string;
  audioDevice: string;
  /** The global wakeWord.confidenceThreshold, already clamped. */
  threshold: number;
  cooldownSeconds: number;
  confirmationMode: boolean;
  pauseOnFocusLoss: boolean;
  enableOnStartup: boolean;
  /** The routes listened for. */
  routes: readonly WakePhrase[];
  /** The routes set aside, listed apart from the ones listened for. */
  setAside: readonly SetAsideRoute[];
  usingDefaultRoutes: boolean;
  /** Lines from formatPhraseChecks(), for the routes listened for. */
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
    "Engine: sherpa-onnx",
    `Engine binary: ${input.engineBinaryPath} (${input.engineBinaryStatus})`,
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
    `Routes: ${input.routes.length + input.setAside.length}${input.usingDefaultRoutes ? " (defaults)" : ""}`,
  ];

  const describeRoute = (route: WakePhrase): string => {
    const handoff = resolveHandoff(route.handoff);
    const cooldown =
      handoff === "timer" && typeof route.cooldownSeconds === "number" ? `, ${route.cooldownSeconds}s` : "";
    // Only for a route that set one, and the value its keyword lines carry:
    // the same clamp the engine's config line goes through, falling back to
    // the global threshold reported above.
    const threshold =
      route.confidenceThreshold === undefined
        ? ""
        : `, threshold ${clampThreshold(route.confidenceThreshold, input.threshold)}`;
    return (
      `  "${route.label}" [${normalizePhrases(route.phrase).join(", ")}] -> ${route.command} ` +
      `(${handoff}${cooldown}${threshold})`
    );
  };

  for (const route of input.routes) {
    lines.push(describeRoute(route));
  }

  if (input.setAside.length === 0) {
    lines.push("Set aside: none");
  } else {
    lines.push(`Set aside: ${plural(input.setAside.length, "route")}, not listened for`);
    for (const setAside of input.setAside) {
      lines.push(`${describeRoute(setAside.route)}: ${setAside.reason}, ${describeMissingCommand(setAside)}`);
    }
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
