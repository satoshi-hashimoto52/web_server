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
    init_db,
    insert_reading,
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
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "").strip()
ALERT_SUPPRESS_MINUTES = 5


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

    model_label = f"Model: {model_name}"
    text_org = (12, 34)
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.9
    cv2.putText(frame, model_label, text_org, font, font_scale, (0, 0, 0), 5, cv2.LINE_AA)
    cv2.putText(frame, model_label, text_org, font, font_scale, (0, 255, 0), 2, cv2.LINE_AA)


class MeterUpsertRequest(BaseModel):
    threshold_high: Optional[float] = None
    threshold_low: Optional[float] = None
    enabled: Optional[bool] = None


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


def _should_send_alert_by_time(meter_id: str) -> bool:
    last_ts = get_last_alert_ts(meter_id)
    if not last_ts:
        return True
    last_dt = _parse_iso_datetime(last_ts)
    if not last_dt:
        return True
    return datetime.now(timezone.utc) - last_dt >= timedelta(minutes=ALERT_SUPPRESS_MINUTES)


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
    over_high = threshold_high is not None and value_float > float(threshold_high)
    under_low = threshold_low is not None and value_float < float(threshold_low)
    if not over_high and not under_low:
        return False

    if not _should_send_alert_by_time(meter_id):
        logger.info("suppress alert meter_id=%s within %s minutes", meter_id, ALERT_SUPPRESS_MINUTES)
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

    try:
        result = infer(
            image_path=abs_path,
            meter_id=(meter_id or "default").strip() or "default",
            model_type=normalized_model_type,
            model_name=model_name.strip() or None,
            preprocess=preprocess_config if normalized_model_type == "yolo" else None,
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
        )
    except Exception:
        logger.exception("failed to upsert meter")
        raise HTTPException(status_code=500, detail="failed to upsert meter")
    return row


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
    preview_preprocess = False
    should_stop = False
    stop_reason = ""

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
                if payload.get("model"):
                    resolved = resolve_model_name(payload.get("model"))
                    if resolved:
                        model_name = resolved
                if "preprocess" in payload:
                    preprocess_config = _parse_preprocess_ws_payload(payload.get("preprocess"))
                preview_preprocess = bool(payload.get("previewPreprocess", False))
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

        await send_status("streaming")

        # フレームを読み続けて送信
        while not should_stop:
            success, frame = cap.read()
            if not success:
                break

            # 領域更新の受信（あれば反映）
            try:
                update_message = await asyncio.wait_for(websocket.receive_text(), timeout=0.001)
                try:
                    update_payload = json.loads(update_message)
                    if isinstance(update_payload, dict):
                        update_type = update_payload.get("type")
                        if update_type == "regions":
                            regions = update_payload.get("regions", []) or []
                            await send_status("streaming", "regions updated")
                        elif update_type == "model":
                            resolved = resolve_model_name(update_payload.get("model"))
                            if resolved:
                                model_name = resolved
                                await send_status("streaming", "model updated")
                        elif update_type == "preprocess":
                            try:
                                preprocess_config = _parse_preprocess_ws_payload(update_payload.get("preprocess"))
                                preview_preprocess = bool(update_payload.get("previewPreprocess", preview_preprocess))
                                await send_status("streaming", "preprocess updated")
                            except HTTPException as preprocess_error:
                                await send_status("error", str(preprocess_error.detail))
                        elif update_type == "stop":
                            should_stop = True
                            stop_reason = "stop requested"
                            await send_status("stopping")
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                pass

            # 物体検出（推論入力は preprocess 適用可）
            frame_for_infer = frame
            if preprocess_config:
                try:
                    frame_for_infer = apply_preprocess(frame.copy(), preprocess_config)
                except Exception as preprocess_error:
                    await send_status("error", f"preprocess failed: {preprocess_error}")
                    frame_for_infer = frame
            infer_display_frame, detections = detect_objects(frame_for_infer, model_name)
            if preview_preprocess:
                display_frame = infer_display_frame
            else:
                display_frame = frame
                _draw_detections_overlay(display_frame, detections, model_name)

            # 領域ごとの検出結果（左から結合）
            height, width = display_frame.shape[:2]
            results_payload = []
            for region in regions:
                try:
                    x = max(min(float(region.get("x", 0)), 100.0), 0.0)
                    y = max(min(float(region.get("y", 0)), 100.0), 0.0)
                    w = max(min(float(region.get("w", 0)), 100.0), 0.0)
                    h = max(min(float(region.get("h", 0)), 100.0), 0.0)
                except (TypeError, ValueError):
                    continue
                rx1 = int((x / 100.0) * width)
                ry1 = int((y / 100.0) * height)
                rx2 = int(((x + w) / 100.0) * width)
                ry2 = int(((y + h) / 100.0) * height)
                region_detections = []
                for det in detections:
                    cx = (det["x1"] + det["x2"]) / 2
                    cy = (det["y1"] + det["y2"]) / 2
                    if rx1 <= cx <= rx2 and ry1 <= cy <= ry2:
                        region_detections.append(det)
                value, debug_info = build_meter_value(region_detections)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug(
                        "region postprocess id=%s raw=%s dedup=%s",
                        region.get("id"),
                        debug_info.get("raw_labels"),
                        debug_info.get("dedup_labels"),
                    )
                results_payload.append({
                    "id": region.get("id"),
                    "value": value,
                })

            # JPEG エンコード → Base64
            _, buffer = cv2.imencode('.jpg', display_frame)
            jpg_b64 = base64.b64encode(buffer).decode('utf-8')

            await websocket.send_text(json.dumps({
                "image": jpg_b64,
                "results": results_payload,
            }))
            await asyncio.sleep(0.03)  # ~30fps

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
