import os
import logging
from typing import Dict, Optional

import cv2
import numpy as np

from detector import MODEL_FILENAME, detect_objects
from postprocess import build_meter_value

logger = logging.getLogger("meter_api")


def _to_numeric(value_text: str) -> float:
    cleaned = value_text.replace(" ", "")
    if not cleaned:
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def _apply_focus(frame: np.ndarray, focus: Dict[str, float]) -> np.ndarray:
    zoom = float(focus.get("zoom", 1.0))
    center_x = float(focus.get("centerX", 0.5))
    center_y = float(focus.get("centerY", 0.5))
    if zoom <= 1.0:
        return frame

    height, width = frame.shape[:2]
    crop_w = int(round(width / zoom))
    crop_h = int(round(height / zoom))
    crop_w = max(1, min(crop_w, width))
    crop_h = max(1, min(crop_h, height))

    cx = center_x * width
    cy = center_y * height
    x1 = int(round(cx - crop_w / 2))
    y1 = int(round(cy - crop_h / 2))
    x1 = max(0, min(x1, width - crop_w))
    y1 = max(0, min(y1, height - crop_h))
    x2 = x1 + crop_w
    y2 = y1 + crop_h

    cropped = frame[y1:y2, x1:x2]
    if cropped.size == 0:
        return frame
    return cv2.resize(cropped, (width, height), interpolation=cv2.INTER_LINEAR)


def _apply_clahe(frame: np.ndarray, clahe_config: Dict[str, object]) -> np.ndarray:
    if not bool(clahe_config.get("enabled", False)):
        return frame
    clip_limit = float(clahe_config.get("clipLimit", 2.0))
    tile_size = int(clahe_config.get("tileGridSize", 8))
    tile = max(1, tile_size)

    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(tile, tile))
    l_channel = clahe.apply(l_channel)
    merged = cv2.merge((l_channel, a_channel, b_channel))
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def _apply_brightness_contrast(frame: np.ndarray, brightness: float, contrast: float) -> np.ndarray:
    output = frame.astype(np.float32)
    output = (output - 128.0) * contrast + 128.0
    output = output * brightness
    return np.clip(output, 0, 255).astype(np.uint8)


def _apply_gamma(frame: np.ndarray, gamma: float) -> np.ndarray:
    if abs(gamma - 1.0) < 1e-6:
        return frame
    inv_gamma = 1.0 / max(gamma, 0.05)
    table = np.array([((i / 255.0) ** inv_gamma) * 255 for i in range(256)], dtype=np.uint8)
    return cv2.LUT(frame, table)


def _apply_sharpness(frame: np.ndarray, sharpness: float) -> np.ndarray:
    amount = max(0.0, sharpness - 1.0)
    if amount <= 0.0:
        return frame
    kernel = np.array(
        [[0.0, -amount, 0.0], [-amount, 1.0 + 4.0 * amount, -amount], [0.0, -amount, 0.0]],
        dtype=np.float32,
    )
    return cv2.filter2D(frame, -1, kernel)


def _apply_highlight_suppression(frame: np.ndarray, strength: float) -> np.ndarray:
    strength = max(0.0, min(float(strength), 1.0))
    if strength <= 0.0:
        return frame

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV).astype(np.float32)
    h_channel, s_channel, v_channel = cv2.split(hsv)
    value_threshold = 190.0
    sat_threshold = 70.0
    highlight_mask = (v_channel >= value_threshold) & (s_channel <= sat_threshold)
    if not np.any(highlight_mask):
        return frame

    over = np.clip((v_channel - value_threshold) / (255.0 - value_threshold), 0.0, 1.0)
    reduced_v = v_channel * (1.0 - over * strength * 0.65)
    v_channel = np.where(highlight_mask, reduced_v, v_channel)

    merged = cv2.merge((h_channel, s_channel, np.clip(v_channel, 0, 255)))
    return cv2.cvtColor(merged.astype(np.uint8), cv2.COLOR_HSV2BGR)


def apply_preprocess(frame: np.ndarray, preprocess: Optional[Dict[str, object]]) -> np.ndarray:
    if not preprocess:
        return frame

    focus = preprocess.get("focus", {})
    clahe = preprocess.get("clahe", {})
    brightness = float(preprocess.get("brightness", 1.0))
    contrast = float(preprocess.get("contrast", 1.0))
    gamma = float(preprocess.get("gamma", 1.0))
    sharpness = float(preprocess.get("sharpness", 1.0))
    highlight_suppression = float(preprocess.get("highlightSuppression", 0.0))

    output = _apply_focus(frame, focus)
    output = _apply_highlight_suppression(output, highlight_suppression)
    output = _apply_clahe(output, clahe)
    output = _apply_brightness_contrast(output, brightness, contrast)
    output = _apply_gamma(output, gamma)
    output = _apply_sharpness(output, sharpness)
    return output


def infer(
    image_path: str,
    meter_id: str = "default",
    model_type: str = "dummy",
    model_name: Optional[str] = None,
    preprocess: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    active_meter_id = meter_id or "default"

    if model_type == "dummy":
        return {
            "meter_id": active_meter_id,
            "value": 0.0,
            "confidence": 1.0,
            "model_type": "dummy",
        }

    if model_type != "yolo":
        raise ValueError(f"Unsupported model_type: {model_type}")

    if not os.path.exists(image_path):
        raise FileNotFoundError(f"image not found: {image_path}")

    frame = cv2.imread(image_path)
    if frame is None:
        raise ValueError("failed to decode image")

    if preprocess:
        frame = apply_preprocess(frame, preprocess)
        focus = preprocess.get("focus", {}) if isinstance(preprocess, dict) else {}
        logger.info(
            "preprocess applied: zoom=%.2f center=(%.2f,%.2f) shape=%s",
            float(focus.get("zoom", 1.0)),
            float(focus.get("centerX", 0.5)),
            float(focus.get("centerY", 0.5)),
            frame.shape,
        )

    _, detections = detect_objects(frame, model_name or MODEL_FILENAME)
    value_text, debug_info = build_meter_value(detections)
    value = _to_numeric(value_text)
    kept_labels = debug_info.get("dedup_labels", [])
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug("meter postprocess(raw=%s -> dedup=%s)", debug_info.get("raw_labels"), kept_labels)

    confidence = max([float(det.get("conf", 0.0)) for det in detections], default=0.0)

    return {
        "meter_id": active_meter_id,
        "value": value,
        "confidence": max(0.0, min(confidence, 1.0)),
        "model_type": "yolo",
        "raw_result": {
            "value_text": value_text,
            "detection_count": len(detections),
            "dedup_detection_count": int(debug_info.get("dedup_count", 0)),
        },
    }
