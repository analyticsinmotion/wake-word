import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * listInputDevices(): how Show Diagnostics asks the packaged engine for the
 * input devices. `execFile` is replaced, so no process runs; what is checked
 * is what the binary is asked, and that every answer, a failure included,
 * becomes a listing rather than a rejection.
 */

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  exists: true,
}));

vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  execFile: mocks.execFile,
}));

vi.mock("fs", async (original) => ({
  ...(await original<typeof import("fs")>()),
  existsSync: () => mocks.exists,
}));

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

function answer(err: Error | null, stdout: string): void {
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => {
    callback(err, stdout, "");
  });
}

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.exists = true;
});

describe("listInputDevices", () => {
  it("runs the binary with --list-devices, hidden, with a time limit", async () => {
    const { listInputDevices } = await import("../../src/sherpaEngine");
    answer(null, "DEVICES:[]\n");
    await listInputDevices("/ext/bin/wake-word-engine", 1234);
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe("/ext/bin/wake-word-engine");
    expect(args).toEqual(["--list-devices"]);
    expect(options).toMatchObject({ timeout: 1234, windowsHide: true });
  });

  it("reads the devices the engine lists", async () => {
    const { listInputDevices } = await import("../../src/sherpaEngine");
    answer(null, 'DEVICES:[{"index":0,"name":"Microphone","id":"","default":true,"channels":1,"sampleRate":48000}]\n');
    await expect(listInputDevices("/ext/bin/wake-word-engine")).resolves.toEqual({
      kind: "listed",
      devices: [{ index: 0, name: "Microphone", id: "", isDefault: true, channels: 1, sampleRate: 48000 }],
    });
  });

  it("gives the engine's own message when it could not list them", async () => {
    const { listInputDevices } = await import("../../src/sherpaEngine");
    answer(new Error("Command failed: exit code 1"), "ERROR:Could not list the input devices: no audio server\n");
    await expect(listInputDevices("/ext/bin/wake-word-engine")).resolves.toEqual({
      kind: "failed",
      reason: "Could not list the input devices: no audio server",
    });
  });

  it("says why when the engine printed nothing, a time-out included", async () => {
    const { listInputDevices } = await import("../../src/sherpaEngine");
    answer(new Error("spawn timed out"), "");
    await expect(listInputDevices("/ext/bin/wake-word-engine")).resolves.toEqual({
      kind: "failed",
      reason: "the engine could not list them: spawn timed out",
    });
  });

  it("does not run a binary that is not there", async () => {
    const { listInputDevices } = await import("../../src/sherpaEngine");
    mocks.exists = false;
    await expect(listInputDevices("/ext/bin/wake-word-engine")).resolves.toEqual({
      kind: "failed",
      reason: "the speech engine is missing from this installation",
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
