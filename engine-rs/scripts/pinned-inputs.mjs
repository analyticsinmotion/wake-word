/**
 * Everything the engine's release build downloads, pinned by size and digest.
 *
 * Nothing here is trusted because of where it came from. Each download is
 * checked against these values before it is used, and a mismatch fails the
 * build: a corrupted or substituted file must never link into the binary or
 * ship beside it.
 *
 * Changing a version means recomputing its entries. For an archive or a file:
 *
 *   sha256sum <file>            # shasum -a 256 <file> on macOS
 *
 * For an npm tarball, the registry publishes the integrity value:
 *
 *   npm view <package>@<version> dist.integrity
 */

/**
 * The static libraries the sherpa-onnx-sys build script links, one archive per
 * target: the sherpa-onnx release of the crate's version built without the
 * text-to-speech components (.github/workflows/engine-archives.yml), under the
 * names the build script expects, and hosted on this repository's
 * sherpa-onnx-v<version> release. Left to itself, the build script downloads
 * the official archives, which include those components, and checks no
 * digest; SHERPA_ONNX_ARCHIVE_DIR makes it take these instead (see
 * scripts/prebuilt.mjs). `version` must equal the sherpa-onnx-sys version in
 * Cargo.lock; scripts/prebuilt.mjs refuses to run when it does not, so a crate
 * bump cannot build against unverified archives.
 */
export const SHERPA_ONNX = {
  version: '1.13.8',
  archives: {
    'win32-x64': {
      name: 'sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib.tar.bz2',
      bytes: 120105505,
      sha256: 'e902a9861b39bdfb42ec646ecb5e80e8d1702dccac4eb015189280b65a3db19e',
    },
    'darwin-arm64': {
      name: 'sherpa-onnx-v1.13.8-osx-arm64-static-lib.tar.bz2',
      bytes: 19712083,
      sha256: 'd586f502cbffb6d50675e035f4e823cd001b52958f5b1e6ff7d16b83d368a6d3',
    },
    'linux-x64': {
      name: 'sherpa-onnx-v1.13.8-linux-x64-static-lib.tar.bz2',
      bytes: 21666983,
      sha256: '328cff8b420d3e560df3e4f465c544c10562ca15b3f515b2b1fa28813a0f2acf',
    },
    'linux-arm64': {
      name: 'sherpa-onnx-v1.13.8-linux-aarch64-static-lib.tar.bz2',
      bytes: 20134985,
      sha256: '64050f0b33f15f63d4e80e6852b2972535f9a550eaa08ab00ac869eea916ab05',
    },
  },
};

/** Where scripts/prebuilt.mjs downloads each archive from. */
export function sherpaOnnxArchiveUrl(name) {
  return `https://github.com/analyticsinmotion/wake-word/releases/download/sherpa-onnx-v${SHERPA_ONNX.version}/${name}`;
}

/**
 * The files the binary loads at run time, installed beside it: ONNX Runtime
 * for the voice activity detector, and the Silero voice activity model.
 *
 * Both come from decibri's npm packages, which publish the ONNX Runtime build
 * decibri is tested against for each platform and the model decibri loads,
 * each with the license notice it requires. The ONNX Runtime packages carry
 * ONNX Runtime 1.28.1; decibri refuses anything older than 1.28. The Linux
 * packages also carry libonnxruntime_providers_shared.so, which ONNX Runtime
 * loads only to register an execution provider other than the CPU; the CPU
 * provider is built into libonnxruntime.so, which does not list it as a
 * dependency, so it is not shipped.
 *
 * `tarball` is the registry's integrity value for the package, checked before
 * the package is unpacked. Each file is then checked against its own digest,
 * and scripts/verify-vsix.mjs checks the packaged copies against the same
 * values.
 */
export const RUNTIME_FILES = {
  model: {
    package: 'decibri',
    version: '5.7.0',
    tarball: 'sha512-M2LoVPG6uEufk5x1oaFDP1ml/r04nTmgzZ1TKJrb2tCva8tkDLtWoujT9Nt5g2rXk3/52Ekymmp2aFs3lyco4Q==',
    files: [
      {
        from: 'package/models/silero_vad.onnx',
        to: 'silero_vad.onnx',
        bytes: 2327524,
        sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
      },
      {
        from: 'package/models/THIRD-PARTY-NOTICES.md',
        to: 'SILERO-VAD-NOTICES.md',
        bytes: 4762,
        sha256: 'a28d7bec6ea298f0a4925e1cab6bdbde5229cc905cdad56c3a6b19409dfb8e3c',
      },
    ],
  },
  onnxRuntime: {
    'win32-x64': {
      package: '@decibri/decibri-win32-x64-msvc',
      version: '5.7.0',
      tarball: 'sha512-msAY4Ig2V19LdNFul1iD/p0NVXJWjEM7dF/6psh6BfNTz3pQKPB2yJatZR2p/MpggEBDY+P9bqm3eyg2upwVtw==',
      library: {
        from: 'package/onnxruntime.dll',
        to: 'onnxruntime.dll',
        bytes: 15818080,
        sha256: 'ab48e807eb96ad3d399c72e5f67dd93fe9c8b452e051fbf27f72d546e1882f4a',
      },
    },
    'darwin-arm64': {
      package: '@decibri/decibri-darwin-arm64',
      version: '5.7.0',
      tarball: 'sha512-RkU5JXH3+ijxGtynnVECo3wtFWqzGKmCqw5e1Tn3Y6Y1njDmiz/r1xNotf6Iq43nJu+czDUTcOh6o2ZNVJvWyg==',
      library: {
        from: 'package/libonnxruntime.dylib',
        to: 'libonnxruntime.dylib',
        bytes: 39365072,
        sha256: 'a3504a59b3178c40a972772730a27eda06bf447fb6d4f26c88bf5df81746a167',
      },
    },
    'linux-x64': {
      package: '@decibri/decibri-linux-x64-gnu',
      version: '5.7.0',
      tarball: 'sha512-H0TpHaM2k8cG4Gy+JTw8Mb5HOWpw8YYhPEOxelcsXBdNeReGUudHZArAelwhoEJP/WOaqKkLiZoQT5Kn2r4VlA==',
      library: {
        from: 'package/libonnxruntime.so',
        to: 'libonnxruntime.so',
        bytes: 24277040,
        sha256: 'e38d2cec3d582c41786bdd428865fc017145599666cb7c82410e52496e7e066d',
      },
    },
    'linux-arm64': {
      package: '@decibri/decibri-linux-arm64-gnu',
      version: '5.7.0',
      tarball: 'sha512-9D8JLtl041mhGqqvrGiKMLq+Dxu+wKJ+8vFc32bESLkZUxCbtfHgSiMcyMdojYRab6NpbL7aK7mebad2WltHvw==',
      library: {
        from: 'package/libonnxruntime.so',
        to: 'libonnxruntime.so',
        bytes: 20591712,
        sha256: '0ce5f75809ba44fdc766b64edf8961014f0ab7ea3686b1be466a61f1474918ac',
      },
    },
  },
  /** The same notice ships in every ONNX Runtime package. */
  onnxRuntimeNotices: {
    from: 'package/THIRD-PARTY-NOTICES.md',
    to: 'ONNXRUNTIME-NOTICES.md',
    bytes: 328269,
    sha256: '5fb6fbffeddb974bb2306a801452adaa831d5cf0c6be9fe954aaf9424af17345',
  },
};

/** The registry URL of a package tarball. */
export function npmTarballUrl(pkg, version) {
  const base = pkg.split('/').pop();
  return `https://registry.npmjs.org/${pkg}/-/${base}-${version}.tgz`;
}

/** The directory in the extension package that holds the engine and its runtime files. */
export const PACKAGE_DIR = 'bin';

/** The engine's file name on each target. */
export function engineFileName(target) {
  return target.startsWith('win32-') ? 'wake-word-engine.exe' : 'wake-word-engine';
}

/** The targets the extension ships for. */
export const TARGETS = ['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
