from __future__ import annotations

from typing import Dict, List, Tuple


def _to_float(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def build_meter_value(
    detections: List[Dict[str, object]],
    min_confidence: float = 0.25,
) -> Tuple[str, Dict[str, object]]:
    """
    重複しやすい同一桁検出を cx/cy の近接で抑制し、左→右で値文字列を生成する。
    """
    normalized: List[Dict[str, object]] = []
    for det in detections or []:
        label = str(det.get("label", ""))
        if not label.isdigit() or len(label) != 1:
            continue
        conf = _to_float(det.get("conf"), 0.0)
        if conf < min_confidence:
            continue
        x1 = _to_float(det.get("x1"))
        y1 = _to_float(det.get("y1"))
        x2 = _to_float(det.get("x2"))
        y2 = _to_float(det.get("y2"))
        w = max(0.0, x2 - x1)
        h = max(0.0, y2 - y1)
        if w <= 0.0 or h <= 0.0:
            continue
        normalized.append(
            {
                "label": label,
                "conf": conf,
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "cx": (x1 + x2) / 2.0,
                "cy": (y1 + y2) / 2.0,
                "w": w,
                "h": h,
            }
        )

    normalized.sort(key=lambda item: item["cx"])
    accepted: List[Dict[str, object]] = []
    for cur in normalized:
        if not accepted:
            accepted.append(cur)
            continue

        prev = accepted[-1]
        same_label = cur["label"] == prev["label"]
        same_row = abs(cur["cy"] - prev["cy"]) <= 0.5 * min(prev["h"], cur["h"])
        near = abs(cur["cx"] - prev["cx"]) <= 0.35 * min(prev["w"], cur["w"])
        if same_label and same_row and near:
            if cur["conf"] > prev["conf"]:
                accepted[-1] = cur
            continue
        accepted.append(cur)

    value = "".join(str(item["label"]) for item in accepted)
    debug_info = {
        "raw_labels": [str(item["label"]) for item in normalized],
        "dedup_labels": [str(item["label"]) for item in accepted],
        "raw_count": len(normalized),
        "dedup_count": len(accepted),
    }
    return value, debug_info

