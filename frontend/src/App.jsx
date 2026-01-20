// *********************************************************
// frontend/src/main.jsx
// *********************************************************

import React, { useState, useRef, useEffect } from 'react';
import './styles.css';

function App() {
  const [sourceType, setSourceType] = useState('url');
  const [streamUrl, setStreamUrl] = useState('');
  const [deviceIndex, setDeviceIndex] = useState('0');
  const [modelOptions, setModelOptions] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [imageData, setImageData] = useState('');
  const [regions, setRegions] = useState([]);
  const [regionValues, setRegionValues] = useState({});
  const [activeAction, setActiveAction] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [dragOverId, setDragOverId] = useState(null);
  const ws = useRef(null);
  const streamRef = useRef(null);
  const dragRef = useRef(null);
  const sendTimerRef = useRef(null);
  const storageKey = 'web_server_regions_v1';

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const isFiniteNumber = (value) => Number.isFinite(value);
  const getFrameSize = () => {
    if (!streamRef.current) return null;
    const rect = streamRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { width: rect.width, height: rect.height };
  };

  const sanitizeRegions = (list) => {
    if (!Array.isArray(list)) return [];
    return list
      .map((region) => ({
        id: typeof region.id === 'string' ? region.id : crypto.randomUUID(),
        name: typeof region.name === 'string' && region.name.trim() ? region.name.trim() : '領域',
        x: isFiniteNumber(region.x) ? region.x : 10,
        y: isFiniteNumber(region.y) ? region.y : 10,
        w: isFiniteNumber(region.w) ? region.w : 160,
        h: isFiniteNumber(region.h) ? region.h : 120,
        color: typeof region.color === 'string' ? region.color : '#ff3b3b',
      }))
      .filter((region) => region.w > 0 && region.h > 0);
  };

  const startStream = () => {
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
        model: selectedModel || undefined,
      }));
      setIsStreaming(true);
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
      setIsStreaming(false);
    };
  };

  useEffect(() => {
    // アンマウント時にクリーンアップ
    return () => ws.current && ws.current.close();
  }, []);

  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await fetch('http://localhost:5050/models');
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data.models)) {
          setModelOptions(data.models);
          if (!selectedModel && data.models.length > 0) {
            setSelectedModel(data.models[0]);
          }
        }
      } catch (error) {
        console.warn('Failed to load models', error);
      }
    };
    loadModels();
  }, [selectedModel]);

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const next = sanitizeRegions(parsed);
      if (next.length > 0) {
        setRegions(next);
      }
    } catch (error) {
      console.warn('Failed to parse stored regions', error);
    }
  }, []);

  const stopStream = () => {
    if (ws.current) ws.current.close();
    setRegionValues({});
    setIsStreaming(false);
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
    const palette = ['#ff3b3b', '#26d0ce', '#1a7fda', '#ffb703', '#c77dff', '#80ed99'];
    const usedColors = new Set(regions.map((region) => region.color));
    const available = palette.filter((color) => !usedColors.has(color));
    const colorPool = available.length > 0 ? available : palette;
    const color = colorPool[Math.floor(Math.random() * colorPool.length)];
    const frameSize = getFrameSize();
    const defaultW = frameSize ? Math.max(80, Math.round(frameSize.width * 0.25)) : 160;
    const defaultH = frameSize ? Math.max(60, Math.round(frameSize.height * 0.18)) : 120;
    const maxX = frameSize ? Math.max(frameSize.width - defaultW, 0) : 0;
    const maxY = frameSize ? Math.max(frameSize.height - defaultH, 0) : 0;
    const newRegion = {
      id: crypto.randomUUID(),
      name: trimmedName,
      x: Math.min(16, maxX),
      y: Math.min(16, maxY),
      w: defaultW,
      h: defaultH,
      color,
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

  const updateRegionName = (id, name) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (regions.some((region) => region.id !== id && region.name === trimmedName)) {
      alert('同じ名前の領域は作成できません。');
      return;
    }
    setRegions((prev) =>
      prev.map((region) =>
        region.id === id ? { ...region, name: trimmedName } : region
      )
    );
  };

  const updateRegionColor = (id, color) => {
    setRegions((prev) =>
      prev.map((region) =>
        region.id === id ? { ...region, color } : region
      )
    );
  };

  const reorderRegions = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    setRegions((prev) => {
      const fromIndex = prev.findIndex((region) => region.id === fromId);
      const toIndex = prev.findIndex((region) => region.id === toId);
      if (fromIndex === -1 || toIndex === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setDragOverId(null);
  };

  useEffect(() => {
    if (!activeAction) return;

    const handleMove = (event) => {
      if (!streamRef.current || !dragRef.current) return;
      const drag = dragRef.current;
      const rect = streamRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const rawX = event.clientX - rect.left;
      const rawY = event.clientY - rect.top;
      if (!isFiniteNumber(rawX) || !isFiniteNumber(rawY)) return;
      const pointerX = clamp(rawX, 0, rect.width);
      const pointerY = clamp(rawY, 0, rect.height);
      const dx = pointerX - drag.lastX;
      const dy = pointerY - drag.lastY;
      if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) return;
      dragRef.current.lastX = pointerX;
      dragRef.current.lastY = pointerY;

      setRegions((prev) =>
        prev.map((region) => {
          if (!dragRef.current) return region;
          if (region.id !== drag.id) return region;
          if (drag.type === 'move') {
            const x = clamp(pointerX - dragRef.current.offsetX, 0, Math.max(rect.width - region.w, 0));
            const y = clamp(pointerY - dragRef.current.offsetY, 0, Math.max(rect.height - region.h, 0));
            return { ...region, x, y };
          }
          const w = clamp(region.w + dx, 20, Math.max(rect.width - region.x, 20));
          const h = clamp(region.h + dy, 20, Math.max(rect.height - region.y, 20));
          return { ...region, w, h };
        })
      );
    };

    const handleUp = () => {
      dragRef.current = null;
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
    if (!isStreaming || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    const frameSize = getFrameSize();
    if (!frameSize) return;
    const { width, height } = frameSize;
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(() => {
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
      const sanitized = regions
        .map((region) => ({
          ...region,
          x: clamp((region.x / width) * 100, 0, 100),
          y: clamp((region.y / height) * 100, 0, 100),
          w: clamp((region.w / width) * 100, 1, 100),
          h: clamp((region.h / height) * 100, 1, 100),
        }))
        .filter((region) =>
          isFiniteNumber(region.x) &&
          isFiniteNumber(region.y) &&
          isFiniteNumber(region.w) &&
          isFiniteNumber(region.h)
        );
      ws.current.send(JSON.stringify({
        type: 'regions',
        regions: sanitized,
      }));
    }, 80);
    return () => {
      if (sendTimerRef.current) {
        clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
      }
    };
  }, [regions, isStreaming]);

  useEffect(() => {
    if (!regions.length) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(regions));
  }, [regions]);

  return (
    <div className={`container${isStreaming ? ' streaming' : ''}`}>
      <header className="hero">
        <p className="eyebrow">Realtime Vision</p>
        <h2>Live Stream Viewer</h2>
        <p className="subhead">
          カメラまたはストリームURLに接続して、YOLOv8の検出結果をリアルタイムで確認できます。
        </p>
      </header>
      <form className="panel" onSubmit={(event) => event.preventDefault()}>
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
                <option value="0">デバイス0（既定）</option>
                <option value="1">デバイス1</option>
              </select>
            </label>
          )}
          <label className="field">
            <span>モデル</span>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {modelOptions.length === 0 ? (
                <option value="">読み込み中</option>
              ) : (
                modelOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))
              )}
            </select>
          </label>
          <button
            className={`primary ${isStreaming ? 'danger' : ''}`}
            type="button"
            onClick={() => (isStreaming ? stopStream() : startStream())}
          >
            {isStreaming ? '停止' : 'ストリーム開始'}
          </button>
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
                      left: `${region.x}px`,
                      top: `${region.y}px`,
                      width: `${region.w}px`,
                      height: `${region.h}px`,
                      '--region-color': region.color || '#ff3b3b',
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      const rect = streamRef.current.getBoundingClientRect();
                      if (rect.width === 0 || rect.height === 0) return;
                      const rawX = event.clientX - rect.left;
                      const rawY = event.clientY - rect.top;
                      if (!isFiniteNumber(rawX) || !isFiniteNumber(rawY)) return;
                      const pointerX = clamp(rawX, 0, rect.width);
                      const pointerY = clamp(rawY, 0, rect.height);
                      const offsetX = clamp(pointerX - region.x, 0, region.w);
                      const offsetY = clamp(pointerY - region.y, 0, region.h);
                      dragRef.current = {
                        id: region.id,
                        type: 'move',
                        lastX: pointerX,
                        lastY: pointerY,
                        offsetX,
                        offsetY,
                      };
                      setActiveAction({ id: region.id, type: 'move' });
                    }}
                  >
                    <span
                      className={`region-label${region.y < 12 ? ' label-bottom' : ''}${region.x < 12 ? ' label-right' : ''}`}
                    >
                      {region.name}
                    </span>
                    <span
                      className="region-handle"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        const rect = streamRef.current.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return;
                        const rawX = event.clientX - rect.left;
                        const rawY = event.clientY - rect.top;
                        if (!isFiniteNumber(rawX) || !isFiniteNumber(rawY)) return;
                        const pointerX = clamp(rawX, 0, rect.width);
                        const pointerY = clamp(rawY, 0, rect.height);
                        dragRef.current = {
                          id: region.id,
                          type: 'resize',
                          lastX: pointerX,
                          lastY: pointerY,
                        };
                        setActiveAction({ id: region.id, type: 'resize' });
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
                  <li
                    key={region.id}
                    className={`result-item${dragOverId === `${region.id}:before` ? ' is-drop-before' : ''}${dragOverId === `${region.id}:after` ? ' is-drop-after' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', region.id);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const rect = event.currentTarget.getBoundingClientRect();
                      const isAfter = event.clientY > rect.top + rect.height / 2;
                      const nextId = `${region.id}:${isAfter ? 'after' : 'before'}`;
                      if (dragOverId !== nextId) {
                        setDragOverId(nextId);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const fromId = event.dataTransfer.getData('text/plain');
                      const dropTarget = dragOverId || `${region.id}:after`;
                      const [targetId, position] = dropTarget.split(':');
                      if (!targetId) {
                        reorderRegions(fromId, region.id);
                        return;
                      }
                      setRegions((prev) => {
                        const fromIndex = prev.findIndex((item) => item.id === fromId);
                        const targetIndex = prev.findIndex((item) => item.id === targetId);
                        if (fromIndex === -1 || targetIndex === -1) return prev;
                        const next = [...prev];
                        const [moved] = next.splice(fromIndex, 1);
                        const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
                        next.splice(insertIndex, 0, moved);
                        return next;
                      });
                      setDragOverId(null);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                  >
                    <div className="result-row">
                      <input
                        className="result-name-input"
                        type="text"
                        value={region.name}
                        onChange={(event) => updateRegionName(region.id, event.target.value)}
                      />
                      <input
                        className="result-color-input"
                        type="color"
                        value={region.color || '#ff3b3b'}
                        onChange={(event) => updateRegionColor(region.id, event.target.value)}
                        aria-label={`${region.name}の色を変更`}
                      />
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => removeRegion(region.id)}
                        aria-label={`${region.name}を削除`}
                      >
                        −
                      </button>
                    </div>
                    <div className="result-value">
                      <span className="result-count">
                        {regionValues[region.id] ?? ''}
                      </span>
                      {/*
                      <span className="result-meta">
                        x:{Math.round(region.x)} y:{Math.round(region.y)}
                        w:{Math.round(region.w)} h:{Math.round(region.h)}
                      </span>
                      */}
                    </div>
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
