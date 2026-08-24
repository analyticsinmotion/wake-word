import { describe, expect, it } from "vitest";
import { formatConfidence, parseEngineLine, splitLines } from "../../src/wakeWordCore";

describe("parseEngineLine", () => {
  it("parses READY", () => {
    expect(parseEngineLine("READY")).toEqual({ type: "ready" });
  });

  it("parses DETECTED with a confidence", () => {
    expect(parseEngineLine("DETECTED:hey claude|0.92")).toEqual({
      type: "detected",
      phrase: "hey claude",
      confidence: 0.92,
    });
  });

  it("lowercases and trims the detected phrase", () => {
    expect(parseEngineLine("DETECTED:  Hey CLAUDE  |0.5")).toMatchObject({
      phrase: "hey claude",
    });
  });

  it("falls back to the default confidence when there is no separator", () => {
    expect(parseEngineLine("DETECTED:hey claude")).toEqual({
      type: "detected",
      phrase: "hey claude",
      confidence: 1.0,
    });
  });

  it("falls back to the default confidence when the score is not a number", () => {
    expect(parseEngineLine("DETECTED:hey claude|notanumber")).toEqual({
      type: "detected",
      phrase: "hey claude",
      confidence: 1.0,
    });
  });

  it("honours a caller-supplied default confidence", () => {
    // The Windows engine passes 0 so a malformed line can never clear the
    // configured threshold.
    expect(parseEngineLine("DETECTED:hey claude", 0)).toMatchObject({ confidence: 0 });
    expect(parseEngineLine("DETECTED:hey claude|", 0)).toMatchObject({ confidence: 0 });
    expect(parseEngineLine("DETECTED:hey claude|oops", 0)).toMatchObject({ confidence: 0 });
  });

  it("accepts an empty phrase", () => {
    expect(parseEngineLine("DETECTED:|0.5")).toEqual({
      type: "detected",
      phrase: "",
      confidence: 0.5,
    });
  });

  it("treats the last pipe as the separator", () => {
    expect(parseEngineLine("DETECTED:a|b|c|0.75")).toEqual({
      type: "detected",
      phrase: "a|b|c",
      confidence: 0.75,
    });
  });

  it("parses RELEASED", () => {
    // The sherpa child sends this once mic.stop() has returned. The extension
    // waits for it before firing the command that takes the microphone.
    expect(parseEngineLine("RELEASED")).toEqual({ type: "released" });
    expect(parseEngineLine("  RELEASED\r")).toEqual({ type: "released" });
  });

  it("does not mistake other output for RELEASED", () => {
    expect(parseEngineLine("released")).toBeNull();
    expect(parseEngineLine("RELEASED:now")).toBeNull();
    expect(parseEngineLine("DEBUG:RELEASED")).toEqual({
      type: "debug",
      message: "RELEASED",
    });
  });

  it("parses the sherpa DETECTED form, which carries no confidence", () => {
    // audio-engine.js stopped sending a fabricated |1.0 suffix: the keyword
    // spotter applies its own threshold and returns no usable score.
    // SherpaEngine discards the parsed value and emits no confidence at all.
    expect(parseEngineLine("DETECTED:hey computer")).toEqual({
      type: "detected",
      phrase: "hey computer",
      confidence: 1.0,
    });
  });

  it("parses ERROR", () => {
    expect(parseEngineLine("ERROR:something broke")).toEqual({
      type: "error",
      message: "something broke",
    });
  });

  it("parses DEBUG", () => {
    expect(parseEngineLine("DEBUG:some info")).toEqual({
      type: "debug",
      message: "some info",
    });
  });

  it("preserves colons inside an error message", () => {
    expect(parseEngineLine("ERROR:Failed to open microphone: access denied")).toEqual({
      type: "error",
      message: "Failed to open microphone: access denied",
    });
  });

  it("tolerates surrounding whitespace and carriage returns", () => {
    expect(parseEngineLine("  READY\r")).toEqual({ type: "ready" });
    expect(parseEngineLine("\tDETECTED:hey claude|0.4 ")).toMatchObject({
      phrase: "hey claude",
      confidence: 0.4,
    });
  });

  it("returns null for a blank line", () => {
    expect(parseEngineLine("")).toBeNull();
    expect(parseEngineLine("   ")).toBeNull();
  });

  it("returns null for unrecognised output", () => {
    // Dependencies of the child sometimes write to stdout. That must not be
    // mistaken for a protocol verb.
    expect(parseEngineLine("some random text")).toBeNull();
    expect(parseEngineLine("Warning: onnxruntime loaded")).toBeNull();
    expect(parseEngineLine("readyish")).toBeNull();
    expect(parseEngineLine("ready")).toBeNull();
  });

  it("does not treat a bare verb without its colon as a message", () => {
    expect(parseEngineLine("DEBUG")).toBeNull();
    expect(parseEngineLine("ERROR")).toBeNull();
    expect(parseEngineLine("DETECTED")).toBeNull();
  });
});

describe("splitLines", () => {
  it("returns complete lines and keeps the trailing partial", () => {
    expect(splitLines("READY\nDEBUG:a\nDETEC")).toEqual({
      lines: ["READY", "DEBUG:a"],
      rest: "DETEC",
    });
  });

  it("keeps everything as the remainder when there is no newline", () => {
    expect(splitLines("READ")).toEqual({ lines: [], rest: "READ" });
  });

  it("leaves an empty remainder when the chunk ends on a newline", () => {
    expect(splitLines("READY\n")).toEqual({ lines: ["READY"], rest: "" });
  });

  it("reassembles a verb split across two chunks", () => {
    const first = splitLines("DETECTED:hey cl");
    const second = splitLines(first.rest + "aude|0.9\n");
    expect(second.lines).toEqual(["DETECTED:hey claude|0.9"]);
    expect(parseEngineLine(second.lines[0])).toMatchObject({ phrase: "hey claude" });
  });

  it("handles an empty buffer", () => {
    expect(splitLines("")).toEqual({ lines: [], rest: "" });
  });
});

describe("formatConfidence", () => {
  it("renders a real score to two decimal places", () => {
    expect(formatConfidence(0.923)).toBe(" (confidence: 0.92)");
    expect(formatConfidence(0)).toBe(" (confidence: 0.00)");
    expect(formatConfidence(1)).toBe(" (confidence: 1.00)");
  });

  it("renders nothing when the engine supplied no score", () => {
    // SherpaEngine reports no confidence rather than a fabricated 1.0, so a
    // sherpa detection logs as `Detected: "Claude"` with nothing after it.
    expect(formatConfidence(undefined)).toBe("");
  });

  it("renders nothing for a non-finite score", () => {
    expect(formatConfidence(NaN)).toBe("");
    expect(formatConfidence(Infinity)).toBe("");
  });
});
