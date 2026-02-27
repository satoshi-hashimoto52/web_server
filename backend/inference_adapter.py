import os
from typing import Dict, Optional

import cv2

from detector import MODEL_FILENAME, detect_objects


def _to_numeric(value_text: str) -> float:
    cleaned = value_text.replace(" ", "")
    if not cleaned:
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def infer(
    image_path: str,
    meter_id: str = "default",
    model_type: str = "dummy",
    model_name: Optional[str] = None,
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

    _, detections = detect_objects(frame, model_name or MODEL_FILENAME)
    detections = sorted(detections, key=lambda det: det.get("x1", 0))

    labels = [str(det.get("label", "")) for det in detections]
    value_text = "".join(labels)
    value = _to_numeric(value_text)
    confidence = max([float(det.get("conf", 0.0)) for det in detections], default=0.0)

    return {
        "meter_id": active_meter_id,
        "value": value,
        "confidence": max(0.0, min(confidence, 1.0)),
        "model_type": "yolo",
        "raw_result": {
            "value_text": value_text,
            "detection_count": len(detections),
        },
    }
