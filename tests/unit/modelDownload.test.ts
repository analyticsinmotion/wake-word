import { describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ execSync: vi.fn(), spawn: vi.fn() }));
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import {
  MAX_REDIRECTS,
  MODEL_SHA256,
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
