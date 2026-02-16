
# *********************************************************
# # backend/detector.py
# *********************************************************

import cv2
from ultralytics import YOLO
import os
import torch
from glob import glob

# モデルを一度だけロード
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "models")
MODEL_FILENAME = "7sgm_yolov8_20250221.pt"


def _resolve_default_model_filename():
    """
    既定モデルが見つからない場合は models 配下の .pt から自動選択する。
    7sgm* を優先し、なければ最終更新時刻が新しい .pt を使う。
    """
    default_path = os.path.join(MODEL_DIR, MODEL_FILENAME)
    if os.path.exists(default_path):
        return MODEL_FILENAME

    preferred = sorted(glob(os.path.join(MODEL_DIR, "7sgm*.pt")))
    if preferred:
        return os.path.basename(preferred[-1])

    candidates = glob(os.path.join(MODEL_DIR, "*.pt"))
    if candidates:
        latest = max(candidates, key=os.path.getmtime)
        return os.path.basename(latest)

    return MODEL_FILENAME


MODEL_FILENAME = _resolve_default_model_filename()
model_path = os.path.join(MODEL_DIR, MODEL_FILENAME)

if not os.path.exists(model_path):
    raise FileNotFoundError(f"モデルファイルが見つかりません: {model_path}")

# 使用可能なデバイスを自動選択（MPS > CPU）
if torch.backends.mps.is_available():
    device = 'mps'
else:
    device = 'cpu'

_model_cache = {}

def _iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h
    if inter_area == 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter_area
    if union == 0:
        return 0.0
    return inter_area / union


def _nms(detections, iou_threshold=0.75):
    """
    IoUが高いもの同士は確信度の高い方のみ残す。
    """
    if not detections:
        return []
    detections = sorted(detections, key=lambda d: d["conf"], reverse=True)
    kept = []
    for det in detections:
        box = (det["x1"], det["y1"], det["x2"], det["y2"])
        overlap = False
        for kept_det in kept:
            kept_box = (kept_det["x1"], kept_det["y1"], kept_det["x2"], kept_det["y2"])
            if _iou(box, kept_box) >= iou_threshold:
                overlap = True
                break
        if not overlap:
            kept.append(det)
    return kept


def get_model(model_name=None):
    """
    モデル名を指定して取得（キャッシュあり）。
    未指定の場合はデフォルトモデルを返す。
    """
    filename = model_name or MODEL_FILENAME
    model_path = os.path.join(MODEL_DIR, filename)
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"モデルファイルが見つかりません: {model_path}")
    if filename not in _model_cache:
        model = YOLO(model_path)
        model.to(device)
        _model_cache[filename] = model
    return _model_cache[filename]


def detect_objects(frame, model_name=None):
    """
    フレームに対して YOLOv8 で物体検出を行い、
    バウンディングボックスとラベルを描画して返します。
    """
    model = get_model(model_name)
    # 推論
    results = model(frame, device=device)[0]  # device を明示
    boxes = results.boxes
    detections = []

    for box in boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        label = f"{model.names[cls_id]} {conf:.2f}"
        detections.append({
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "cls_id": cls_id,
            "conf": conf,
            "label": str(model.names[cls_id]),
        })
        # バウンディングボックス
    # 重なりが大きい検出は確信度の高い方のみ残す
    detections = _nms(detections, iou_threshold=0.75)

    for det in detections:
        x1, y1, x2, y2 = det["x1"], det["y1"], det["x2"], det["y2"]
        label = f"{model.names[det['cls_id']]} {det['conf']:.2f}"
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(frame, label, (x1, y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    return frame, detections
