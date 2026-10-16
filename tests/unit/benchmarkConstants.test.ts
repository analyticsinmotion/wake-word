import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTES } from "../../src/extension";
import { KWS_MODEL } from "../../src/speechModel";
import { normalizePhrases } from "../../src/wakeWordCore";
import {
  DEFAULT_PHRASES,
  MODEL_FILES as BENCHMARK_MODEL_FILES,
  MODEL_NAME as BENCHMARK_MODEL_NAME,
} from "../acoustic/lib/benchmark-core.js";

/**
 * The acoustic benchmark is a plain Node script and cannot import the
 * extension's TypeScript, so it carries its own copies of the default
 * phrases and the model's directory and files. These tests are what keeps
 * those copies honest: a change to DEFAULT_ROUTES or to KWS_MODEL in
 * speechModel.ts fails here until tests/acoustic/lib/benchmark-core.js
 * follows.
 */
describe("benchmark constants", () => {
  it("lists exactly the default routes' phrases, in order", () => {
    const phrases = DEFAULT_ROUTES.flatMap((r) => normalizePhrases(r.phrase));
    expect(DEFAULT_PHRASES).toEqual(phrases);
  });

  it("names the same model directory as the package carries", () => {
    expect(BENCHMARK_MODEL_NAME).toBe(KWS_MODEL.name);
  });

  it("requires the same model files as the package carries", () => {
    expect(BENCHMARK_MODEL_FILES).toEqual(KWS_MODEL.files.map((file) => file.name));
  });
});
