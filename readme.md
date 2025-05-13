# Webカメラストリーミング物体検出アプリ 概要

## 構成概要

本アプリケーションは、以下の2つのコンポーネントから構成される:

* **バックエンド（FastAPI + OpenCV + YOLOv8）**
* **フロントエンド（React + WebSocket + Vite）**

HTTP/RTSPカメラの映像をバックエンドでYOLOv8を用いて処理し、物体検出結果付きの画像をWebSocket経由でReactアプリにリアルタイム送信する。

---

## ディレクトリ構成

```
web_server/
├── backend/             # FastAPI ベースの物体検出サーバー
│   ├── models/          # 学習済みYOLOv8モデルを格納
│   ├── detector.py      # YOLOによる推論処理
│   ├── main.py          # WebSocket サーバー処理
│   ├── requirements.txt # Python依存パッケージ
│   └── venv/            # 仮想環境（.gitignore対象）
├── frontend/            # Reactアプリケーション
│   ├── public/          # 静的アセット
│   ├── src/             # Reactソースコード
│   │   └── main.jsx     # メインアプリケーション
│   ├── package.json     # フロント依存定義
│   └── vite.config.js   # Vite設定
└── readme.md            # 全体のREADME（任意）
```

---

## バックエンドの仕様（`backend/`）
- `FastAPI` によるWebSocketエンドポイント `/ws/stream`
- クライアントからカメラストリームURLを受信
- OpenCVでフレーム読み込み
- YOLOv8モデル（例: `7sgm_20250221.pt`）による物体検出
- 検出結果付きのフレームをBase64エンコードし送信
- デバイス: `torch.mps` が使える場合は M1 MacのGPUを使用

### 必須パッケージ
- `ultralytics`
- `opencv-python`
- `fastapi`
- `uvicorn`
- `torch`

### 起動方法
サーバー起動（ポート 5050 で起動）
```bash
cd backend
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 5050
```

---

## フロントエンドの仕様（`frontend/`）

* 入力フォームでカメラストリームURLを指定
* WebSocket (`ws://localhost:5050/ws/stream`) に接続
* Base64 JPEGデータを受信して `<img>` タグに表示

### 必須パッケージ

* `react`
* `vite`
* `eslint`（任意）

### 起動方法

```bash
cd web_server/frontend
npm run dev
```

起動後、`http://localhost:5173` にアクセス

---

## 使用方法

1. フロント画面で「HTTP または RTSP ストリームURL」を入力
2. `Start Stream` をクリック
3. バックエンドがストリームを処理して物体検出を実行
4. 結果がフロントにリアルタイム表示される

---

## 備考

- YOLOv8 モデルは `backend/models/` に `.pt` ファイルとして配置
- フレームレートは実測で約 20FPS（M1 Mac + MPS利用時）
- 30FPS を目標とする場合は更なる最適化が必要（例: モデル軽量化、非同期推論）

---