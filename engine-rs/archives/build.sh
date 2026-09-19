#!/usr/bin/env bash
# Builds the sherpa-onnx static libraries for one target with the
# text-to-speech components excluded, and stages them as <stage>/<stem>/lib,
# the layout the sherpa-onnx-sys build script unpacks.
#
#   bash build.sh --source <dir> --work <dir> --stage <dir> --stem <name>
#
# <source> is a sherpa-onnx checkout at a release tag. <work> holds the build
# and install trees. <stem> is the archive name without .tar.bz2, which is also
# the top-level directory inside the archive.
#
# Runs on the Windows runner (Git Bash, Visual Studio generator), on the macOS
# runner, and inside a manylinux_2_28 container for Linux.
#
# The build script of sherpa-onnx-sys links a fixed list of libraries, three of
# which (espeak-ng, piper_phonemize, ucd) exist only when text-to-speech is
# compiled. Each is supplied here as a static library whose one member is an
# empty object file, made with the compiler and archiver CMake used for the
# real libraries. The link list does not force whole-archive inclusion, so a
# library that defines no symbols contributes nothing to the executable.

set -euo pipefail

# Built by the text-to-speech stack only; supplied as empty libraries. The
# same three as PLACEHOLDERS in verify.mjs, which checks them.
PLACEHOLDERS=(espeak-ng piper_phonemize ucd)

usage() {
  echo "usage: build.sh --source <dir> --work <dir> --stage <dir> --stem <name>" >&2
  exit 2
}

source_dir='' work_dir='' stage_dir='' stem=''
while [ $# -gt 0 ]; do
  case "$1" in
    --source) source_dir=$2; shift 2 ;;
    --work) work_dir=$2; shift 2 ;;
    --stage) stage_dir=$2; shift 2 ;;
    --stem) stem=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$source_dir" ] && [ -n "$work_dir" ] && [ -n "$stage_dir" ] && [ -n "$stem" ] || usage

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) echo "error: unsupported system $(uname -s)" >&2; exit 1 ;;
esac

case "$os" in
  windows) jobs=${NUMBER_OF_PROCESSORS:-2} ;;
  macos) jobs=$(sysctl -n hw.ncpu) ;;
  linux) jobs=$(nproc) ;;
esac

# Absolute paths, so CMake reads the install prefix the same way whatever
# directory it runs in.
mkdir -p "$work_dir" "$stage_dir"
source_dir=$(cd "$source_dir" && pwd)
work_dir=$(cd "$work_dir" && pwd)
stage_dir=$(cd "$stage_dir" && pwd)

build_dir="$work_dir/build"
install_dir="$work_dir/install"
lib_dir="$stage_dir/$stem/lib"

# The name a static library called <name> has on this platform.
lib_file() {
  if [ "$os" = windows ]; then echo "$1.lib"; else echo "lib$1.a"; fi
}

# The options that differ from upstream's defaults, and the ones the archive's
# properties depend on. Everything else is left at upstream's default, as in
# the official archives. Binaries, and with them portaudio and the websocket
# servers, are not built: the archive carries libraries only. Pre-installed
# ONNX Runtime copies are ignored, so the ONNX Runtime linked is the one
# upstream's CMake downloads and checks against its own pinned digest.
cmake_args=(
  -D CMAKE_BUILD_TYPE=Release
  -D CMAKE_INSTALL_PREFIX="$install_dir"
  -D BUILD_SHARED_LIBS=OFF
  -D SHERPA_ONNX_ENABLE_TTS=OFF
  -D SHERPA_ONNX_ENABLE_C_API=ON
  -D SHERPA_ONNX_ENABLE_BINARY=OFF
  -D SHERPA_ONNX_ENABLE_PORTAUDIO=OFF
  -D SHERPA_ONNX_ENABLE_WEBSOCKET=OFF
  -D SHERPA_ONNX_ENABLE_TESTS=OFF
  -D SHERPA_ONNX_ENABLE_PYTHON=OFF
  -D SHERPA_ONNX_ENABLE_JNI=OFF
  -D SHERPA_ONNX_ENABLE_GPU=OFF
  -D SHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF
)
case "$os" in
  windows)
    # The Visual Studio generator: upstream selects its ONNX Runtime download
    # by the generator's platform name. The static C runtime (/MT) matches the
    # official archive and the engine's +crt-static build; a library built
    # against the dynamic runtime makes the link warn LNK4098.
    cmake_args+=(-A x64 -D SHERPA_ONNX_USE_STATIC_CRT=ON)
    ;;
  macos)
    # Universal, then thinned to arm64 when staged, as upstream builds its
    # macOS archives: an arm64-only configure links a different ONNX Runtime
    # build. The engine is built with MACOSX_DEPLOYMENT_TARGET=11.0, so no
    # object may require a newer macOS than that.
    cmake_args+=(-D 'CMAKE_OSX_ARCHITECTURES=arm64;x86_64' -D CMAKE_OSX_DEPLOYMENT_TARGET=11.0)
    ;;
esac

echo "== Configure ($os, $jobs jobs)"
cmake --version
cmake -S "$source_dir" -B "$build_dir" "${cmake_args[@]}"

echo "== Build"
cmake --build "$build_dir" --config Release --parallel "$jobs"
cmake --install "$build_dir" --config Release

# The same selection as upstream's -lib archives: every static library the
# install step put in lib/.
echo "== Stage $lib_dir"
rm -rf "${stage_dir:?}/$stem"
mkdir -p "$lib_dir"
case "$os" in
  windows) cp "$install_dir"/lib/*.lib "$lib_dir"/ ;;
  macos)
    for library in "$install_dir"/lib/lib*.a; do
      lipo -thin arm64 "$library" -output "$lib_dir/$(basename "$library")"
    done
    ;;
  linux) cp "$install_dir"/lib/lib*.a "$lib_dir"/ ;;
esac

for name in "${PLACEHOLDERS[@]}"; do
  if [ -e "$lib_dir/$(lib_file "$name")" ]; then
    echo "error: $(lib_file "$name") was built although text-to-speech is off" >&2
    exit 1
  fi
done

# The compiler and archiver CMake recorded for this build tree.
compiler_files=("$build_dir"/CMakeFiles/*/CMakeCCompiler.cmake)
compiler_file=${compiler_files[0]}
[ -f "$compiler_file" ] || { echo "error: CMake recorded no C compiler in $build_dir" >&2; exit 1; }
cmake_value() {
  # The first match only. A missing value is reported by the checks below.
  sed -n "s/^set($1 \"\([^\"]*\)\").*/\1/p" "$compiler_file" | head -n 1 || true
}
cc=$(cmake_value CMAKE_C_COMPILER)
ar=$(cmake_value CMAKE_AR)
ranlib=$(cmake_value CMAKE_RANLIB)
if [ "$os" = windows ]; then
  cc=$(cygpath -u "$cc")
  ar=$(cygpath -u "$ar")
fi
[ -n "$cc" ] && [ -n "$ar" ] || { echo "error: no compiler or archiver in $compiler_file" >&2; exit 1; }
if [ "$os" != windows ] && [ -z "$ranlib" ]; then
  echo "error: no ranlib in $compiler_file" >&2
  exit 1
fi

echo "== Placeholder libraries (compiler $cc, archiver $ar)"
placeholder_dir="$work_dir/placeholder"
rm -rf "$placeholder_dir"
mkdir -p "$placeholder_dir"
: > "$placeholder_dir/empty.c"
(
  # Relative names only: Git Bash rewrites arguments that look like POSIX
  # paths before they reach a Windows program.
  cd "$placeholder_dir"
  case "$os" in
    windows)
      # -Zl leaves out the default C runtime library directives, so the object
      # names no runtime at all.
      "$cc" -nologo -c -Zl -Foempty.obj empty.c
      for name in "${PLACEHOLDERS[@]}"; do
        "$ar" -nologo -machine:x64 "-out:$name.lib" empty.obj
      done
      ;;
    macos)
      "$cc" -c -arch arm64 -mmacosx-version-min=11.0 empty.c -o empty.o
      for name in "${PLACEHOLDERS[@]}"; do
        "$ar" qc "lib$name.a" empty.o
        "$ranlib" "lib$name.a"
      done
      ;;
    linux)
      "$cc" -c empty.c -o empty.o
      for name in "${PLACEHOLDERS[@]}"; do
        "$ar" qc "lib$name.a" empty.o
        "$ranlib" "lib$name.a"
      done
      ;;
  esac
)
for name in "${PLACEHOLDERS[@]}"; do
  cp "$placeholder_dir/$(lib_file "$name")" "$lib_dir/"
done

# The versions that built the archive, for the job summary.
{
  echo "cmake: $(cmake --version | head -n 1)"
  echo "compiler: $(cmake_value CMAKE_C_COMPILER_ID) $(cmake_value CMAKE_C_COMPILER_VERSION)"
  if [ "$os" = linux ]; then echo "libc: $(ldd --version 2>&1 | head -n 1)"; fi
  if [ "$os" = macos ]; then echo "sdk: macOS $(xcrun --show-sdk-version), deployment target 11.0"; fi
} > "$work_dir/toolchain.txt"
cat "$work_dir/toolchain.txt"

echo "== Staged"
ls -l "$lib_dir"
