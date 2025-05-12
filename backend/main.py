# *********************************************************
# backend/main.py
# *********************************************************
# BS(RasPizero2W+PiCam) -> http://192.168.101.***:5000/video_feed (***を確認)

import cv2
import base64
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from .detector import detect_objects  # detector.py から取り込み

app = FastAPI()

# CORS 設定（React 開発サーバーからの接続を許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    await websocket.accept()
    cap = None
    try:
        # 最初のメッセージを「ストリーム URL」として受信
        stream_url = await websocket.receive_text()
        cap = cv2.VideoCapture(stream_url)
        if not cap.isOpened():
            await websocket.send_text("ERROR: Unable to open stream.")
            await websocket.close()
            return

        # フレームを読み続けて送信
        while True:
            success, frame = cap.read()
            if not success:
                break

            # 物体検出 + 描画
            frame = detect_objects(frame)

            # JPEG エンコード → Base64
            _, buffer = cv2.imencode('.jpg', frame)
            jpg_b64 = base64.b64encode(buffer).decode('utf-8')

            await websocket.send_text(jpg_b64)
            await asyncio.sleep(0.03)  # ~30fps

        cap.release()
        await websocket.close()
    except WebSocketDisconnect:
        if cap:
            cap.release()
        print("Client disconnected")
