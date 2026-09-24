import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ISSUE_BODY,
  isVerboseLogLevel,
  issueReportText,
  issueReportUrl,
  logLevelName,
  terminalHandsOverToggle,
} from "../../src/wakeWordCore";

/**
 * The route from Show Diagnostics to a new issue, the verbose log's level,
 * and whether the terminal hands the toggle shortcut over.
 */

const bugsUrl = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { bugs: { url: string } }
).bugs.url;

describe("issueReportUrl", () => {
  it("opens a new issue on the repository the manifest names, with the fixed body", () => {
    const url = issueReportUrl(bugsUrl);
    expect(url).toBe(
      `https://github.com/analyticsinmotion/wake-word/issues/new?body=${encodeURIComponent(ISSUE_BODY)}`
    );
    expect(decodeURIComponent(new URL(url ?? "").searchParams.get("body") ?? "")).toBe(ISSUE_BODY);
  });

  it("accepts a trailing slash, and nothing that is not a GitHub issue tracker", () => {
    expect(issueReportUrl("https://github.com/owner/repo/issues/")).toMatch(/^https:\/\/github\.com\/owner\/repo\/issues\/new\?/);
    for (const other of [undefined, 42, "", "http://github.com/o/r/issues", "https://example.com/o/r/issues", "https://github.com/o/issues"]) {
      expect(issueReportUrl(other)).toBeNull();
    }
  });
});

describe("the new issue's body", () => {
  it("carries nothing from the machine: the report goes on the clipboard, not in the address", () => {
    expect(ISSUE_BODY).toContain("Paste it below this line");
    expect(ISSUE_BODY).not.toMatch(/Diagnostics ===|Version:|Platform:/);
  });

  it("holds no character the editor changes on its way to the browser", () => {
    expect(ISSUE_BODY).not.toMatch(/[?#&=+%]/);
  });
});

describe("issueReportText", () => {
  it("puts the report in a fenced block, one line each", () => {
    expect(issueReportText(["=== Wake Word Diagnostics ===", "Version: 1.0.0"])).toBe(
      "```text\n=== Wake Word Diagnostics ===\nVersion: 1.0.0\n```\n"
    );
  });
});

describe("the log level", () => {
  it("turns the verbose log on at Debug and Trace only", () => {
    // vscode.LogLevel: Off 0, Trace 1, Debug 2, Info 3, Warning 4, Error 5.
    expect([0, 1, 2, 3, 4, 5].map(isVerboseLogLevel)).toEqual([false, true, true, false, false, false]);
  });

  it("names each level", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(logLevelName)).toEqual([
      "off",
      "trace",
      "debug",
      "info",
      "warning",
      "error",
      "level 9",
    ]);
  });
});

describe("terminalHandsOverToggle", () => {
  it("is true when the toggle is in commandsToSkipShell, as the manifest's default puts it", () => {
    expect(terminalHandsOverToggle(["wakeWord.toggle"], false)).toBe(true);
    expect(terminalHandsOverToggle(["other.command", "wakeWord.toggle"], undefined)).toBe(true);
  });

  it("is false when a value of the user's or another extension's replaces it, or takes it out", () => {
    expect(terminalHandsOverToggle([], false)).toBe(false);
    expect(terminalHandsOverToggle(["other.command"], false)).toBe(false);
    expect(terminalHandsOverToggle(["wakeWord.toggle", "-wakeWord.toggle"], false)).toBe(false);
    expect(terminalHandsOverToggle(undefined, false)).toBe(false);
  });

  it("is false when every key is sent to the shell", () => {
    expect(terminalHandsOverToggle(["wakeWord.toggle"], true)).toBe(false);
  });
});
