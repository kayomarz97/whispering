use crate::recorder::artifact::{
    clear_artifacts, delete_artifacts, read_artifact_bytes, write_artifact, write_artifact_bytes,
    RecordingArtifact,
};
use crate::recorder::error::RecorderError;
use crate::recorder::recorder::{Recorder, Result};
use log::{debug, info, warn};
use serde::Serialize;
use std::sync::Mutex;
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};

const RECORDER_STATE_CHANGED: &str = "recorder:state-changed";

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "UPPERCASE")]
enum RecordingState {
    Idle,
    Recording,
}

fn emit_recording_state(app: &AppHandle, state: RecordingState) {
    crate::shell::set_tray_recording_state(app, matches!(state, RecordingState::Recording));
    if let Err(e) = app.emit(RECORDER_STATE_CHANGED, state) {
        warn!(
            "Failed to emit {} = {:?}: {}",
            RECORDER_STATE_CHANGED, state, e
        );
    }
}

#[tauri::command]
#[specta::specta]
pub async fn enumerate_recording_devices(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Vec<String>> {
    debug!("Enumerating recording devices");
    let recorder = recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
    recorder.enumerate_devices()
}

#[tauri::command]
#[specta::specta]
pub async fn init_recording_session(
    device_identifier: String,
    recording_id: String,
    sample_rate: Option<u32>,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!(
        "Initializing recording session: device={device_identifier}, id={recording_id}, sample_rate={sample_rate:?}",
    );

    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.init_session(
            device_identifier,
            recording_id,
            sample_rate,
            app_handle.clone(),
        )?;
    }
    // init_session calls close_session internally as cleanup. If the previous
    // session was actively recording, that transition is silent at the domain
    // layer; emit IDLE here so the JS state never diverges from reality.
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Starting recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.start_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Recording);
    Ok(())
}

/// Stop the recorder, write the canonical WAV artifact to
/// `<appDataDir>/recordings/{id}.wav`, return the small JSON handle.
///
/// JS never sees raw PCM samples on the wire: later operations look the
/// file up by id (`transcribe_recording`, `encode_recording_for_upload`,
/// and `delete_recording_artifacts`).
#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<RecordingArtifact> {
    info!("Stopping recording");
    let (recording_id, samples) = {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        let id = recorder
            .session_id()
            .ok_or_else(|| RecorderError::failed("no active recording session at stop"))?;
        let samples = recorder.stop_recording()?;
        (id, samples)
    };

    // Measured on the critical path on purpose: this synchronous write + fsync
    // is exactly the cost the parked handoff + async-persist optimization would
    // remove. The numbers here decide whether that optimization is worth it.
    let artifact = crate::timing::measure("stop.wav_write+fsync", || {
        write_artifact(&app_handle, &recording_id, &samples)
    })?;
    emit_recording_state(&app_handle, RecordingState::Idle);
    info!(
        "Recording stopped: id={}, duration_ms={}, bytes={}",
        artifact.id, artifact.duration_ms, artifact.byte_length,
    );
    Ok(artifact)
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Cancelling recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.cancel_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn close_recording_session(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Closing recording session");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
        recorder.close_session()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_current_recording_id(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Option<String>> {
    debug!("Getting current recording ID");
    let recorder = recorder
        .lock()
        .map_err(|e| RecorderError::failed(format!("Failed to lock recorder: {e}")))?;
    Ok(recorder.get_current_recording_id())
}

/// Delete recording artifacts by id.
///
/// This is intentionally id-based instead of path-based. The recorder
/// artifact module owns which files under the recordings directory are blobs,
/// so TypeScript callers cannot accidentally delete markdown sidecars or
/// arbitrary files. Missing artifacts are ignored to keep cleanup retryable.
#[tauri::command]
#[specta::specta]
pub async fn delete_recording_artifacts(
    recording_ids: Vec<String>,
    app_handle: AppHandle,
) -> Result<u32> {
    info!("Deleting {} recording artifacts", recording_ids.len());
    tokio::task::spawn_blocking(move || delete_artifacts(&app_handle, &recording_ids))
        .await
        .map_err(|e| RecorderError::failed(format!("Task join error: {e}")))?
}

/// Delete every recording artifact while preserving markdown sidecars.
///
/// Used by the blob store's `clear()` path. The Rust layer owns the directory
/// scan because it has the same artifact matching rule used by targeted
/// deletion and transcription lookup.
#[tauri::command]
#[specta::specta]
pub async fn clear_recording_artifacts(app_handle: AppHandle) -> Result<u32> {
    info!("Clearing recording artifacts");
    tokio::task::spawn_blocking(move || clear_artifacts(&app_handle))
        .await
        .map_err(|e| RecorderError::failed(format!("Task join error: {e}")))?
}

/// Read one recording artifact as a raw IPC byte body.
///
/// This command deliberately accepts an app-owned id rather than a path. Its
/// raw response lives outside tauri-specta and has a handwritten TypeScript
/// wrapper, matching `encode_recording_for_upload`.
#[tauri::command]
pub async fn read_recording_artifact(
    recording_id: String,
    app_handle: AppHandle,
) -> std::result::Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_artifact_bytes(&app_handle, &recording_id))
        .await
        .map_err(|e| format!("background artifact read failed: {e}"))?
        .map(Response::new)
        .map_err(|e| e.to_string())
}

/// One header value as a `String`, or a message naming what was missing.
fn required_header(headers: &HeaderMap, name: &str) -> std::result::Result<String, String> {
    headers
        .get(name)
        .ok_or_else(|| format!("missing '{name}' header"))?
        .to_str()
        .map(str::to_string)
        .map_err(|e| format!("invalid '{name}' header: {e}"))
}

/// Persist already-encoded audio bytes as the artifact for a recording id.
///
/// The producers that hand over a finished container rather than PCM — the VAD
/// recorder and file import — reach the recordings directory through here.
/// Without it both fail with "we could not write the recording bytes" before
/// transcription is ever attempted, which is what took voice-activated capture
/// (and with it live transcription) off the table on desktop.
///
/// The audio rides the IPC as a raw body rather than a JSON argument:
/// serializing a multi-megabyte recording as an array of numbers is slow and
/// several times larger than the audio itself. The id and extension ride
/// alongside as headers. Like the other raw-body commands, this lives outside
/// tauri-specta and has a handwritten TypeScript wrapper.
///
/// The frontend never names a path: it supplies an id and an extension, both
/// validated in `artifact.rs` before anything touches the filesystem, so this
/// grants persistence for recordings and not generic filesystem write authority.
#[tauri::command]
pub async fn save_recording_artifact(
    request: Request<'_>,
    app_handle: AppHandle,
) -> std::result::Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_recording_artifact expects a raw byte body".to_string());
    };
    let recording_id = required_header(request.headers(), "recording-id")?;
    let extension = required_header(request.headers(), "artifact-extension")?;
    let bytes = bytes.clone();

    let byte_length = tauri::async_runtime::spawn_blocking(move || {
        write_artifact_bytes(&app_handle, &recording_id, &extension, &bytes)
    })
    .await
    .map_err(|e| format!("background artifact write failed: {e}"))?
    .map_err(|e| e.to_string())?;

    info!("Saved recording artifact: {byte_length} bytes");
    Ok(())
}
