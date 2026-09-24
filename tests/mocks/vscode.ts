/**
 * Minimal stand-in for the `vscode` module.
 *
 * The real module only exists inside the extension host. Unit tests never call
 * into the VS Code API: this stub exists so that importing a src module which
 * declares `import * as vscode from "vscode"` resolves. Anything a test does
 * reach for should be stubbed per-test with `vi.spyOn`, not added here.
 */

export const version = "0.0.0-test";

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warning = 4,
  Error = 5,
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
  /** Keeps the text it was given, which toString() returns. */
  static parse(value: string): Uri {
    return new Uri(value);
  }
  toString(): string {
    return this.fsPath;
  }
}

export class MarkdownString {
  isTrusted = false;
  constructor(public value = "") {}
}

/**
 * A local desktop window. A test of a remote window sets `remoteName` on the
 * instance it imported.
 */
export const env = {
  appName: "Test Editor",
  remoteName: undefined as string | undefined,
  uiKind: UIKind.Desktop,
  clipboard: {
    writeText: (_text: string): Promise<void> => notImplemented("env.clipboard.writeText"),
  },
  openExternal: (_target: Uri): Promise<boolean> => notImplemented("env.openExternal"),
};

function notImplemented(name: string): never {
  throw new Error(
    `vscode.${name} was called in a unit test. Unit tests must not touch the ` +
      `VS Code API; stub it explicitly or move the logic under test into a ` +
      `pure module.`
  );
}

export const window = {
  createOutputChannel: () => notImplemented("window.createOutputChannel"),
  createStatusBarItem: () => notImplemented("window.createStatusBarItem"),
  showInformationMessage: () => notImplemented("window.showInformationMessage"),
  showWarningMessage: () => notImplemented("window.showWarningMessage"),
  showErrorMessage: () => notImplemented("window.showErrorMessage"),
  withProgress: () => notImplemented("window.withProgress"),
  onDidChangeWindowState: () => notImplemented("window.onDidChangeWindowState"),
  get state(): never {
    return notImplemented("window.state");
  },
};

export const workspace = {
  getConfiguration: () => notImplemented("workspace.getConfiguration"),
  onDidChangeConfiguration: () => notImplemented("workspace.onDidChangeConfiguration"),
};

export const commands = {
  registerCommand: () => notImplemented("commands.registerCommand"),
  executeCommand: () => notImplemented("commands.executeCommand"),
  getCommands: () => notImplemented("commands.getCommands"),
};

export const extensions = {
  get all(): never {
    return notImplemented("extensions.all");
  },
  onDidChange: () => notImplemented("extensions.onDidChange"),
};
