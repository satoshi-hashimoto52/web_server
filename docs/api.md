# API仕様

## WebSocket
- エンドポイント: `/ws/stream`
- プロトコル: WebSocket

### クライアント → サーバ
#### 開始
```json
{
  "type": "start",
  "source": "http://..." | "rtsp://..." | "device:0",
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

#### 領域更新
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

※ `x/y/w/h` はストリーム枠に対する百分率（0-100）で送信される。

### サーバ → クライアント
#### 推論結果
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

## エラー
- 開始時にストリームが開けない場合は `ERROR: ...` 文字列を送信。

## モデル一覧
### GET /models
```json
{
  "models": [
    "model_a.pt",
    "model_b.pt"
  ]
}
```
