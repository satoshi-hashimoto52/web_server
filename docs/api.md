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
- `400`: `image` 不足/空ファイル/不正content-type/不正`model_type`
- `500`: 画像保存失敗、推論失敗、DB保存失敗

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
