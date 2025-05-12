
# *********************************************************
# # backend/detector.py
# *********************************************************

import cv2
from ultralytics import YOLO
import os
import torch

# モデルを一度だけロード
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "models")
MODEL_FILENAME = "7sgm_20250221.pt"
model_path = os.path.join(MODEL_DIR, MODEL_FILENAME)

if not os.path.exists(model_path):
    raise FileNotFoundError(f"モデルファイルが見つかりません: {model_path}")

# YOLOv8 モデルのロード
model = YOLO(model_path)

# 使用可能なデバイスを自動選択（MPS > CPU）
if torch.backends.mps.is_available():
    device = 'mps'
else:
    device = 'cpu'
model.to(device)


def detect_objects(frame):
    """
    フレームに対して YOLOv8 で物体検出を行い、
    バウンディングボックスとラベルを描画して返します。
    """
    # 推論
    results = model(frame, device=device)[0]  # device を明示
    boxes = results.boxes

    for box in boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        label = f"{model.names[cls_id]} {conf:.2f}"
        # バウンディングボックス
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        # ラベル
        cv2.putText(frame, label, (x1, y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    return frame
