// *********************************************************
// frontend/src/main.jsx
// *********************************************************

import React, { useState, useRef, useEffect, useCallback } from 'react';
import './styles.css';
import DashboardPage from './DashboardPage';

const REGION_STORAGE_KEY = 'web_server_regions_v1';
const VIDEO_SETTINGS_STORAGE_KEY = 'stream.video.settings';
const CAMERA_PROFILES_KEY = 'stream.camera.profiles.v1';
const ACTIVE_CAMERA_PROFILE_KEY = 'stream.camera.active_profile_id.v1';
const LAST_USED_CAMERA_SETTINGS_KEY = 'stream.camera.last_used_settings.v1';
const CAMERA_SIDEBAR_COLLAPSED_KEY = 'stream.camera.sidebar.collapsed.v1';
const TEST_CAPTURE_SAVE_DIR_KEY = 'stream.test.capture.save_dir.v1';
const TEST_CAPTURE_SAVE_DIR_ABS_KEY = 'stream.test.capture.save_dir_abs.v1';
const SETTINGS_DIALOG_DEFAULT_WIDTH = 460;
const INFERENCE_RETRY_COUNT = 3;
const INFERENCE_RETRY_INTERVAL_MS = 150;
const START_TIMEOUT_MS = 8000;
const FIRST_FRAME_TIMEOUT_MS = 8000;
const FRAME_STALL_TIMEOUT_MS = 5000;
const AUTO_RECONNECT_MAX = 2;
const ADJUSTING_PREVIEW_FPS = 8;
const NORMAL_PREVIEW_FPS = 20;
const NORMAL_PREVIEW_MAX_WIDTH = 960;
const HEAVY_PREVIEW_MAX_WIDTH = 720;
const REGION_VALUES_UPDATE_FPS = 12;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5050';
const WS_BASE_URL = API_BASE_URL.replace(/^http/i, 'ws').replace(/\/$/, '');
const DEFAULT_VIDEO_SETTINGS = Object.freeze({
  brightness: 1,
  contrast: 1,
  gamma: 1,
  sharpness: 1,
  highlightSuppression: 0,
  highlightRecovery: 0,
  highlightRecoveryCurve: 1,
  highlightRecoveryMode: 'natural',
  highlightLineMaxDist: 5,
  highlightLineKernelWidth: 9,
  binarizationEnabled: false,
  binarizationThreshold: 128,
  claheEnabled: false,
  claheClipLimit: 2,
  claheTileGridSize: 8,
  zoom: 1,
  centerX: 0.5,
  centerY: 0.5,
});
const DEFAULT_DETECTION_SETTINGS = Object.freeze({
  confidenceThreshold: 0.25,
  nmsIouThreshold: 0.55,
  resultIntervalFrames: 1,
  mergeSameDigits: true,
  mergeSameDigitsRowTolerance: 0.5,
  mergeSameDigitsXGapRatio: 0.35,
});

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);
const toPreprocessPayload = (settings) => ({
  brightness: settings.brightness,
  contrast: settings.contrast,
  gamma: settings.gamma,
  sharpness: settings.sharpness,
  highlightSuppression: settings.highlightSuppression,
  highlightRecovery: settings.highlightRecovery,
  highlightRecoveryCurve: settings.highlightRecoveryCurve,
  highlightRecoveryMode: settings.highlightRecoveryMode,
  highlightLineMaxDist: settings.highlightLineMaxDist,
  highlightLineKernelWidth: settings.highlightLineKernelWidth,
  binarization: {
    enabled: settings.binarizationEnabled,
    threshold: settings.binarizationThreshold,
  },
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
    highlightRecovery: clampNumber(asNumber(input.highlightRecovery, 0), 0, 1),
    highlightRecoveryCurve: clampNumber(asNumber(input.highlightRecoveryCurve, 1), 0.5, 3),
    highlightRecoveryMode: input.highlightRecoveryMode === 'line' ? 'line' : 'natural',
    highlightLineMaxDist: clampNumber(Math.round(asNumber(input.highlightLineMaxDist, 5)), 3, 20),
    highlightLineKernelWidth: clampNumber(Math.round(asNumber(input.highlightLineKernelWidth, 9)), 3, 25),
    binarizationEnabled: Boolean(input.binarizationEnabled),
    binarizationThreshold: clampNumber(Math.round(asNumber(input.binarizationThreshold, 128)), 0, 255),
    claheEnabled: Boolean(input.claheEnabled),
    claheClipLimit: clampNumber(asNumber(input.claheClipLimit, 2), 1, 12),
    claheTileGridSize: clampNumber(Math.round(asNumber(input.claheTileGridSize, 8)), 4, 24),
    zoom: clampNumber(asNumber(input.zoom, 1), 1, 6),
    centerX: clampNumber(asNumber(input.centerX, 0.5), 0, 1),
    centerY: clampNumber(asNumber(input.centerY, 0.5), 0, 1),
  };
};

const sanitizeDetectionSettings = (value) => {
  const input = value && typeof value === 'object' ? value : {};
  const asNumber = (raw, fallback) => {
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  };
  return {
    confidenceThreshold: clampNumber(
      asNumber(input.confidenceThreshold ?? input.confidence_threshold, DEFAULT_DETECTION_SETTINGS.confidenceThreshold),
      0.01,
      0.99,
    ),
    nmsIouThreshold: clampNumber(
      asNumber(input.nmsIouThreshold ?? input.nms_iou_threshold, DEFAULT_DETECTION_SETTINGS.nmsIouThreshold),
      0.1,
      0.95,
    ),
    resultIntervalFrames: clampNumber(
      Math.round(asNumber(input.resultIntervalFrames ?? input.result_interval_frames, DEFAULT_DETECTION_SETTINGS.resultIntervalFrames)),
      1,
      60,
    ),
    mergeSameDigits: Boolean(input.mergeSameDigits ?? input.merge_same_digits ?? DEFAULT_DETECTION_SETTINGS.mergeSameDigits),
    mergeSameDigitsRowTolerance: clampNumber(
      asNumber(input.mergeSameDigitsRowTolerance ?? input.merge_row_tolerance, DEFAULT_DETECTION_SETTINGS.mergeSameDigitsRowTolerance),
      0.05,
      2.0,
    ),
    mergeSameDigitsXGapRatio: clampNumber(
      asNumber(input.mergeSameDigitsXGapRatio ?? input.merge_x_gap_ratio, DEFAULT_DETECTION_SETTINGS.mergeSameDigitsXGapRatio),
      0.01,
      2.0,
    ),
  };
};

const toDetectionSettingsPayload = (settings) => ({
  confidenceThreshold: settings.confidenceThreshold,
  nmsIouThreshold: settings.nmsIouThreshold,
  resultIntervalFrames: settings.resultIntervalFrames,
  mergeSameDigits: settings.mergeSameDigits,
  mergeSameDigitsRowTolerance: settings.mergeSameDigitsRowTolerance,
  mergeSameDigitsXGapRatio: settings.mergeSameDigitsXGapRatio,
});

const sanitizeLastUsedCameraSettings = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    activeCameraProfileId: typeof value.activeCameraProfileId === 'string' ? value.activeCameraProfileId : '',
    sourceType: value.sourceType === 'device' ? 'device' : 'url',
    streamUrl: typeof value.streamUrl === 'string' ? value.streamUrl : '',
    deviceIndex: typeof value.deviceIndex === 'string' ? value.deviceIndex : '0',
    model: typeof value.model === 'string' ? value.model : '',
    videoSettings: sanitizeVideoSettings(value.videoSettings),
    detectionSettings: sanitizeDetectionSettings(value.detectionSettings),
  };
};

const sanitizeCameraProfile = (profile, fallbackName = 'default') => ({
  id: typeof profile?.id === 'string' && profile.id ? profile.id : crypto.randomUUID(),
  name: typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim() : fallbackName,
  sourceType: profile?.sourceType === 'device' ? 'device' : 'url',
  streamUrl: typeof profile?.streamUrl === 'string' ? profile.streamUrl : '',
  deviceIndex: typeof profile?.deviceIndex === 'string' ? profile.deviceIndex : '0',
  model: typeof profile?.model === 'string' ? profile.model : '',
  regions: Array.isArray(profile?.regions) ? profile.regions : [],
  videoSettings: sanitizeVideoSettings(profile?.videoSettings),
  detectionSettings: sanitizeDetectionSettings(profile?.detectionSettings),
});

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

const applyHighlightRecovery = (data, width, height, strength, curve = 1) => {
  if (strength <= 0) return;
  if (width < 3 || height < 3) return;
  const normalizedStrength = clampNumber(strength, 0, 1);
  const curveStrength = clampNumber(curve, 0.5, 3);
  const effectiveStrength = 1 - Math.pow(1 - normalizedStrength, curveStrength);
  const src = new Uint8ClampedArray(data);
  const rowStride = width * 4;
  const brightThreshold = 210;
  const satThreshold = 140;
  const maxRadius = 4;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * rowStride + x * 4;
      const r = src[idx];
      const g = src[idx + 1];
      const b = src[idx + 2];
      const maxCh = Math.max(r, g, b);
      const sat = maxCh - Math.min(r, g, b);
      if (maxCh < brightThreshold || sat > satThreshold) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let weightSum = 0;
      for (let radius = 1; radius <= maxRadius && weightSum < 0.001; radius += 1) {
        for (let oy = -radius; oy <= radius; oy += 1) {
          for (let ox = -radius; ox <= radius; ox += 1) {
            if (ox === 0 && oy === 0) continue;
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nIdx = ny * rowStride + nx * 4;
            const nr = src[nIdx];
            const ng = src[nIdx + 1];
            const nb = src[nIdx + 2];
            const nMax = Math.max(nr, ng, nb);
            const nSat = nMax - Math.min(nr, ng, nb);
            if (nMax >= 245 && nSat <= satThreshold) continue;
            const dist2 = ox * ox + oy * oy;
            const weight = 1 / Math.max(1, dist2);
            sumR += nr * weight;
            sumG += ng * weight;
            sumB += nb * weight;
            weightSum += weight;
          }
        }
      }
      if (weightSum <= 0) continue;

      const avgR = sumR / weightSum;
      const avgG = sumG / weightSum;
      const avgB = sumB / weightSum;
      const over = clampNumber((maxCh - brightThreshold) / (255 - brightThreshold), 0, 1);
      const mix = effectiveStrength * (0.45 + over * 0.55);

      const restoredR = r * (1 - mix) + avgR * mix;
      const restoredG = g * (1 - mix) + avgG * mix;
      const restoredB = b * (1 - mix) + avgB * mix;
      const currentLuma = 0.299 * restoredR + 0.587 * restoredG + 0.114 * restoredB;
      const neighborLuma = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;
      const targetLuma = (0.299 * r + 0.587 * g + 0.114 * b) * (1 - 0.28 * mix) + neighborLuma * (0.28 * mix);
      const lumaScale = currentLuma > 1 ? targetLuma / currentLuma : 1;

      data[idx] = clampNumber(restoredR * lumaScale, 0, 255);
      data[idx + 1] = clampNumber(restoredG * lumaScale, 0, 255);
      data[idx + 2] = clampNumber(restoredB * lumaScale, 0, 255);
    }
  }
};

const applyBinarization = (data, threshold) => {
  const t = clampNumber(Math.round(threshold), 0, 255);
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = luma >= t ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
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
  const [cameraProfiles, setCameraProfiles] = useState([]);
  const [activeCameraProfileId, setActiveCameraProfileId] = useState('');
  const [imageData, setImageData] = useState('');
  const [regions, setRegions] = useState([]);
  const [regionValues, setRegionValues] = useState({});
  const [activeAction, setActiveAction] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [isCameraSidebarCollapsed, setIsCameraSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(CAMERA_SIDEBAR_COLLAPSED_KEY) === '1';
    } catch (_error) {
      return false;
    }
  });
  const [dragOverId, setDragOverId] = useState(null);
  const [videoSettings, setVideoSettings] = useState(DEFAULT_VIDEO_SETTINGS);
  const [showVideoSettings, setShowVideoSettings] = useState(false);
  const [detectionSettings, setDetectionSettings] = useState(DEFAULT_DETECTION_SETTINGS);
  const [hideRoiRegions, setHideRoiRegions] = useState(false);
  const [hideInferenceResults, setHideInferenceResults] = useState(false);
  const [showCameraSettings, setShowCameraSettings] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState('yolo');
  const [settingsDialogPosition, setSettingsDialogPosition] = useState({ left: 24, top: 64 });
  const [isSettingsDialogDragging, setIsSettingsDialogDragging] = useState(false);
  const [inferLoading, setInferLoading] = useState(false);
  const [inferError, setInferError] = useState('');
  const [inferResult, setInferResult] = useState(null);
  const [testCaptureSaveDir, setTestCaptureSaveDir] = useState(() => {
    try {
      return window.localStorage.getItem(TEST_CAPTURE_SAVE_DIR_KEY) || '';
    } catch (_error) {
      return '';
    }
  });
  const [testCaptureSaveDirAbs, setTestCaptureSaveDirAbs] = useState(() => {
    try {
      return window.localStorage.getItem(TEST_CAPTURE_SAVE_DIR_ABS_KEY) || '';
    } catch (_error) {
      return '';
    }
  });
  const [testCaptureSelectingDir, setTestCaptureSelectingDir] = useState(false);
  const [testCaptureSaving, setTestCaptureSaving] = useState(false);
  const [testCaptureMessage, setTestCaptureMessage] = useState('');
  const [displayFps, setDisplayFps] = useState(0);
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const ws = useRef(null);
  const connectionStateRef = useRef('idle');
  const activeTabRef = useRef('stream');
  const latestImageDataRef = useRef('');
  const streamRef = useRef(null);
  const streamCanvasRef = useRef(null);
  const videoShellRef = useRef(null);
  const sourceImageRef = useRef(null);
  const regionLayerRef = useRef(null);
  const dragRef = useRef(null);
  const settingsDialogRef = useRef(null);
  const settingsDialogDragRef = useRef(null);
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
  const streamingProfileIdRef = useRef('');
  const showVideoSettingsRef = useRef(false);
  const lastDisplayFrameAtRef = useRef(0);
  const lastRegionValuesAtRef = useRef(0);
  const imageVersionRef = useRef(0);
  const settingsVersionRef = useRef(0);
  const drawStateRef = useRef({
    imageVersion: -1,
    settingsVersion: -1,
    claheAt: 0,
    renderedAt: 0,
  });
  const frameSizeRef = useRef({ width: 0, height: 0 });
  const prevShowVideoSettingsRef = useRef(showVideoSettings);
  const lastDisplayFrameTsRef = useRef(0);
  const fpsEmaRef = useRef(0);
  const [mediaRect, setMediaRect] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [streamingProfileId, setStreamingProfileId] = useState('');
  const [videoShellHeight, setVideoShellHeight] = useState(0);
  const profileHydratingRef = useRef('');

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const isFiniteNumber = (value) => Number.isFinite(value);
  const clampSettingsDialogPosition = useCallback((left, top) => {
    const node = settingsDialogRef.current;
    const dialogWidth = node?.offsetWidth ?? Math.min(SETTINGS_DIALOG_DEFAULT_WIDTH, Math.max(320, window.innerWidth - 24));
    const dialogHeight = node?.offsetHeight ?? Math.min(760, window.innerHeight - 24);
    const minLeft = 8;
    const minTop = 8;
    const maxLeft = Math.max(minLeft, window.innerWidth - dialogWidth - 8);
    const maxTop = Math.max(minTop, window.innerHeight - dialogHeight - 8);
    return {
      left: clamp(left, minLeft, maxLeft),
      top: clamp(top, minTop, maxTop),
    };
  }, []);
  const getFrameSize = () => {
    if (mediaRect.width > 0 && mediaRect.height > 0) {
      return { width: mediaRect.width, height: mediaRect.height };
    }
    return null;
  };
  const getInteractionRect = () => {
    if (regionLayerRef.current) {
      const rect = regionLayerRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    if (streamRef.current) {
      const rect = streamRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return null;
  };

  const computeMediaRect = useCallback(() => {
    const container = streamRef.current;
    if (!container) {
      setMediaRect({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setMediaRect({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }

    const image = sourceImageRef.current;
    const canvas = streamCanvasRef.current;
    const sourceWidth = image?.naturalWidth || canvas?.width || 0;
    const sourceHeight = image?.naturalHeight || canvas?.height || 0;
    if (!sourceWidth || !sourceHeight) {
      const last = frameSizeRef.current;
      if (last.width > 0 && last.height > 0) {
        setMediaRect({ x: 0, y: 0, width: last.width, height: last.height });
      } else {
        setMediaRect({ x: 0, y: 0, width: 0, height: 0 });
      }
      return;
    }

    const containerRatio = rect.width / rect.height;
    const mediaRatio = sourceWidth / sourceHeight;
    let drawWidth = rect.width;
    let drawHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (mediaRatio > containerRatio) {
      drawHeight = rect.width / mediaRatio;
      offsetY = 0;
    } else {
      drawWidth = rect.height * mediaRatio;
      offsetX = 0;
    }
    setMediaRect({
      x: Math.max(0, offsetX),
      y: Math.max(0, offsetY),
      width: Math.max(1, drawWidth),
      height: Math.max(1, drawHeight),
    });
  }, []);

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
  const normalizeRegionsForWs = (regionList) => {
    const frameSize = getFrameSize();
    if (!Array.isArray(regionList)) return [];
    if (!frameSize || frameSize.width <= 0 || frameSize.height <= 0) {
      return regionList
        .map((region) => ({
          id: region.id,
          name: region.name,
          x: Number(region.x),
          y: Number(region.y),
          w: Number(region.w),
          h: Number(region.h),
          color: region.color,
        }))
        .filter((region) =>
          isFiniteNumber(region.x) &&
          isFiniteNumber(region.y) &&
          isFiniteNumber(region.w) &&
          isFiniteNumber(region.h)
        );
    }
    const { width, height } = frameSize;
    return regionList
      .map((region) => ({
        id: region.id,
        name: region.name,
        x: clamp((Number(region.x) / width) * 100, 0, 100),
        y: clamp((Number(region.y) / height) * 100, 0, 100),
        w: clamp((Number(region.w) / width) * 100, 1, 100),
        h: clamp((Number(region.h) / height) * 100, 1, 100),
        color: region.color,
      }))
      .filter((region) =>
        isFiniteNumber(region.x) &&
        isFiniteNumber(region.y) &&
        isFiniteNumber(region.w) &&
        isFiniteNumber(region.h)
      );
  };
  const activeCameraProfile = cameraProfiles.find((p) => p.id === activeCameraProfileId) || null;
  const activeCameraName = activeCameraProfile?.name || 'default';
  const streamAspectRatio = sourceSize.width > 0 && sourceSize.height > 0
    ? `${sourceSize.width} / ${sourceSize.height}`
    : '16 / 9';
  const displayZoomPct = sourceSize.width > 0
    ? Math.max(1, Math.round((mediaRect.width / sourceSize.width) * 100))
    : 100;

  const shouldUpdateDisplayFrame = () => {
    const now = performance.now();
    const targetFps = showVideoSettingsRef.current ? ADJUSTING_PREVIEW_FPS : NORMAL_PREVIEW_FPS;
    const intervalMs = 1000 / targetFps;
    if (now - lastDisplayFrameAtRef.current < intervalMs) return false;
    lastDisplayFrameAtRef.current = now;
    return true;
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
    streamingProfileIdRef.current = activeCameraProfileId;
    setStreamingProfileId(activeCameraProfileId);
    // 新規 WebSocket 接続
    setConnectionStatus('connecting', '接続中...');
    const socket = new WebSocket(`${WS_BASE_URL}/ws/stream`);
    ws.current = socket;

    socket.onopen = () => {
      if (ws.current !== socket) return;
      console.log('WebSocket connected');
      socket.send(JSON.stringify({
        type: 'start',
        source: target,
        cameraName: activeCameraName,
        regions: normalizeRegionsForWs(regions),
        model: selectedModel || undefined,
        preprocess: toPreprocessPayload(videoSettings),
        detectionSettings: toDetectionSettingsPayload(detectionSettings),
        previewPreprocess: showVideoSettings,
        showInferenceOverlay: !hideInferenceResults,
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
      if (typeof msg !== 'string') return;

      const handleIncomingFrame = (rawBase64) => {
        const frameData = `data:image/jpeg;base64,${rawBase64}`;
        latestImageDataRef.current = frameData;
        clearFirstFrameTimeout();
        lastFrameAtRef.current = Date.now();
        autoReconnectCountRef.current = 0;
        if (connectionStateRef.current !== 'streaming') {
          clearStartTimeout();
          setConnectionStatus('streaming', 'ストリーミング中');
          setIsStreaming(true);
          setStreamingProfileId(streamingProfileIdRef.current || activeCameraProfileId);
        }
        if (activeTabRef.current === 'stream' && shouldUpdateDisplayFrame()) {
          const now = performance.now();
          if (lastDisplayFrameTsRef.current > 0) {
            const delta = now - lastDisplayFrameTsRef.current;
            if (delta > 0) {
              const instant = 1000 / delta;
              fpsEmaRef.current = fpsEmaRef.current > 0 ? fpsEmaRef.current * 0.85 + instant * 0.15 : instant;
              setDisplayFps(fpsEmaRef.current);
            }
          }
          lastDisplayFrameTsRef.current = now;
          setImageData(frameData);
        }
      };

      if (msg.startsWith('ERROR')) {
        clearStartTimeout();
        clearStopTimeout();
        setConnectionStatus('error', msg);
        setIsStreaming(false);
        alert(msg);
        return;
      }
      const isLikelyJson = msg.startsWith('{') || msg.startsWith('[');
      if (isLikelyJson) {
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
            setStreamingProfileId(streamingProfileIdRef.current || activeCameraProfileId);
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
            if (!desiredStreamingRef.current) {
              streamingProfileIdRef.current = '';
              setStreamingProfileId('');
            }
            if (desiredStreamingRef.current) {
              scheduleAutoReconnect('ストリームが停止しました');
            }
          } else if (state === 'error') {
            clearStartTimeout();
            clearStopTimeout();
            clearFirstFrameTimeout();
            setConnectionStatus('error', statusMessage || 'ストリームエラー');
            setIsStreaming(false);
            if (!desiredStreamingRef.current) {
              streamingProfileIdRef.current = '';
              setStreamingProfileId('');
            }
            scheduleAutoReconnect(statusMessage || 'ストリームエラー');
          }
          return;
        }
        if (payload.image) {
          handleIncomingFrame(payload.image);
        }
        if (Array.isArray(payload.results)) {
          const now = performance.now();
          if (now - lastRegionValuesAtRef.current < (1000 / REGION_VALUES_UPDATE_FPS)) {
            return;
          }
          lastRegionValuesAtRef.current = now;
          const nextValues = {};
          payload.results.forEach((item) => {
            if (item && item.id) {
              nextValues[item.id] = typeof item.value === 'string' ? item.value : '';
            }
          });
          setRegionValues(nextValues);
        } else if (Array.isArray(payload.counts)) {
          const now = performance.now();
          if (now - lastRegionValuesAtRef.current < (1000 / REGION_VALUES_UPDATE_FPS)) {
            return;
          }
          lastRegionValuesAtRef.current = now;
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
      }
      handleIncomingFrame(msg);
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
        if (!desiredStreamingRef.current) {
          streamingProfileIdRef.current = '';
          setStreamingProfileId('');
        }
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
        const response = await fetch(`${API_BASE_URL}/models`);
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
    const legacyRegionsRaw = window.localStorage.getItem(REGION_STORAGE_KEY);
    const legacySettingsRaw = window.localStorage.getItem(VIDEO_SETTINGS_STORAGE_KEY);
    const lastUsedRaw = window.localStorage.getItem(LAST_USED_CAMERA_SETTINGS_KEY);
    let legacyRegions = [];
    let legacySettings = DEFAULT_VIDEO_SETTINGS;
    let lastUsedSettings = null;
    try {
      legacyRegions = sanitizeRegions(JSON.parse(legacyRegionsRaw || '[]'));
    } catch (error) {
      console.warn('Failed to parse stored regions', error);
    }
    try {
      legacySettings = sanitizeVideoSettings(JSON.parse(legacySettingsRaw || '{}'));
    } catch (error) {
      console.warn('Failed to parse video settings', error);
    }
    try {
      lastUsedSettings = sanitizeLastUsedCameraSettings(JSON.parse(lastUsedRaw || 'null'));
    } catch (error) {
      console.warn('Failed to parse last used camera settings', error);
    }

    const rawProfiles = window.localStorage.getItem(CAMERA_PROFILES_KEY);
    let profiles = [];
    if (rawProfiles) {
      try {
        const parsed = JSON.parse(rawProfiles);
        profiles = Array.isArray(parsed)
          ? parsed.map((p) => sanitizeCameraProfile(
            { ...p, regions: sanitizeRegions(p?.regions || []) },
            p?.name || 'camera'
          ))
          : [];
      } catch (error) {
        console.warn('Failed to parse camera profiles', error);
      }
    }
    if (profiles.length === 0) {
      profiles = [sanitizeCameraProfile({
        id: crypto.randomUUID(),
        name: 'default',
        sourceType: 'url',
        streamUrl: '',
        deviceIndex: '0',
        model: '',
        regions: legacyRegions,
        videoSettings: legacySettings,
        detectionSettings: DEFAULT_DETECTION_SETTINGS,
      }, 'default')];
    }

    const storedActiveId = window.localStorage.getItem(ACTIVE_CAMERA_PROFILE_KEY) || '';
    let activeId = profiles.some((p) => p.id === storedActiveId) ? storedActiveId : profiles[0].id;
    if (lastUsedSettings) {
      const preferredId = lastUsedSettings.activeCameraProfileId;
      const targetId = profiles.some((p) => p.id === preferredId) ? preferredId : activeId;
      profiles = profiles.map((profile) => (
        profile.id === targetId
          ? sanitizeCameraProfile(
            {
              ...profile,
              sourceType: lastUsedSettings.sourceType,
              streamUrl: lastUsedSettings.streamUrl,
              deviceIndex: lastUsedSettings.deviceIndex,
              model: lastUsedSettings.model || profile.model,
              videoSettings: lastUsedSettings.videoSettings,
              detectionSettings: lastUsedSettings.detectionSettings,
            },
            profile.name || 'camera',
          )
          : profile
      ));
      activeId = targetId;
    }

    setCameraProfiles(profiles);
    setActiveCameraProfileId(activeId);
  }, []);

  useEffect(() => {
    if (!activeCameraProfile) return;
    frameSizeRef.current = { width: 0, height: 0 };
    setMediaRect({ x: 0, y: 0, width: 0, height: 0 });
    profileHydratingRef.current = activeCameraProfile.id;
    setSourceType(activeCameraProfile.sourceType);
    setStreamUrl(activeCameraProfile.streamUrl);
    setDeviceIndex(activeCameraProfile.deviceIndex);
    setRegions(sanitizeRegions(activeCameraProfile.regions));
    setVideoSettings(sanitizeVideoSettings(activeCameraProfile.videoSettings));
    setDetectionSettings(sanitizeDetectionSettings(activeCameraProfile.detectionSettings));
    setSelectedModel(activeCameraProfile.model || modelOptions[0] || '');
    const timer = window.setTimeout(() => {
      if (profileHydratingRef.current === activeCameraProfile.id) {
        profileHydratingRef.current = '';
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeCameraProfileId, modelOptions]);

  const stopStream = () => {
    desiredStreamingRef.current = false;
    streamingProfileIdRef.current = '';
    setStreamingProfileId('');
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

  const shutdownApplication = async () => {
    if (isShuttingDown) return;
    const confirmed = window.confirm('アプリを終了します。フロントエンドとバックエンドを停止しますか？');
    if (!confirmed) return;

    setIsShuttingDown(true);
    try {
      if (isStreaming) {
        stopStream();
      }
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 2200);
      try {
        await fetch(`${API_BASE_URL}/api/v1/app/shutdown`, {
          method: 'POST',
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
    } catch (error) {
      console.warn('app shutdown request failed', error);
    } finally {
      window.setTimeout(() => {
        try {
          window.open('', '_self');
          window.close();
        } catch (_closeError) {
          // no-op
        }
        window.location.replace('about:blank');
      }, 120);
      window.setTimeout(() => setIsShuttingDown(false), 2400);
    }
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

  const updateDetectionSetting = (key, value) => {
    setDetectionSettings((prev) => sanitizeDetectionSettings({
      ...prev,
      [key]: value,
    }));
  };

  const resetVideoSettings = () => {
    setVideoSettings(sanitizeVideoSettings(DEFAULT_VIDEO_SETTINGS));
  };

  const resetDetectionSettings = () => {
    const nextSettings = sanitizeDetectionSettings(DEFAULT_DETECTION_SETTINGS);
    setDetectionSettings(nextSettings);
    if (!activeCameraProfileId) return;
    setCameraProfiles((prev) => prev.map((profile) => (
      profile.id === activeCameraProfileId
        ? {
            ...profile,
            detectionSettings: nextSettings,
          }
        : profile
    )));
  };

  const createCameraProfile = () => {
    const name = window.prompt('カメラ設定名を入力してください');
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (cameraProfiles.some((p) => p.name === trimmed)) {
      alert('同じ名前のカメラ設定は作成できません。');
      return;
    }
    const newProfile = sanitizeCameraProfile({
      id: crypto.randomUUID(),
      name: trimmed,
      sourceType: 'url',
      streamUrl: '',
      deviceIndex: '0',
      model: selectedModel || '',
      regions: [],
      videoSettings: DEFAULT_VIDEO_SETTINGS,
      detectionSettings: DEFAULT_DETECTION_SETTINGS,
    }, trimmed);
    setCameraProfiles((prev) => [...prev, newProfile]);
    setActiveCameraProfileId(newProfile.id);
  };

  const deleteCameraProfile = (targetId = activeCameraProfileId) => {
    if (cameraProfiles.length <= 1) {
      alert('最後の1件は削除できません。');
      return;
    }
    const target = cameraProfiles.find((profile) => profile.id === targetId) || null;
    if (!target) return;
    if (!window.confirm(`カメラ設定「${target.name}」を削除しますか？`)) return;
    const nextProfiles = cameraProfiles.filter((p) => p.id !== target.id);
    setCameraProfiles(nextProfiles);
    if (activeCameraProfileId === target.id) {
      setActiveCameraProfileId(nextProfiles[0]?.id || '');
    }
  };

  const updateActiveCameraProfileName = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (cameraProfiles.some((p) => p.id !== activeCameraProfileId && p.name === trimmed)) {
      alert('同じ名前のカメラ設定は使用できません。');
      return;
    }
    setCameraProfiles((prev) => prev.map((profile) => (
      profile.id === activeCameraProfileId ? { ...profile, name: trimmed } : profile
    )));
  };

  const handleStreamClick = (event) => {
    const rect = getInteractionRect();
    if (!rect) return;
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

  const captureDisplayedFramePngBlob = async () => {
    if (showVideoSettings) {
      const canvas = streamCanvasRef.current;
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
        throw new Error('調整映像を取得できません。');
      }
      const canvasBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob || blob.size === 0) {
            reject(new Error('調整映像の画像化に失敗しました。'));
            return;
          }
          resolve(blob);
        }, 'image/png');
      });
      return canvasBlob;
    }

    const rawBlob = await captureCurrentFrameBlob();
    const rawDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result !== 'string' || !reader.result) {
          reject(new Error('フレームの読込に失敗しました。'));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error('フレームの読込に失敗しました。'));
      reader.readAsDataURL(rawBlob);
    });

    const pngBlob = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('画像変換に失敗しました。'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob || blob.size === 0) {
            reject(new Error('PNG変換に失敗しました。'));
            return;
          }
          resolve(blob);
        }, 'image/png');
      };
      img.onerror = () => reject(new Error('フレーム画像の読み込みに失敗しました。'));
      img.src = rawDataUrl;
    });
    return pngBlob;
  };

  const saveTestModeCapture = async () => {
    if (testCaptureSaving) return;
    setTestCaptureMessage('');
    setTestCaptureSaving(true);
    try {
      const frameBlob = await captureDisplayedFramePngBlob();
      const formData = new FormData();
      formData.append('image', frameBlob, 'capture.png');
      formData.append('save_dir', testCaptureSaveDir.trim());
      formData.append('save_dir_abs', testCaptureSaveDirAbs.trim());
      const response = await fetch(`${API_BASE_URL}/api/v1/test-mode/capture`, {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof payload.detail === 'string' ? payload.detail : '保存に失敗しました。';
        throw new Error(detail);
      }
      const savedPath = typeof payload.abs_path === 'string'
        ? payload.abs_path
        : (typeof payload.path === 'string' ? payload.path : '');
      setTestCaptureMessage(savedPath ? `保存完了: ${savedPath}` : '保存完了');
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存に失敗しました。';
      setTestCaptureMessage(`保存失敗: ${message}`);
    } finally {
      setTestCaptureSaving(false);
    }
  };

  const pickTestModeSaveDir = async () => {
    if (testCaptureSelectingDir) return;
    setTestCaptureSelectingDir(true);
    setTestCaptureMessage('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/test-mode/select-save-dir`, {
        method: 'POST',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof payload.detail === 'string' ? payload.detail : '保存先の選択に失敗しました。';
        throw new Error(detail);
      }
      const selectedDir = typeof payload.selected_dir === 'string' ? payload.selected_dir : '';
      if (!selectedDir) {
        throw new Error('保存先の選択に失敗しました。');
      }
      setTestCaptureSaveDirAbs(selectedDir);
      setTestCaptureMessage(`保存先を選択: ${selectedDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存先の選択に失敗しました。';
      setTestCaptureMessage(`保存先選択失敗: ${message}`);
    } finally {
      setTestCaptureSelectingDir(false);
    }
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
          formData.append('meter_id', activeCameraName);
          formData.append('model_type', 'yolo');
          formData.append('preprocess', preprocessPayload);
          formData.append('detection_settings', JSON.stringify(toDetectionSettingsPayload(detectionSettings)));

          const response = await fetch(`${API_BASE_URL}/api/v1/images`, {
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

  const drawAdjustedFrame = (ctx, canvas, image, settings, localPreviewEnabled) => {
    const sourceWidth = image.naturalWidth || image.videoWidth || image.width;
    const sourceHeight = image.naturalHeight || image.videoHeight || image.height;
    if (!sourceWidth || !sourceHeight) return;
    if (!settings) return;
    const hasAdjustments = (
      Math.abs(settings.brightness - 1) > 0.001
      || Math.abs(settings.contrast - 1) > 0.001
      || Math.abs(settings.gamma - 1) > 0.001
      || Math.abs(settings.sharpness) > 0.001
      || Math.abs(settings.highlightSuppression) > 0.001
      || Math.abs(settings.highlightRecovery) > 0.001
      || Boolean(settings.binarizationEnabled)
      || Boolean(settings.claheEnabled)
    );

    const previewMaxWidth = localPreviewEnabled ? HEAVY_PREVIEW_MAX_WIDTH : NORMAL_PREVIEW_MAX_WIDTH;
    const renderScale = Math.min(1, previewMaxWidth / sourceWidth);
    const renderWidth = Math.max(1, Math.round(sourceWidth * renderScale));
    const renderHeight = Math.max(1, Math.round(sourceHeight * renderScale));
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth;
      canvas.height = renderHeight;
    }
    ctx.drawImage(image, 0, 0, renderWidth, renderHeight);

    if (!localPreviewEnabled) return;
    if (!hasAdjustments) return;

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;
    applyBasicAdjustments(data, settings.brightness, settings.contrast, settings.gamma);
    applyHighlightRecovery(
      data,
      canvas.width,
      canvas.height,
      settings.highlightRecovery,
      settings.highlightRecoveryCurve
    );
    applyHighlightSuppression(data, settings.highlightSuppression);
    if (settings.binarizationEnabled) {
      applyBinarization(data, settings.binarizationThreshold);
    }
    if (settings.claheEnabled) {
      applyClaheToLuma(data, canvas.width, canvas.height, settings.claheClipLimit, settings.claheTileGridSize);
    }
    applySharpen(data, canvas.width, canvas.height, settings.sharpness);
    ctx.putImageData(frame, 0, 0);
  };

  useEffect(() => {
    if (!activeAction) return;

    const handleMove = (event) => {
      event.preventDefault();
      if (!dragRef.current) return;
      const drag = dragRef.current;
      const rect = getInteractionRect();
      if (!rect) return;
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
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(() => {
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
      const sanitized = normalizeRegionsForWs(regions);
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
    if (!activeCameraProfileId) return;
    if (activeAction) return;
    if (profileHydratingRef.current === activeCameraProfileId) return;
    setCameraProfiles((prev) => prev.map((profile) => (
      profile.id === activeCameraProfileId
        ? {
            ...profile,
            sourceType,
            streamUrl,
            deviceIndex,
            model: selectedModel,
            regions,
            videoSettings,
            detectionSettings,
          }
        : profile
    )));
  }, [
    activeCameraProfileId,
    sourceType,
    streamUrl,
    deviceIndex,
    selectedModel,
    regions,
    videoSettings,
    detectionSettings,
    activeAction,
  ]);

  useEffect(() => {
    if (!cameraProfiles.length) return;
    window.localStorage.setItem(CAMERA_PROFILES_KEY, JSON.stringify(cameraProfiles));
  }, [cameraProfiles]);

  useEffect(() => {
    if (!activeCameraProfileId) return;
    window.localStorage.setItem(ACTIVE_CAMERA_PROFILE_KEY, activeCameraProfileId);
  }, [activeCameraProfileId]);

  useEffect(() => {
    window.localStorage.setItem(CAMERA_SIDEBAR_COLLAPSED_KEY, isCameraSidebarCollapsed ? '1' : '0');
  }, [isCameraSidebarCollapsed]);

  useEffect(() => {
    if (!activeCameraProfileId) return;
    window.localStorage.setItem(
      LAST_USED_CAMERA_SETTINGS_KEY,
      JSON.stringify({
        activeCameraProfileId,
        sourceType,
        streamUrl,
        deviceIndex,
        model: selectedModel,
        videoSettings,
        detectionSettings,
      }),
    );
  }, [
    activeCameraProfileId,
    sourceType,
    streamUrl,
    deviceIndex,
    selectedModel,
    videoSettings,
    detectionSettings,
  ]);

  useEffect(() => {
    window.localStorage.setItem(TEST_CAPTURE_SAVE_DIR_KEY, testCaptureSaveDir);
  }, [testCaptureSaveDir]);

  useEffect(() => {
    window.localStorage.setItem(TEST_CAPTURE_SAVE_DIR_ABS_KEY, testCaptureSaveDirAbs);
  }, [testCaptureSaveDirAbs]);

  useEffect(() => {
    const flushCurrentSettings = () => {
      if (!activeCameraProfileId) return;
      const mergedProfiles = cameraProfiles.map((profile) => (
        profile.id === activeCameraProfileId
          ? {
              ...profile,
              sourceType,
              streamUrl,
              deviceIndex,
              model: selectedModel,
              regions,
              videoSettings,
              detectionSettings,
            }
          : profile
      ));
      window.localStorage.setItem(CAMERA_PROFILES_KEY, JSON.stringify(mergedProfiles));
      window.localStorage.setItem(ACTIVE_CAMERA_PROFILE_KEY, activeCameraProfileId);
    };
    window.addEventListener('beforeunload', flushCurrentSettings);
    return () => {
      window.removeEventListener('beforeunload', flushCurrentSettings);
    };
  }, [
    cameraProfiles,
    activeCameraProfileId,
    sourceType,
    streamUrl,
    deviceIndex,
    selectedModel,
    regions,
    videoSettings,
    detectionSettings,
  ]);

  useEffect(() => {
    if (!isStreaming) return;
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({
      type: 'preprocess',
      preprocess: toPreprocessPayload(videoSettings),
      detectionSettings: toDetectionSettingsPayload(detectionSettings),
      previewPreprocess: showVideoSettings,
      showInferenceOverlay: !hideInferenceResults,
    }));
  }, [videoSettings, detectionSettings, isStreaming, showVideoSettings, hideInferenceResults]);

  useEffect(() => {
    showVideoSettingsRef.current = showVideoSettings;
    if (!showVideoSettings) {
      lastDisplayFrameAtRef.current = 0;
    }
  }, [showVideoSettings]);

  useEffect(() => {
    computeMediaRect();
  }, [imageData, activeTab, computeMediaRect]);

  useEffect(() => {
    if (activeTab !== 'stream') return undefined;
    const node = videoShellRef.current;
    if (!node) return undefined;
    const updateHeight = (nextHeight) => {
      const rounded = Math.max(0, Math.round(nextHeight));
      setVideoShellHeight((prev) => (Math.abs(prev - rounded) <= 1 ? prev : rounded));
    };
    updateHeight(node.getBoundingClientRect().height || 0);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateHeight(entry.contentRect.height || 0);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [activeTab, streamAspectRatio]);

  useEffect(() => {
    if (activeTab !== 'stream') return undefined;
    const node = streamRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => {
      computeMediaRect();
    });
    observer.observe(node);
    window.addEventListener('resize', computeMediaRect);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', computeMediaRect);
    };
  }, [activeTab, computeMediaRect]);

  useEffect(() => {
    const toggledAdjustPanel = prevShowVideoSettingsRef.current !== showVideoSettings;
    prevShowVideoSettingsRef.current = showVideoSettings;
    if (toggledAdjustPanel) return;
    if (mediaRect.width <= 0 || mediaRect.height <= 0) return;
    const prev = frameSizeRef.current;
    if (prev.width > 0 && prev.height > 0) {
      const resized = Math.abs(prev.width - mediaRect.width) > 2 || Math.abs(prev.height - mediaRect.height) > 2;
      if (resized) {
        const scaleX = mediaRect.width / prev.width;
        const scaleY = mediaRect.height / prev.height;
        setRegions((current) => current.map((region) => ({
          ...region,
          x: clamp(region.x * scaleX, 0, Math.max(mediaRect.width - 20, 0)),
          y: clamp(region.y * scaleY, 0, Math.max(mediaRect.height - 20, 0)),
          w: clamp(region.w * scaleX, 20, Math.max(mediaRect.width, 20)),
          h: clamp(region.h * scaleY, 20, Math.max(mediaRect.height, 20)),
        })));
      }
    }
    frameSizeRef.current = { width: mediaRect.width, height: mediaRect.height };
  }, [mediaRect.width, mediaRect.height, showVideoSettings]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab === 'stream' && latestImageDataRef.current) {
      lastDisplayFrameAtRef.current = 0;
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
  }, [videoSettings]);

  useEffect(() => {
    if (!showSettingsDialog) return undefined;
    const resetPositionToRight = () => {
      const node = settingsDialogRef.current;
      const dialogWidth = node?.offsetWidth ?? Math.min(SETTINGS_DIALOG_DEFAULT_WIDTH, Math.max(320, window.innerWidth - 24));
      const initialLeft = window.innerWidth - dialogWidth - 24;
      const initialTop = 64;
      setSettingsDialogPosition(clampSettingsDialogPosition(initialLeft, initialTop));
    };
    const rafId = window.requestAnimationFrame(resetPositionToRight);
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setShowSettingsDialog(false);
      }
    };
    const handleResize = () => {
      setSettingsDialogPosition((prev) => clampSettingsDialogPosition(prev.left, prev.top));
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      settingsDialogDragRef.current = null;
      setIsSettingsDialogDragging(false);
    };
  }, [showSettingsDialog, clampSettingsDialogPosition]);

  useEffect(() => {
    if (!showSettingsDialog || !isSettingsDialogDragging) return undefined;
    const handleMouseMove = (event) => {
      if (!settingsDialogDragRef.current) return;
      const nextLeft = event.clientX - settingsDialogDragRef.current.offsetX;
      const nextTop = event.clientY - settingsDialogDragRef.current.offsetY;
      setSettingsDialogPosition(clampSettingsDialogPosition(nextLeft, nextTop));
    };
    const handleMouseUp = () => {
      settingsDialogDragRef.current = null;
      setIsSettingsDialogDragging(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [showSettingsDialog, isSettingsDialogDragging, clampSettingsDialogPosition]);

  useEffect(() => {
    if (activeTab !== 'stream' || !showVideoSettings) return undefined;
    drawStateRef.current = {
      imageVersion: -1,
      settingsVersion: -1,
      claheAt: 0,
      renderedAt: 0,
    };
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
            const localPreviewEnabled = true;
            const targetFps = ADJUSTING_PREVIEW_FPS;
            const renderIntervalMs = 1000 / targetFps;
            const shouldSkipRender = !settingsChanged && now - state.renderedAt < renderIntervalMs;
            if (shouldSkipRender) {
              drawRafRef.current = window.requestAnimationFrame(render);
              return;
            }
            const claheIntervalMs = localPreviewEnabled && videoSettings.claheEnabled ? 250 : 0;
            const canRenderClahe = !videoSettings.claheEnabled || settingsChanged || now - state.claheAt >= claheIntervalMs;
            if (canRenderClahe) {
              drawAdjustedFrame(ctx, canvas, image, videoSettings, localPreviewEnabled);
              state.imageVersion = imageVersionRef.current;
              state.settingsVersion = settingsVersionRef.current;
              state.renderedAt = now;
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
  }, [videoSettings, activeTab, showVideoSettings]);

  return (
    <div className={`container${isStreaming ? ' streaming' : ''}`}>
      <div className="tab-panels">
        <section
          className={`tab-panel stream-view${activeTab === 'stream' ? ' is-active' : ' is-hidden'}${isCameraSidebarCollapsed ? ' sidebar-collapsed' : ''}`}
          aria-hidden={activeTab !== 'stream'}
        >
          <header className="hero">
            <div className="hero-layout">
              <div className="hero-copy">
                <div className="title-line">
                  <div className="hero-topline">
                    <p className="eyebrow">Realtime Vision</p>
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
                      <button
                        type="button"
                        className={`tab-button ${showSettingsDialog ? 'active' : ''}`}
                        onClick={() => {
                          setActiveSettingsTab('yolo');
                          setShowSettingsDialog(true);
                        }}
                      >
                        Setting
                      </button>
                    </div>
                  </div>
                  <h2>Live Stream Viewer</h2>
                </div>
              </div>
            </div>
          </header>
          <div className={`stream-workspace${isCameraSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
              <aside className={`left-pane${isCameraSidebarCollapsed ? ' is-collapsed' : ''}`}>
                <div className="left-pane-header">
                  {!isCameraSidebarCollapsed && <h4>カメラ設定</h4>}
                  <div className="left-pane-actions">
                    {!isCameraSidebarCollapsed && (
                      <button className="secondary" type="button" onClick={createCameraProfile}>
                        設定を作成 +
                      </button>
                    )}
                    <button
                      className="secondary sidebar-toggle"
                      type="button"
                      onClick={() => setIsCameraSidebarCollapsed((prev) => !prev)}
                      aria-label={isCameraSidebarCollapsed ? '左サイドバーを開く' : '左サイドバーを閉じる'}
                    >
                      {isCameraSidebarCollapsed ? '▶' : '◀'}
                    </button>
                  </div>
                </div>
                <div className="left-pane-body">
                  {!isCameraSidebarCollapsed && (
                    <div className="camera-card-list">
                      {cameraProfiles.map((profile) => {
                        const isActiveProfile = profile.id === activeCameraProfileId;
                        const summarySource = isActiveProfile ? sourceType : (profile.sourceType || 'url');
                        const summaryDevice = summarySource === 'device'
                          ? `device:${isActiveProfile ? deviceIndex : (profile.deviceIndex || '0')}`
                          : (isActiveProfile ? (streamUrl || '-') : (profile.streamUrl || '-'));
                        const summaryModel = isActiveProfile ? (selectedModel || '-') : (profile.model || '-');
                        const summarySourceLabel = summarySource === 'device' ? 'デバイス' : 'URL';
                        const summaryEndpointLabel = summarySource === 'device' ? 'デバイス' : 'ストリームURL';
                        return (
                          <article
                            key={profile.id}
                            className={`camera-card${isActiveProfile ? ' active' : ''}`}
                          >
                            <div className="camera-card-head">
                              <button
                                type="button"
                                className="camera-card-summary"
                                onClick={() => {
                                  setActiveCameraProfileId(profile.id);
                                  setShowCameraSettings(false);
                                }}
                              >
                                <div className="camera-card-thumb">
                                  {isActiveProfile && isStreaming && streamingProfileId === profile.id && imageData ? (
                                    <img src={imageData} alt={`${profile.name} preview`} />
                                  ) : (
                                    <span>NO IMAGE</span>
                                  )}
                                </div>
                                <div className="camera-card-meta">
                                  <strong>{profile.name}</strong>
                                  <span>{isActiveProfile ? '選択中' : '未選択'}</span>
                                </div>
                              </button>
                              <div className="camera-card-head-actions">
                                <button
                                  type="button"
                                  className="secondary camera-toggle"
                                  onClick={() => {
                                    if (!isActiveProfile) {
                                      setActiveCameraProfileId(profile.id);
                                      setShowCameraSettings(true);
                                      return;
                                    }
                                    setShowCameraSettings((prev) => !prev);
                                  }}
                                >
                                  {isActiveProfile && showCameraSettings ? '閉' : '開'}
                                </button>
                              </div>
                            </div>
                            {isActiveProfile && !showCameraSettings && (
                              <div className="camera-card-summaryline">
                                <div className="camera-card-titleline">
                                  <strong>{profile.name}</strong>
                                  <button
                                    className={`primary camera-stream-toggle ${isStreaming ? 'danger' : ''}`}
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
                                          : 'ストリーム'}
                                  </button>
                                </div>
                                <span>入力ソース:{summarySourceLabel}</span>
                                <span>{summaryEndpointLabel}:{summaryDevice}</span>
                                <span>モデル:{summaryModel}</span>
                              </div>
                            )}
                            {isActiveProfile && showCameraSettings && (
                              <div className="camera-card-body">
                                <label className="field">
                                  <span>設定名</span>
                                  <input
                                    type="text"
                                    key={activeCameraProfileId}
                                    defaultValue={activeCameraName}
                                    onBlur={(e) => updateActiveCameraProfileName(e.target.value)}
                                  />
                                </label>
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
                                  <label className="field">
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
                                  <label className="field">
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
                                <div className="camera-card-actions">
                                  <button
                                    className="secondary"
                                    type="button"
                                    onClick={() => deleteCameraProfile(profile.id)}
                                  >
                                    設定を削除
                                  </button>
                                </div>
                                {(connectionState !== 'idle' || connectionMessage) && (
                                  <p className={`muted connection-line state-${connectionState}`}>
                                    状態: {connectionState}
                                    {connectionMessage ? ` / ${connectionMessage}` : ''}
                                  </p>
                                )}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="left-pane-footer">
                  <button
                    className="primary danger sidebar-exit-button"
                    type="button"
                    onClick={shutdownApplication}
                    disabled={isShuttingDown}
                    aria-label="アプリ終了"
                    title="フロントエンドとバックエンドを終了"
                  >
                    {isShuttingDown ? '終了中...' : (isCameraSidebarCollapsed ? '⏻' : 'アプリ終了')}
                  </button>
                </div>
              </aside>
              <div
                className={`preview${isCameraSidebarCollapsed ? ' sidebar-collapsed' : ''}`}
                style={{ '--video-shell-height': videoShellHeight > 0 ? `${videoShellHeight}px` : undefined }}
              >
              <div className="stream-column">
                <div
                  ref={videoShellRef}
                  className="video-shell"
                  style={{ '--stream-aspect-ratio': streamAspectRatio }}
                >
                  <div
                    className={`stream-frame${showVideoSettings ? ' is-adjusting' : ' is-raw'}`}
                    ref={streamRef}
                  >
                    {showVideoSettings && (
                      <div className="stream-adjusting-indicator">映像調整中</div>
                    )}
                    <div className="stream-metrics-overlay">
                      FPS: {displayFps > 0 ? displayFps.toFixed(1) : '-'} Zoom: {displayZoomPct}%
                    </div>
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
                        className={`stream-source${showVideoSettings ? ' is-hidden' : ' is-visible'}`}
                        onLoad={() => {
                          imageVersionRef.current += 1;
                          setSourceSize({
                            width: sourceImageRef.current?.naturalWidth || 0,
                            height: sourceImageRef.current?.naturalHeight || 0,
                          });
                          computeMediaRect();
                        }}
                      />
                    ) : (
                      <div className="stream-frame-placeholder">
                        映像受信待ち...
                      </div>
                    )}
                    {!hideRoiRegions && (
                      <div
                        className="region-layer"
                        ref={regionLayerRef}
                        style={{
                          left: `${mediaRect.x}px`,
                          top: `${mediaRect.y}px`,
                          width: `${mediaRect.width}px`,
                          height: `${mediaRect.height}px`,
                        }}
                      >
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
                              const rect = getInteractionRect();
                              if (!rect) return;
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
                                event.preventDefault();
                                event.stopPropagation();
                                const rect = getInteractionRect();
                                if (!rect) return;
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
                    )}
                  </div>
                </div>
                <div className="left-bottom">
                  <div className="stream-header">
                    <h3>{activeCameraName}</h3>
                    <div className="stream-actions">
                      <button className="ghost" type="button" onClick={addRegion}>
                        領域作成 +
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="right-pane">
                <aside className="results">
                  <details className="results-section" open>
                    <summary>領域結果</summary>
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
                  </details>
                </aside>
              </div>
              </div>
            </div>
        </section>
        <section
          className={`tab-panel dashboard-view${activeTab === 'dashboard' ? ' is-active' : ' is-hidden'}`}
          aria-hidden={activeTab !== 'dashboard'}
        >
          <div className="dashboard-tab-row">
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
              <button
                type="button"
                className={`tab-button ${showSettingsDialog ? 'active' : ''}`}
                onClick={() => {
                  setActiveSettingsTab('yolo');
                  setShowSettingsDialog(true);
                }}
              >
                Setting
              </button>
            </div>
          </div>
          <DashboardPage />
        </section>
        {showSettingsDialog && (
          <div
            className="settings-dialog-backdrop"
            onClick={() => setShowSettingsDialog(false)}
          >
            <section
              ref={settingsDialogRef}
              className={`settings-dialog${isSettingsDialogDragging ? ' dragging' : ''}`}
              role="dialog"
              aria-modal="true"
              aria-label="Setting"
              style={{
                left: `${settingsDialogPosition.left}px`,
                top: `${settingsDialogPosition.top}px`,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div
                className="settings-dialog-header"
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  if (event.target.closest('button')) return;
                  const rect = settingsDialogRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  event.preventDefault();
                  settingsDialogDragRef.current = {
                    offsetX: event.clientX - rect.left,
                    offsetY: event.clientY - rect.top,
                  };
                  setIsSettingsDialogDragging(true);
                }}
              >
                <h3>Setting</h3>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setShowSettingsDialog(false)}
                >
                  Close
                </button>
              </div>
              <div className="settings-dialog-tabs">
                <button
                  type="button"
                  className={`settings-tab ${activeSettingsTab === 'yolo' ? 'active' : ''}`}
                  onClick={() => setActiveSettingsTab('yolo')}
                >
                  YOLO
                </button>
                <button
                  type="button"
                  className={`settings-tab ${activeSettingsTab === 'image' ? 'active' : ''}`}
                  onClick={() => setActiveSettingsTab('image')}
                >
                  Image
                </button>
                <button
                  type="button"
                  className={`settings-tab ${activeSettingsTab === 'test' ? 'active' : ''}`}
                  onClick={() => setActiveSettingsTab('test')}
                >
                  Test
                </button>
              </div>
              <div className="settings-dialog-body">
                {activeSettingsTab === 'yolo' && (
                  <div className="settings-tab-panel">
                    <div className="video-settings-header">
                      <h4>YOLO検出設定</h4>
                      <button className="secondary" type="button" onClick={resetDetectionSettings}>
                        Reset
                      </button>
                    </div>
                    <div className="setting-details-body">
                      <label className="setting-row setting-row--stacked">
                        <span>検出確信度（閾値）</span>
                        <input
                          type="range"
                          min="0.01"
                          max="0.99"
                          step="0.01"
                          value={detectionSettings.confidenceThreshold}
                          onChange={(event) => updateDetectionSetting('confidenceThreshold', Number(event.target.value))}
                        />
                        <strong className="setting-value">{detectionSettings.confidenceThreshold.toFixed(2)}</strong>
                      </label>
                      <label className="setting-row setting-row--stacked">
                        <span>検出頻度（何フレームごとに結果更新するか）</span>
                        <input
                          type="range"
                          min="1"
                          max="20"
                          step="1"
                          value={detectionSettings.resultIntervalFrames}
                          onChange={(event) => updateDetectionSetting('resultIntervalFrames', Number(event.target.value))}
                        />
                        <strong className="setting-value">{Math.round(detectionSettings.resultIntervalFrames)}f</strong>
                      </label>
                      <label className="setting-row setting-row--stacked">
                        <span>NMS IoU（重複抑制）</span>
                        <input
                          type="range"
                          min="0.10"
                          max="0.95"
                          step="0.01"
                          value={detectionSettings.nmsIouThreshold}
                          onChange={(event) => updateDetectionSetting('nmsIouThreshold', Number(event.target.value))}
                        />
                        <strong className="setting-value">{detectionSettings.nmsIouThreshold.toFixed(2)}</strong>
                      </label>
                      <label className="setting-checkbox">
                        <input
                          type="checkbox"
                          checked={detectionSettings.mergeSameDigits}
                          onChange={(event) => updateDetectionSetting('mergeSameDigits', event.target.checked)}
                        />
                        <span>同一文字の近接マージを有効化（例: 000→0 の抑制）</span>
                      </label>
                      <label className="setting-row setting-row--stacked">
                        <span>同一文字マージ: 行方向許容</span>
                        <input
                          type="range"
                          min="0.05"
                          max="2.0"
                          step="0.05"
                          value={detectionSettings.mergeSameDigitsRowTolerance}
                          onChange={(event) => updateDetectionSetting('mergeSameDigitsRowTolerance', Number(event.target.value))}
                          disabled={!detectionSettings.mergeSameDigits}
                        />
                        <strong className="setting-value">{detectionSettings.mergeSameDigitsRowTolerance.toFixed(2)}</strong>
                      </label>
                      <label className="setting-row setting-row--stacked">
                        <span>同一文字マージ: 横方向近接</span>
                        <input
                          type="range"
                          min="0.01"
                          max="2.0"
                          step="0.01"
                          value={detectionSettings.mergeSameDigitsXGapRatio}
                          onChange={(event) => updateDetectionSetting('mergeSameDigitsXGapRatio', Number(event.target.value))}
                          disabled={!detectionSettings.mergeSameDigits}
                        />
                        <strong className="setting-value">{detectionSettings.mergeSameDigitsXGapRatio.toFixed(2)}</strong>
                      </label>
                    </div>
                  </div>
                )}
                {activeSettingsTab === 'image' && (
                  <aside className="video-settings">
                    <div className="video-settings-header">
                      <h4>映像調整</h4>
                      <button className="secondary" type="button" onClick={resetVideoSettings}>
                        Reset
                      </button>
                    </div>
                    <div className="video-settings-body">
                      <div className="setting-section">
                        <label className="setting-checkbox">
                          <input
                            type="checkbox"
                            checked={showVideoSettings}
                            onChange={(event) => setShowVideoSettings(event.target.checked)}
                          />
                          <span>映像調整プレビューを有効化</span>
                        </label>
                        <label className="setting-checkbox">
                          <input
                            type="checkbox"
                            checked={hideRoiRegions}
                            onChange={(event) => setHideRoiRegions(event.target.checked)}
                          />
                          <span>ROI領域を非表示</span>
                        </label>
                        <label className="setting-checkbox">
                          <input
                            type="checkbox"
                            checked={hideInferenceResults}
                            onChange={(event) => setHideInferenceResults(event.target.checked)}
                          />
                          <span>推論結果を非表示（映像内）</span>
                        </label>
                      </div>
                      <div className="setting-section">
                        <p className="setting-title">基本補正</p>
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
                      </div>
                      <details className="setting-details" open>
                        <summary>白飛び補正</summary>
                        <div className="setting-details-body">
                          <label className="setting-row setting-row--stacked">
                            <span>白飛び抑制(白飛びを抑える)</span>
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
                          <p className="setting-title">復元</p>
                          <label className="setting-row setting-row--stacked">
                            <span>復元方式</span>
                            <select
                              value={videoSettings.highlightRecoveryMode}
                              onChange={(event) => updateVideoSetting('highlightRecoveryMode', event.target.value)}
                            >
                              <option value="natural">自然光復元</option>
                              <option value="line">線状白飛び復元</option>
                            </select>
                          </label>
                          <label className="setting-row setting-row--stacked">
                            <span>復元強度</span>
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.05"
                              value={videoSettings.highlightRecovery}
                              onChange={(event) => updateVideoSetting('highlightRecovery', Number(event.target.value))}
                            />
                            <strong className="setting-value">{videoSettings.highlightRecovery.toFixed(2)}</strong>
                          </label>
                          <label className="setting-row setting-row--stacked">
                            <span>復元カーブ(復元の効き方)</span>
                            <input
                              type="range"
                              min="0.5"
                              max="3"
                              step="0.05"
                              value={videoSettings.highlightRecoveryCurve}
                              onChange={(event) => updateVideoSetting('highlightRecoveryCurve', Number(event.target.value))}
                            />
                            <strong className="setting-value">{videoSettings.highlightRecoveryCurve.toFixed(2)}</strong>
                          </label>
                          {videoSettings.highlightRecoveryMode === 'line' && (
                            <>
                              <p className="setting-title">線状白飛び詳細</p>
                              <label className="setting-row setting-row--stacked">
                                <span>線状復元探索距離(px)</span>
                                <input
                                  type="range"
                                  min="3"
                                  max="20"
                                  step="1"
                                  value={videoSettings.highlightLineMaxDist}
                                  onChange={(event) => updateVideoSetting('highlightLineMaxDist', Number(event.target.value))}
                                />
                                <strong className="setting-value">{videoSettings.highlightLineMaxDist.toFixed(0)}</strong>
                              </label>
                              <label className="setting-row setting-row--stacked">
                                <span>横連結距離(px)</span>
                                <input
                                  type="range"
                                  min="3"
                                  max="25"
                                  step="1"
                                  value={videoSettings.highlightLineKernelWidth}
                                  onChange={(event) => updateVideoSetting('highlightLineKernelWidth', Number(event.target.value))}
                                />
                                <strong className="setting-value">{videoSettings.highlightLineKernelWidth.toFixed(0)}</strong>
                              </label>
                            </>
                          )}
                        </div>
                      </details>
                      <div className="setting-section">
                        <label className="setting-checkbox">
                          <input
                            type="checkbox"
                            checked={videoSettings.binarizationEnabled}
                            onChange={(event) => updateVideoSetting('binarizationEnabled', event.target.checked)}
                          />
                          <span>2値化を有効化</span>
                        </label>
                        <label className="setting-row">
                          <span>threshold</span>
                          <input
                            type="range"
                            min="0"
                            max="255"
                            step="1"
                            value={videoSettings.binarizationThreshold}
                            onChange={(event) => updateVideoSetting('binarizationThreshold', Number(event.target.value))}
                          />
                          <strong className="setting-value">{videoSettings.binarizationThreshold.toFixed(0)}</strong>
                        </label>
                      </div>
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
                    </div>
                  </aside>
                )}
                {activeSettingsTab === 'test' && (
                  <div className="settings-tab-panel">
                    <h4>テストモード（学習用画像撮影）</h4>
                    <div className="setting-details-body">
                      <p className="muted">
                        表示中の映像を inbo ディレクトリへ <code>yyyymmddhhmmss.png</code> 形式で保存します。
                      </p>
                      <label className="field">
                        <span>保存先（inbo配下）</span>
                        <input
                          type="text"
                          value={testCaptureSaveDir}
                          list="test-capture-dir-options"
                          onChange={(event) => {
                            setTestCaptureSaveDir(event.target.value);
                            if (testCaptureSaveDirAbs) setTestCaptureSaveDirAbs('');
                          }}
                          placeholder="空欄で inbo 直下 / 例: train/cam01"
                        />
                        <datalist id="test-capture-dir-options">
                          <option value="" />
                          <option value="train" />
                          <option value="train/cam01" />
                          <option value="valid" />
                        </datalist>
                      </label>
                      <div className="camera-settings-actions">
                        <button
                          className="secondary"
                          type="button"
                          onClick={pickTestModeSaveDir}
                          disabled={testCaptureSelectingDir}
                        >
                          {testCaptureSelectingDir ? '参照中...' : 'ローカル参照...'}
                        </button>
                        {testCaptureSaveDirAbs && (
                          <button
                            className="ghost"
                            type="button"
                            onClick={() => setTestCaptureSaveDirAbs('')}
                          >
                            絶対パス指定を解除
                          </button>
                        )}
                      </div>
                      <p className="muted">
                        現在の保存先:
                        {' '}
                        <code>
                          {testCaptureSaveDirAbs.trim()
                            ? testCaptureSaveDirAbs.trim()
                            : `backend/data/inbo${testCaptureSaveDir.trim() ? `/${testCaptureSaveDir.trim()}` : ''}`}
                        </code>
                      </p>
                      <button
                        className="secondary"
                        type="button"
                        onClick={saveTestModeCapture}
                        disabled={testCaptureSaving || !imageData}
                      >
                        {testCaptureSaving ? '保存中...' : '現在フレームを保存'}
                      </button>
                      {testCaptureMessage && (
                        <p className="muted test-capture-message">{testCaptureMessage}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
