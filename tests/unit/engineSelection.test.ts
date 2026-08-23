import { describe, expect, it } from "vitest";
import {
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  clampThreshold,
  parsePowerShellError,
  selectEngineKind,
} from "../../src/wakeWordCore";

describe("selectEngineKind", () => {
  it("picks the Windows engine on Windows under auto", () => {
    expect(selectEngineKind("auto", "win32")).toBe("windows");
  });

  it("picks sherpa on macOS and Linux under auto", () => {
    expect(selectEngineKind("auto", "darwin")).toBe("sherpa");
    expect(selectEngineKind("auto", "linux")).toBe("sherpa");
  });

  it("honours an explicit sherpa override on Windows", () => {
    expect(selectEngineKind("sherpa", "win32")).toBe("sherpa");
  });

  it("honours an explicit windows override", () => {
    expect(selectEngineKind("windows", "win32")).toBe("windows");
  });

  // Known limitation, tracked in the relay report: forcing "windows" off
  // Windows is honoured and then fails at spawn time with an ENOENT for
  // powershell.exe. The setting is documented as Windows only.
  it("honours a windows override even where PowerShell does not exist", () => {
    expect(selectEngineKind("windows", "darwin")).toBe("windows");
    expect(selectEngineKind("windows", "linux")).toBe("windows");
  });

  it("treats an unknown setting value as auto", () => {
    expect(selectEngineKind("nonsense", "win32")).toBe("windows");
    expect(selectEngineKind("nonsense", "darwin")).toBe("sherpa");
    expect(selectEngineKind("", "linux")).toBe("sherpa");
  });

  it("covers every platform the extension builds for", () => {
    expect(selectEngineKind("auto", "win32")).toBe("windows");
    expect(selectEngineKind("auto", "darwin")).toBe("sherpa");
    expect(selectEngineKind("auto", "linux")).toBe("sherpa");
    expect(selectEngineKind("auto", "freebsd")).toBe("sherpa");
  });
});

describe("clampThreshold", () => {
  it("passes an in-range value through", () => {
    expect(clampThreshold(0.5)).toBe(0.5);
  });

  it("clamps below the minimum", () => {
    expect(clampThreshold(-5)).toBe(MIN_THRESHOLD);
    expect(clampThreshold(0.01)).toBe(MIN_THRESHOLD);
  });

  it("clamps above the maximum", () => {
    expect(clampThreshold(5)).toBe(MAX_THRESHOLD);
    expect(clampThreshold(0.95)).toBe(MAX_THRESHOLD);
  });

  it("keeps the range bounds themselves", () => {
    expect(clampThreshold(MIN_THRESHOLD)).toBe(MIN_THRESHOLD);
    expect(clampThreshold(MAX_THRESHOLD)).toBe(MAX_THRESHOLD);
  });

  it("falls back to the default for values that are not usable numbers", () => {
    expect(clampThreshold(undefined)).toBe(0.3);
    expect(clampThreshold(null)).toBe(0.3);
    expect(clampThreshold(NaN)).toBe(0.3);
    expect(clampThreshold("not a number")).toBe(0.3);
    expect(clampThreshold(0)).toBe(0.3);
  });

  it("coerces a numeric string", () => {
    expect(clampThreshold("0.6")).toBe(0.6);
  });

  it("honours a caller-supplied fallback", () => {
    expect(clampThreshold(undefined, 0.25)).toBe(0.25);
  });

  it("never returns a value outside the settings range", () => {
    const inputs = [-1, 0, 0.1, 0.3, 0.9, 1, 100, NaN, "x", null, undefined];
    for (const input of inputs) {
      const result = clampThreshold(input);
      expect(result).toBeGreaterThanOrEqual(MIN_THRESHOLD);
      expect(result).toBeLessThanOrEqual(MAX_THRESHOLD);
    }
  });
});

describe("parsePowerShellError", () => {
  it("extracts the message from a CLIXML error record", () => {
    const raw =
      '#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">' +
      "Exception calling SetInputToDefaultAudioDevice_x000D__x000D_" +
      "</S></Objs>";
    expect(parsePowerShellError(raw)).toBe(
      "Exception calling SetInputToDefaultAudioDevice"
    );
  });

  it("turns encoded newlines into spaces", () => {
    const raw = '<S S="Error">first line&#xA;second line</S>';
    expect(parsePowerShellError(raw)).toBe("first line second line");
  });

  it("matches across real newlines inside the record", () => {
    const raw = '<S S="Error">first\nsecond</S>';
    expect(parsePowerShellError(raw)).toBe("first\nsecond");
  });

  it("falls back to the raw text with the CLIXML header stripped", () => {
    expect(parsePowerShellError("#< CLIXML\nsomething went wrong")).toBe(
      "something went wrong"
    );
  });

  it("returns plain stderr unchanged apart from trimming", () => {
    expect(parsePowerShellError("  plain failure  ")).toBe("plain failure");
  });

  it("returns an empty string for empty input", () => {
    expect(parsePowerShellError("")).toBe("");
  });
});
