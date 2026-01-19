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
  const [regions, setRegions] = useState([]);
  const [regionValues, setRegionValues] = useState({});
  const [activeAction, setActiveAction] = useState(null);
  const ws = useRef(null);
  const streamRef = useRef(null);

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
      ws.current.send(JSON.stringify({
        type: 'start',
        source: target,
        regions,
      }));
    };

    ws.current.onmessage = (event) => {
      const msg = event.data;
      if (msg.startsWith('ERROR')) {
        alert(msg);
        return;
      }
      try {
        const payload = JSON.parse(msg);
        if (payload.image) {
          setImageData(`data:image/jpeg;base64,${payload.image}`);
        }
        if (Array.isArray(payload.results)) {
          const nextValues = {};
          payload.results.forEach((item) => {
            if (item && item.id) {
              nextValues[item.id] = typeof item.value === 'string' ? item.value : '';
            }
          });
          setRegionValues(nextValues);
        } else if (Array.isArray(payload.counts)) {
          const nextValues = {};
          payload.counts.forEach((item) => {
            if (item && item.id) {
              nextValues[item.id] = typeof item.count === 'number' ? String(item.count) : '0';
            }
          });
          setRegionValues(nextValues);
        }
        return;
      } catch (error) {
        // non-JSON payload fallback
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
    setRegionValues({});
  };

  const addRegion = () => {
    const name = window.prompt('領域名を入力してください');
    if (!name) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (regions.some((region) => region.name === trimmedName)) {
      alert('同じ名前の領域は作成できません。');
      return;
    }
    const newRegion = {
      id: crypto.randomUUID(),
      name: trimmedName,
      x: 10,
      y: 10,
      w: 35,
      h: 22,
    };
    setRegions((prev) => [...prev, newRegion]);
  };

  const removeRegion = (id) => {
    setRegions((prev) => prev.filter((region) => region.id !== id));
    setRegionValues((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  useEffect(() => {
    if (!activeAction) return;

    const handleMove = (event) => {
      if (!streamRef.current) return;
      const rect = streamRef.current.getBoundingClientRect();
      const dx = ((event.clientX - rect.left) / rect.width) * 100 - activeAction.startX;
      const dy = ((event.clientY - rect.top) / rect.height) * 100 - activeAction.startY;

      setRegions((prev) =>
        prev.map((region) => {
          if (region.id !== activeAction.id) return region;
          if (activeAction.type === 'move') {
            const x = Math.min(Math.max(activeAction.originX + dx, 0), 100 - region.w);
            const y = Math.min(Math.max(activeAction.originY + dy, 0), 100 - region.h);
            return { ...region, x, y };
          }
          const w = Math.min(Math.max(activeAction.originW + dx, 6), 100 - region.x);
          const h = Math.min(Math.max(activeAction.originH + dy, 6), 100 - region.y);
          return { ...region, w, h };
        })
      );
    };

    const handleUp = () => {
      setActiveAction(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [activeAction]);

  useEffect(() => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({
      type: 'regions',
      regions,
    }));
  }, [regions]);

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
          <div className="stream-column">
            <div className="stream-header">
              <h3>エリア_カメラ</h3>
              <div className="stream-actions">
                <button className="ghost" type="button" onClick={addRegion}>
                  領域作成 +
                </button>
                <button className="secondary" type="button" onClick={stopStream}>
                  スタート画面へ戻る
                </button>
              </div>
            </div>
            <div className="stream-frame" ref={streamRef}>
              <img
                src={imageData}
                alt="Live Stream"
                className="stream"
              />
              <div className="region-layer">
                {regions.map((region) => (
                  <div
                    key={region.id}
                    className="region-box"
                    style={{
                      left: `${region.x}%`,
                      top: `${region.y}%`,
                      width: `${region.w}%`,
                      height: `${region.h}%`,
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setActiveAction({
                        id: region.id,
                        type: 'move',
                        startX: ((event.clientX - streamRef.current.getBoundingClientRect().left) / streamRef.current.getBoundingClientRect().width) * 100,
                        startY: ((event.clientY - streamRef.current.getBoundingClientRect().top) / streamRef.current.getBoundingClientRect().height) * 100,
                        originX: region.x,
                        originY: region.y,
                      });
                    }}
                  >
                    <span className="region-label">{region.name}</span>
                    <span
                      className="region-handle"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        setActiveAction({
                          id: region.id,
                          type: 'resize',
                          startX: ((event.clientX - streamRef.current.getBoundingClientRect().left) / streamRef.current.getBoundingClientRect().width) * 100,
                          startY: ((event.clientY - streamRef.current.getBoundingClientRect().top) / streamRef.current.getBoundingClientRect().height) * 100,
                          originW: region.w,
                          originH: region.h,
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <aside className="results">
            <h4>検出結果</h4>
            {regions.length === 0 ? (
              <p className="muted">領域を作成すると結果が表示されます。</p>
            ) : (
              <ul>
                {regions.map((region) => (
                  <li key={region.id}>
                    <span className="result-name">{region.name}</span>
                    <span className="result-count">
                      {regionValues[region.id] ?? ''}
                    </span>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => removeRegion(region.id)}
                      aria-label={`${region.name}を削除`}
                    >
                      −
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
