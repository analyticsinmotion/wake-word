import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * What package.json declares for the toggle shortcut and for the listing.
 * The shortcut and the words the Marketplace, Open VSX, and each editor's
 * Extensions view show are pinned here, so a change to either is a change to
 * this test, made on purpose.
 */

interface Keybinding {
  command: string;
  key: string;
  win?: string;
  linux?: string;
  mac?: string;
  when?: string;
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as {
  description: string;
  keywords: string[];
  contributes: {
    commands: Array<{ command: string }>;
    keybindings: Keybinding[];
    configurationDefaults: Record<string, unknown>;
  };
};

describe("the toggle shortcut", () => {
  const bindings = manifest.contributes.keybindings.filter((binding) => binding.command === "wakeWord.toggle");

  it("is declared once, for Toggle Listening", () => {
    expect(bindings).toHaveLength(1);
    expect(manifest.contributes.commands.map((command) => command.command)).toContain("wakeWord.toggle");
  });

  it("is Shift+Alt+W on Windows and Linux and Ctrl+Cmd+W on macOS", () => {
    const [binding] = bindings;
    expect(binding.key).toBe("shift+alt+w");
    expect(binding.win).toBe("shift+alt+w");
    expect(binding.linux).toBe("shift+alt+w");
    expect(binding.mac).toBe("ctrl+cmd+w");
  });

  it("has no when clause, so it works wherever focus is", () => {
    expect(bindings[0].when).toBeUndefined();
  });

  it("is the only shortcut the extension declares", () => {
    expect(manifest.contributes.keybindings).toHaveLength(1);
  });

  it("reaches the extension from the terminal, which otherwise sends it to the shell", () => {
    expect(manifest.contributes.configurationDefaults["terminal.integrated.commandsToSkipShell"]).toEqual([
      "wakeWord.toggle",
    ]);
    expect(Object.keys(manifest.contributes.configurationDefaults)).toEqual(["terminal.integrated.commandsToSkipShell"]);
  });
});

describe("the listing", () => {
  it("says what the extension does", () => {
    expect(manifest.description).toBe(
      "Say a wake phrase to open Claude Code, the chat panel, the terminal, or any command. " +
        "Runs locally, no accounts, zero config."
    );
  });

  it("has these keywords and no others", () => {
    expect(manifest.keywords).toEqual([
      "voice",
      "wake word",
      "speech",
      "hands-free",
      "accessibility",
      "claude code",
      "voice activation",
    ]);
  });

  it("names no product other than Claude Code, the default route's target", () => {
    for (const text of [manifest.description, ...manifest.keywords]) {
      const withoutClaudeCode = text.replace(/claude code/gi, "");
      expect(withoutClaudeCode).not.toMatch(/claude/i);
    }
  });
});
