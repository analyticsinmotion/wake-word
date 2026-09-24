import { describe, expect, it } from "vitest";
import {
  InputDevice,
  REDACTED_NAME,
  formatDeviceLines,
  parseDeviceListing,
  redactDeviceName,
  selectDevice,
} from "../../src/wakeWordCore";

/**
 * The input devices in Show Diagnostics: what the engine's `--list-devices`
 * line is read as, which device `wakeWord.audioDevice` selects, and how a
 * person's name is kept out of a report meant for a public issue.
 */

function device(index: number, name: string, isDefault = false): InputDevice {
  return { index, name, id: `wasapi:{${index}}`, isDefault, channels: 1, sampleRate: 48000 };
}

const DEVICES = [device(0, "Microphone Array", true), device(1, "Headset Microphone"), device(2, "USB Audio Device")];

describe("parseDeviceListing", () => {
  it("reads the engine's line", () => {
    const stdout =
      'DEVICES:[{"index":0,"name":"Microphone Array","id":"wasapi:{a}","default":true,"channels":2,"sampleRate":48000},' +
      '{"index":1,"name":"Headset \\"Pro\\"","id":"","default":false,"channels":1,"sampleRate":16000}]\n';
    expect(parseDeviceListing(stdout)).toEqual({
      kind: "listed",
      devices: [
        { index: 0, name: "Microphone Array", id: "wasapi:{a}", isDefault: true, channels: 2, sampleRate: 48000 },
        { index: 1, name: 'Headset "Pro"', id: "", isDefault: false, channels: 1, sampleRate: 16000 },
      ],
    });
  });

  it("reads an empty list as no devices", () => {
    expect(parseDeviceListing("DEVICES:[]\r\n")).toEqual({ kind: "listed", devices: [] });
  });

  it("reads the line among others, with Windows line endings", () => {
    expect(parseDeviceListing('noise\r\nDEVICES:[{"index":3,"name":"Mic"}]\r\n')).toEqual({
      kind: "listed",
      devices: [{ index: 3, name: "Mic", id: "", isDefault: false, channels: 0, sampleRate: 0 }],
    });
  });

  it("skips an entry without an index or a name, and ignores fields it does not know", () => {
    const stdout = 'DEVICES:[{"name":"No index"},{"index":1},{"index":"2","name":"x"},7,{"index":4,"name":"Kept","future":1}]';
    const listing = parseDeviceListing(stdout);
    expect(listing.kind === "listed" && listing.devices.map((d) => d.name)).toEqual(["Kept"]);
  });

  it("reports the engine's error line", () => {
    expect(parseDeviceListing("ERROR:Could not list the input devices: no audio server\n", "exit code 1")).toEqual({
      kind: "failed",
      reason: "Could not list the input devices: no audio server",
    });
  });

  it("reports why the engine did not answer when it printed nothing", () => {
    expect(parseDeviceListing("", "the engine could not list them: timed out")).toEqual({
      kind: "failed",
      reason: "the engine could not list them: timed out",
    });
    expect(parseDeviceListing("")).toEqual({ kind: "failed", reason: "the engine printed no device list" });
  });

  it("reports a line that is not a list", () => {
    expect(parseDeviceListing("DEVICES:{").kind).toBe("failed");
    expect(parseDeviceListing('DEVICES:{"index":0}')).toEqual({
      kind: "failed",
      reason: "the device list could not be read (not a list)",
    });
  });
});

describe("selectDevice", () => {
  it("selects the system default when the setting is empty", () => {
    expect(selectDevice(DEVICES, "")).toEqual({ kind: "default", index: 0 });
    expect(selectDevice(DEVICES, "   ")).toEqual({ kind: "default", index: 0 });
    expect(selectDevice([device(0, "Mic")], "")).toEqual({ kind: "default", index: null });
  });

  it("reads digits as an index, as the engine does", () => {
    expect(selectDevice(DEVICES, "2")).toEqual({ kind: "index", index: 2, found: true });
    expect(selectDevice(DEVICES, " 02 ")).toEqual({ kind: "index", index: 2, found: true });
    expect(selectDevice(DEVICES, "7")).toEqual({ kind: "index", index: 7, found: false });
  });

  it("reads digits too large for an index as a name", () => {
    expect(selectDevice(DEVICES, "99999999999")).toEqual({ kind: "name", name: "99999999999", matches: [] });
  });

  it("matches a name case-insensitively as a substring", () => {
    expect(selectDevice(DEVICES, "usb")).toEqual({ kind: "name", name: "usb", matches: [2] });
    expect(selectDevice(DEVICES, "MICROPHONE")).toEqual({ kind: "name", name: "MICROPHONE", matches: [0, 1] });
    expect(selectDevice(DEVICES, "2nd mic")).toEqual({ kind: "name", name: "2nd mic", matches: [] });
  });
});

describe("redactDeviceName", () => {
  it("leaves a name that says only what the device is", () => {
    for (const name of ["Microphone Array", "Headset Microphone", "USB Audio Device", "MacBook Pro Microphone", "default"]) {
      expect(redactDeviceName(name, [])).toBe(name);
    }
  });

  it("takes out the owner of a device named after them, and keeps what the device is", () => {
    expect(redactDeviceName("Ann's Headphones", [])).toBe(`${REDACTED_NAME}'s Headphones`);
    expect(redactDeviceName("Ann\u2019s Headphones", [])).toBe(`${REDACTED_NAME}\u2019s Headphones`);
    expect(redactDeviceName("Headset (Ann's Earbuds)", [])).toBe(`Headset (${REDACTED_NAME}'s Earbuds)`);
    expect(redactDeviceName("James' Headset", [])).toBe(`${REDACTED_NAME}' Headset`);
    expect(redactDeviceName("Zo\u00eb's Phone Microphone", [])).toBe(`${REDACTED_NAME}'s Phone Microphone`);
  });

  it("takes out the owner in the forms other languages use", () => {
    expect(redactDeviceName("Headphones de Ann", [])).toBe(`Headphones de ${REDACTED_NAME}`);
    expect(redactDeviceName("Headphones von Ann", [])).toBe(`Headphones von ${REDACTED_NAME}`);
    expect(redactDeviceName("Headphones van Ann", [])).toBe(`Headphones van ${REDACTED_NAME}`);
    expect(redactDeviceName("Headphones di Ann", [])).toBe(`Headphones di ${REDACTED_NAME}`);
    expect(redactDeviceName("Headset (Earbuds de \u00c9lodie)", [])).toBe(`Headset (Earbuds de ${REDACTED_NAME})`);
  });

  it("takes out the account's name wherever it stands alone, in any case", () => {
    expect(redactDeviceName("annsmith Headset", ["annsmith"])).toBe(`${REDACTED_NAME} Headset`);
    expect(redactDeviceName("Headset ANNSMITH", ["annsmith"])).toBe(`Headset ${REDACTED_NAME}`);
    expect(redactDeviceName("Headset annsmithy", ["annsmith"])).toBe("Headset annsmithy");
  });

  it("ignores an account name too short to tell from a word, and one with regular expression characters is literal", () => {
    expect(redactDeviceName("Mic Array", ["mi", ""])).toBe("Mic Array");
    expect(redactDeviceName("a.b+c Mic", ["a.b+c"])).toBe(`${REDACTED_NAME} Mic`);
    expect(redactDeviceName("axb+c Mic", ["a.b+c"])).toBe("axb+c Mic");
  });
});

describe("formatDeviceLines", () => {
  it("lists each device with its format, and marks the default, which an empty setting selects", () => {
    expect(formatDeviceLines({ kind: "listed", devices: DEVICES }, "", [])).toEqual([
      `Input devices: 3 (a name that looks like a person's is shown as ${REDACTED_NAME}; check the names before posting)`,
      "  0: Microphone Array, 1 ch, 48000 Hz (system default, selected)",
      "  1: Headset Microphone, 1 ch, 48000 Hz",
      "  2: USB Audio Device, 1 ch, 48000 Hz",
    ]);
  });

  it("marks the device an index selects", () => {
    const lines = formatDeviceLines({ kind: "listed", devices: DEVICES }, "1", []);
    expect(lines[1]).toBe("  0: Microphone Array, 1 ch, 48000 Hz (system default)");
    expect(lines[2]).toBe("  1: Headset Microphone, 1 ch, 48000 Hz (selected)");
    expect(lines).toHaveLength(4);
  });

  it("says when an index selects nothing", () => {
    const lines = formatDeviceLines({ kind: "listed", devices: DEVICES }, "5", []);
    expect(lines.at(-1)).toBe('  wakeWord.audioDevice "5" is not the index of any input device');
  });

  it("marks the one device a name selects, and says when a name selects none", () => {
    expect(formatDeviceLines({ kind: "listed", devices: DEVICES }, "usb", [])[3]).toBe(
      "  2: USB Audio Device, 1 ch, 48000 Hz (selected)"
    );
    expect(formatDeviceLines({ kind: "listed", devices: DEVICES }, "desk", []).at(-1)).toBe(
      '  wakeWord.audioDevice "desk" matches no input device'
    );
  });

  it("marks every device a name matches when it matches several, and says none is opened", () => {
    const lines = formatDeviceLines({ kind: "listed", devices: DEVICES }, "microphone", []);
    expect(lines[1]).toBe('  0: Microphone Array, 1 ch, 48000 Hz (system default, matches wakeWord.audioDevice "microphone")');
    expect(lines[2]).toBe('  1: Headset Microphone, 1 ch, 48000 Hz (matches wakeWord.audioDevice "microphone")');
    expect(lines.at(-1)).toBe(
      '  wakeWord.audioDevice "microphone" matches 2 input devices, so none is opened: ' +
        "use a longer part of the name or the device index"
    );
  });

  it("says when no device is the system default", () => {
    const lines = formatDeviceLines({ kind: "listed", devices: [device(0, "Mic")] }, "", []);
    expect(lines.at(-1)).toBe("  No device is marked as the system default");
  });

  it("takes names out of the devices and of the setting, but selects by the real name", () => {
    const devices = [device(0, "Microphone Array", true), device(1, "Ann's Headphones")];
    const lines = formatDeviceLines({ kind: "listed", devices }, "ann's", ["annsmith"]);
    expect(lines[2]).toBe(`  1: ${REDACTED_NAME}'s Headphones, 1 ch, 48000 Hz (selected)`);
    expect(lines.join("\n")).not.toMatch(/ann/i);

    const none = formatDeviceLines({ kind: "listed", devices }, "annsmith", ["annsmith"]);
    expect(none.at(-1)).toBe(`  wakeWord.audioDevice "${REDACTED_NAME}" matches no input device`);
  });

  it("leaves out a format the engine could not read", () => {
    const unknown: InputDevice = { index: 0, name: "Mic", id: "", isDefault: false, channels: 0, sampleRate: 0 };
    expect(formatDeviceLines({ kind: "listed", devices: [unknown] }, "0", [])[1]).toBe("  0: Mic (selected)");
  });

  it("says when there are no devices, and when they could not be listed", () => {
    expect(formatDeviceLines({ kind: "listed", devices: [] }, "", [])).toEqual(["Input devices: none found"]);
    expect(formatDeviceLines({ kind: "failed", reason: "no audio server" }, "", [])).toEqual([
      "Input devices: could not be listed (no audio server)",
    ]);
  });
});
