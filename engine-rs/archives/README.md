# sherpa-onnx archives without text-to-speech

The engine links sherpa-onnx statically. The build script of the
`sherpa-onnx-sys` crate downloads one prebuilt archive per target and links a
fixed list of static libraries from it. The official archives also carry the
text-to-speech components, which the engine never calls.

The **Engine archives** workflow (`.github/workflows/engine-archives.yml`)
builds the same libraries from the same sherpa-onnx release with
text-to-speech turned off (`SHERPA_ONNX_ENABLE_TTS=OFF`), and packages them
under the official archives' names and layout, so that the build script uses
them unmodified.

## What it produces

One archive per target, uploaded as a workflow artifact:

| Target | Runner | Archive |
| --- | --- | --- |
| win-x64 | `windows-2022` | `sherpa-onnx-<tag>-win-x64-static-MT-Release-lib.tar.bz2` |
| osx-arm64 | `macos-26` | `sherpa-onnx-<tag>-osx-arm64-static-lib.tar.bz2` |
| linux-x64 | `ubuntu-24.04` | `sherpa-onnx-<tag>-linux-x64-static-lib.tar.bz2` |
| linux-aarch64 | `ubuntu-24.04-arm` | `sherpa-onnx-<tag>-linux-aarch64-static-lib.tar.bz2` |

A static library links only with a toolchain at least as new as the one that
compiled it, so each runner, and on Linux the container image, is pinned
rather than named by a moving label:

- **Windows:** Visual Studio 2022 (MSVC 14.44), the toolset the official
  archives are compiled with. Objects from the Visual Studio 2026 toolset call
  standard library helpers that the 14.44 runtime library does not define.
- **macOS:** macOS 26 with its default Xcode, the SDK the official archives
  are compiled with.
- **Linux:** a dated `manylinux_2_28` image, pinned by digest, whose GCC 14
  toolset sets the oldest compiler that can link the archive: GCC 13.3 links
  it, GCC 12 does not.

Each holds `<name>/lib/` and the static libraries, as the official archive
does. `espeak-ng`, `piper_phonemize` and `ucd` are in the build script's link
list but exist only in a text-to-speech build, so the archive carries each as a
library holding one empty object file. The link list does not force
whole-archive linking, so nothing is linked from them.

## How each target is built

`build.sh` configures upstream's CMake with text-to-speech, the demo programs,
portaudio and the websocket servers off, static libraries, and a release
build, then stages the installed libraries and makes the three placeholder
libraries with the compiler and archiver CMake used.

- **Windows:** the Visual Studio generator with the static C runtime (`/MT`),
  which the engine's `+crt-static` build requires.
- **macOS:** a universal build thinned to arm64 with `lipo`, as upstream
  builds its archives, for macOS 11.0, the engine's deployment target.
- **Linux:** inside `quay.io/pypa/manylinux_2_28_x86_64` or `_aarch64`, the
  image family the engine's release build uses, so nothing needs a newer glibc
  than 2.28.

ONNX Runtime is the build upstream's CMake downloads and checks against its own
pinned SHA-256.

## What is checked

`verify.mjs` checks the placeholders as soon as they are made, then checks the
packed archive, unpacked again, against the official archive for the same
release and target:

- the layout, and the same library files as the official archive, less the
  portaudio library, which is not built;
- every library the link list names is present and holds only objects for the
  target's format and machine;
- the placeholders define and reference no symbol;
- the C API defines the functions the engine calls, and every `SherpaOnnx`
  function the official C API defines;
- no library defines or references a symbol of the excluded components, by
  name pattern and by the names only the official archive's copies of those
  libraries define;
- Windows: no object asks for the DLL or a debug C runtime, and the C++
  objects declare the static release one; macOS: no object requires a newer
  macOS than 11.0.

The job summary shows the archive's size and SHA-256 beside the official
archive's, what built it (runner image, upstream commit, compiler, and on
Linux the container image digest), and each check's result.

## Running it

Run it from the repository's **Actions** tab, or with the GitHub CLI:

```bash
gh workflow run engine-archives.yml -f tag=v1.13.8            # the default branch's copy
gh workflow run engine-archives.yml --ref <branch> -f tag=v1.13.8
gh api repos/{owner}/{repo}/actions/runs/<run-id>/artifacts \
  --jq '.artifacts[] | "\(.id) \(.name)"' |
  while read -r id name; do
    gh api "repos/{owner}/{repo}/actions/artifacts/$id/zip" > "$name"
  done                                                        # the four archives
```

`gh run download` expects zipped artifacts and cannot unpack these, so the
archives are fetched through the API, which returns each file as uploaded.

GitHub starts a manually triggered workflow only once the workflow file is on
the default branch; after that, `--ref` runs another branch's copy.

The artifacts are the archives themselves, not zipped. To publish them,
attach them to a release in this repository whose tag does not start with `v`,
such as `sherpa-onnx-v1.13.8`: `release.yml` builds and publishes the extension
for tags that do. The engine builds against the archives
`engine-rs/scripts/pinned-inputs.mjs` pins; using these means pinning each
one's size and SHA-256 there and pointing the download URL at the release.

## Running it locally

On Windows (Git Bash, Visual Studio Build Tools with CMake on `PATH`) or macOS,
as below; for Linux, run the same `build.sh` inside the `manylinux_2_28` image
as the workflow does:

```bash
git clone --depth 1 --branch v1.13.8 https://github.com/k2-fsa/sherpa-onnx.git src
bash engine-rs/archives/build.sh --source src --work work --stage stage \
  --stem sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib
node engine-rs/archives/verify.mjs placeholders --lib-dir stage/sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib/lib
```

On Windows keep the work directory's path under about 90 characters: the
deepest file of the build tree lies 165 characters below it, and the Microsoft
build tools fail on paths over 260. Pack with `tar -cjf` from inside the stage
directory, then run `verify.mjs archive` as the workflow does.

To build the engine against a local archive, point `SHERPA_ONNX_ARCHIVE_DIR` at
the directory holding it and use an empty `CARGO_TARGET_DIR`: the build script
reuses an already unpacked `target/sherpa-onnx-prebuilt/` copy without looking
at the archive. `prebuilt.mjs` rejects an archive whose digest is not pinned.

## A new sherpa-onnx release

`LINK_LIST` and `PLACEHOLDERS` in `verify.mjs`, and `PLACEHOLDERS` in
`build.sh`, follow `SHERPA_ONNX_STATIC_LIBS` in the `sherpa-onnx-sys` build
script, and the matrix variants follow its `archive_name()`. Check both
against the crate version being built for.
