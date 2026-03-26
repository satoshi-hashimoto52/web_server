# web_server

デジタルメータ監視の PoC です。  
FastAPI バックエンドで推論・保存を行い、React フロントエンドでライブ表示とダッシュボードを提供します。

<img src="docs/images/推論時_20260120.png" width="600">

## 構成
- backend: FastAPI + OpenCV + YOLOv8 + SQLite
- frontend: React + Vite

## 現在の機能（コード準拠）
- Stream 画面
- 左サイドバーのカメラ設定プロファイル管理（作成・削除・切替・折りたたみ）
- WebSocket ストリーミング表示（ROI 編集、結果表示、FPS/Zoom 表示）
- 設定ダイアログ（`YOLO` / `Image` / `Test` タブ）
- テストモード画像保存（`yyyymmddhhmmss.png`）
- Dashboard 画面（カメラ別/領域別の履歴と状態表示、メータ設定更新）
- 左サイドバー最下段の「アプリ終了」ボタン

## 保存先
- DB: `backend/data/app.db`
- 画像API保存先: `backend/data/images/YYYYMMDD/<uuid>.<ext>`
- テストモード保存先（デフォルト）: `backend/data/inbo/`
- モデル配置: `backend/models/*.pt`

## 前提
- Python 仮想環境: `backend/venv`
- Node/npm: `frontend/package.json` が実行できる環境
- macOS（`/api/v1/test-mode/select-save-dir` は `osascript` を使用）

## 起動手順
### 1) Backend
```bash
cd /Users/hashimoto/vscode/test/web_server/backend
source venv/bin/activate
uvicorn main:app --reload --host 127.0.0.1 --port 5050
```

### 2) Frontend
```bash
cd /Users/hashimoto/vscode/test/web_server/frontend
npm run dev
```

### 3) ブラウザ
- `http://localhost:5173`

## 停止手順
- フロントから停止する場合は、Stream 画面左サイドバー最下段の「アプリ終了」を押下
- 手動停止する場合は各ターミナルで `Ctrl + C`

## 環境変数
- `SLACK_WEBHOOK_URL`
  Slack 通知先。未設定時は通知送信をスキップ
- `FRONTEND_DEV_PORTS`
  `/api/v1/app/shutdown` が停止対象の frontend dev server を探索するポート一覧  
  デフォルト: `5173,4173`
- `VITE_API_BASE_URL`
  フロントエンドの API 接続先
  未指定時の既定値は Stream 側コードが `http://127.0.0.1:5050`、Dashboard 側 API ヘルパーが `http://localhost:5050`

## Stream 画面の設定項目（要約）
- YOLO タブ
- 検出確信度 `confidenceThreshold`（既定 0.25, 範囲 0.01-0.99）
- 検出頻度 `resultIntervalFrames`（既定 1）
- 同一文字マージ `mergeSameDigits`（既定 true）
- 行方向許容 `mergeSameDigitsRowTolerance`（既定 0.5）
- 横方向近接 `mergeSameDigitsXGapRatio`（既定 0.35）
- Image タブ
- 明るさ/コントラスト/ガンマ/シャープネス
- 白飛び抑制・白飛び復元（`natural` / `line`）
- 2値化、CLAHE、フォーカス（zoom/centerX/centerY）
- Test タブ
- 現在表示フレームを PNG 保存
- `save_dir`（`backend/data/inbo` 配下の相対指定）
- `save_dir_abs`（絶対パス指定）
- 「ローカル参照...」でフォルダ選択

## 設定の永続化（localStorage）
- カメラプロファイル: `stream.camera.profiles.v1`
- アクティブプロファイル: `stream.camera.active_profile_id.v1`
- 最後に使用したカメラ設定: `stream.camera.last_used_settings.v1`
- 左サイドバー折りたたみ状態: `stream.camera.sidebar.collapsed.v1`
- テストモード保存先（相対）: `stream.test.capture.save_dir.v1`
- テストモード保存先（絶対）: `stream.test.capture.save_dir_abs.v1`

## HTTP API（`backend/main.py`）
- `POST /api/v1/images`
- `POST /api/v1/test-mode/capture`
- `POST /api/v1/test-mode/select-save-dir`
- `POST /api/v1/app/shutdown`
- `GET /api/v1/readings/latest`
- `GET /api/v1/readings`
- `GET /api/v1/meters`
- `PUT /api/v1/meters/{meter_id}`
- `GET /api/v1/stream/cameras`
- `GET /api/v1/stream/dates`
- `GET /api/v1/stream/readings`
- `GET /models`

## WebSocket API
- エンドポイント: `ws://<host>:5050/ws/stream`
- クライアント送信タイプ
- `start`（source, regions, cameraName, model, preprocess, detectionSettings, previewPreprocess, showInferenceOverlay）
- `regions`
- `model`
- `preprocess`
- `detection_settings`
- `stop`
- サーバー送信
- `{"type":"status","state":"starting|streaming|stopping|stopped|error","message":...}`
- `{"image":"<base64-jpeg>","results":[...]}`
- 失敗時は `ERROR: ...` テキストを送る場合あり

## 画像送信スクリプト
- ファイル: `backend/tools/edge_sender.py`
- 概要: Web カメラ映像を定期的に `POST /api/v1/images` へ送信

実行例:
```bash
cd /Users/hashimoto/vscode/test/web_server/backend/tools
python edge_sender.py --api http://127.0.0.1:5050 --meter-id default --model-type yolo --interval 5
```

主な引数:
- `--api`（既定 `http://127.0.0.1:5050`）
- `--meter-id`（既定 `default`）
- `--model-type`（`dummy` or `yolo`、既定 `dummy`）
- `--interval`（秒、既定 `5.0`）
- `--camera-index`（既定 `0`）
- `--timeout`（秒、既定 `10.0`）

## 動作メモ
- `model_type=dummy` は `value=0.0`, `confidence=1.0` を返却
- Slack 通知は閾値超過時のみ評価され、再通知抑制は既定 5 分
- `/api/v1/app/shutdown` は backend と frontend dev server 停止を試行
- フロント側は終了時に `window.close()` を試行し、失敗時は `about:blank` へ遷移

## ドキュメント
- API仕様: `docs/api.md`
- 仕様: `docs/spec.md`
- アーキテクチャ: `docs/architecture.md`
- AI運用メモ: `docs/ai.md`
