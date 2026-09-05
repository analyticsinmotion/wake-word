import { describe, expect, it } from "vitest";
import {
  CALIBRATION_DURATION_MS,
  CalibrationDetection,
  formatCalibrationReport,
} from "../../src/wakeWordCore";

describe("formatCalibrationReport", () => {
  it("listens for 15 seconds by default", () => {
    expect(CALIBRATION_DURATION_MS).toBe(15_000);
  });

  describe("with no detections", () => {
    const report = formatCalibrationReport([], CALIBRATION_DURATION_MS);

    it("says so and suggests what to change", () => {
      expect(report.lines).toEqual([
        "=== Calibration Results ===",
        "No phrases detected in 15 seconds.",
        "Try: speak closer to the microphone, reduce background noise, or lower wakeWord.confidenceThreshold.",
        "=== End Calibration ===",
      ]);
    });

    it("summarises the same for the notification", () => {
      expect(report.summary).toBe(
        "Wake Word: No phrases detected in 15 seconds. " +
          "Try speaking closer to the microphone or lowering the confidence threshold."
      );
    });
  });

  describe("with detections that carry a confidence score", () => {
    const detections: CalibrationDetection[] = [
      { label: "Claude", confidence: 0.91, time: 1200 },
      { label: "Copilot", confidence: 0.62, time: 4870 },
      { label: "Claude", confidence: 0.83, time: 9010 },
    ];
    const report = formatCalibrationReport(detections, CALIBRATION_DURATION_MS);

    it("lists every detection with its time and score, in order", () => {
      expect(report.lines.slice(1, 4)).toEqual([
        '  1.2s: "Claude" (confidence: 0.91)',
        '  4.9s: "Copilot" (confidence: 0.62)',
        '  9.0s: "Claude" (confidence: 0.83)',
      ]);
    });

    it("groups the summary by phrase in first-heard order", () => {
      const summaryIndex = report.lines.indexOf("Summary:");
      expect(summaryIndex).toBeGreaterThan(0);
      expect(report.lines.slice(summaryIndex + 1, summaryIndex + 3)).toEqual([
        '  "Claude": 2 detections, avg confidence: 0.87, min: 0.83',
        '  "Copilot": 1 detection, avg confidence: 0.62, min: 0.62',
      ]);
    });

    it("does not add the sherpa note when every detection has a score", () => {
      expect(report.lines.some((l) => l.startsWith("Note:"))).toBe(false);
    });

    it("opens and closes with the banner lines", () => {
      expect(report.lines[0]).toBe("=== Calibration Results ===");
      expect(report.lines[report.lines.length - 1]).toBe("=== End Calibration ===");
    });

    it("counts the detections in the notification", () => {
      expect(report.summary).toBe(
        "Wake Word: 3 detections in 15 seconds. Check the Wake Word output channel for details."
      );
    });
  });

  it("uses the singular for a single detection", () => {
    const report = formatCalibrationReport(
      [{ label: "Claude", confidence: 0.5, time: 3000 }],
      CALIBRATION_DURATION_MS
    );
    expect(report.lines).toContain('  "Claude": 1 detection, avg confidence: 0.50, min: 0.50');
    expect(report.summary).toMatch(/^Wake Word: 1 detection in 15 seconds\./);
  });

  it("computes the average and minimum per phrase", () => {
    const report = formatCalibrationReport(
      [
        { label: "Terminal", confidence: 0.4, time: 1000 },
        { label: "Terminal", confidence: 0.8, time: 5000 },
        { label: "Terminal", confidence: 0.6, time: 9000 },
      ],
      CALIBRATION_DURATION_MS
    );
    expect(report.lines).toContain('  "Terminal": 3 detections, avg confidence: 0.60, min: 0.40');
  });

  describe("with sherpa detections, which carry no score", () => {
    const report = formatCalibrationReport(
      [
        { label: "Claude", time: 2000 },
        { label: "Claude", time: 7500 },
      ],
      CALIBRATION_DURATION_MS
    );

    it("renders the detections with no confidence suffix", () => {
      expect(report.lines[1]).toBe('  2.0s: "Claude"');
      expect(report.lines[2]).toBe('  7.5s: "Claude"');
    });

    it("gives the summary a count only", () => {
      expect(report.lines).toContain('  "Claude": 2 detections');
    });

    it("adds the note explaining the missing score", () => {
      expect(report.lines).toContain(
        "Note: the sherpa engine reports no confidence score. The threshold is applied inside the keyword spotter."
      );
    });
  });

  it("treats a non-finite score as no score", () => {
    const report = formatCalibrationReport(
      [{ label: "Claude", confidence: NaN, time: 1000 }],
      CALIBRATION_DURATION_MS
    );
    expect(report.lines[1]).toBe('  1.0s: "Claude"');
    expect(report.lines.some((l) => l.startsWith("Note:"))).toBe(true);
  });

  it("reports the actual window length when the run was cut short", () => {
    const report = formatCalibrationReport([{ label: "Claude", time: 500 }], 7400);
    expect(report.summary).toBe(
      "Wake Word: 1 detection in 7 seconds. Check the Wake Word output channel for details."
    );
    expect(formatCalibrationReport([], 7400).lines[1]).toBe("No phrases detected in 7 seconds.");
  });

  it("never reports a window shorter than one second", () => {
    expect(formatCalibrationReport([], 120).lines[1]).toBe("No phrases detected in 1 second.");
  });

  it("does not mutate the detections it is given", () => {
    const detections: CalibrationDetection[] = [
      { label: "Copilot", confidence: 0.7, time: 3000 },
      { label: "Claude", confidence: 0.9, time: 1000 },
    ];
    formatCalibrationReport(detections, CALIBRATION_DURATION_MS);
    expect(detections.map((d) => d.label)).toEqual(["Copilot", "Claude"]);
  });
});
