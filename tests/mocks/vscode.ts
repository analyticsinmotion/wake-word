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

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
}

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
};

export const workspace = {
  getConfiguration: () => notImplemented("workspace.getConfiguration"),
  onDidChangeConfiguration: () => notImplemented("workspace.onDidChangeConfiguration"),
};

export const commands = {
  registerCommand: () => notImplemented("commands.registerCommand"),
  executeCommand: () => notImplemented("commands.executeCommand"),
};
