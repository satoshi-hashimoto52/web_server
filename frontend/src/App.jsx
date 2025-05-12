// *********************************************************
// frontend/src/main.jsx
// *********************************************************

import React, { useState, useRef, useEffect } from 'react';
import './styles.css';

function App() {
  const [streamUrl, setStreamUrl] = useState('');
  const [imageData, setImageData] = useState('');
  const ws = useRef(null);

  const startStream = (e) => {
    e.preventDefault();
    // 既存接続をクリーンに閉じる
    if (ws.current) ws.current.close();

    // 新規 WebSocket 接続
    ws.current = new WebSocket('ws://localhost:5050/ws/stream');

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      ws.current.send(streamUrl);
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

  return (
    <div className="container">
      <h2>Live Stream Viewer</h2>
      <form onSubmit={startStream}>
        <input
          type="text"
          value={streamUrl}
          placeholder="Enter HTTP or RTSP URL"
          onChange={(e) => setStreamUrl(e.target.value)}
          required
        />
        <button type="submit">Start Stream</button>
      </form>
      {/* imageData がセットされたら表示 */}
      {imageData && (
        <img
          src={imageData}
          alt="Live Stream"
          className="stream"
        />
      )}
    </div>
  );
}

export default App;
