# *********************************************************
# backend/main.py
# *********************************************************
# BS(RasPizero2W+PiCam) -> http://192.168.101.***:5000/video_feed (***を確認)

import cv2
import base64
import asyncio
import json
import logging
import os
import signal
import subprocess
import threading
import time
import numpy as np
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from uuid import uuid4

import requests
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from db import (
    get_latest_readings,
    get_last_alert_ts,
    get_meter_by_id,
    get_meters,
    get_readings,
    get_stream_camera_names,
    get_stream_dates,
    get_stream_readings,
    init_db,
    insert_reading,
    insert_stream_reading,
    set_last_alert_ts,
    upsert_meter,
)
from detector import detect_objects, MODEL_DIR, MODEL_FILENAME  # detector.py から取り込み
from inference_adapter import infer, apply_preprocess
from postprocess import build_meter_value

app = FastAPI()
logger = logging.getLogger("meter_api")

# CORS 設定（React 開発サーバーからの接続を許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGE_SAVE_ROOT = os.path.join(BASE_DIR, "data", "images")
TEST_MODE_IMAGE_SAVE_ROOT = os.path.join(BASE_DIR, "data", "inbo")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "").strip()
ALERT_SUPPRESS_MINUTES = 5
STREAM_TARGET_FPS = 20.0
STREAM_READ_RETRY_LIMIT = 20
DEFAULT_DETECTION_CONFIDENCE_THRESHOLD = 0.25
DEFAULT_NMS_IOU_THRESHOLD = 0.55
DEFAULT_RESULT_INTERVAL_FRAMES = 1
DEFAULT_MERGE_SAME_DIGITS = True
DEFAULT_MERGE_ROW_TOLERANCE = 0.5
DEFAULT_MERGE_X_GAP_RATIO = 0.35
FRONTEND_DEV_PORTS = os.getenv("FRONTEND_DEV_PORTS", "5173,4173")


@app.on_event("startup")
def startup_event():
    init_db()


def resolve_model_name(name):
    if not isinstance(name, str):
        return None
    candidate = os.path.basename(name.strip())
    if not candidate:
        return None
    model_path = os.path.join(MODEL_DIR, candidate)
    if not os.path.exists(model_path):
        return None
    return candidate


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(min(value, maximum), minimum)


def _to_float(value: Any, name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"invalid preprocess: {name}")


def _to_int(value: Any, name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"invalid preprocess: {name}")


def _parse_preprocess(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid preprocess json")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid preprocess json")

    brightness = _to_float(payload.get("brightness", 1.0), "brightness")
    contrast = _to_float(payload.get("contrast", 1.0), "contrast")
    gamma = _to_float(payload.get("gamma", 1.0), "gamma")
    sharpness = _to_float(payload.get("sharpness", 1.0), "sharpness")
    highlight_suppression = _to_float(payload.get("highlightSuppression", 0.0), "highlightSuppression")
    highlight_recovery = _to_float(payload.get("highlightRecovery", 0.0), "highlightRecovery")
    highlight_recovery_curve = _to_float(payload.get("highlightRecoveryCurve", 1.0), "highlightRecoveryCurve")
    highlight_recovery_mode = payload.get("highlightRecoveryMode", "natural")
    highlight_line_max_dist = _to_int(payload.get("highlightLineMaxDist", 5), "highlightLineMaxDist")
    highlight_line_kernel_width = _to_int(payload.get("highlightLineKernelWidth", 9), "highlightLineKernelWidth")
    binarization_payload = payload.get("binarization", {})
    if binarization_payload is None:
        binarization_payload = {}
    if not isinstance(binarization_payload, dict):
        raise HTTPException(status_code=400, detail="invalid preprocess: binarization")
    binarization_enabled = bool(binarization_payload.get("enabled", False))
    binarization_threshold = _to_int(binarization_payload.get("threshold", 128), "binarization.threshold")

    if not 0.0 <= brightness <= 3.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: brightness")
    if not 0.0 <= contrast <= 3.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: contrast")
    if not 0.05 <= gamma <= 4.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: gamma")
    if not 0.0 <= sharpness <= 3.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: sharpness")
    if not 0.0 <= highlight_suppression <= 1.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightSuppression")
    if not 0.0 <= highlight_recovery <= 1.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightRecovery")
    if not 0.5 <= highlight_recovery_curve <= 3.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightRecoveryCurve")
    if not isinstance(highlight_recovery_mode, str):
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightRecoveryMode")
    if highlight_recovery_mode not in ("natural", "line"):
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightRecoveryMode")
    if not 3 <= highlight_line_max_dist <= 20:
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightLineMaxDist")
    if not 3 <= highlight_line_kernel_width <= 25:
        raise HTTPException(status_code=400, detail="invalid preprocess: highlightLineKernelWidth")
    if not 0 <= binarization_threshold <= 255:
        raise HTTPException(status_code=400, detail="invalid preprocess: binarization.threshold")

    clahe_payload = payload.get("clahe", {})
    if clahe_payload is None:
        clahe_payload = {}
    if not isinstance(clahe_payload, dict):
        raise HTTPException(status_code=400, detail="invalid preprocess: clahe")
    clahe_enabled = bool(clahe_payload.get("enabled", False))
    clahe_clip_limit = _to_float(clahe_payload.get("clipLimit", 2.0), "clahe.clipLimit")
    clahe_tile_grid_size = _to_int(clahe_payload.get("tileGridSize", 8), "clahe.tileGridSize")
    if not 1.0 <= clahe_clip_limit <= 12.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: clahe.clipLimit")
    if not 4 <= clahe_tile_grid_size <= 24:
        raise HTTPException(status_code=400, detail="invalid preprocess: clahe.tileGridSize")

    focus_payload = payload.get("focus", {})
    if focus_payload is None:
        focus_payload = {}
    if not isinstance(focus_payload, dict):
        raise HTTPException(status_code=400, detail="invalid preprocess: focus")
    focus_zoom = _to_float(focus_payload.get("zoom", 1.0), "focus.zoom")
    focus_center_x = _to_float(focus_payload.get("centerX", 0.5), "focus.centerX")
    focus_center_y = _to_float(focus_payload.get("centerY", 0.5), "focus.centerY")
    if not 1.0 <= focus_zoom <= 6.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: focus.zoom")
    if not 0.0 <= focus_center_x <= 1.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: focus.centerX")
    if not 0.0 <= focus_center_y <= 1.0:
        raise HTTPException(status_code=400, detail="invalid preprocess: focus.centerY")

    return {
        "brightness": _clamp(brightness, 0.0, 3.0),
        "contrast": _clamp(contrast, 0.0, 3.0),
        "gamma": _clamp(gamma, 0.05, 4.0),
        "sharpness": _clamp(sharpness, 0.0, 3.0),
        "highlightSuppression": _clamp(highlight_suppression, 0.0, 1.0),
        "highlightRecovery": _clamp(highlight_recovery, 0.0, 1.0),
        "highlightRecoveryCurve": _clamp(highlight_recovery_curve, 0.5, 3.0),
        "highlightRecoveryMode": highlight_recovery_mode,
        "highlightLineMaxDist": int(_clamp(float(highlight_line_max_dist), 3.0, 20.0)),
        "highlightLineKernelWidth": int(_clamp(float(highlight_line_kernel_width), 3.0, 25.0)),
        "binarization": {
            "enabled": binarization_enabled,
            "threshold": int(_clamp(float(binarization_threshold), 0.0, 255.0)),
        },
        "clahe": {
            "enabled": clahe_enabled,
            "clipLimit": _clamp(clahe_clip_limit, 1.0, 12.0),
            "tileGridSize": int(_clamp(float(clahe_tile_grid_size), 4.0, 24.0)),
        },
        "focus": {
            "zoom": _clamp(focus_zoom, 1.0, 6.0),
            "centerX": _clamp(focus_center_x, 0.0, 1.0),
            "centerY": _clamp(focus_center_y, 0.0, 1.0),
        },
    }


def _parse_preprocess_ws_payload(raw_payload: Any) -> Optional[Dict[str, Any]]:
    if raw_payload is None:
        return None
    if isinstance(raw_payload, str):
        return _parse_preprocess(raw_payload)
    if isinstance(raw_payload, dict):
        return _parse_preprocess(json.dumps(raw_payload))
    raise HTTPException(status_code=400, detail="invalid preprocess json")


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _default_detection_settings() -> Dict[str, Any]:
    return {
        "confidence_threshold": DEFAULT_DETECTION_CONFIDENCE_THRESHOLD,
        "nms_iou_threshold": DEFAULT_NMS_IOU_THRESHOLD,
        "result_interval_frames": DEFAULT_RESULT_INTERVAL_FRAMES,
        "merge_same_digits": DEFAULT_MERGE_SAME_DIGITS,
        "merge_row_tolerance": DEFAULT_MERGE_ROW_TOLERANCE,
        "merge_x_gap_ratio": DEFAULT_MERGE_X_GAP_RATIO,
    }


def _sanitize_detection_settings(payload: Dict[str, Any], fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base = fallback.copy() if isinstance(fallback, dict) else _default_detection_settings()

    confidence_threshold = _to_float(
        payload.get("confidenceThreshold", payload.get("confidence_threshold", base["confidence_threshold"])),
        "detectionSettings.confidenceThreshold",
    )
    nms_iou_threshold = _to_float(
        payload.get("nmsIouThreshold", payload.get("nms_iou_threshold", base["nms_iou_threshold"])),
        "detectionSettings.nmsIouThreshold",
    )
    result_interval_frames = _to_int(
        payload.get("resultIntervalFrames", payload.get("result_interval_frames", base["result_interval_frames"])),
        "detectionSettings.resultIntervalFrames",
    )
    merge_same_digits = _to_bool(payload.get("mergeSameDigits", payload.get("merge_same_digits", base["merge_same_digits"])), base["merge_same_digits"])
    merge_row_tolerance = _to_float(
        payload.get("mergeSameDigitsRowTolerance", payload.get("merge_row_tolerance", base["merge_row_tolerance"])),
        "detectionSettings.mergeSameDigitsRowTolerance",
    )
    merge_x_gap_ratio = _to_float(
        payload.get("mergeSameDigitsXGapRatio", payload.get("merge_x_gap_ratio", base["merge_x_gap_ratio"])),
        "detectionSettings.mergeSameDigitsXGapRatio",
    )

    if not 0.01 <= confidence_threshold <= 0.99:
        raise HTTPException(status_code=400, detail="invalid detectionSettings: confidenceThreshold")
    if not 0.1 <= nms_iou_threshold <= 0.95:
        raise HTTPException(status_code=400, detail="invalid detectionSettings: nmsIouThreshold")
    if not 1 <= result_interval_frames <= 60:
        raise HTTPException(status_code=400, detail="invalid detectionSettings: resultIntervalFrames")
    if not 0.05 <= merge_row_tolerance <= 2.0:
        raise HTTPException(status_code=400, detail="invalid detectionSettings: mergeSameDigitsRowTolerance")
    if not 0.01 <= merge_x_gap_ratio <= 2.0:
        raise HTTPException(status_code=400, detail="invalid detectionSettings: mergeSameDigitsXGapRatio")

    return {
        "confidence_threshold": _clamp(confidence_threshold, 0.01, 0.99),
        "nms_iou_threshold": _clamp(nms_iou_threshold, 0.1, 0.95),
        "result_interval_frames": int(_clamp(float(result_interval_frames), 1.0, 60.0)),
        "merge_same_digits": merge_same_digits,
        "merge_row_tolerance": _clamp(merge_row_tolerance, 0.05, 2.0),
        "merge_x_gap_ratio": _clamp(merge_x_gap_ratio, 0.01, 2.0),
    }


def _parse_detection_settings_ws_payload(raw_payload: Any, fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if raw_payload is None:
        return fallback.copy() if isinstance(fallback, dict) else _default_detection_settings()
    if isinstance(raw_payload, str):
        text = raw_payload.strip()
        if not text:
            return fallback.copy() if isinstance(fallback, dict) else _default_detection_settings()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="invalid detectionSettings json")
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="invalid detectionSettings json")
        return _sanitize_detection_settings(payload, fallback=fallback)
    if isinstance(raw_payload, dict):
        return _sanitize_detection_settings(raw_payload, fallback=fallback)
    raise HTTPException(status_code=400, detail="invalid detectionSettings json")


def _resolve_test_mode_save_dir(save_dir: Optional[str], save_dir_abs: Optional[str]) -> str:
    absolute_raw = (save_dir_abs or "").strip()
    if absolute_raw:
        expanded = os.path.expanduser(absolute_raw)
        if not os.path.isabs(expanded):
            raise HTTPException(status_code=400, detail="invalid save_dir_abs")
        return os.path.abspath(expanded)

    raw = (save_dir or "").strip()
    if not raw:
        return TEST_MODE_IMAGE_SAVE_ROOT

    normalized = raw.replace("\\", "/")
    normalized = normalized.lstrip("/")
    normalized = os.path.normpath(normalized)
    if normalized in {"", "."}:
        return TEST_MODE_IMAGE_SAVE_ROOT
    if normalized.startswith("..") or os.path.isabs(normalized):
        raise HTTPException(status_code=400, detail="invalid save_dir")

    base_dir = os.path.abspath(TEST_MODE_IMAGE_SAVE_ROOT)
    target_dir = os.path.abspath(os.path.join(base_dir, normalized))
    try:
        if os.path.commonpath([base_dir, target_dir]) != base_dir:
            raise HTTPException(status_code=400, detail="invalid save_dir")
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid save_dir")
    return target_dir


def _read_process_command(pid: int) -> str:
    try:
        proc = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            check=False,
            capture_output=True,
            text=True,
            timeout=1.0,
        )
        return (proc.stdout or "").strip()
    except Exception:
        return ""


def _collect_frontend_dev_pids() -> list[int]:
    candidates = []
    for raw in FRONTEND_DEV_PORTS.split(","):
        port_text = raw.strip()
        if not port_text.isdigit():
            continue
        candidates.append(int(port_text))

    detected = set()
    current_pid = os.getpid()
    for port in candidates:
        try:
            proc = subprocess.run(
                ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                check=False,
                capture_output=True,
                text=True,
                timeout=1.5,
            )
        except Exception:
            continue
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line or not line.isdigit():
                continue
            pid = int(line)
            if pid <= 1 or pid == current_pid:
                continue
            command = _read_process_command(pid).lower()
            if "vite" in command or "npm run dev" in command or ("node" in command and "frontend" in command):
                detected.add(pid)
    return sorted(detected)


def _collect_backend_shutdown_pids() -> list[int]:
    current_pid = os.getpid()
    parent_pid = os.getppid()
    targets = {current_pid}
    if parent_pid > 1:
        parent_command = _read_process_command(parent_pid).lower()
        if "uvicorn" in parent_command or "watchfiles" in parent_command:
            targets.add(parent_pid)
    return sorted(targets)


def _schedule_termination(frontend_pids: list[int], backend_pids: list[int]):
    unique_frontend = [pid for pid in dict.fromkeys(frontend_pids) if pid > 1]
    unique_backend = [pid for pid in dict.fromkeys(backend_pids) if pid > 1]
    current_pid = os.getpid()

    def _worker():
        time.sleep(0.35)
        # 先に frontend / 親 uvicorn を停止し、最後に現在の backend プロセスを停止する。
        ordered_targets = []
        for pid in unique_frontend + unique_backend:
            if pid == current_pid:
                continue
            if pid not in ordered_targets:
                ordered_targets.append(pid)
        for pid in ordered_targets:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                continue
            except Exception:
                logger.exception("failed to terminate pid=%s", pid)

        if current_pid in unique_backend:
            try:
                os.kill(current_pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            except Exception:
                logger.exception("failed to terminate current backend pid=%s", current_pid)

    threading.Thread(target=_worker, daemon=True).start()


@app.post("/api/v1/test-mode/select-save-dir")
def api_select_test_mode_save_dir():
    script = 'POSIX path of (choose folder with prompt "テストモード画像の保存先を選択")'
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except Exception:
        logger.exception("failed to open folder picker")
        raise HTTPException(status_code=500, detail="failed to open folder picker")

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    if result.returncode != 0:
        if "User canceled" in stderr:
            raise HTTPException(status_code=400, detail="folder selection canceled")
        logger.error("folder picker failed: return=%s stderr=%s", result.returncode, stderr)
        raise HTTPException(status_code=500, detail="failed to select save dir")
    if not stdout:
        raise HTTPException(status_code=500, detail="failed to select save dir")

    selected_dir = os.path.abspath(os.path.expanduser(stdout))
    return {
        "ok": True,
        "selected_dir": selected_dir,
        "default_dir": TEST_MODE_IMAGE_SAVE_ROOT,
    }


@app.post("/api/v1/app/shutdown")
def api_shutdown_app():
    frontend_pids = _collect_frontend_dev_pids()
    backend_pids = _collect_backend_shutdown_pids()
    _schedule_termination(frontend_pids, backend_pids)
    return {
        "ok": True,
        "message": "shutdown requested",
        "frontend_pids": frontend_pids,
        "backend_pids": backend_pids,
    }


def _draw_detections_overlay(frame, detections, model_name: str):
    for det in detections or []:
        x1 = int(det.get("x1", 0))
        y1 = int(det.get("y1", 0))
        x2 = int(det.get("x2", 0))
        y2 = int(det.get("y2", 0))
        conf = float(det.get("conf", 0.0))
        label_text = f"{det.get('label', '')} {conf:.2f}"
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(
            frame,
            label_text,
            (x1, y1 - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            1,
        )


def _draw_stream_metrics_overlay(
    frame,
    model_name: str,
    processing_fps: float,
    camera_raw_fps: float,
    show_processing_fps: bool,
):
    model_label = f"Model: {model_name}"
    model_text_org = (12, 34)
    target_fps = processing_fps if show_processing_fps else camera_raw_fps
    _ = target_fps
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.9
    cv2.putText(frame, model_label, model_text_org, font, font_scale, (0, 0, 0), 5, cv2.LINE_AA)
    cv2.putText(frame, model_label, model_text_org, font, font_scale, (0, 255, 0), 2, cv2.LINE_AA)


class MeterUpsertRequest(BaseModel):
    threshold_high: Optional[float] = None
    threshold_low: Optional[float] = None
    enabled: Optional[bool] = None
    fetch_interval_sec: Optional[int] = None
    anomaly_confirm_count: Optional[int] = None
    notify_cooldown_minutes: Optional[int] = None
    status_delay_seconds: Optional[int] = None
    status_down_seconds: Optional[int] = None


def _parse_iso_datetime(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def _should_send_alert_by_time(meter_id: str, cooldown_minutes: int = ALERT_SUPPRESS_MINUTES) -> bool:
    last_ts = get_last_alert_ts(meter_id)
    if not last_ts:
        return True
    last_dt = _parse_iso_datetime(last_ts)
    if not last_dt:
        return True
    return datetime.now(timezone.utc) - last_dt >= timedelta(minutes=max(cooldown_minutes, 0))


def _post_to_slack(text: str) -> bool:
    if not SLACK_WEBHOOK_URL:
        logger.info("SLACK_WEBHOOK_URL is not set; skip slack alert")
        return False
    try:
        resp = requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=5)
        if 200 <= resp.status_code < 300:
            return True
        logger.error("slack webhook failed status=%s body=%s", resp.status_code, resp.text)
        return False
    except Exception:
        logger.exception("slack webhook request failed")
        return False


def _maybe_send_threshold_alert(reading: dict) -> bool:
    meter_id = str(reading.get("meter_id", ""))
    meter = get_meter_by_id(meter_id)
    if not meter:
        logger.info("meter setting not found; skip alert meter_id=%s", meter_id)
        return False

    enabled = int(meter.get("enabled") or 0)
    if enabled != 1:
        logger.info("meter alert disabled; skip alert meter_id=%s", meter_id)
        return False

    value = reading.get("value")
    if value is None:
        logger.info("reading value is null; skip alert meter_id=%s", meter_id)
        return False
    try:
        value_float = float(value)
    except (TypeError, ValueError):
        logger.info("reading value is not numeric; skip alert meter_id=%s", meter_id)
        return False

    threshold_high = meter.get("threshold_high")
    threshold_low = meter.get("threshold_low")
    try:
        cooldown_minutes = int(meter.get("notify_cooldown_minutes") or ALERT_SUPPRESS_MINUTES)
    except (TypeError, ValueError):
        cooldown_minutes = ALERT_SUPPRESS_MINUTES
    cooldown_minutes = max(cooldown_minutes, 0)
    over_high = threshold_high is not None and value_float > float(threshold_high)
    under_low = threshold_low is not None and value_float < float(threshold_low)
    if not over_high and not under_low:
        return False

    if not _should_send_alert_by_time(meter_id, cooldown_minutes):
        logger.info("suppress alert meter_id=%s within %s minutes", meter_id, cooldown_minutes)
        return False

    reason = "HIGH" if over_high else "LOW"
    message = (
        f"[Meter Alert] meter_id={meter_id} reason={reason} "
        f"value={value_float} high={threshold_high} low={threshold_low} "
        f"ts={reading.get('ts')}"
    )
    sent = _post_to_slack(message)
    if sent:
        set_last_alert_ts(meter_id, datetime.now(timezone.utc).isoformat())
        logger.info("slack alert sent meter_id=%s", meter_id)
    return sent


@app.post("/api/v1/images")
async def upload_image(
    image: Optional[UploadFile] = File(None),
    meter_id: str = Form("default"),
    model_type: str = Form("dummy"),
    model_name: str = Form(""),
    preprocess: Optional[str] = Form(None),
    detection_settings: Optional[str] = Form(None),
):
    if image is None:
        raise HTTPException(status_code=400, detail="image is required")

    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="empty image")

    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="invalid content type")

    ext = os.path.splitext(image.filename or "")[1].lower()
    if ext not in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}:
        ext = ".jpg"

    date_dir = os.path.join(IMAGE_SAVE_ROOT, datetime.utcnow().strftime("%Y%m%d"))
    os.makedirs(date_dir, exist_ok=True)
    filename = f"{uuid4().hex}{ext}"
    abs_path = os.path.join(date_dir, filename)

    try:
        with open(abs_path, "wb") as f:
            f.write(content)
        logger.info("image received and saved: %s", abs_path)
    except Exception:
        logger.exception("failed to save uploaded image")
        raise HTTPException(status_code=500, detail="failed to save image")

    normalized_model_type = (model_type or "dummy").strip().lower()
    if normalized_model_type not in {"dummy", "yolo"}:
        raise HTTPException(status_code=400, detail="model_type must be dummy or yolo")
    preprocess_config = _parse_preprocess(preprocess)
    detection_settings_config = _parse_detection_settings_ws_payload(detection_settings)

    try:
        result = infer(
            image_path=abs_path,
            meter_id=(meter_id or "default").strip() or "default",
            model_type=normalized_model_type,
            model_name=model_name.strip() or None,
            preprocess=preprocess_config if normalized_model_type == "yolo" else None,
            detection_settings=detection_settings_config if normalized_model_type == "yolo" else None,
        )
        logger.info("inference completed: meter_id=%s model_type=%s", result["meter_id"], result["model_type"])
    except Exception:
        logger.exception("inference failed")
        raise HTTPException(status_code=500, detail="inference failed")

    image_path_for_db = os.path.relpath(abs_path, BASE_DIR)

    try:
        reading = insert_reading(
            meter_id=str(result.get("meter_id", "default")),
            value=result.get("value", 0.0),
            confidence=float(result.get("confidence", 0.0)),
            image_path=image_path_for_db,
            model_type=str(result.get("model_type", normalized_model_type)),
        )
        logger.info("reading saved to db: id=%s meter_id=%s", reading["id"], reading["meter_id"])
    except Exception:
        logger.exception("failed to save reading to db")
        raise HTTPException(status_code=500, detail="db save failed")

    alert_sent = False
    try:
        alert_sent = _maybe_send_threshold_alert(reading)
    except Exception:
        logger.exception("alert evaluation failed")

    return {
        "ok": True,
        "reading": reading,
        "alert_sent": alert_sent,
    }


@app.post("/api/v1/test-mode/capture")
async def save_test_mode_capture(
    image: Optional[UploadFile] = File(None),
    save_dir: str = Form(""),
    save_dir_abs: str = Form(""),
):
    if image is None:
        raise HTTPException(status_code=400, detail="image is required")

    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="empty image")

    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="invalid content type")

    decoded = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise HTTPException(status_code=400, detail="invalid image data")

    target_dir = _resolve_test_mode_save_dir(save_dir, save_dir_abs)
    os.makedirs(target_dir, exist_ok=True)
    filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}.png"
    abs_path = os.path.join(target_dir, filename)
    if os.path.exists(abs_path):
        raise HTTPException(status_code=409, detail="same timestamp file already exists, please retry")

    try:
        ok = cv2.imwrite(abs_path, decoded)
        if not ok:
            raise RuntimeError("cv2.imwrite failed")
        logger.info("test mode image saved: %s", abs_path)
    except Exception:
        logger.exception("failed to save test mode image")
        raise HTTPException(status_code=500, detail="failed to save test mode image")

    rel_path = os.path.relpath(abs_path, BASE_DIR)
    if rel_path.startswith(".."):
        rel_path = abs_path

    return {
        "ok": True,
        "filename": filename,
        "path": rel_path,
        "abs_path": abs_path,
    }


@app.get("/api/v1/readings/latest")
def api_get_latest_readings():
    try:
        rows = get_latest_readings()
    except Exception:
        logger.exception("failed to fetch latest readings")
        raise HTTPException(status_code=500, detail="failed to fetch latest readings")
    return rows


@app.get("/api/v1/readings")
def api_get_readings(
    meter_id: str = Query(...),
    from_ts: Optional[str] = Query(None, alias="from"),
    to_ts: Optional[str] = Query(None, alias="to"),
):
    meter_id = (meter_id or "").strip()
    if not meter_id:
        raise HTTPException(status_code=400, detail="meter_id is required")
    try:
        rows = get_readings(meter_id=meter_id, from_ts=from_ts, to_ts=to_ts)
    except Exception:
        logger.exception("failed to fetch readings")
        raise HTTPException(status_code=500, detail="failed to fetch readings")
    return rows


@app.get("/api/v1/meters")
def api_get_meters():
    try:
        rows = get_meters()
    except Exception:
        logger.exception("failed to fetch meters")
        raise HTTPException(status_code=500, detail="failed to fetch meters")
    return rows


@app.put("/api/v1/meters/{meter_id}")
def api_upsert_meter(meter_id: str, payload: MeterUpsertRequest):
    target_meter_id = (meter_id or "").strip()
    if not target_meter_id:
        raise HTTPException(status_code=400, detail="meter_id is required")
    try:
        row = upsert_meter(
            meter_id=target_meter_id,
            threshold_high=payload.threshold_high,
            threshold_low=payload.threshold_low,
            enabled=payload.enabled,
            fetch_interval_sec=payload.fetch_interval_sec,
            anomaly_confirm_count=payload.anomaly_confirm_count,
            notify_cooldown_minutes=payload.notify_cooldown_minutes,
            status_delay_seconds=payload.status_delay_seconds,
            status_down_seconds=payload.status_down_seconds,
        )
    except Exception:
        logger.exception("failed to upsert meter")
        raise HTTPException(status_code=500, detail="failed to upsert meter")
    return row


@app.get("/api/v1/stream/cameras")
def api_get_stream_cameras():
    try:
        return {"cameras": get_stream_camera_names()}
    except Exception:
        logger.exception("failed to fetch stream cameras")
        raise HTTPException(status_code=500, detail="failed to fetch stream cameras")


@app.get("/api/v1/stream/dates")
def api_get_stream_dates(camera_name: str = Query(...)):
    name = (camera_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="camera_name is required")
    try:
        return {"dates": get_stream_dates(name)}
    except Exception:
        logger.exception("failed to fetch stream dates")
        raise HTTPException(status_code=500, detail="failed to fetch stream dates")


@app.get("/api/v1/stream/readings")
def api_get_stream_readings(
    camera_name: str = Query(...),
    date: str = Query(...),
    region_id: Optional[str] = Query(None),
):
    name = (camera_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="camera_name is required")
    target_region = (region_id or "").strip() or None
    try:
        rows = get_stream_readings(name, date, target_region)
    except Exception:
        logger.exception("failed to fetch stream readings")
        raise HTTPException(status_code=500, detail="failed to fetch stream readings")
    return rows


@app.get("/models")
def list_models():
    models = []
    if os.path.isdir(MODEL_DIR):
        for name in os.listdir(MODEL_DIR):
            if name.endswith(".pt"):
                models.append(name)
    models.sort()
    return {"models": models}


@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    await websocket.accept()
    cap = None
    regions = []
    model_name = MODEL_FILENAME
    preprocess_config = None
    detection_settings = _default_detection_settings()
    preview_preprocess = False
    show_inference_overlay = True
    camera_name = "default"
    region_log_state = {}
    should_stop = False
    stop_reason = ""
    previous_frame_time = None
    fps_ema = 0.0
    camera_raw_fps = 0.0
    frame_seq = 0
    latest_detections = []
    latest_results_payload = []

    async def send_status(state: str, message: str = ""):
        payload = {"type": "status", "state": state}
        if message:
            payload["message"] = message
        await websocket.send_text(json.dumps(payload))

    async def open_capture_with_retry(source: str, retries: int = 3, delay_sec: float = 0.4):
        for attempt in range(retries):
            local_cap = None
            if source.startswith("device:"):
                try:
                    device_index = int(source.split(":", 1)[1])
                except ValueError:
                    return None, "Invalid device index."
                local_cap = cv2.VideoCapture(device_index)
            else:
                local_cap = cv2.VideoCapture(source)
            if local_cap is not None and local_cap.isOpened():
                try:
                    local_cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                except Exception:
                    pass
                return local_cap, ""
            if local_cap is not None:
                local_cap.release()
            if attempt < retries - 1:
                await asyncio.sleep(delay_sec)
        return None, "Unable to open stream."

    try:
        # 最初のメッセージを「ストリーム URL」または「デバイス指定」として受信
        raw_message = await websocket.receive_text()
        stream_url = raw_message
        try:
            payload = json.loads(raw_message)
            if isinstance(payload, dict) and payload.get("type") == "start":
                stream_url = payload.get("source", "")
                regions = payload.get("regions", []) or []
                camera_name = str(payload.get("cameraName") or stream_url or "default")
                if payload.get("model"):
                    resolved = resolve_model_name(payload.get("model"))
                    if resolved:
                        model_name = resolved
                if "preprocess" in payload:
                    preprocess_config = _parse_preprocess_ws_payload(payload.get("preprocess"))
                if "detectionSettings" in payload:
                    detection_settings = _parse_detection_settings_ws_payload(
                        payload.get("detectionSettings"),
                        fallback=detection_settings,
                    )
                preview_preprocess = bool(payload.get("previewPreprocess", False))
                show_inference_overlay = bool(payload.get("showInferenceOverlay", True))
        except json.JSONDecodeError:
            pass

        await send_status("starting")

        cap, open_error = await open_capture_with_retry(stream_url, retries=3, delay_sec=0.4)
        if cap is None and open_error == "Invalid device index.":
            await send_status("error", open_error)
            await websocket.send_text(f"ERROR: {open_error}")
            await websocket.close()
            return

        model_path = os.path.join(MODEL_DIR, model_name)
        if not os.path.exists(model_path):
            await send_status("error", "Model not found.")
            await websocket.send_text("ERROR: Model not found.")
            await websocket.close()
            return
        if cap is None or not cap.isOpened():
            message = open_error or "Unable to open stream."
            await send_status("error", message)
            await websocket.send_text(f"ERROR: {message}")
            await websocket.close()
            return
        try:
            camera_raw_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        except Exception:
            camera_raw_fps = 0.0
        read_failures = 0
        if camera_raw_fps < 1 or camera_raw_fps > 240:
            camera_raw_fps = 0.0

        await send_status("streaming")

        # フレームを読み続けて送信
        target_frame_interval = 1.0 / max(STREAM_TARGET_FPS, 1.0)
        while not should_stop:
            loop_started_at = time.time()
            success, frame = cap.read()
            if not success:
                read_failures += 1
                if read_failures >= STREAM_READ_RETRY_LIMIT:
                    stop_reason = "frame read failed"
                    break
                await asyncio.sleep(0.01)
                continue
            read_failures = 0

            frame_now = time.time()
            if previous_frame_time is not None:
                delta = frame_now - previous_frame_time
                if delta > 0:
                    instant_fps = 1.0 / delta
                    if fps_ema <= 0:
                        fps_ema = instant_fps
                    else:
                        fps_ema = fps_ema * 0.88 + instant_fps * 0.12
            previous_frame_time = frame_now

            # 領域更新の受信（あれば反映）
            try:
                update_message = await asyncio.wait_for(websocket.receive_text(), timeout=0.001)
                try:
                    update_payload = json.loads(update_message)
                    if isinstance(update_payload, dict):
                        update_type = update_payload.get("type")
                        if update_type == "regions":
                            regions = update_payload.get("regions", []) or []
                        elif update_type == "model":
                            resolved = resolve_model_name(update_payload.get("model"))
                            if resolved:
                                model_name = resolved
                        elif update_type == "preprocess":
                            try:
                                preprocess_config = _parse_preprocess_ws_payload(update_payload.get("preprocess"))
                                preview_preprocess = bool(update_payload.get("previewPreprocess", preview_preprocess))
                                show_inference_overlay = bool(update_payload.get("showInferenceOverlay", show_inference_overlay))
                                if "detectionSettings" in update_payload:
                                    detection_settings = _parse_detection_settings_ws_payload(
                                        update_payload.get("detectionSettings"),
                                        fallback=detection_settings,
                                    )
                            except HTTPException as preprocess_error:
                                await send_status("error", str(preprocess_error.detail))
                        elif update_type == "detection_settings":
                            try:
                                detection_settings = _parse_detection_settings_ws_payload(
                                    update_payload.get("detectionSettings"),
                                    fallback=detection_settings,
                                )
                            except HTTPException as detection_error:
                                await send_status("error", str(detection_error.detail))
                        elif update_type == "stop":
                            should_stop = True
                            stop_reason = "stop requested"
                            await send_status("stopping")
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                pass

            # 物体検出（推論入力は preprocess 適用可）
            frame_seq += 1
            confidence_threshold = float(detection_settings.get("confidence_threshold", DEFAULT_DETECTION_CONFIDENCE_THRESHOLD))
            nms_iou_threshold = float(detection_settings.get("nms_iou_threshold", DEFAULT_NMS_IOU_THRESHOLD))
            result_interval_frames = int(detection_settings.get("result_interval_frames", DEFAULT_RESULT_INTERVAL_FRAMES))
            merge_same_digits = bool(detection_settings.get("merge_same_digits", DEFAULT_MERGE_SAME_DIGITS))
            merge_row_tolerance = float(detection_settings.get("merge_row_tolerance", DEFAULT_MERGE_ROW_TOLERANCE))
            merge_x_gap_ratio = float(detection_settings.get("merge_x_gap_ratio", DEFAULT_MERGE_X_GAP_RATIO))
            should_run_inference = (frame_seq % max(result_interval_frames, 1) == 0) or not latest_detections

            frame_for_infer = frame.copy()
            if preprocess_config:
                try:
                    frame_for_infer = apply_preprocess(frame_for_infer, preprocess_config)
                except Exception as preprocess_error:
                    await send_status("error", f"preprocess failed: {preprocess_error}")
                    frame_for_infer = frame.copy()

            if should_run_inference:
                infer_display_frame, detections = detect_objects(
                    frame_for_infer,
                    model_name,
                    draw_overlay=show_inference_overlay,
                    draw_model_label=show_inference_overlay,
                    conf_threshold=confidence_threshold,
                    nms_iou_threshold=nms_iou_threshold,
                )
                latest_detections = detections
            else:
                detections = latest_detections
                infer_display_frame = frame_for_infer

            if preview_preprocess:
                display_frame = infer_display_frame.copy()
                if show_inference_overlay and not should_run_inference:
                    _draw_detections_overlay(display_frame, detections, model_name)
            else:
                display_frame = frame.copy()
                if show_inference_overlay:
                    _draw_detections_overlay(display_frame, detections, model_name)
            _draw_stream_metrics_overlay(
                display_frame,
                model_name,
                fps_ema,
                camera_raw_fps,
                preview_preprocess,
            )

            results_payload = latest_results_payload
            if should_run_inference:
                # 領域ごとの検出結果（左から結合）
                height, width = display_frame.shape[:2]
                results_payload = []
                for region in regions:
                    try:
                        raw_x = float(region.get("x", 0))
                        raw_y = float(region.get("y", 0))
                        raw_w = float(region.get("w", 0))
                        raw_h = float(region.get("h", 0))
                    except (TypeError, ValueError):
                        continue
                    if raw_x <= 100.0 and raw_y <= 100.0 and raw_w <= 100.0 and raw_h <= 100.0:
                        x = max(min(raw_x, 100.0), 0.0)
                        y = max(min(raw_y, 100.0), 0.0)
                        w = max(min(raw_w, 100.0), 0.0)
                        h = max(min(raw_h, 100.0), 0.0)
                        rx1 = int((x / 100.0) * width)
                        ry1 = int((y / 100.0) * height)
                        rx2 = int(((x + w) / 100.0) * width)
                        ry2 = int(((y + h) / 100.0) * height)
                    else:
                        x = max(min(raw_x, float(width)), 0.0)
                        y = max(min(raw_y, float(height)), 0.0)
                        w = max(min(raw_w, float(width)), 0.0)
                        h = max(min(raw_h, float(height)), 0.0)
                        rx1 = int(x)
                        ry1 = int(y)
                        rx2 = int(min(x + w, float(width)))
                        ry2 = int(min(y + h, float(height)))
                    region_detections = []
                    for det in detections:
                        cx = (det["x1"] + det["x2"]) / 2
                        cy = (det["y1"] + det["y2"]) / 2
                        if rx1 <= cx <= rx2 and ry1 <= cy <= ry2:
                            region_detections.append(det)
                    value, debug_info = build_meter_value(
                        region_detections,
                        min_confidence=confidence_threshold,
                        merge_same_digits=merge_same_digits,
                        row_tolerance_ratio=merge_row_tolerance,
                        x_gap_ratio=merge_x_gap_ratio,
                    )
                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug(
                            "region postprocess id=%s raw=%s dedup=%s",
                            region.get("id"),
                            debug_info.get("raw_labels"),
                            debug_info.get("dedup_labels"),
                        )
                    results_payload.append({
                        "id": region.get("id"),
                        "name": region.get("name"),
                        "value": value,
                    })

                    region_id = str(region.get("id") or "")
                    region_name = str(region.get("name") or "")
                    if region_id and value:
                        now_ts = time.time()
                        last_state = region_log_state.get(region_id)
                        should_log = False
                        if not last_state:
                            should_log = True
                        else:
                            value_changed = last_state.get("value") != value
                            elapsed = now_ts - float(last_state.get("ts", 0.0))
                            should_log = value_changed or elapsed >= 1.0
                        if should_log:
                            try:
                                insert_stream_reading(
                                    camera_name=camera_name,
                                    region_id=region_id,
                                    region_name=region_name,
                                    value_text=value,
                                )
                                region_log_state[region_id] = {"value": value, "ts": now_ts}
                            except Exception:
                                logger.exception("failed to save stream reading")
                latest_results_payload = results_payload

            # JPEG エンコード → Base64
            _, buffer = cv2.imencode('.jpg', display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            jpg_b64 = base64.b64encode(buffer).decode('utf-8')

            await websocket.send_text(json.dumps({
                "image": jpg_b64,
                "results": results_payload,
            }))
            elapsed = time.time() - loop_started_at
            wait = target_frame_interval - elapsed
            if wait > 0:
                await asyncio.sleep(wait)

        if cap:
            cap.release()
            cap = None
        await send_status("stopped", stop_reason or "stream ended")
        await websocket.close()
    except WebSocketDisconnect:
        if cap:
            cap.release()
        print("Client disconnected")
    except Exception as error:
        if cap:
            cap.release()
        try:
            await send_status("error", str(error))
        except Exception:
            pass
        raise
