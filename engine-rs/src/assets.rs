//! Where the engine finds the Silero voice activity model and ONNX Runtime.
//!
//! decibri is built with `ort-load-dynamic`, so neither is compiled into the
//! binary. ONNX Runtime is a shared library loaded when the first voice
//! activity detector is constructed, and the Silero model is a file that
//! detector loads. decibri requires ONNX Runtime 1.28 or later.
//!
//! The Silero model, first match wins:
//!
//! 1. `vadModelPath` in the config line;
//! 2. the `WAKE_WORD_VAD_MODEL` environment variable;
//! 3. `silero_vad.onnx` in the directory that holds the executable.
//!
//! ONNX Runtime is located by decibri itself, in this order:
//!
//! 1. `ortLibraryPath` in the config line, passed as
//!    `VadConfig::ort_library_path`;
//! 2. the `ORT_DYLIB_PATH` environment variable;
//! 3. the platform library (`onnxruntime.dll`, `libonnxruntime.dylib`,
//!    `libonnxruntime.so`) in the directory that holds the executable;
//! 4. the same name through the system loader. On Windows that finds the copy
//!    in System32 first, which is not a compatible build, and decibri refuses
//!    it.
//!
//! [`ort_location`] repeats that search only to say which library decibri
//! will load, for the debug line and the self-test. The load itself, and every
//! check on the library, is decibri's.

use std::path::{Path, PathBuf};

/// Environment variable naming the Silero model file.
pub const VAD_MODEL_ENV: &str = "WAKE_WORD_VAD_MODEL";
/// The Silero model's file name when it sits beside the executable.
pub const VAD_MODEL_FILE: &str = "silero_vad.onnx";
/// Environment variable decibri reads for the ONNX Runtime library.
pub const ORT_PATH_ENV: &str = "ORT_DYLIB_PATH";

/// The platform's ONNX Runtime library name, as decibri looks for it.
#[cfg(target_os = "windows")]
pub const ORT_LIBRARY_FILE: &str = "onnxruntime.dll";
#[cfg(target_os = "macos")]
pub const ORT_LIBRARY_FILE: &str = "libonnxruntime.dylib";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const ORT_LIBRARY_FILE: &str = "libonnxruntime.so";

/// The Silero model file to load.
pub fn vad_model_path(configured: Option<&str>) -> PathBuf {
    choose_vad_model(configured, env_path(VAD_MODEL_ENV), executable_dir())
}

/// The ONNX Runtime library decibri will load, given the config's
/// `ortLibraryPath`.
pub fn ort_location(configured: Option<&str>) -> OrtLocation {
    choose_ort(
        configured,
        env_path(ORT_PATH_ENV),
        executable_dir(),
        &|path: &Path| path.is_file(),
    )
}

/// Which ONNX Runtime library decibri will load, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrtLocation {
    /// `ortLibraryPath` in the config line.
    Configured(PathBuf),
    /// The `ORT_DYLIB_PATH` environment variable.
    Environment(PathBuf),
    /// The library beside the executable.
    BesideExecutable(PathBuf),
    /// Nothing more specific was found, so the name is handed to the system
    /// loader.
    SystemLoader,
}

impl OrtLocation {
    /// How the location reads in a debug or self-test line.
    pub fn describe(&self) -> String {
        match self {
            OrtLocation::Configured(path)
            | OrtLocation::Environment(path)
            | OrtLocation::BesideExecutable(path) => path.display().to_string(),
            OrtLocation::SystemLoader => format!("{ORT_LIBRARY_FILE} from the system loader"),
        }
    }

    /// True when a specific library was named or found, so a failure to load
    /// it is a fault rather than the absence of a runtime.
    pub fn is_explicit(&self) -> bool {
        !matches!(self, OrtLocation::SystemLoader)
    }
}

/// An environment variable holding a path. Unset, empty, and non-Unicode all
/// count as not given, which is how decibri reads `ORT_DYLIB_PATH`.
fn env_path(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn executable_dir() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.to_path_buf())
}

fn choose_vad_model(
    configured: Option<&str>,
    environment: Option<String>,
    executable_dir: Option<PathBuf>,
) -> PathBuf {
    if let Some(path) = configured {
        return PathBuf::from(path);
    }
    if let Some(path) = environment {
        return PathBuf::from(path);
    }
    match executable_dir {
        Some(dir) => dir.join(VAD_MODEL_FILE),
        None => PathBuf::from(VAD_MODEL_FILE),
    }
}

fn choose_ort(
    configured: Option<&str>,
    environment: Option<String>,
    executable_dir: Option<PathBuf>,
    is_file: &dyn Fn(&Path) -> bool,
) -> OrtLocation {
    if let Some(path) = configured {
        return OrtLocation::Configured(PathBuf::from(path));
    }
    if let Some(path) = environment {
        // decibri resolves a relative ORT_DYLIB_PATH against the executable's
        // directory when a file is there, and hands it on as given otherwise.
        let path = PathBuf::from(path);
        let beside = executable_dir
            .as_ref()
            .filter(|_| path.is_relative())
            .map(|dir| dir.join(&path))
            .filter(|candidate| is_file(candidate));
        return OrtLocation::Environment(beside.unwrap_or(path));
    }
    if let Some(dir) = executable_dir {
        let beside = dir.join(ORT_LIBRARY_FILE);
        if is_file(&beside) {
            return OrtLocation::BesideExecutable(beside);
        }
    }
    OrtLocation::SystemLoader
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> Option<PathBuf> {
        Some(PathBuf::from("/opt/wake-word/bin"))
    }

    fn nothing_exists(_: &Path) -> bool {
        false
    }

    #[test]
    fn the_configured_model_path_wins() {
        assert_eq!(
            choose_vad_model(Some("/cfg/vad.onnx"), Some("/env/vad.onnx".into()), dir()),
            PathBuf::from("/cfg/vad.onnx")
        );
    }

    #[test]
    fn the_environment_model_path_comes_next() {
        assert_eq!(
            choose_vad_model(None, Some("/env/vad.onnx".into()), dir()),
            PathBuf::from("/env/vad.onnx")
        );
    }

    #[test]
    fn the_model_is_otherwise_looked_for_beside_the_executable() {
        assert_eq!(
            choose_vad_model(None, None, dir()),
            PathBuf::from("/opt/wake-word/bin").join("silero_vad.onnx")
        );
        assert_eq!(
            choose_vad_model(None, None, None),
            PathBuf::from("silero_vad.onnx")
        );
    }

    #[test]
    fn the_configured_onnx_runtime_wins() {
        assert_eq!(
            choose_ort(Some("/cfg/ort"), Some("/env/ort".into()), dir(), &|_| true),
            OrtLocation::Configured(PathBuf::from("/cfg/ort"))
        );
    }

    #[test]
    fn the_environment_onnx_runtime_comes_next_whether_or_not_it_exists() {
        assert_eq!(
            choose_ort(None, Some("/env/ort".into()), dir(), &nothing_exists),
            OrtLocation::Environment(PathBuf::from("/env/ort"))
        );
    }

    #[test]
    fn a_relative_environment_path_resolves_beside_the_executable_when_a_file_is_there() {
        let beside = PathBuf::from("/opt/wake-word/bin").join("lib/ort");
        let exists = beside.clone();
        assert_eq!(
            choose_ort(None, Some("lib/ort".into()), dir(), &|path| path == exists),
            OrtLocation::Environment(beside)
        );
        assert_eq!(
            choose_ort(None, Some("lib/ort".into()), dir(), &nothing_exists),
            OrtLocation::Environment(PathBuf::from("lib/ort"))
        );
    }

    #[test]
    fn the_library_beside_the_executable_is_used_when_present() {
        let beside = PathBuf::from("/opt/wake-word/bin").join(ORT_LIBRARY_FILE);
        let exists = beside.clone();
        assert_eq!(
            choose_ort(None, None, dir(), &|path| path == exists),
            OrtLocation::BesideExecutable(beside)
        );
    }

    #[test]
    fn the_system_loader_is_the_last_resort() {
        assert_eq!(
            choose_ort(None, None, dir(), &nothing_exists),
            OrtLocation::SystemLoader
        );
        assert_eq!(
            choose_ort(None, None, None, &nothing_exists),
            OrtLocation::SystemLoader
        );
    }

    #[test]
    fn describes_each_location() {
        assert_eq!(
            OrtLocation::Environment(PathBuf::from("/env/ort")).describe(),
            PathBuf::from("/env/ort").display().to_string()
        );
        assert_eq!(
            OrtLocation::SystemLoader.describe(),
            format!("{ORT_LIBRARY_FILE} from the system loader")
        );
        assert!(OrtLocation::Configured(PathBuf::new()).is_explicit());
        assert!(!OrtLocation::SystemLoader.is_explicit());
    }
}
