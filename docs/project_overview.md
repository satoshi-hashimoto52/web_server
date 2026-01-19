# Webカメラストリーミング物体検出アプリ

## 目的
- HTTP/RTSPカメラやMacbookカメラの映像をバックエンドでYOLOv8推論し、検出結果付きのフレームをフロントへリアルタイム配信する。
- WebSocketで低遅延表示し、ブラウザ上で物体検出結果と領域ごとの推論値を確認できるようにする。

## 構成
- **バックエンド**: FastAPI + OpenCV + YOLOv8
  - WebSocketエンドポイント: `/ws/stream`
  - クライアントからストリームURL/デバイス指定と推論領域を受信し、フレームを推論
  - 推論結果をBase64 JPEG + 領域ごとの推論値で送信
- **フロントエンド**: React + Vite + WebSocket
  - WebSocketで受信したBase64 JPEGを`<img>`表示
  - 推論領域の作成/移動/リサイズ、領域ごとの推論結果表示

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
1. フロント画面で入力ソース（HTTP/RTSP URL または Macbookカメラ）を選択
2. `ストリーム開始` をクリック
3. 映像が表示されたら `領域作成 +` で推論領域を追加
4. 赤枠をドラッグで移動、右下のハンドルでサイズ調整
5. 右側のリストに領域ごとの推論結果が表示される（削除は `−`）

## 推論領域と結果の仕様
- 推論領域は画面上の赤枠矩形として表示される。
- 領域内の検出結果は、検出ボックスの左端座標が小さい順に並べて文字列化する。
  - 例: `"0","1"` → `01`

## 制約・注意点
- YOLOv8モデル（`.pt`）は `backend/models/` に配置が必要。
- 依存パッケージは `backend/requirements.txt` と `frontend/package.json` を参照。
- M1 Macでは `torch.mps` によるGPU推論が使える場合がある。
- フレームレートは実測で約20FPS（環境に依存）。30FPS以上は追加最適化が必要。
- 推論領域名は重複不可。

## WebSocketメッセージ仕様（概要）
### クライアント → サーバ
- 開始: `{"type":"start","source":"<url or device:0>","regions":[...]}`
- 領域更新: `{"type":"regions","regions":[...]}`

### サーバ → クライアント
- 推論結果: `{"image":"<base64>","results":[{"id":"...","value":"01"}]}`

## Codexへの依頼時に伝えると良い情報
- 目的（例: UI改善、推論高速化、接続安定化）
- 対象範囲（`backend` / `frontend` / 両方）
- 現在の問題点・期待動作
- 実行環境（OS、Python/Nodeのバージョン、GPU有無）
- 再現手順・エラーログ（該当する場合）
