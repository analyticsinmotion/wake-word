import { describe, expect, it, vi } from "vitest";
import { releaseThenFire, retiredEngineNotice, RETIRED_ENGINE_NOTICE } from "../../src/wakeWordCore";

/**
 * The order of a handoff: the microphone is released first, and the route's
 * command fires only once that release has settled. The engine side, that
 * SherpaEngine.pause() settles on PAUSED or its timeout, is covered in
 * engineLifecycle.test.ts, including a handoff driven through this function.
 */

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("releaseThenFire", () => {
  it("fires the command only after the release settles", async () => {
    const order: string[] = [];
    const release = deferred();
    const fire = vi.fn(async () => {
      order.push("command");
    });

    const handoff = releaseThenFire(
      () => {
        order.push("release requested");
        return release.promise.then(() => {
          order.push("released");
        });
      },
      () => true,
      fire
    );

    await flush();
    expect(fire).not.toHaveBeenCalled();
    expect(order).toEqual(["release requested"]);

    release.resolve();
    await expect(handoff).resolves.toEqual({ kind: "fired" });
    expect(order).toEqual(["release requested", "released", "command"]);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("waits for the command to settle before reporting it fired", async () => {
    const command = deferred();
    let settled = false;
    const handoff = releaseThenFire(
      () => Promise.resolve(),
      () => true,
      () => command.promise
    ).then((outcome) => {
      settled = true;
      return outcome;
    });

    await flush();
    expect(settled).toBe(false);
    command.resolve();
    await expect(handoff).resolves.toEqual({ kind: "fired" });
  });

  it("fires nothing when the handoff was overtaken during the release", async () => {
    const release = deferred();
    let current = true;
    const fire = vi.fn(async () => undefined);

    const handoff = releaseThenFire(() => release.promise, () => current, fire);
    // The user disables listening while the engine is still closing the
    // microphone.
    current = false;
    release.resolve();

    await expect(handoff).resolves.toEqual({ kind: "superseded" });
    expect(fire).not.toHaveBeenCalled();
  });

  it("asks whether the handoff is current after the release, not before", async () => {
    const release = deferred();
    const isCurrent = vi.fn(() => true);
    const handoff = releaseThenFire(() => release.promise, isCurrent, async () => undefined);

    await flush();
    expect(isCurrent).not.toHaveBeenCalled();
    release.resolve();
    await handoff;
    expect(isCurrent).toHaveBeenCalledTimes(1);
  });

  it("reports a command that rejects as failed", async () => {
    const error = new Error("command 'claude-vscode.focus' not found");
    const handoff = releaseThenFire(
      () => Promise.resolve(),
      () => true,
      () => Promise.reject(error)
    );
    await expect(handoff).resolves.toEqual({ kind: "failed", error });
  });

  it("reports a command that throws synchronously as failed", async () => {
    const error = new Error("boom");
    const handoff = releaseThenFire(
      () => Promise.resolve(),
      () => true,
      () => {
        throw error;
      }
    );
    await expect(handoff).resolves.toEqual({ kind: "failed", error });
  });
});

describe("retiredEngineNotice", () => {
  it("explains the retirement to a user who chose the windows engine", () => {
    expect(retiredEngineNotice("windows")).toBe(RETIRED_ENGINE_NOTICE);
    expect(RETIRED_ENGINE_NOTICE).toBe(
      "The 'windows' engine has been retired. Wake Word now uses the sherpa-onnx " +
        "engine on all platforms. You can remove wakeWord.engine from your settings."
    );
  });

  it("says nothing for values that already describe what runs", () => {
    expect(retiredEngineNotice("auto")).toBeNull();
    expect(retiredEngineNotice("sherpa")).toBeNull();
  });

  it("says nothing when the setting is absent or not a string", () => {
    expect(retiredEngineNotice(undefined)).toBeNull();
    expect(retiredEngineNotice(null)).toBeNull();
    expect(retiredEngineNotice(1)).toBeNull();
    expect(retiredEngineNotice("Windows")).toBeNull();
  });
});
