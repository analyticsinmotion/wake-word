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

/**
 * The Microsoft Visual C++ runtime libraries that ship beside the binary on
 * Windows, by target.
 *
 * The engine itself links the C runtime statically, but the ONNX Runtime
 * library it loads imports these four, and a Windows installation does not
 * include them. Windows looks for a library's imports in the directory of the
 * running executable before anywhere else, so copies beside the binary are
 * the ones loaded and nothing has to be installed. The list is the closure of
 * what onnxruntime.dll imports (msvcp140.dll, msvcp140_1.dll,
 * vcruntime140.dll, vcruntime140_1.dll) and what those import in turn;
 * scripts/verify-vsix.mjs reads the imports of every packaged library and
 * fails when one names a Visual C++ runtime library that is not packaged. The
 * api-ms-win-crt-* imports are the Universal C Runtime, which is part of
 * Windows 10 and later. The libraries must be at least as new as the toolset
 * that built onnxruntime.dll, which its header records as 14.44.
 *
 * They come from Microsoft's Visual C++ Redistributable installer, at a URL
 * that names one build of it. scripts/stage.mjs checks the installer against
 * `installer`, unpacks it without running it, and checks each library
 * against its own digest. `from` is the library's name inside the installer's
 * cabinet. `notices` is the tracked file that ships with them.
 */
export const C_RUNTIME = {
  'win32-x64': {
    version: '14.44.35211.0',
    installer: {
      url: 'https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe',
      bytes: 25635768,
      sha256: 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b',
    },
    files: [
      {
        from: 'msvcp140.dll_amd64',
        to: 'msvcp140.dll',
        bytes: 557728,
        sha256: '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9',
      },
      {
        from: 'msvcp140_1.dll_amd64',
        to: 'msvcp140_1.dll',
        bytes: 35952,
        sha256: 'bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d',
      },
      {
        from: 'vcruntime140.dll_amd64',
        to: 'vcruntime140.dll',
        bytes: 124544,
        sha256: 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066',
      },
      {
        from: 'vcruntime140_1.dll_amd64',
        to: 'vcruntime140_1.dll',
        bytes: 49792,
        sha256: '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f',
      },
    ],
    notices: { from: 'notices/VC-RUNTIME-NOTICES.md', to: 'VC-RUNTIME-NOTICES.md' },
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
