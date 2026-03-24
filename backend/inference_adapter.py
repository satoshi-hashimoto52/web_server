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


def _apply_highlight_recovery(frame: np.ndarray, strength: float, curve: float = 1.0) -> np.ndarray:
    strength = max(0.0, min(float(strength), 1.0))
    if strength <= 0.0:
        return frame
    curve = max(0.5, min(float(curve), 3.0))
    effective_strength = 1.0 - ((1.0 - strength) ** curve)

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    v_channel = hsv[:, :, 2].astype(np.float32)
    s_channel = hsv[:, :, 1].astype(np.float32)
    bright_mask = ((v_channel >= 210.0) & (s_channel <= 140.0)).astype(np.uint8) * 255
    if not np.any(bright_mask):
        return frame

    kernel = np.ones((3, 3), np.uint8)
    expanded_mask = cv2.dilate(bright_mask, kernel, iterations=1)
    soft_mask = cv2.GaussianBlur(expanded_mask, (0, 0), 1.2)
    alpha = (soft_mask.astype(np.float32) / 255.0) * (0.2 + 0.8 * effective_strength)
    alpha = np.clip(alpha, 0.0, 1.0)

    ycc = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
    y_channel = ycc[:, :, 0]
    inpainted_y = cv2.inpaint(y_channel, expanded_mask, 3.0, cv2.INPAINT_TELEA)
    smoothed_y = cv2.bilateralFilter(inpainted_y, d=5, sigmaColor=30, sigmaSpace=5)

    y_f = y_channel.astype(np.float32)
    s_f = smoothed_y.astype(np.float32)
    out_y = y_f * (1.0 - alpha) + s_f * alpha
    ycc[:, :, 0] = np.clip(out_y, 0, 255).astype(np.uint8)
    return cv2.cvtColor(ycc, cv2.COLOR_YCrCb2BGR)


def _apply_line_highlight_recovery(
    frame: np.ndarray,
    strength: float,
    curve: float = 1.0,
    max_dist: int = 5,
    kernel_width: int = 9,
) -> np.ndarray:
    strength = max(0.0, min(float(strength), 1.0))
    if strength <= 0.0:
        return frame
    curve = max(0.5, min(float(curve), 3.0))
    effective_strength = 1.0 - ((1.0 - strength) ** curve)

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    v_channel = hsv[:, :, 2].astype(np.float32)
    s_channel = hsv[:, :, 1].astype(np.float32)
    base_mask = ((v_channel >= 210.0) & (s_channel <= 140.0)).astype(np.uint8) * 255
    if not np.any(base_mask):
        return frame

    # 上下探索距離:
    # 白飛び線が太いと上下の有効画素に届かないためUIから調整可能にしている
    max_dist = int(max(3, min(max_dist, 20)))
    # 横連結距離:
    # 線状白飛びが途切れず1本として検出されるよう、横方向カーネル幅をUIから調整可能にしている
    kernel_width = int(max(3, min(kernel_width, 25)))
    if kernel_width % 2 == 0:
        kernel_width += 1

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_width, 1))
    line_mask = cv2.morphologyEx(base_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    line_mask = cv2.dilate(line_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3)), iterations=1)
    if not np.any(line_mask):
        return frame

    soft_mask = cv2.GaussianBlur(line_mask, (0, 0), 0.8)
    alpha = (soft_mask.astype(np.float32) / 255.0) * effective_strength
    alpha = np.clip(alpha, 0.0, 1.0)

    ycc = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
    y_channel = ycc[:, :, 0].astype(np.float32)
    recovered_y = y_channel.copy()
    mask = line_mask > 0
    height, width = mask.shape
    diff_threshold = 10.0

    for y in range(height):
        row_mask = mask[y]
        if not row_mask.any():
            continue
        xs = np.flatnonzero(row_mask)
        for x in xs:
            up_val = None
            down_val = None
            for d in range(1, max_dist + 1):
                y_up = y - d
                if y_up >= 0 and not mask[y_up, x]:
                    up_val = y_channel[y_up, x]
                    break
            for d in range(1, max_dist + 1):
                y_down = y + d
                if y_down < height and not mask[y_down, x]:
                    down_val = y_channel[y_down, x]
                    break
            if up_val is None and down_val is None:
                continue
            if up_val is None:
                target = down_val
            elif down_val is None:
                target = up_val
            else:
                if abs(up_val - down_val) <= diff_threshold:
                    target = (up_val + down_val) * 0.5
                else:
                    target = min(up_val, down_val)
            recovered_y[y, x] = target

    out_y = y_channel * (1.0 - alpha) + recovered_y * alpha
    ycc[:, :, 0] = np.clip(out_y, 0, 255).astype(np.uint8)
    return cv2.cvtColor(ycc, cv2.COLOR_YCrCb2BGR)


def _apply_binarization(frame: np.ndarray, config: Dict[str, object]) -> np.ndarray:
    if not bool(config.get("enabled", False)):
        return frame
    threshold = int(config.get("threshold", 128))
    threshold = max(0, min(threshold, 255))
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def apply_preprocess(frame: np.ndarray, preprocess: Optional[Dict[str, object]]) -> np.ndarray:
    if not preprocess:
        return frame

    focus = preprocess.get("focus", {})
    clahe = preprocess.get("clahe", {})
    binarization = preprocess.get("binarization", {})
    brightness = float(preprocess.get("brightness", 1.0))
    contrast = float(preprocess.get("contrast", 1.0))
    gamma = float(preprocess.get("gamma", 1.0))
    sharpness = float(preprocess.get("sharpness", 1.0))
    highlight_suppression = float(preprocess.get("highlightSuppression", 0.0))
    highlight_recovery = float(preprocess.get("highlightRecovery", 0.0))
    highlight_recovery_curve = float(preprocess.get("highlightRecoveryCurve", 1.0))
    highlight_recovery_mode = preprocess.get("highlightRecoveryMode", "natural")
    highlight_line_max_dist = int(preprocess.get("highlightLineMaxDist", 5))
    highlight_line_kernel_width = int(preprocess.get("highlightLineKernelWidth", 9))

    output = _apply_focus(frame, focus)
    output = _apply_highlight_suppression(output, highlight_suppression)
    if highlight_recovery_mode == "line":
        output = _apply_line_highlight_recovery(
            output,
            highlight_recovery,
            highlight_recovery_curve,
            highlight_line_max_dist,
            highlight_line_kernel_width,
        )
    else:
        output = _apply_highlight_recovery(output, highlight_recovery, highlight_recovery_curve)
    output = _apply_binarization(output, binarization if isinstance(binarization, dict) else {})
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
    detection_settings: Optional[Dict[str, object]] = None,
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

    detection = detection_settings or {}
    confidence_threshold = max(0.0, min(float(detection.get("confidence_threshold", 0.25)), 1.0))
    merge_same_digits = bool(detection.get("merge_same_digits", True))
    merge_row_tolerance = float(detection.get("merge_row_tolerance", 0.5))
    merge_x_gap_ratio = float(detection.get("merge_x_gap_ratio", 0.35))

    _, detections = detect_objects(
        frame,
        model_name or MODEL_FILENAME,
        conf_threshold=confidence_threshold,
    )
    value_text, debug_info = build_meter_value(
        detections,
        min_confidence=confidence_threshold,
        merge_same_digits=merge_same_digits,
        row_tolerance_ratio=merge_row_tolerance,
        x_gap_ratio=merge_x_gap_ratio,
    )
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
            "confidence_threshold": confidence_threshold,
            "merge_same_digits": merge_same_digits,
        },
    }
