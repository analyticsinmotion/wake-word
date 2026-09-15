import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";

vi.mock("child_process", () => ({ execSync: vi.fn(), spawn: vi.fn() }));
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { existsSync, readFileSync } from "fs";
import {
  MAX_REDIRECTS,
  MODEL_FILES,
  MODEL_NAME,
  MODEL_SHA256,
  modelExtractCommand,
  modelStatus,
  redirectLimitExceeded,
  shouldFollowRedirect,
  verifyModelHash,
} from "../../src/sherpaEngine";

describe("shouldFollowRedirect", () => {
  it("follows the 302 GitHub returns for a release asset", () => {
    expect(
      shouldFollowRedirect(302, "https://objects.githubusercontent.com/kws-models.tar.bz2")
    ).toBe(true);
  });

  it("follows every 3xx that carries a location", () => {
    for (const code of [300, 301, 302, 303, 307, 308]) {
      expect(shouldFollowRedirect(code, "https://cdn.example/model")).toBe(true);
    }
  });

  it("does not follow a 3xx without a location header", () => {
    // Node reports a missing header as undefined. Following it would recurse
    // into https.get(undefined) rather than surfacing the bad response.
    expect(shouldFollowRedirect(302, undefined)).toBe(false);
    expect(shouldFollowRedirect(302, "")).toBe(false);
  });

  it("does not follow a success response", () => {
    expect(shouldFollowRedirect(200, "https://cdn.example/model")).toBe(false);
    expect(shouldFollowRedirect(204, undefined)).toBe(false);
  });

  it("does not follow an error response", () => {
    expect(shouldFollowRedirect(404, "https://cdn.example/model")).toBe(false);
    expect(shouldFollowRedirect(500, undefined)).toBe(false);
  });

  it("does not follow a response with no status code", () => {
    expect(shouldFollowRedirect(undefined, "https://cdn.example/model")).toBe(false);
  });
});

describe("redirectLimitExceeded", () => {
  it("allows the hops a real download needs", () => {
    // GitHub answers a release asset with one 302 to a CDN host.
    expect(redirectLimitExceeded(0)).toBe(false);
    expect(redirectLimitExceeded(1)).toBe(false);
    expect(redirectLimitExceeded(MAX_REDIRECTS - 1)).toBe(false);
  });

  it("stops at the limit so a redirect loop cannot recurse forever", () => {
    expect(redirectLimitExceeded(MAX_REDIRECTS)).toBe(true);
    expect(redirectLimitExceeded(MAX_REDIRECTS + 1)).toBe(true);
  });

  it("caps at 5 hops", () => {
    expect(MAX_REDIRECTS).toBe(5);
  });
});

describe("MODEL_SHA256", () => {
  it("is a full 64-character lowercase hex digest", () => {
    // A truncated or placeholder constant would fail every download rather
    // than verify anything, so the shape is worth pinning.
    expect(MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyModelHash", () => {
  it("accepts the expected digest", () => {
    expect(() => verifyModelHash(MODEL_SHA256)).not.toThrow();
  });

  it("ignores digest casing", () => {
    expect(() => verifyModelHash(MODEL_SHA256.toUpperCase())).not.toThrow();
  });

  it("rejects a digest that does not match", () => {
    const wrong = "0".repeat(64);
    expect(() => verifyModelHash(wrong)).toThrow(/Model integrity check failed/);
  });

  it("names both digests so a bug report can tell corruption from substitution", () => {
    const wrong = "a".repeat(64);
    let message = "";
    try {
      verifyModelHash(wrong, MODEL_SHA256);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(MODEL_SHA256.substring(0, 16));
    expect(message).toContain(wrong.substring(0, 16));
    // Prefixes only: a full digest pair in a notification is unreadable.
    expect(message).not.toContain(MODEL_SHA256);
  });

  it("rejects an empty digest", () => {
    // A failed hash computation must not read as a pass.
    expect(() => verifyModelHash("")).toThrow(/Model integrity check failed/);
  });
});

describe("modelExtractCommand", () => {
  const tarball = "C:\\Users\\Ann\\AppData\\Roaming\\Code\\User\\globalStorage\\x\\sherpa-onnx\\model.tar.bz2";
  const storage = "C:\\Users\\Ann\\AppData\\Roaming\\Code\\User\\globalStorage\\x\\sherpa-onnx";

  it("uses the tar.exe in System32 on Windows, by full path", () => {
    // A GNU tar earlier on PATH needs an external bzip2 that may not exist.
    const exists = vi.fn((p: string) => p === "C:\\WINDOWS\\System32\\tar.exe");
    expect(modelExtractCommand(tarball, storage, "win32", "C:\\WINDOWS", exists)).toEqual({
      file: "C:\\WINDOWS\\System32\\tar.exe",
      args: ["-xjf", tarball, "-C", storage],
    });
  });

  it("assumes C:\\Windows when SystemRoot is empty", () => {
    // Passing undefined would take the parameter's default, process.env.SystemRoot.
    const exists = vi.fn(() => true);
    expect(modelExtractCommand(tarball, storage, "win32", "", exists).file).toBe(
      "C:\\Windows\\System32\\tar.exe"
    );
  });

  it("falls back to tar from PATH on a Windows without System32 tar.exe", () => {
    expect(modelExtractCommand(tarball, storage, "win32", "C:\\WINDOWS", () => false).file).toBe("tar");
  });

  it("uses tar from PATH on macOS and Linux without probing System32", () => {
    const exists = vi.fn(() => true);
    for (const platform of ["darwin", "linux"]) {
      expect(modelExtractCommand("/s/model.tar.bz2", "/s", platform, undefined, exists)).toEqual({
        file: "tar",
        args: ["-xjf", "/s/model.tar.bz2", "-C", "/s"],
      });
    }
    expect(exists).not.toHaveBeenCalled();
  });

  it("passes paths as separate arguments, unquoted, for execFileSync", () => {
    const spaced = "/Users/Ann Lee/Library/Application Support/Code/model.tar.bz2";
    expect(modelExtractCommand(spaced, "/x y", "darwin").args).toEqual(["-xjf", spaced, "-C", "/x y"]);
  });
});

describe("modelStatus", () => {
  const storage = path.join("fake", "storage");

  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it("points at the model directory and version file in global storage", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const status = modelStatus(storage);
    expect(status.dir).toBe(path.join(storage, "sherpa-onnx", MODEL_NAME));
    expect(status.versionFile).toBe(path.join(storage, "sherpa-onnx", "version.txt"));
    expect(status.present).toBe(false);
  });

  it("is present when every file exists and the version matches", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("1\n");
    expect(modelStatus(storage).present).toBe(true);
  });

  it("is not present when one model file is missing", () => {
    vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith("tokens.txt"));
    vi.mocked(readFileSync).mockReturnValue("1");
    expect(modelStatus(storage).present).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("is not present when the version is older", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("0");
    expect(modelStatus(storage).present).toBe(false);
  });

  it("is not present when the version file cannot be read", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(modelStatus(storage).present).toBe(false);
  });

  it("checks every model file", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("1");
    modelStatus(storage);
    for (const file of MODEL_FILES) {
      expect(existsSync).toHaveBeenCalledWith(path.join(storage, "sherpa-onnx", MODEL_NAME, file));
    }
  });
});
