# *********************************************************
# backend/main.py
# *********************************************************
# BS(RasPizero2W+PiCam) -> http://192.168.101.***:5000/video_feed (***を確認)

import cv2
import base64
import asyncio
import json
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from detector import detect_objects, MODEL_DIR, MODEL_FILENAME  # detector.py から取り込み

app = FastAPI()

# CORS 設定（React 開発サーバーからの接続を許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        except json.JSONDecodeError:
            pass

        if stream_url.startswith("device:"):
            try:
                device_index = int(stream_url.split(":", 1)[1])
            except ValueError:
                await websocket.send_text("ERROR: Invalid device index.")
                await websocket.close()
                return
            cap = cv2.VideoCapture(device_index)
        else:
            cap = cv2.VideoCapture(stream_url)

        model_path = os.path.join(MODEL_DIR, model_name)
        if not os.path.exists(model_path):
            await websocket.send_text("ERROR: Model not found.")
            await websocket.close()
            return
        if not cap.isOpened():
            await websocket.send_text("ERROR: Unable to open stream.")
            await websocket.close()
            return

        # フレームを読み続けて送信
        while True:
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
                        elif update_type == "model":
                            resolved = resolve_model_name(update_payload.get("model"))
                            if resolved:
                                model_name = resolved
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                pass

            # 物体検出 + 描画
            frame, detections = detect_objects(frame, model_name)

            # 領域ごとの検出結果（左から結合）
            height, width = frame.shape[:2]
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
                hits = []
                for det in detections:
                    cx = (det["x1"] + det["x2"]) / 2
                    cy = (det["y1"] + det["y2"]) / 2
                    if rx1 <= cx <= rx2 and ry1 <= cy <= ry2:
                        hits.append((det["x1"], det.get("label", "")))
                hits.sort(key=lambda item: item[0])
                value = "".join([label for _, label in hits])
                results_payload.append({
                    "id": region.get("id"),
                    "value": value,
                })

            # JPEG エンコード → Base64
            _, buffer = cv2.imencode('.jpg', frame)
            jpg_b64 = base64.b64encode(buffer).decode('utf-8')

            await websocket.send_text(json.dumps({
                "image": jpg_b64,
                "results": results_payload,
            }))
            await asyncio.sleep(0.03)  # ~30fps

        cap.release()
        await websocket.close()
    except WebSocketDisconnect:
        if cap:
            cap.release()
        print("Client disconnected")
