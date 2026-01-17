# Webカメラストリーミング物体検出アプリ

## 目的
- HTTP/RTSPカメラの映像をバックエンドでYOLOv8推論し、検出結果付きのフレームをフロントへリアルタイム配信する。
- WebSocketで低遅延表示し、ブラウザ上で物体検出結果を確認できるようにする。

## 構成
- **バックエンド**: FastAPI + OpenCV + YOLOv8
  - WebSocketエンドポイント: `/ws/stream`
  - クライアントからストリームURLを受信し、フレームを推論
  - 推論結果をBase64 JPEGで送信
- **フロントエンド**: React + Vite + WebSocket
  - WebSocketで受信したBase64 JPEGを`<img>`表示

## 起動方法

### バックエンド
```bash
cd /Users/hashimoto/vscode/test/web_server/backend
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 5050
```

### フロントエンド
```bash
cd /Users/hashimoto/vscode/test/web_server/frontend
npm run dev
```

- フロントURL: `http://localhost:5173`
- WebSocket: `ws://localhost:5050/ws/stream`

## 使い方
1. フロント画面で「HTTP または RTSP ストリームURL」を入力
2. `Start Stream` をクリック
3. バックエンドが物体検出を実行
4. 検出結果がリアルタイム表示される

## 制約・注意点
- YOLOv8モデル（`.pt`）は `backend/models/` に配置が必要。
- 依存パッケージは `backend/requirements.txt` と `frontend/package.json` を参照。
- M1 Macでは `torch.mps` によるGPU推論が使える場合がある。
- フレームレートは実測で約20FPS（環境に依存）。30FPS以上は追加最適化が必要。

## Codexへの依頼時に伝えると良い情報
- 目的（例: UI改善、推論高速化、接続安定化）
- 対象範囲（`backend` / `frontend` / 両方）
- 現在の問題点・期待動作
- 実行環境（OS、Python/Nodeのバージョン、GPU有無）
- 再現手順・エラーログ（該当する場合）
