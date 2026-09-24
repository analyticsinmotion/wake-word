import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  DownloadCancelledError,
  DownloadSource,
  MODEL_NAME,
  downloadFile,
  ensureModel,
} from "../../src/sherpaEngine";

/**
 * The model download against servers that stall, never answer, or are
 * cancelled part way, and what each leaves behind.
 *
 * Every server is a plain HTTP server on the loopback interface, on a port
 * the system picks, closed after each test, and reached with `http.get` in
 * place of `https.get`. Files go to a fresh directory under the system temp
 * directory. Timers are real: the inactivity limit is a few hundred
 * milliseconds here, where the extension uses DOWNLOAD_INACTIVITY_MS.
 */

const INACTIVITY_MS = 400;
const STALLED = /^no data arrived for \d+ seconds?, so the download was stopped\. Check the network connection/;

const get: DownloadSource["get"] = (url, callback) => http.get(url, callback);

let dir = "";
const servers: http.Server[] = [];

/** Start a server with this handler and return its base URL. */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A server that sends the headers for `size` bytes, then `sent` of them, then nothing. */
function stallsAfter(sent: number, size = 10_000): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "Content-Length": String(size) });
    res.write(Buffer.alloc(sent, 7));
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wake-word-download-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadFile", () => {
  it("stops a download that sends part of the file and then nothing, and removes what it wrote", async () => {
    const url = await serve(stallsAfter(1000));
    const dest = path.join(dir, "model.tar.gz");
    let received = 0;

    await expect(
      downloadFile(url, dest, { get, inactivityMs: INACTIVITY_MS, onData: (total) => (received = total) })
    ).rejects.toThrow(STALLED);
    expect(received).toBe(1000);
    expect(existsSync(dest)).toBe(false);
  });

  it("stops a download whose server never answers, and leaves no file", async () => {
    const url = await serve(() => {
      // Accepts the connection and never sends a response.
    });
    const dest = path.join(dir, "model.tar.gz");

    await expect(downloadFile(url, dest, { get, inactivityMs: INACTIVITY_MS })).rejects.toThrow(STALLED);
    expect(existsSync(dest)).toBe(false);
  });

  it("stops when cancelled part way, and removes what it wrote", async () => {
    const url = await serve(stallsAfter(1000));
    const dest = path.join(dir, "model.tar.gz");
    const abort = new AbortController();

    await expect(
      downloadFile(url, dest, { get, inactivityMs: 60_000, signal: abort.signal, onData: () => abort.abort() })
    ).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(existsSync(dest)).toBe(false);
  });

  it("does not start when it is already cancelled", async () => {
    let requests = 0;
    const url = await serve((_req, res) => {
      requests++;
      res.end("x");
    });
    const dest = path.join(dir, "model.tar.gz");
    const abort = new AbortController();
    abort.abort();

    await expect(downloadFile(url, dest, { get, inactivityMs: 60_000, signal: abort.signal })).rejects.toBeInstanceOf(
      DownloadCancelledError
    );
    expect(requests).toBe(0);
    expect(existsSync(dest)).toBe(false);
  });

  it("keeps a slow download that is never silent for the whole limit", async () => {
    // Ten chunks, each well inside the limit, over more than twice its length.
    const body = Buffer.alloc(1000, 3);
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": String(body.length) });
      let sent = 0;
      const next = setInterval(() => {
        res.write(body.subarray(sent, sent + 100));
        sent += 100;
        if (sent >= body.length) {
          clearInterval(next);
          res.end();
        }
      }, INACTIVITY_MS / 4);
    });
    const dest = path.join(dir, "model.tar.gz");

    await downloadFile(url, dest, { get, inactivityMs: INACTIVITY_MS });
    expect(readFileSync(dest)).toEqual(body);
  });

  it("follows a redirect to the file", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/release") {
        res.writeHead(302, { Location: "/cdn/model.tar.gz" });
        res.end();
      } else {
        res.end("the archive");
      }
    });
    const dest = path.join(dir, "model.tar.gz");

    await downloadFile(`${url}/release`, dest, { get, inactivityMs: INACTIVITY_MS });
    expect(readFileSync(dest, "utf8")).toBe("the archive");
  });

  it("gives up on a redirect loop and removes the file", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(302, { Location: "/again" });
      res.end();
    });
    const dest = path.join(dir, "model.tar.gz");

    await expect(downloadFile(url, dest, { get, inactivityMs: INACTIVITY_MS })).rejects.toThrow(
      /^Too many redirects \(over 5\) downloading model$/
    );
    expect(existsSync(dest)).toBe(false);
  });

  it("reports an HTTP error and removes the file", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404);
      res.end("not here");
    });
    const dest = path.join(dir, "model.tar.gz");

    await expect(downloadFile(url, dest, { get, inactivityMs: INACTIVITY_MS })).rejects.toThrow(
      /^HTTP 404 downloading model$/
    );
    expect(existsSync(dest)).toBe(false);
  });
});

describe("ensureModel", () => {
  /** A notification whose Cancel the test presses, recording the options it was shown with. */
  function notification(): { options: vscode.ProgressOptions[]; cancel: () => void } {
    const listeners: Array<() => void> = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    };
    const options: vscode.ProgressOptions[] = [];
    vi.spyOn(vscode.window, "withProgress").mockImplementation(((
      shown: vscode.ProgressOptions,
      task: (progress: unknown, cancellation: unknown) => Promise<unknown>
    ) => {
      options.push(shown);
      return task({ report: () => undefined }, token);
    }) as never);
    return {
      options,
      cancel: () => {
        token.isCancellationRequested = true;
        listeners.forEach((listener) => listener());
      },
    };
  }

  function context(): vscode.ExtensionContext {
    return { globalStorageUri: { fsPath: dir } } as unknown as vscode.ExtensionContext;
  }

  const tarball = (): string => path.join(dir, "sherpa-onnx", MODEL_NAME + ".tar.gz");
  const versionFile = (): string => path.join(dir, "sherpa-onnx", "version.txt");

  it("offers Cancel, which stops the download and leaves no partial file and no version file", async () => {
    const shown = notification();
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": "10000" });
      res.write(Buffer.alloc(1000, 7));
      // The user presses Cancel while the rest is still to come.
      setTimeout(shown.cancel, 50);
    });

    await expect(
      ensureModel(context(), undefined, { url, get, inactivityMs: 60_000 })
    ).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(shown.options[0].cancellable).toBe(true);
    expect(existsSync(tarball())).toBe(false);
    expect(existsSync(versionFile())).toBe(false);
  });

  it("stops a stalled download and says why, leaving no partial file", async () => {
    notification();
    const url = await serve(stallsAfter(1000));

    await expect(ensureModel(context(), undefined, { url, get, inactivityMs: INACTIVITY_MS })).rejects.toThrow(
      STALLED
    );
    expect(existsSync(tarball())).toBe(false);
    expect(existsSync(versionFile())).toBe(false);
  });

  it("downloads afresh on the next start after a cancelled one", async () => {
    const shown = notification();
    const cancelled = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": "10000" });
      res.write(Buffer.alloc(1000, 7));
      setTimeout(shown.cancel, 50);
    });
    await expect(ensureModel(context(), undefined, { url: cancelled, get, inactivityMs: 60_000 })).rejects.toThrow(
      DownloadCancelledError
    );

    // A whole archive this time, which is not the model, so the digest check
    // refuses it: the point is that a new download ran to the end.
    notification();
    let requests = 0;
    const whole = await serve((_req, res) => {
      requests++;
      res.end(Buffer.alloc(2000, 9));
    });
    await expect(ensureModel(context(), undefined, { url: whole, get, inactivityMs: 60_000 })).rejects.toThrow(
      /^Model integrity check failed/
    );
    expect(requests).toBe(1);
    expect(existsSync(tarball())).toBe(false);
    expect(existsSync(versionFile())).toBe(false);
  });

  it("shares one download between two starts that overlap", async () => {
    const shown = notification();
    let requests = 0;
    const url = await serve((_req, res) => {
      requests++;
      res.writeHead(200, { "Content-Length": "10000" });
      res.write(Buffer.alloc(1000, 7));
      setTimeout(shown.cancel, 50);
    });
    const source = { url, get, inactivityMs: 60_000 };

    const first = ensureModel(context(), undefined, source);
    const second = ensureModel(context(), undefined, source);
    await expect(first).rejects.toBeInstanceOf(DownloadCancelledError);
    await expect(second).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(requests).toBe(1);
    expect(shown.options).toHaveLength(1);
  });
});
