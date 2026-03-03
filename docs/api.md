# API仕様

## Base URL
- `http://localhost:5050`

## REST API

### POST /api/v1/images
画像受信 -> 保存 -> 推論 -> DB保存 -> 閾値判定/Slack通知を実行。

- Content-Type: `multipart/form-data`
- Form fields:
  - `image` (required): 画像ファイル
  - `meter_id` (optional, default=`default`)
  - `model_type` (optional, `dummy` or `yolo`, default=`dummy`)
  - `model_name` (optional, YOLOモデル名)
  - `preprocess` (optional): 前処理設定JSON文字列。`model_type=yolo` のときのみ推論前処理に適用

#### preprocess JSON 例
```json
{
  "brightness": 1.0,
  "contrast": 1.0,
  "gamma": 1.0,
  "sharpness": 1.0,
  "highlightSuppression": 0.0,
  "clahe": {
    "enabled": false,
    "clipLimit": 2,
    "tileGridSize": 8
  },
  "focus": {
    "zoom": 1.0,
    "centerX": 0.5,
    "centerY": 0.5
  }
}
```

#### preprocess 値域
- `brightness`: 0.0〜3.0
- `contrast`: 0.0〜3.0
- `gamma`: 0.05〜4.0
- `sharpness`: 0.0〜3.0
- `highlightSuppression`: 0.0〜1.0
- `clahe.clipLimit`: 1〜12
- `clahe.tileGridSize`: 4〜24
- `focus.zoom`: 1.0〜6.0
- `focus.centerX`, `focus.centerY`: 0.0〜1.0

#### Response (200)
```json
{
  "ok": true,
  "reading": {
    "id": 10,
    "meter_id": "default",
    "ts": "2026-02-27T11:07:58.488871+00:00",
    "value": 0.0,
    "confidence": 1.0,
    "image_path": "data/images/20260227/xxxx.png",
    "model_type": "dummy"
  },
  "alert_sent": false
}
```

#### Error
- `400`: `image` 不足/空ファイル/不正content-type/不正`model_type`/不正`preprocess`
- `500`: 画像保存失敗、推論失敗、DB保存失敗

#### curl 例（preprocess未指定）
```bash
curl -X POST "http://localhost:5050/api/v1/images" \
  -F "image=@/path/to/input.jpg" \
  -F "meter_id=default" \
  -F "model_type=yolo"
```

#### curl 例（preprocess指定）
```bash
curl -X POST "http://localhost:5050/api/v1/images" \
  -F "image=@/path/to/input.jpg" \
  -F "meter_id=default" \
  -F "model_type=yolo" \
  -F 'preprocess={"brightness":1.1,"contrast":1.2,"gamma":0.9,"sharpness":1.3,"highlightSuppression":0.6,"clahe":{"enabled":true,"clipLimit":2,"tileGridSize":8},"focus":{"zoom":2.0,"centerX":0.5,"centerY":0.5}}'
```

### GET /api/v1/readings/latest
`meter_id` ごとの最新1件を返す。

#### Response (200)
```json
[
  {
    "id": 9,
    "meter_id": "default",
    "ts": "2026-02-27T11:07:58.488871+00:00",
    "value": 0.0,
    "confidence": 1.0,
    "image_path": "data/images/20260227/xxxx.png",
    "model_type": "dummy"
  }
]
```

### GET /api/v1/readings?meter_id=...&from=...&to=...
指定meterの履歴を `ts` 昇順で返す（グラフ用）。

- Query:
  - `meter_id` (required)
  - `from` (optional, ISO8601)
  - `to` (optional, ISO8601)
- `from/to` 未指定時は直近24時間。

#### Response (200)
```json
[
  {
    "id": 1,
    "meter_id": "default",
    "ts": "2026-02-27T10:40:23.851490+00:00",
    "value": 0.0,
    "confidence": 1.0,
    "image_path": "data/images/20260227/xxxx.png",
    "model_type": "dummy"
  }
]
```

### GET /api/v1/meters
全メータ設定を返す。

#### Response (200)
```json
[
  {
    "meter_id": "default",
    "name": "default",
    "location": "",
    "threshold_high": 9999.0,
    "threshold_low": 0.1,
    "enabled": 1
  }
]
```

### PUT /api/v1/meters/{meter_id}
閾値/有効フラグを更新。存在しない `meter_id` は作成（upsert）。

- Body (JSON):
  - `threshold_high` (optional, number or null)
  - `threshold_low` (optional, number or null)
  - `enabled` (optional, boolean)

#### Request example
```json
{
  "threshold_high": 9999,
  "threshold_low": 0.1,
  "enabled": true
}
```

#### Response (200)
```json
{
  "meter_id": "default",
  "name": "default",
  "location": "",
  "threshold_high": 9999.0,
  "threshold_low": 0.1,
  "enabled": 1
}
```

## 既存API（ストリーム）

### GET /models
`backend/models` 配下の `.pt` 一覧を返す。

### WebSocket /ws/stream
既存ストリーム表示用。クライアントが開始メッセージと領域を送信し、サーバがBase64 JPEGと推論結果を返す。

#### Client -> Server (開始)
```json
{
  "type": "start",
  "source": "http://... または rtsp://... または device:0",
  "model": "model_name.pt",
  "regions": [
    {
      "id": "uuid",
      "name": "領域名",
      "x": 10,
      "y": 10,
      "w": 35,
      "h": 22
    }
  ]
}
```

#### Client -> Server (領域更新)
```json
{
  "type": "regions",
  "regions": [
    {
      "id": "uuid",
      "name": "領域名",
      "x": 10,
      "y": 10,
      "w": 35,
      "h": 22
    }
  ]
}
```

`x/y/w/h` は百分率（0-100）。

#### Server -> Client
```json
{
  "image": "<base64 JPEG>",
  "results": [
    {
      "id": "uuid",
      "value": "01"
    }
  ]
}
```
