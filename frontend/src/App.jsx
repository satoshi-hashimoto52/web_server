// *********************************************************
// frontend/src/main.jsx
// *********************************************************

import React, { useState, useRef, useEffect } from 'react';
import './styles.css';
import DashboardPage from './DashboardPage';

const REGION_STORAGE_KEY = 'web_server_regions_v1';
const VIDEO_SETTINGS_STORAGE_KEY = 'stream.video.settings';
const INFERENCE_RETRY_COUNT = 3;
const INFERENCE_RETRY_INTERVAL_MS = 150;
const START_TIMEOUT_MS = 8000;
const FIRST_FRAME_TIMEOUT_MS = 8000;
const FRAME_STALL_TIMEOUT_MS = 5000;
const AUTO_RECONNECT_MAX = 2;
const DEFAULT_VIDEO_SETTINGS = Object.freeze({
  brightness: 1,
  contrast: 1,
  gamma: 1,
  sharpness: 1,
  highlightSuppression: 0,
  claheEnabled: false,
  claheClipLimit: 2,
  claheTileGridSize: 8,
  zoom: 1,
  centerX: 0.5,
  centerY: 0.5,
});

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);
const toPreprocessPayload = (settings) => ({
  brightness: settings.brightness,
  contrast: settings.contrast,
  gamma: settings.gamma,
  sharpness: settings.sharpness,
  highlightSuppression: settings.highlightSuppression,
  clahe: {
    enabled: settings.claheEnabled,
    clipLimit: settings.claheClipLimit,
    tileGridSize: settings.claheTileGridSize,
  },
  focus: {
    zoom: settings.zoom,
    centerX: settings.centerX,
    centerY: settings.centerY,
  },
});

const sanitizeVideoSettings = (value) => {
  const input = value && typeof value === 'object' ? value : {};
  const asNumber = (raw, fallback) => {
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  };
  return {
    brightness: clampNumber(asNumber(input.brightness, 1), 0, 3),
    contrast: clampNumber(asNumber(input.contrast, 1), 0, 3),
    gamma: clampNumber(asNumber(input.gamma, 1), 0.05, 4),
    sharpness: clampNumber(asNumber(input.sharpness, 1), 0, 3),
    highlightSuppression: clampNumber(asNumber(input.highlightSuppression, 0), 0, 1),
    claheEnabled: Boolean(input.claheEnabled),
    claheClipLimit: clampNumber(asNumber(input.claheClipLimit, 2), 1, 12),
    claheTileGridSize: clampNumber(Math.round(asNumber(input.claheTileGridSize, 8)), 4, 24),
    zoom: clampNumber(asNumber(input.zoom, 1), 1, 6),
    centerX: clampNumber(asNumber(input.centerX, 0.5), 0, 1),
    centerY: clampNumber(asNumber(input.centerY, 0.5), 0, 1),
  };
};

const applyBasicAdjustments = (data, brightness, contrast, gamma) => {
  const invGamma = 1 / Math.max(gamma, 0.05);
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    r = ((r - 128) * contrast + 128) * brightness;
    g = ((g - 128) * contrast + 128) * brightness;
    b = ((b - 128) * contrast + 128) * brightness;

    r = 255 * Math.pow(clampNumber(r, 0, 255) / 255, invGamma);
    g = 255 * Math.pow(clampNumber(g, 0, 255) / 255, invGamma);
    b = 255 * Math.pow(clampNumber(b, 0, 255) / 255, invGamma);

    data[i] = clampNumber(r, 0, 255);
    data[i + 1] = clampNumber(g, 0, 255);
    data[i + 2] = clampNumber(b, 0, 255);
  }
};

const applySharpen = (data, width, height, amount) => {
  if (amount <= 0) return;
  const src = new Uint8ClampedArray(data);
  const kernelCenter = 1 + 4 * amount;
  const kernelEdge = -amount;
  const rowStride = width * 4;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * rowStride + x * 4;
      for (let c = 0; c < 3; c += 1) {
        const center = src[idx + c] * kernelCenter;
        const top = src[idx - rowStride + c] * kernelEdge;
        const bottom = src[idx + rowStride + c] * kernelEdge;
        const left = src[idx - 4 + c] * kernelEdge;
        const right = src[idx + 4 + c] * kernelEdge;
        data[idx + c] = clampNumber(center + top + bottom + left + right, 0, 255);
      }
    }
  }
};

const applyHighlightSuppression = (data, strength) => {
  if (strength <= 0) return;
  const valueThreshold = 190;
  const saturationThreshold = 55;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const maxCh = Math.max(r, g, b);
    const minCh = Math.min(r, g, b);
    const saturation = maxCh - minCh;
    if (maxCh < valueThreshold || saturation > saturationThreshold) continue;

    const over = (maxCh - valueThreshold) / (255 - valueThreshold);
    const reduce = 1 - over * strength * 0.65;
    data[i] = clampNumber(r * reduce, 0, 255);
    data[i + 1] = clampNumber(g * reduce, 0, 255);
    data[i + 2] = clampNumber(b * reduce, 0, 255);
  }
};

const applyClaheToLuma = (data, width, height, clipLimit, tileGridSize) => {
  const pixelCount = width * height;
  if (pixelCount === 0) return;
  const luminance = new Uint8Array(pixelCount);
  for (let i = 0, p = 0; p < pixelCount; i += 4, p += 1) {
    luminance[p] = clampNumber(
      Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]),
      0,
      255
    );
  }

  const tilesX = tileGridSize;
  const tilesY = tileGridSize;
  const tileWidth = Math.ceil(width / tilesX);
  const tileHeight = Math.ceil(height / tilesY);
  const lut = new Uint8Array(tilesX * tilesY * 256);

  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const x0 = tx * tileWidth;
      const y0 = ty * tileHeight;
      const x1 = Math.min(x0 + tileWidth, width);
      const y1 = Math.min(y0 + tileHeight, height);
      const tilePixels = Math.max((x1 - x0) * (y1 - y0), 1);
      const hist = new Uint32Array(256);

      for (let y = y0; y < y1; y += 1) {
        const row = y * width;
        for (let x = x0; x < x1; x += 1) {
          hist[luminance[row + x]] += 1;
        }
      }

      const clipThreshold = Math.max(Math.floor((clipLimit * tilePixels) / 256), 1);
      let excess = 0;
      for (let i = 0; i < 256; i += 1) {
        if (hist[i] > clipThreshold) {
          excess += hist[i] - clipThreshold;
          hist[i] = clipThreshold;
        }
      }
      const distribute = Math.floor(excess / 256);
      const remainder = excess % 256;
      for (let i = 0; i < 256; i += 1) {
        hist[i] += distribute + (i < remainder ? 1 : 0);
      }

      let cdf = 0;
      const lutBase = (ty * tilesX + tx) * 256;
      for (let i = 0; i < 256; i += 1) {
        cdf += hist[i];
        lut[lutBase + i] = clampNumber(Math.round((cdf * 255) / tilePixels), 0, 255);
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    const tileY = Math.min(Math.floor(y / tileHeight), tilesY - 1);
    for (let x = 0; x < width; x += 1) {
      const tileX = Math.min(Math.floor(x / tileWidth), tilesX - 1);
      const p = y * width + x;
      const lum = luminance[p];
      const lutValue = lut[(tileY * tilesX + tileX) * 256 + lum];
      const ratio = lum > 0 ? lutValue / lum : 1;
      const i = p * 4;
      data[i] = clampNumber(data[i] * ratio, 0, 255);
      data[i + 1] = clampNumber(data[i + 1] * ratio, 0, 255);
      data[i + 2] = clampNumber(data[i + 2] * ratio, 0, 255);
    }
  }
};

function App() {
  const [activeTab, setActiveTab] = useState('stream');
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
  const [connectionState, setConnectionState] = useState('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [dragOverId, setDragOverId] = useState(null);
  const [videoSettings, setVideoSettings] = useState(DEFAULT_VIDEO_SETTINGS);
  const [showVideoSettings, setShowVideoSettings] = useState(false);
  const [inferLoading, setInferLoading] = useState(false);
  const [inferError, setInferError] = useState('');
  const [inferResult, setInferResult] = useState(null);
  const ws = useRef(null);
  const connectionStateRef = useRef('idle');
  const activeTabRef = useRef('stream');
  const latestImageDataRef = useRef('');
  const streamRef = useRef(null);
  const streamCanvasRef = useRef(null);
  const sourceImageRef = useRef(null);
  const dragRef = useRef(null);
  const sendTimerRef = useRef(null);
  const drawRafRef = useRef(null);
  const drawContextRef = useRef(null);
  const startTimeoutRef = useRef(null);
  const stopTimeoutRef = useRef(null);
  const firstFrameTimeoutRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const lastFrameAtRef = useRef(0);
  const autoReconnectCountRef = useRef(0);
  const desiredStreamingRef = useRef(false);
  const imageVersionRef = useRef(0);
  const settingsVersionRef = useRef(0);
  const drawStateRef = useRef({
    imageVersion: -1,
    settingsVersion: -1,
    claheAt: 0,
  });

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
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

  const setConnectionStatus = (nextState, message = '') => {
    connectionStateRef.current = nextState;
    setConnectionState(nextState);
    setConnectionMessage(message);
  };

  const clearStartTimeout = () => {
    if (startTimeoutRef.current) {
      window.clearTimeout(startTimeoutRef.current);
      startTimeoutRef.current = null;
    }
  };

  const clearStopTimeout = () => {
    if (stopTimeoutRef.current) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
  };

  const clearFirstFrameTimeout = () => {
    if (firstFrameTimeoutRef.current) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = null;
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const scheduleAutoReconnect = (reason) => {
    if (!desiredStreamingRef.current) {
      return;
    }
    if (connectionStateRef.current === 'stopping' || connectionStateRef.current === 'connecting') {
      return;
    }
    if (autoReconnectCountRef.current >= AUTO_RECONNECT_MAX) {
      setConnectionStatus('error', `${reason}（自動再接続の上限に達しました）`);
      return;
    }
    autoReconnectCountRef.current += 1;
    clearReconnectTimer();
    setConnectionStatus('error', `${reason}（自動再接続 ${autoReconnectCountRef.current}/${AUTO_RECONNECT_MAX}）`);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      startStream();
    }, 500);
  };

  const startStream = () => {
    if (connectionStateRef.current === 'connecting' || connectionStateRef.current === 'stopping') {
      return;
    }
    // 既存接続をクリーンに閉じる
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    clearStartTimeout();
    clearStopTimeout();
    clearFirstFrameTimeout();
    clearReconnectTimer();

    const target =
      sourceType === 'device' ? `device:${deviceIndex}` : streamUrl.trim();
    if (!target) {
      alert('Please enter a valid stream URL.');
      return;
    }

    desiredStreamingRef.current = true;
    // 新規 WebSocket 接続
    setConnectionStatus('connecting', '接続中...');
    const socket = new WebSocket('ws://localhost:5050/ws/stream');
    ws.current = socket;

    socket.onopen = () => {
      if (ws.current !== socket) return;
      console.log('WebSocket connected');
      socket.send(JSON.stringify({
        type: 'start',
        source: target,
        regions,
        model: selectedModel || undefined,
        preprocess: toPreprocessPayload(videoSettings),
        previewPreprocess: showVideoSettings,
      }));
      setConnectionStatus('connecting', '開始要求を送信しました...');
      clearStartTimeout();
      startTimeoutRef.current = window.setTimeout(() => {
        if (ws.current !== socket) return;
        if (connectionStateRef.current === 'streaming') return;
        setConnectionStatus('error', '開始タイムアウト: 映像開始できませんでした。');
        setIsStreaming(false);
        socket.close();
        ws.current = null;
        scheduleAutoReconnect('開始に失敗しました');
      }, START_TIMEOUT_MS);
    };

    socket.onmessage = (event) => {
      if (ws.current !== socket) return;
      const msg = event.data;
      if (msg.startsWith('ERROR')) {
        clearStartTimeout();
        clearStopTimeout();
        setConnectionStatus('error', msg);
        setIsStreaming(false);
        alert(msg);
        return;
      }
      try {
        const payload = JSON.parse(msg);
        if (payload && payload.type === 'status') {
          const state = payload.state || '';
          const statusMessage = typeof payload.message === 'string' ? payload.message : '';
          if (state === 'starting') {
            setConnectionStatus('connecting', statusMessage || 'ストリーム開始中...');
            setIsStreaming(false);
          } else if (state === 'streaming') {
            clearStartTimeout();
            setConnectionStatus('streaming', statusMessage || 'ストリーミング中');
            setIsStreaming(true);
            lastFrameAtRef.current = Date.now();
            clearFirstFrameTimeout();
            firstFrameTimeoutRef.current = window.setTimeout(() => {
              if (ws.current !== socket) return;
              setConnectionStatus('error', '開始後に映像フレームを受信できませんでした。再試行してください。');
              setIsStreaming(false);
              socket.close();
              ws.current = null;
              scheduleAutoReconnect('開始後のフレーム受信に失敗しました');
            }, FIRST_FRAME_TIMEOUT_MS);
          } else if (state === 'stopping') {
            setConnectionStatus('stopping', statusMessage || '停止中...');
            setIsStreaming(false);
          } else if (state === 'stopped') {
            clearStopTimeout();
            clearStartTimeout();
            clearFirstFrameTimeout();
            setConnectionStatus('idle', '');
            setIsStreaming(false);
            if (desiredStreamingRef.current) {
              scheduleAutoReconnect('ストリームが停止しました');
            }
          } else if (state === 'error') {
            clearStartTimeout();
            clearStopTimeout();
            clearFirstFrameTimeout();
            setConnectionStatus('error', statusMessage || 'ストリームエラー');
            setIsStreaming(false);
            scheduleAutoReconnect(statusMessage || 'ストリームエラー');
          }
          return;
        }
        if (payload.image) {
          clearFirstFrameTimeout();
          lastFrameAtRef.current = Date.now();
          autoReconnectCountRef.current = 0;
          const frameData = `data:image/jpeg;base64,${payload.image}`;
          latestImageDataRef.current = frameData;
          if (connectionStateRef.current !== 'streaming') {
            clearStartTimeout();
            setConnectionStatus('streaming', 'ストリーミング中');
            setIsStreaming(true);
          }
          if (activeTabRef.current === 'stream') {
            setImageData(frameData);
          }
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
      const frameData = `data:image/jpeg;base64,${msg}`;
      latestImageDataRef.current = frameData;
      clearFirstFrameTimeout();
      lastFrameAtRef.current = Date.now();
      autoReconnectCountRef.current = 0;
      if (connectionStateRef.current !== 'streaming') {
        clearStartTimeout();
        setConnectionStatus('streaming', 'ストリーミング中');
        setIsStreaming(true);
      }
      if (activeTabRef.current === 'stream') {
        setImageData(frameData);
      }
    };

    socket.onerror = (err) => {
      if (ws.current !== socket) return;
      console.error('WebSocket error:', err);
      clearFirstFrameTimeout();
      if (connectionStateRef.current !== 'error') {
        setConnectionStatus('error', 'WebSocket通信エラーが発生しました。');
      }
      scheduleAutoReconnect('WebSocket通信エラー');
    };

    socket.onclose = () => {
      const wasCurrent = ws.current === socket;
      if (wasCurrent) {
        ws.current = null;
        clearStartTimeout();
        clearStopTimeout();
        clearFirstFrameTimeout();
        setIsStreaming(false);
        if (connectionStateRef.current !== 'error') {
          setConnectionStatus('idle', '');
        }
        if (desiredStreamingRef.current && connectionStateRef.current !== 'stopping') {
          scheduleAutoReconnect('接続が切断されました');
        }
      }
      console.log('WebSocket disconnected');
    };
  };

  useEffect(() => {
    // アンマウント時にクリーンアップ
    return () => {
      desiredStreamingRef.current = false;
      clearStartTimeout();
      clearStopTimeout();
      clearFirstFrameTimeout();
      clearReconnectTimer();
      if (ws.current) ws.current.close();
    };
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
    const raw = window.localStorage.getItem(REGION_STORAGE_KEY);
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

  useEffect(() => {
    const raw = window.localStorage.getItem(VIDEO_SETTINGS_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      setVideoSettings(sanitizeVideoSettings(parsed));
    } catch (error) {
      console.warn('Failed to parse video settings', error);
    }
  }, []);

  const stopStream = () => {
    desiredStreamingRef.current = false;
    clearStartTimeout();
    clearStopTimeout();
    clearFirstFrameTimeout();
    clearReconnectTimer();
    autoReconnectCountRef.current = 0;
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      setConnectionStatus('stopping', '停止中...');
      ws.current.send(JSON.stringify({ type: 'stop' }));
      stopTimeoutRef.current = window.setTimeout(() => {
        if (!ws.current) return;
        ws.current.close();
        ws.current = null;
        setConnectionStatus('idle', '');
      }, 1200);
    } else if (ws.current) {
      ws.current.close();
      ws.current = null;
      setConnectionStatus('idle', '');
    } else {
      setConnectionStatus('idle', '');
    }
    setRegionValues({});
    latestImageDataRef.current = '';
    setImageData('');
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

  const updateVideoSetting = (key, value) => {
    setVideoSettings((prev) => sanitizeVideoSettings({
      ...prev,
      [key]: value,
    }));
  };

  const resetVideoSettings = () => {
    setVideoSettings(DEFAULT_VIDEO_SETTINGS);
  };

  const handleStreamClick = (event) => {
    if (!streamRef.current) return;
    const rect = streamRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const normalizedX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const normalizedY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    setVideoSettings((prev) => ({
      ...prev,
      centerX: normalizedX,
      centerY: normalizedY,
    }));
  };

  const formatReadingTimestamp = (timestamp) => {
    if (!timestamp) return '-';
    const dt = new Date(timestamp);
    if (Number.isNaN(dt.getTime())) return String(timestamp);
    return dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  };

  const captureCurrentFrameBlob = async () => {
    if (!imageData) {
      throw new Error('現在フレームを取得できません。');
    }
    const response = await fetch(imageData);
    if (!response.ok) {
      throw new Error('元フレームの取得に失敗しました。');
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('フレームの画像化に失敗しました。');
    }
    return blob;
  };

  const runInferenceWithCurrentFrame = async () => {
    if (inferLoading) return;
    setInferError('');
    setInferResult(null);
    setInferLoading(true);
    try {
      const preprocessPayload = JSON.stringify(toPreprocessPayload(videoSettings));
      const attempts = [];
      for (let i = 0; i < INFERENCE_RETRY_COUNT; i += 1) {
        try {
          const frameBlob = await captureCurrentFrameBlob();
          const formData = new FormData();
          formData.append('image', frameBlob, `stream_frame_${Date.now()}_${i + 1}.jpg`);
          formData.append('meter_id', 'default');
          formData.append('model_type', 'yolo');
          formData.append('preprocess', preprocessPayload);

          const response = await fetch('http://localhost:5050/api/v1/images', {
            method: 'POST',
            body: formData,
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            const detail = typeof payload.detail === 'string' ? payload.detail : '推論に失敗しました。';
            throw new Error(detail);
          }

          const rawValue = payload?.reading?.value;
          const rawConfidence = payload?.reading?.confidence;
          const numericValue = Number(rawValue);
          const numericConfidence = Number(rawConfidence);
          attempts.push({
            attempt: i + 1,
            ok: true,
            value: rawValue,
            confidence: rawConfidence,
            ts: payload?.reading?.ts ?? '',
            alertSent: Boolean(payload?.alert_sent),
            numericValue: Number.isFinite(numericValue) ? numericValue : null,
            numericConfidence: Number.isFinite(numericConfidence) ? numericConfidence : null,
          });
        } catch (error) {
          attempts.push({
            attempt: i + 1,
            ok: false,
            error: error instanceof Error ? error.message : '推論に失敗しました。',
            numericValue: null,
            numericConfidence: null,
          });
        }
        if (i < INFERENCE_RETRY_COUNT - 1) {
          await sleep(INFERENCE_RETRY_INTERVAL_MS);
        }
      }

      const valid = attempts.filter((item) => item.ok && Number.isFinite(item.numericValue));
      if (valid.length === 0) {
        const firstError = attempts.find((item) => !item.ok)?.error || '推論に失敗しました。';
        throw new Error(firstError);
      }

      const counts = new Map();
      valid.forEach((item) => {
        const key = String(item.numericValue);
        counts.set(key, (counts.get(key) || 0) + 1);
      });

      let chosen = null;
      let strategy = '中央値';
      const majorityKey = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .find((entry) => entry[1] >= 2)?.[0];

      if (majorityKey !== undefined) {
        strategy = '多数決';
        const candidates = valid.filter((item) => String(item.numericValue) === majorityKey);
        chosen = candidates.sort((a, b) => (b.numericConfidence ?? -1) - (a.numericConfidence ?? -1))[0];
      } else {
        const sorted = [...valid].sort((a, b) => a.numericValue - b.numericValue);
        chosen = sorted[Math.floor(sorted.length / 2)];
      }

      setInferResult({
        finalValue: chosen?.value ?? '-',
        finalConfidence: chosen?.confidence ?? '-',
        ts: chosen?.ts ?? '',
        alertSent: Boolean(chosen?.alertSent),
        rawValues: attempts.map((item) => (item.ok ? String(item.value ?? '') : 'ERR')),
        adoptedAttempt: chosen?.attempt ?? null,
        strategy,
      });
    } catch (error) {
      setInferError(error instanceof Error ? error.message : '推論に失敗しました。');
    } finally {
      setInferLoading(false);
    }
  };

  const drawAdjustedFrame = (ctx, canvas, image) => {
    const sourceWidth = image.naturalWidth || image.videoWidth || image.width;
    const sourceHeight = image.naturalHeight || image.videoHeight || image.height;
    if (!sourceWidth || !sourceHeight) return;
    if (canvas.width !== sourceWidth || canvas.height !== sourceHeight) {
      canvas.width = sourceWidth;
      canvas.height = sourceHeight;
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
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
    if (!isStreaming || !selectedModel) return;
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({
      type: 'model',
      model: selectedModel,
    }));
  }, [selectedModel, isStreaming]);

  useEffect(() => {
    if (!isStreaming) return;
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({
      type: 'preprocess',
      preprocess: toPreprocessPayload(videoSettings),
      previewPreprocess: showVideoSettings,
    }));
  }, [videoSettings, isStreaming, showVideoSettings]);

  useEffect(() => {
    if (!regions.length) {
      window.localStorage.removeItem(REGION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(REGION_STORAGE_KEY, JSON.stringify(regions));
  }, [regions]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab === 'stream' && latestImageDataRef.current) {
      setImageData(latestImageDataRef.current);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!isStreaming) return undefined;
    const timer = window.setInterval(() => {
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
      const elapsed = Date.now() - lastFrameAtRef.current;
      if (lastFrameAtRef.current > 0 && elapsed > FRAME_STALL_TIMEOUT_MS) {
        const staleSocket = ws.current;
        setIsStreaming(false);
        staleSocket.close();
        ws.current = null;
        scheduleAutoReconnect('映像受信が途切れました');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    settingsVersionRef.current += 1;
    window.localStorage.setItem(VIDEO_SETTINGS_STORAGE_KEY, JSON.stringify(videoSettings));
  }, [videoSettings]);

  useEffect(() => {
    const render = () => {
      const canvas = streamCanvasRef.current;
      const image = sourceImageRef.current;
      if (canvas && image) {
        if (!drawContextRef.current) {
          drawContextRef.current = canvas.getContext('2d', { willReadFrequently: true });
        }
        const ctx = drawContextRef.current;
        if (ctx && (image.naturalWidth || image.videoWidth || image.width)) {
          const state = drawStateRef.current;
          const imageChanged = state.imageVersion !== imageVersionRef.current;
          const settingsChanged = state.settingsVersion !== settingsVersionRef.current;
          if (imageChanged || settingsChanged) {
            const now = performance.now();
            const claheIntervalMs = videoSettings.claheEnabled ? 250 : 0;
            const canRenderClahe = !videoSettings.claheEnabled || settingsChanged || now - state.claheAt >= claheIntervalMs;
            if (canRenderClahe) {
              drawAdjustedFrame(ctx, canvas, image, videoSettings);
              state.imageVersion = imageVersionRef.current;
              state.settingsVersion = settingsVersionRef.current;
              if (videoSettings.claheEnabled) state.claheAt = now;
            }
          }
        }
      }
      drawRafRef.current = window.requestAnimationFrame(render);
    };
    drawRafRef.current = window.requestAnimationFrame(render);
    return () => {
      if (drawRafRef.current) {
        window.cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
    };
  }, [videoSettings]);

  return (
    <div className={`container${isStreaming ? ' streaming' : ''}`}>
      <div className="tab-row">
        <button
          type="button"
          className={`tab-button ${activeTab === 'stream' ? 'active' : ''}`}
          onClick={() => setActiveTab('stream')}
        >
          Stream
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
      </div>

      {activeTab === 'dashboard' ? (
        <DashboardPage />
      ) : (
        <>
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
                disabled={connectionState === 'connecting' || connectionState === 'stopping'}
              >
                {connectionState === 'connecting'
                  ? '接続中...'
                  : connectionState === 'stopping'
                    ? '停止中...'
                    : isStreaming
                      ? '停止'
                      : 'ストリーム開始'}
              </button>
            </div>
            {(connectionState !== 'idle' || connectionMessage) && (
              <p className={`muted connection-line state-${connectionState}`}>
                状態: {connectionState}
                {connectionMessage ? ` / ${connectionMessage}` : ''}
              </p>
            )}
          </form>
          {/* 映像受信中/受信待ち中はプレビュー領域を表示 */}
          {(imageData || isStreaming) && (
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
                  <canvas
                    ref={streamCanvasRef}
                    className="stream-canvas"
                    onClick={handleStreamClick}
                  />
                  {imageData ? (
                    <img
                      ref={sourceImageRef}
                      src={imageData}
                      alt="Live Stream"
                      className="stream-source"
                      onLoad={() => {
                        imageVersionRef.current += 1;
                      }}
                    />
                  ) : (
                    <div className="stream-frame-placeholder">
                      映像受信待ち...
                    </div>
                  )}
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
              <div className="side-column">
                <aside className="results">
                  <h4>推論結果</h4>
                  <div className="result-card">
                    <div className="result-label">現在値</div>
                    <div className="result-value">
                      {inferResult ? String(inferResult.finalValue) : '-'}
                    </div>
                    <div className="result-grid">
                      <div>
                        <div className="result-label">Confidence</div>
                        <div>{inferResult ? String(inferResult.finalConfidence) : '-'}</div>
                      </div>
                      <div>
                        <div className="result-label">更新時刻</div>
                        <div>{inferResult ? formatReadingTimestamp(inferResult.ts) : '-'}</div>
                      </div>
                    </div>
                    {inferResult && (
                      <p className="muted result-raw">
                        raw: [{inferResult.rawValues.join(', ')}] / 採用: {inferResult.adoptedAttempt}回目（{inferResult.strategy}）
                      </p>
                    )}
                  </div>
                  <h4>領域結果</h4>
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
                          <div className="region-value">
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
                <button
                  className="primary infer-button"
                  type="button"
                  onClick={runInferenceWithCurrentFrame}
                  disabled={inferLoading || !imageData}
                >
                  {inferLoading ? '推論中...' : '現在フレームで推論'}
                </button>
                {inferError && <p className="muted">{inferError}</p>}
                <button
                  className="secondary settings-toggle"
                  type="button"
                  onClick={() => setShowVideoSettings((prev) => !prev)}
                >
                  {showVideoSettings ? '▲ 映像調整' : '▼ 映像調整'}
                </button>
                {showVideoSettings && (
                  <aside className="video-settings">
                    <div className="video-settings-header">
                      <h4>映像の調整設定</h4>
                      <button className="secondary" type="button" onClick={resetVideoSettings}>
                        Reset
                      </button>
                    </div>
                    <label className="setting-row">
                      <span>明るさ</span>
                      <input
                        type="range"
                        min="0"
                        max="3"
                        step="0.05"
                        value={videoSettings.brightness}
                        onChange={(event) => updateVideoSetting('brightness', Number(event.target.value))}
                      />
                      <strong className="setting-value">{videoSettings.brightness.toFixed(2)}</strong>
                    </label>
                    <label className="setting-row">
                      <span>コントラスト</span>
                      <input
                        type="range"
                        min="0"
                        max="3"
                        step="0.05"
                        value={videoSettings.contrast}
                        onChange={(event) => updateVideoSetting('contrast', Number(event.target.value))}
                      />
                      <strong className="setting-value">{videoSettings.contrast.toFixed(2)}</strong>
                    </label>
                    <label className="setting-row">
                      <span>ガンマ</span>
                      <input
                        type="range"
                        min="0.05"
                        max="4"
                        step="0.05"
                        value={videoSettings.gamma}
                        onChange={(event) => updateVideoSetting('gamma', Number(event.target.value))}
                      />
                      <strong className="setting-value">{videoSettings.gamma.toFixed(2)}</strong>
                    </label>
                    <label className="setting-row">
                      <span>シャープネス</span>
                      <input
                        type="range"
                        min="0"
                        max="3"
                        step="0.05"
                        value={videoSettings.sharpness}
                        onChange={(event) => updateVideoSetting('sharpness', Number(event.target.value))}
                      />
                      <strong className="setting-value">{videoSettings.sharpness.toFixed(2)}</strong>
                    </label>
                    <label className="setting-row">
                      <span>白飛び抑制</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={videoSettings.highlightSuppression}
                        onChange={(event) => updateVideoSetting('highlightSuppression', Number(event.target.value))}
                      />
                      <strong className="setting-value">{videoSettings.highlightSuppression.toFixed(2)}</strong>
                    </label>
                    <div className="setting-section">
                      <label className="setting-checkbox">
                        <input
                          type="checkbox"
                          checked={videoSettings.claheEnabled}
                          onChange={(event) => updateVideoSetting('claheEnabled', event.target.checked)}
                        />
                        <span>CLAHEを有効化</span>
                      </label>
                      <label className="setting-row">
                        <span>clipLimit</span>
                        <input
                          type="range"
                          min="1"
                          max="12"
                          step="1"
                          value={videoSettings.claheClipLimit}
                          onChange={(event) => updateVideoSetting('claheClipLimit', Number(event.target.value))}
                        />
                        <strong className="setting-value">{videoSettings.claheClipLimit.toFixed(0)}</strong>
                      </label>
                      <label className="setting-row">
                        <span>tileGridSize</span>
                        <input
                          type="range"
                          min="4"
                          max="24"
                          step="1"
                          value={videoSettings.claheTileGridSize}
                          onChange={(event) => updateVideoSetting('claheTileGridSize', Number(event.target.value))}
                        />
                        <strong className="setting-value">{videoSettings.claheTileGridSize.toFixed(0)}</strong>
                      </label>
                    </div>
                    <div className="setting-section">
                      <p className="setting-title">フォーカス（ズーム＋中心）</p>
                      <label className="setting-row">
                        <span>zoom</span>
                        <input
                          type="range"
                          min="1"
                          max="6"
                          step="0.05"
                          value={videoSettings.zoom}
                          onChange={(event) => updateVideoSetting('zoom', Number(event.target.value))}
                        />
                        <strong className="setting-value">{videoSettings.zoom.toFixed(2)}</strong>
                      </label>
                      <label className="setting-row">
                        <span>centerX</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={videoSettings.centerX}
                          onChange={(event) => updateVideoSetting('centerX', Number(event.target.value))}
                        />
                        <strong className="setting-value">{videoSettings.centerX.toFixed(2)}</strong>
                      </label>
                      <label className="setting-row">
                        <span>centerY</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={videoSettings.centerY}
                          onChange={(event) => updateVideoSetting('centerY', Number(event.target.value))}
                        />
                        <strong className="setting-value">{videoSettings.centerY.toFixed(2)}</strong>
                      </label>
                      <p className="muted">映像をクリックすると中心位置を更新できます。</p>
                    </div>
                  </aside>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
