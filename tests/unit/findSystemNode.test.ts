import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: mocks.execSync,
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: mocks.existsSync,
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { clearNodePathCache, findSystemNode } from "../../src/sherpaEngine";

const realPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("findSystemNode", () => {
  beforeEach(() => {
    // The lookup result is cached for the life of the module.
    clearNodePathCache();
    mocks.execSync.mockReset();
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("returns the user override without probing anything", () => {
    setPlatform("darwin");
    expect(findSystemNode("/Users/me/.nvm/versions/node/v20.11.0/bin/node")).toBe(
      "/Users/me/.nvm/versions/node/v20.11.0/bin/node"
    );
    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });

  it("falls through to the shell lookup when the override is empty", () => {
    setPlatform("linux");
    mocks.execSync.mockReturnValue("/usr/bin/node\n");
    expect(findSystemNode("")).toBe("/usr/bin/node");
    expect(mocks.execSync).toHaveBeenCalledWith("which node", { encoding: "utf8", windowsHide: true });
  });

  it("falls through to the shell lookup when no override is passed", () => {
    setPlatform("linux");
    mocks.execSync.mockReturnValue("/usr/bin/node\n");
    expect(findSystemNode()).toBe("/usr/bin/node");
  });

  it("uses `where node` on Windows", () => {
    setPlatform("win32");
    mocks.execSync.mockReturnValue("C:\\Program Files\\nodejs\\node.exe\r\n");
    expect(findSystemNode()).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(mocks.execSync).toHaveBeenCalledWith("where node", { encoding: "utf8", windowsHide: true });
  });

  it("takes the first result when `where node` returns several", () => {
    setPlatform("win32");
    mocks.execSync.mockReturnValue(
      "C:\\Program Files\\nodejs\\node.exe\r\nC:\\Users\\me\\scoop\\node.exe\r\n"
    );
    expect(findSystemNode()).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("falls through when the shell lookup throws", () => {
    setPlatform("linux");
    mocks.execSync.mockImplementation(() => {
      throw new Error("Command failed: which node");
    });
    mocks.existsSync.mockImplementation((p: string) => p === "/usr/bin/node");
    expect(findSystemNode()).toBe("/usr/bin/node");
  });

  it("falls through when the shell lookup returns nothing", () => {
    setPlatform("linux");
    mocks.execSync.mockReturnValue("   \n");
    mocks.existsSync.mockImplementation((p: string) => p === "/usr/local/bin/node");
    expect(findSystemNode()).toBe("/usr/local/bin/node");
  });

  it("probes the Windows well-known path", () => {
    setPlatform("win32");
    mocks.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mocks.existsSync.mockImplementation(
      (p: string) => p === "C:\\Program Files\\nodejs\\node.exe"
    );
    expect(findSystemNode()).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("prefers Homebrew over /usr/local on macOS", () => {
    setPlatform("darwin");
    mocks.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mocks.existsSync.mockReturnValue(true);
    expect(findSystemNode()).toBe("/opt/homebrew/bin/node");
  });

  it("falls back to /usr/local on an Intel Mac without Homebrew ARM paths", () => {
    setPlatform("darwin");
    mocks.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mocks.existsSync.mockImplementation((p: string) => p === "/usr/local/bin/node");
    expect(findSystemNode()).toBe("/usr/local/bin/node");
  });

  it("prefers /usr/bin over /usr/local on Linux", () => {
    setPlatform("linux");
    mocks.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mocks.existsSync.mockReturnValue(true);
    expect(findSystemNode()).toBe("/usr/bin/node");
  });

  it("returns bare 'node' as a last resort", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      mocks.execSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mocks.existsSync.mockReturnValue(false);
      setPlatform(platform);
      expect(findSystemNode()).toBe("node");
    }
  });

  it("never probes the wrong platform's well-known paths", () => {
    setPlatform("darwin");
    mocks.execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mocks.existsSync.mockReturnValue(false);
    findSystemNode();
    const probed = mocks.existsSync.mock.calls.map((c) => c[0]);
    expect(probed).toEqual(["/opt/homebrew/bin/node", "/usr/local/bin/node"]);
  });

  describe("cache", () => {
    // The lookup spawns a shell synchronously on the extension host thread.
    // It used to run on every engine start, which meant every resume.

    it("returns the cached path without running the shell lookup again", () => {
      setPlatform("linux");
      mocks.execSync.mockReturnValue("/usr/bin/node\n");
      expect(findSystemNode()).toBe("/usr/bin/node");
      expect(findSystemNode()).toBe("/usr/bin/node");
      expect(findSystemNode("")).toBe("/usr/bin/node");
      expect(mocks.execSync).toHaveBeenCalledTimes(1);
    });

    it("caches a well-known path found after the shell lookup failed", () => {
      setPlatform("darwin");
      mocks.execSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mocks.existsSync.mockImplementation((p: string) => p === "/usr/local/bin/node");
      expect(findSystemNode()).toBe("/usr/local/bin/node");
      expect(findSystemNode()).toBe("/usr/local/bin/node");
      expect(mocks.execSync).toHaveBeenCalledTimes(1);
      expect(mocks.existsSync).toHaveBeenCalledTimes(2);
    });

    it("lets an override bypass the cache without replacing it", () => {
      setPlatform("linux");
      mocks.execSync.mockReturnValue("/usr/bin/node\n");
      findSystemNode();
      expect(findSystemNode("/opt/node22/bin/node")).toBe("/opt/node22/bin/node");
      expect(findSystemNode()).toBe("/usr/bin/node");
      expect(mocks.execSync).toHaveBeenCalledTimes(1);
    });

    it("never caches an override", () => {
      setPlatform("linux");
      mocks.execSync.mockReturnValue("/usr/bin/node\n");
      findSystemNode("/opt/node22/bin/node");
      expect(findSystemNode()).toBe("/usr/bin/node");
      expect(mocks.execSync).toHaveBeenCalledTimes(1);
    });

    it("probes afresh after clearNodePathCache()", () => {
      setPlatform("linux");
      mocks.execSync.mockReturnValue("/usr/bin/node\n");
      findSystemNode();
      mocks.execSync.mockReturnValue("/home/me/.local/bin/node\n");
      clearNodePathCache();
      expect(findSystemNode()).toBe("/home/me/.local/bin/node");
      expect(mocks.execSync).toHaveBeenCalledTimes(2);
    });

    it("does not cache the bare fallback, so a Node.js installed later is found", () => {
      setPlatform("win32");
      mocks.execSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(findSystemNode()).toBe("node");
      mocks.existsSync.mockImplementation((p: string) => p === "C:\\Program Files\\nodejs\\node.exe");
      expect(findSystemNode()).toBe("C:\\Program Files\\nodejs\\node.exe");
    });
  });
});
