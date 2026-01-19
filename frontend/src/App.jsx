// *********************************************************
// frontend/src/main.jsx
// *********************************************************

import React, { useState, useRef, useEffect } from 'react';
import './styles.css';

function App() {
  const [sourceType, setSourceType] = useState('url');
  const [streamUrl, setStreamUrl] = useState('');
  const [deviceIndex, setDeviceIndex] = useState('0');
  const [imageData, setImageData] = useState('');
  const ws = useRef(null);

  const startStream = (e) => {
    e.preventDefault();
    // 既存接続をクリーンに閉じる
    if (ws.current) ws.current.close();

    const target =
      sourceType === 'device' ? `device:${deviceIndex}` : streamUrl.trim();
    if (!target) {
      alert('Please enter a valid stream URL.');
      return;
    }

    // 新規 WebSocket 接続
    ws.current = new WebSocket('ws://localhost:5050/ws/stream');

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      ws.current.send(target);
    };

    ws.current.onmessage = (event) => {
      const msg = event.data;
      if (msg.startsWith('ERROR')) {
        alert(msg);
        return;
      }
      // Base64 JPEG を受け取って表示
      setImageData(`data:image/jpeg;base64,${msg}`);
    };

    ws.current.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
    };
  };

  useEffect(() => {
    // アンマウント時にクリーンアップ
    return () => ws.current && ws.current.close();
  }, []);

  const stopStream = () => {
    if (ws.current) ws.current.close();
    setImageData('');
  };

  return (
    <div className="container">
      <header className="hero">
        <p className="eyebrow">Realtime Vision</p>
        <h2>Live Stream Viewer</h2>
        <p className="subhead">
          カメラまたはストリームURLに接続して、YOLOv8の検出結果をリアルタイムで確認できます。
        </p>
      </header>
      <form className="panel" onSubmit={startStream}>
        <div className="controls">
          <label className="field">
            <span>入力ソース</span>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
            >
              <option value="url">HTTP/RTSP URL</option>
              <option value="device">Macbook カメラ</option>
            </select>
          </label>
          {sourceType === 'url' ? (
            <label className="field field-wide">
              <span>ストリームURL</span>
              <input
                type="text"
                value={streamUrl}
                placeholder="http:// または rtsp://"
                onChange={(e) => setStreamUrl(e.target.value)}
                required
              />
            </label>
          ) : (
            <label className="field field-wide">
              <span>デバイス</span>
              <select
                value={deviceIndex}
                onChange={(e) => setDeviceIndex(e.target.value)}
              >
                <option value="0">デバイス0（内蔵）</option>
                <option value="1">デバイス1</option>
              </select>
            </label>
          )}
          <button className="primary" type="submit">ストリーム開始</button>
        </div>
      </form>
      {/* imageData がセットされたら表示 */}
      {imageData && (
        <div className="preview">
          <img
            src={imageData}
            alt="Live Stream"
            className="stream"
          />
          <button className="secondary" type="button" onClick={stopStream}>
            スタート画面へ戻る
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
