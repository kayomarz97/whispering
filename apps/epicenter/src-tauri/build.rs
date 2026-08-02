//! Epicenter Tauri build script.
//!
//! The Whispering surface links transcribe-cpp statically on macOS and
//! aarch64 Windows. Linux and x86_64 Windows use dynamic backends, so their
//! runtime libraries are staged for the final bundle here.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const COMMANDS: &[&str] = &[
    "get_runtime_info",
    "write_text",
    "simulate_enter_keystroke",
    "simulate_copy_keystroke",
    "get_current_recording_id",
    "enumerate_recording_devices",
    "init_recording_session",
    "close_recording_session",
    "start_recording",
    "stop_recording",
    "cancel_recording",
    "delete_recording_artifacts",
    "clear_recording_artifacts",
    "read_recording_artifact",
    "save_recording_artifact",
    "encode_recording_for_upload",
    "transcribe_recording",
    "prewarm_model",
    "open_accessibility_settings",
    "request_accessibility_permission",
    "get_microphone_permission",
    "request_microphone_permission",
    "set_unload_policy",
    "list_models",
    "download_model",
    "delete_model",
    "cancel_download",
    "pause_playback",
    "resume_playback",
    "keyring_read",
    "keyring_write",
    "set_auto_paste_enabled",
    "get_dictation_capability",
];

fn main() {
    bake_transcribe_rpath();
    stage_transcribe_runtime();
    give_test_binaries_a_manifest();

    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Epicenter's Tauri manifest");
}

/// Give Windows test binaries the Common Controls v6 activation context that
/// `tauri_build` only embeds into the *application* binary.
///
/// Without it `cargo test` cannot run at all on Windows: the dependency graph
/// statically imports `TaskDialogIndirect` from `comctl32.dll`, that export
/// exists only in the side-by-side Common Controls **v6** assembly, and an
/// executable with no manifest resolves `comctl32.dll` to System32's v5.82 —
/// which does not export it. The loader then kills the process with
/// `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139) before `main` runs, so every test
/// in the crate "fails" without a single one having been executed.
///
/// The app binary never hit this because `tauri_build` embeds a manifest into
/// it. Cargo's test harness executables are separate link targets and get
/// nothing, which is what `rustc-link-arg-tests` exists for.
///
/// Declared inline rather than through a checked-in `.manifest` file on
/// purpose: the whole content is this one dependency, and a separate file is a
/// second place for it to rot.
fn give_test_binaries_a_manifest() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
    // …but NOT for the application binary, which already links `tauri_build`'s
    // resource carrying RT_MANIFEST id 1. Two manifests is a hard link failure
    // (`CVT1100: duplicate resource` → `LNK1123`), and `rustc-link-arg-tests`
    // cannot be used instead because Cargo classifies the lib's unit-test
    // executable as the *lib* target compiled in test mode, not as a test
    // target — verified by grepping the linker invocation, where the
    // `-tests` form never appeared. `/MANIFEST:NO` last wins for link.exe, and
    // bin-scoped arguments are appended after the general ones.
    println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
}

/// Bake the rpaths the shared `libtranscribe` needs on Linux. Windows resolves
/// DLLs from the executable directory and macOS links transcribe-cpp statically.
fn bake_transcribe_rpath() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    // Bundles install the executable to /usr/bin and the staged libraries to
    // /usr/lib, so this is the only relative rpath a shipped build needs.
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");

    // Dev builds also need the transcribe-cpp build output before a bundle
    // layout exists.
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_LIB_DIR");
    if let Some(lib_dir) = env::var_os("DEP_TRANSCRIBE_CPP_LIB_DIR") {
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,{}",
            Path::new(&lib_dir).display()
        );
    }
}

/// Copy transcribe-cpp's shared libraries and backend modules into the stable
/// `transcribe-libs/` staging directory used by Tauri's platform bundles.
fn stage_transcribe_runtime() {
    for var in [
        "DEP_TRANSCRIBE_CPP_RUNTIME_DIR",
        "DEP_TRANSCRIBE_CPP_MODULE_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }

    let staging = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("transcribe-libs");

    // A missing runtime directory means this is a statically linked target.
    // Remove stale cross-target libraries once, but leave an already-empty
    // directory untouched so `tauri dev` does not rebuild in a watcher loop.
    let Some(runtime_dir) = env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR") else {
        let has_stale_entries =
            fs::read_dir(&staging).is_ok_and(|mut entries| entries.next().is_some());
        if has_stale_entries {
            fs::remove_dir_all(&staging).expect("remove stale transcribe-libs staging directory");
            fs::create_dir_all(&staging).expect("create transcribe-libs staging directory");
        }
        return;
    };

    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).expect("create transcribe-libs staging directory");

    let mut dirs = BTreeSet::new();
    dirs.insert(PathBuf::from(runtime_dir));
    if let Some(module_dir) = env::var_os("DEP_TRANSCRIBE_CPP_MODULE_DIR") {
        dirs.insert(PathBuf::from(module_dir));
    }

    let mut copied = 0;
    for dir in &dirs {
        println!("cargo:rerun-if-changed={}", dir.display());
        copied += copy_libs(dir, &staging);
    }
    assert!(
        copied > 0,
        "no transcribe-cpp runtime libraries found under {dirs:?}; a dynamic-backends build must ship them"
    );
    println!("cargo:warning=Staged {copied} transcribe-cpp runtime library file(s)");
}

fn is_lib(name: &str) -> bool {
    name.ends_with(".dll")
        || name.ends_with(".dylib")
        || name.ends_with(".so")
        || name.contains(".so.")
}

fn copy_libs(src: &Path, dest: &Path) -> usize {
    let Ok(entries) = fs::read_dir(src) else {
        return 0;
    };
    let mut copied = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if is_lib(name) {
            fs::copy(&path, dest.join(name))
                .unwrap_or_else(|error| panic!("copy {} into staging: {error}", path.display()));
            copied += 1;
        }
    }
    copied
}
