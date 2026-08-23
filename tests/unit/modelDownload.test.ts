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

import { shouldFollowRedirect } from "../../src/sherpaEngine";

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
