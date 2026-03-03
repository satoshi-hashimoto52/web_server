import React, { useEffect, useMemo, useState } from 'react';

import {
  fetchMeters,
  fetchStreamCameras,
  fetchStreamDates,
  fetchStreamReadings,
  updateMeter,
} from './api';

const JST_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });
const DEFAULT_FETCH_INTERVAL_SEC = 5;
const DEFAULT_ANOMALY_CONFIRM_COUNT = 3;
const DEFAULT_NOTIFY_COOLDOWN_MINUTES = 5;
const DEFAULT_STATUS_DELAY_SECONDS = 20;
const DEFAULT_STATUS_DOWN_SECONDS = 120;

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatTimestamp(value) {
  const date = parseTimestamp(value);
  if (!date) return '-';
  return date.toLocaleString('ja-JP', { hour12: false });
}

function formatLag(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 60) return `${Math.floor(seconds)}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}分${remainSeconds}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60}分`;
}

function classifyStatus(lagSeconds, isToday, delaySeconds, downSeconds) {
  if (!isToday) return 'history';
  if (!Number.isFinite(lagSeconds)) return 'down';
  if (lagSeconds <= delaySeconds) return 'normal';
  if (lagSeconds <= downSeconds) return 'delay';
  return 'down';
}

function statusLabel(status) {
  if (status === 'normal') return '正常';
  if (status === 'delay') return '遅延';
  if (status === 'down') return '断';
  return '履歴';
}

function statusClass(status) {
  if (status === 'normal') return 'status-normal';
  if (status === 'delay') return 'status-delay';
  if (status === 'down') return 'status-down';
  return 'status-history';
}

function toCsvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function ReadingsChart({ points }) {
  const numericPoints = points
    .map((p) => ({
      ...p,
      v: Number(p.value_num),
    }))
    .filter((p) => Number.isFinite(p.v));

  if (!numericPoints.length) {
    return (
      <div className="dashboard-card">
        <h3>時系列グラフ</h3>
        <p className="muted">表示できる数値データがありません。</p>
      </div>
    );
  }

  const width = 680;
  const height = 240;
  const padding = 26;
  const values = numericPoints.map((p) => p.v);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const isFlat = maxValue === minValue;
  const range = maxValue - minValue || 1;

  const toX = (idx) => {
    if (numericPoints.length <= 1) return padding;
    return padding + (idx / (numericPoints.length - 1)) * (width - padding * 2);
  };

  const toY = (value) => {
    if (isFlat) return height / 2;
    const normalized = (value - minValue) / range;
    return height - padding - normalized * (height - padding * 2);
  };

  const polyline = numericPoints
    .map((p, idx) => `${toX(idx)},${toY(p.v)}`)
    .join(' ');
  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount }, (_, idx) => {
    const ratio = idx / (yTickCount - 1);
    const value = maxValue - range * ratio;
    return {
      y: padding + (height - padding * 2) * ratio,
      label: Number.isInteger(value) ? String(value) : value.toFixed(1),
    };
  });

  return (
    <div className="dashboard-card">
      <h3>時系列グラフ</h3>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="meter history chart">
          {yTicks.map((tick) => (
            <g key={`y-tick-${tick.y}`}>
              <line
                x1={padding}
                y1={tick.y}
                x2={width - padding}
                y2={tick.y}
                stroke="rgba(255,255,255,0.12)"
              />
              <text
                x={padding - 6}
                y={tick.y + 3}
                textAnchor="end"
                fontSize="10"
                fill="rgba(248,251,255,0.75)"
              >
                {tick.label}
              </text>
            </g>
          ))}
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.35)" />
          <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="rgba(255,255,255,0.35)" />
          <polyline fill="none" stroke="#3bd7a6" strokeWidth="2.5" points={polyline} />
          {numericPoints.map((p, idx) => {
            const x = toX(idx);
            const y = toY(p.v);
            return (
              <g key={`${p.ts}-${idx}`}>
                <circle cx={x} cy={y} r="3.5" fill="#3aa0ff" />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-meta">
        <span>最小: {minValue}</span>
        <span>最大: {maxValue}</span>
        <span>件数: {numericPoints.length}</span>
      </div>
    </div>
  );
}

function DashboardPage() {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState('');
  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [rows, setRows] = useState([]);
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [meters, setMeters] = useState([]);
  const [thresholdHighInput, setThresholdHighInput] = useState('');
  const [thresholdLowInput, setThresholdLowInput] = useState('');
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [fetchIntervalInput, setFetchIntervalInput] = useState(String(DEFAULT_FETCH_INTERVAL_SEC));
  const [anomalyConfirmInput, setAnomalyConfirmInput] = useState(String(DEFAULT_ANOMALY_CONFIRM_COUNT));
  const [notifyCooldownInput, setNotifyCooldownInput] = useState(String(DEFAULT_NOTIFY_COOLDOWN_MINUTES));
  const [statusDelayInput, setStatusDelayInput] = useState(String(DEFAULT_STATUS_DELAY_SECONDS));
  const [statusDownInput, setStatusDownInput] = useState(String(DEFAULT_STATUS_DOWN_SECONDS));
  const [meterSaving, setMeterSaving] = useState(false);
  const [meterMessage, setMeterMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  const regionOptions = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => {
      const id = String(row.region_id || '');
      if (!id) return;
      if (!map.has(id)) {
        map.set(id, String(row.region_name || id));
      }
    });
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (!selectedRegionId) return [];
    return rows.filter((row) => String(row.region_id || '') === selectedRegionId);
  }, [rows, selectedRegionId]);

  const selectedMeter = useMemo(
    () => meters.find((meter) => String(meter.meter_id || '') === selectedCamera) || null,
    [meters, selectedCamera],
  );

  const todayJst = JST_DATE_FORMATTER.format(new Date());
  const isTodaySelected = selectedDate === todayJst;

  const latestCameraRow = useMemo(() => rows[rows.length - 1] || null, [rows]);
  const latestRegionRow = useMemo(() => filteredRows[filteredRows.length - 1] || null, [filteredRows]);

  const cameraLagSeconds = useMemo(() => {
    if (!latestCameraRow?.ts) return Number.NaN;
    const ts = parseTimestamp(latestCameraRow.ts);
    if (!ts) return Number.NaN;
    return (Date.now() - ts.getTime()) / 1000;
  }, [latestCameraRow]);

  const regionLagSeconds = useMemo(() => {
    if (!latestRegionRow?.ts) return Number.NaN;
    const ts = parseTimestamp(latestRegionRow.ts);
    if (!ts) return Number.NaN;
    return (Date.now() - ts.getTime()) / 1000;
  }, [latestRegionRow]);

  const numericFilteredRows = useMemo(() => (
    filteredRows
      .map((row) => ({ ...row, numericValue: Number(row.value_num) }))
      .filter((row) => Number.isFinite(row.numericValue))
  ), [filteredRows]);

  const thresholdHigh = useMemo(() => {
    const value = Number(selectedMeter?.threshold_high);
    return Number.isFinite(value) ? value : null;
  }, [selectedMeter]);

  const thresholdLow = useMemo(() => {
    const value = Number(selectedMeter?.threshold_low);
    return Number.isFinite(value) ? value : null;
  }, [selectedMeter]);

  const hasThreshold = thresholdHigh != null || thresholdLow != null;

  const fetchIntervalSec = useMemo(() => {
    const value = Number(selectedMeter?.fetch_interval_sec);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_FETCH_INTERVAL_SEC;
    return Math.floor(value);
  }, [selectedMeter]);

  const anomalyConfirmCount = useMemo(() => {
    const value = Number(selectedMeter?.anomaly_confirm_count);
    if (!Number.isFinite(value) || value < 1) return DEFAULT_ANOMALY_CONFIRM_COUNT;
    return Math.floor(value);
  }, [selectedMeter]);

  const notifyCooldownMinutes = useMemo(() => {
    const value = Number(selectedMeter?.notify_cooldown_minutes);
    if (!Number.isFinite(value) || value < 0) return DEFAULT_NOTIFY_COOLDOWN_MINUTES;
    return Math.floor(value);
  }, [selectedMeter]);

  const statusDelaySeconds = useMemo(() => {
    const value = Number(selectedMeter?.status_delay_seconds);
    if (!Number.isFinite(value) || value < 1) return DEFAULT_STATUS_DELAY_SECONDS;
    return Math.floor(value);
  }, [selectedMeter]);

  const statusDownSeconds = useMemo(() => {
    const value = Number(selectedMeter?.status_down_seconds);
    if (!Number.isFinite(value) || value <= statusDelaySeconds) {
      return Math.max(DEFAULT_STATUS_DOWN_SECONDS, statusDelaySeconds + 1);
    }
    return Math.floor(value);
  }, [selectedMeter, statusDelaySeconds]);

  const cameraStatus = classifyStatus(cameraLagSeconds, isTodaySelected, statusDelaySeconds, statusDownSeconds);
  const regionStatus = classifyStatus(regionLagSeconds, isTodaySelected, statusDelaySeconds, statusDownSeconds);

  const regionStatuses = useMemo(() => {
    return regionOptions.map((region) => {
      const latest = [...rows].reverse().find((row) => String(row.region_id || '') === region.id);
      const ts = latest?.ts;
      const date = parseTimestamp(ts);
      const lagSeconds = date ? (Date.now() - date.getTime()) / 1000 : Number.NaN;
      const status = classifyStatus(lagSeconds, isTodaySelected, statusDelaySeconds, statusDownSeconds);
      return {
        id: region.id,
        name: region.name,
        ts,
        lagSeconds,
        status,
      };
    });
  }, [regionOptions, rows, isTodaySelected, statusDelaySeconds, statusDownSeconds]);

  const anomalySummary = useMemo(() => {
    if (!hasThreshold) {
      return {
        count: 0,
        longestRunCount: 0,
        longestRunSeconds: 0,
        recent: [],
      };
    }
    let count = 0;
    let longestRunCount = 0;
    let longestRunSeconds = 0;
    let currentRunCount = 0;
    let currentRunStart = null;
    let previousTs = null;
    const recent = [];

    numericFilteredRows.forEach((row) => {
      const value = row.numericValue;
      const ts = parseTimestamp(row.ts);
      const isHigh = thresholdHigh != null && value > thresholdHigh;
      const isLow = thresholdLow != null && value < thresholdLow;
      const anomaly = isHigh || isLow;
      if (anomaly) {
        currentRunCount += 1;
        if (!currentRunStart) currentRunStart = ts;
        previousTs = ts;
        if (currentRunCount === anomalyConfirmCount) {
          count += 1;
          recent.push({
            ts: row.ts,
            value,
            reason: isHigh ? 'HIGH' : 'LOW',
          });
        }
      } else if (currentRunCount > 0) {
        longestRunCount = Math.max(longestRunCount, currentRunCount);
        if (currentRunStart && previousTs) {
          const runSeconds = Math.max(0, (previousTs.getTime() - currentRunStart.getTime()) / 1000);
          longestRunSeconds = Math.max(longestRunSeconds, runSeconds);
        }
        currentRunCount = 0;
        currentRunStart = null;
        previousTs = null;
      }
    });

    if (currentRunCount > 0) {
      longestRunCount = Math.max(longestRunCount, currentRunCount);
      if (currentRunStart && previousTs) {
        const runSeconds = Math.max(0, (previousTs.getTime() - currentRunStart.getTime()) / 1000);
        longestRunSeconds = Math.max(longestRunSeconds, runSeconds);
      }
    }

    return {
      count,
      longestRunCount,
      longestRunSeconds,
      recent: recent.slice(-5).reverse(),
    };
  }, [numericFilteredRows, thresholdHigh, thresholdLow, hasThreshold, anomalyConfirmCount]);

  const loadMeters = async () => {
    try {
      const data = await fetchMeters();
      const list = Array.isArray(data) ? data : [];
      setMeters(list);
    } catch (e) {
      console.error(e);
    }
  };

  const loadCameras = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchStreamCameras();
      const list = Array.isArray(data?.cameras) ? data.cameras : [];
      setCameras(list);
      setSelectedCamera((prev) => prev || list[0] || '');
    } catch (e) {
      setError('カメラ一覧の取得に失敗しました。');
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCameras();
    loadMeters();
  }, []);

  useEffect(() => {
    if (!selectedCamera) {
      setDates([]);
      setSelectedDate('');
      setRows([]);
      return;
    }
    const loadDates = async () => {
      setError('');
      try {
        const data = await fetchStreamDates(selectedCamera);
        const list = Array.isArray(data?.dates) ? data.dates : [];
        setDates(list);
        setSelectedDate((prev) => (prev && list.includes(prev) ? prev : (list[0] || '')));
      } catch (e) {
        setError('日付一覧の取得に失敗しました。');
        console.error(e);
      }
    };
    loadDates();
  }, [selectedCamera]);

  useEffect(() => {
    if (!selectedCamera || !selectedDate) {
      setRows([]);
      setSelectedRegionId('');
      return;
    }
    const loadRows = async () => {
      setError('');
      try {
        const data = await fetchStreamReadings(selectedCamera, selectedDate);
        const list = Array.isArray(data) ? data : [];
        setRows(list);
        const firstRegion = list.find((row) => row.region_id)?.region_id || '';
        setSelectedRegionId((prev) => (
          prev && list.some((row) => String(row.region_id || '') === prev)
            ? prev
            : String(firstRegion || '')
        ));
      } catch (e) {
        setError('履歴データの取得に失敗しました。');
        console.error(e);
      }
    };
    loadRows();
  }, [selectedCamera, selectedDate, refreshToken]);

  useEffect(() => {
    if (!selectedCamera || !selectedDate || !isTodaySelected) return undefined;
    const intervalMs = Math.max(1, fetchIntervalSec) * 1000;
    const intervalId = window.setInterval(() => {
      setRefreshToken((prev) => prev + 1);
    }, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [selectedCamera, selectedDate, isTodaySelected, fetchIntervalSec]);

  useEffect(() => {
    setThresholdHighInput(selectedMeter?.threshold_high ?? '');
    setThresholdLowInput(selectedMeter?.threshold_low ?? '');
    setAlertEnabled(selectedMeter?.enabled !== 0);
    setFetchIntervalInput(String(selectedMeter?.fetch_interval_sec ?? DEFAULT_FETCH_INTERVAL_SEC));
    setAnomalyConfirmInput(String(selectedMeter?.anomaly_confirm_count ?? DEFAULT_ANOMALY_CONFIRM_COUNT));
    setNotifyCooldownInput(String(selectedMeter?.notify_cooldown_minutes ?? DEFAULT_NOTIFY_COOLDOWN_MINUTES));
    setStatusDelayInput(String(selectedMeter?.status_delay_seconds ?? DEFAULT_STATUS_DELAY_SECONDS));
    setStatusDownInput(String(selectedMeter?.status_down_seconds ?? DEFAULT_STATUS_DOWN_SECONDS));
    setMeterMessage('');
  }, [
    selectedMeter?.meter_id,
    selectedMeter?.threshold_high,
    selectedMeter?.threshold_low,
    selectedMeter?.enabled,
    selectedMeter?.fetch_interval_sec,
    selectedMeter?.anomaly_confirm_count,
    selectedMeter?.notify_cooldown_minutes,
    selectedMeter?.status_delay_seconds,
    selectedMeter?.status_down_seconds,
  ]);

  const handleSaveMeter = async () => {
    if (!selectedCamera) return;
    setMeterSaving(true);
    setMeterMessage('');
    const high = String(thresholdHighInput).trim();
    const low = String(thresholdLowInput).trim();
    const fetchInterval = String(fetchIntervalInput).trim();
    const anomalyConfirm = String(anomalyConfirmInput).trim();
    const notifyCooldown = String(notifyCooldownInput).trim();
    const statusDelay = String(statusDelayInput).trim();
    const statusDown = String(statusDownInput).trim();
    const payload = {
      threshold_high: high === '' ? null : Number(high),
      threshold_low: low === '' ? null : Number(low),
      enabled: alertEnabled,
      fetch_interval_sec: fetchInterval === '' ? null : Number(fetchInterval),
      anomaly_confirm_count: anomalyConfirm === '' ? null : Number(anomalyConfirm),
      notify_cooldown_minutes: notifyCooldown === '' ? null : Number(notifyCooldown),
      status_delay_seconds: statusDelay === '' ? null : Number(statusDelay),
      status_down_seconds: statusDown === '' ? null : Number(statusDown),
    };
    if (
      (payload.threshold_high != null && !Number.isFinite(payload.threshold_high))
      || (payload.threshold_low != null && !Number.isFinite(payload.threshold_low))
    ) {
      setMeterMessage('閾値は数値で入力してください。');
      setMeterSaving(false);
      return;
    }
    if (
      payload.fetch_interval_sec != null
      && (!Number.isFinite(payload.fetch_interval_sec) || payload.fetch_interval_sec < 1)
    ) {
      setMeterMessage('取得間隔は1秒以上の整数で入力してください。');
      setMeterSaving(false);
      return;
    }
    if (
      payload.anomaly_confirm_count != null
      && (!Number.isFinite(payload.anomaly_confirm_count) || payload.anomaly_confirm_count < 1)
    ) {
      setMeterMessage('異常確定回数は1以上の整数で入力してください。');
      setMeterSaving(false);
      return;
    }
    if (
      payload.notify_cooldown_minutes != null
      && (!Number.isFinite(payload.notify_cooldown_minutes) || payload.notify_cooldown_minutes < 0)
    ) {
      setMeterMessage('通知クールダウンは0以上の整数で入力してください。');
      setMeterSaving(false);
      return;
    }
    if (
      payload.status_delay_seconds != null
      && (!Number.isFinite(payload.status_delay_seconds) || payload.status_delay_seconds < 1)
    ) {
      setMeterMessage('遅延判定秒数は1以上の整数で入力してください。');
      setMeterSaving(false);
      return;
    }
    if (
      payload.status_down_seconds != null
      && (!Number.isFinite(payload.status_down_seconds) || payload.status_down_seconds < 1)
    ) {
      setMeterMessage('断判定秒数は1以上の整数で入力してください。');
      setMeterSaving(false);
      return;
    }
    if (
      payload.status_delay_seconds != null
      && payload.status_down_seconds != null
      && payload.status_down_seconds <= payload.status_delay_seconds
    ) {
      setMeterMessage('断判定秒数は遅延判定秒数より大きくしてください。');
      setMeterSaving(false);
      return;
    }

    payload.fetch_interval_sec = payload.fetch_interval_sec == null ? null : Math.floor(payload.fetch_interval_sec);
    payload.anomaly_confirm_count = payload.anomaly_confirm_count == null ? null : Math.floor(payload.anomaly_confirm_count);
    payload.notify_cooldown_minutes = payload.notify_cooldown_minutes == null ? null : Math.floor(payload.notify_cooldown_minutes);
    payload.status_delay_seconds = payload.status_delay_seconds == null ? null : Math.floor(payload.status_delay_seconds);
    payload.status_down_seconds = payload.status_down_seconds == null ? null : Math.floor(payload.status_down_seconds);
    try {
      const updated = await updateMeter(selectedCamera, payload);
      setMeters((prev) => {
        const exists = prev.some((meter) => String(meter.meter_id) === selectedCamera);
        if (!exists) return [...prev, updated];
        return prev.map((meter) => (
          String(meter.meter_id) === selectedCamera ? updated : meter
        ));
      });
      setMeterMessage('通知設定を保存しました。');
    } catch (e) {
      console.error(e);
      setMeterMessage('通知設定の保存に失敗しました。');
    } finally {
      setMeterSaving(false);
    }
  };

  const handleExportCsv = () => {
    const header = [
      'id',
      'camera_name',
      'region_id',
      'region_name',
      'ts',
      'value_text',
      'value_num',
      'confidence',
      'is_anomaly',
    ];
    const lines = [header.map(toCsvCell).join(',')];

    filteredRows.forEach((row) => {
      const numericValue = Number(row.value_num);
      const isHigh = thresholdHigh != null && Number.isFinite(numericValue) && numericValue > thresholdHigh;
      const isLow = thresholdLow != null && Number.isFinite(numericValue) && numericValue < thresholdLow;
      const isAnomaly = isHigh || isLow;
      const cells = [
        row.id,
        row.camera_name,
        row.region_id,
        row.region_name,
        row.ts,
        row.value_text,
        row.value_num,
        row.confidence,
        isAnomaly ? '1' : '0',
      ];
      lines.push(cells.map(toCsvCell).join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const suffix = selectedRegionId || 'all';
    link.href = url;
    link.download = `stream_${selectedCamera || 'camera'}_${selectedDate || 'date'}_${suffix}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="dashboard-shell">
      <div className="dashboard-toolbar">
        <h2>Meter Dashboard</h2>
        <button className="ghost" type="button" onClick={loadCameras} disabled={loading}>
          {loading ? '更新中...' : '再読み込み'}
        </button>
      </div>

      {error && <p className="error-line">{error}</p>}

      <div className="dashboard-overview">
        <div className="dashboard-card stat-card">
          <h3>データ鮮度</h3>
          <div className="stat-row">
            <span>最終受信(カメラ)</span>
            <strong>{formatTimestamp(latestCameraRow?.ts)}</strong>
          </div>
          <div className="stat-row">
            <span>遅延(カメラ)</span>
            <strong>{formatLag(cameraLagSeconds)}</strong>
          </div>
          <div className="stat-row">
            <span>最終受信(領域)</span>
            <strong>{formatTimestamp(latestRegionRow?.ts)}</strong>
          </div>
          <div className="stat-row">
            <span>遅延(領域)</span>
            <strong>{formatLag(regionLagSeconds)}</strong>
          </div>
          <div className="stat-row">
            <span>自動取得間隔</span>
            <strong>{fetchIntervalSec}秒</strong>
          </div>
          {!isTodaySelected && (
            <p className="muted">選択日が本日ではないため、状態判定は履歴表示です。</p>
          )}
        </div>

        <div className="dashboard-card stat-card">
          <h3>稼働状態</h3>
          <div className="status-line">
            <span>カメラ全体</span>
            <strong className={`status-pill ${statusClass(cameraStatus)}`}>{statusLabel(cameraStatus)}</strong>
          </div>
          <div className="status-line">
            <span>選択領域</span>
            <strong className={`status-pill ${statusClass(regionStatus)}`}>{statusLabel(regionStatus)}</strong>
          </div>
          <div className="region-status-list">
            {regionStatuses.length === 0 ? (
              <p className="muted">領域データなし</p>
            ) : (
              regionStatuses.map((region) => (
                <div key={region.id} className="region-status-item">
                  <span>{region.name}</span>
                  <strong className={`status-pill ${statusClass(region.status)}`}>{statusLabel(region.status)}</strong>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="dashboard-card stat-card">
          <h3>異常サマリ</h3>
          <div className="stat-row">
            <span>異常確定回数</span>
            <strong>{hasThreshold ? anomalySummary.count : '-'}</strong>
          </div>
          <div className="stat-row">
            <span>最大連続逸脱</span>
            <strong>{hasThreshold ? `${anomalySummary.longestRunCount}件` : '-'}</strong>
          </div>
          <div className="stat-row">
            <span>最大連続逸脱時間</span>
            <strong>{hasThreshold ? formatLag(anomalySummary.longestRunSeconds) : '-'}</strong>
          </div>
          <div className="anomaly-list">
            <div className="result-label">直近アラート（連続{anomalyConfirmCount}回で確定）</div>
            {hasThreshold && anomalySummary.recent.length > 0 ? (
              <ul className="dashboard-mini-list">
                {anomalySummary.recent.map((item, index) => (
                  <li key={`${item.ts}-${index}`}>
                    <span>{formatTimestamp(item.ts)}</span>
                    <strong>{item.value}</strong>
                    <span>{item.reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{hasThreshold ? '直近の逸脱なし' : '閾値未設定'}</p>
            )}
          </div>
        </div>
      </div>

      <div className="dashboard-filters">
        <div className="dashboard-card">
          <h3>meter選択</h3>
          <select
            value={selectedCamera}
            onChange={(e) => setSelectedCamera(e.target.value)}
            disabled={loading || cameras.length === 0}
          >
            {cameras.length === 0 ? (
              <option value="">データなし</option>
            ) : (
              cameras.map((camera) => (
                <option key={camera} value={camera}>
                  {camera}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="dashboard-card">
          <h3>日付選択</h3>
          <select
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            disabled={dates.length === 0}
          >
            {dates.length === 0 ? (
              <option value="">データなし</option>
            ) : (
              dates.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="dashboard-card">
          <h3>領域名選択</h3>
          <select
            value={selectedRegionId}
            onChange={(e) => setSelectedRegionId(e.target.value)}
            disabled={regionOptions.length === 0}
          >
            {regionOptions.length === 0 ? (
              <option value="">データなし</option>
            ) : (
              regionOptions.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.name}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <div className="dashboard-main">
        <ReadingsChart points={filteredRows} />

        <div className="dashboard-card">
          <h3>閾値/通知設定</h3>
          <div className="dashboard-settings">
            <label className="field">
              <span>上限閾値</span>
              <input
                type="number"
                step="0.1"
                value={thresholdHighInput}
                onChange={(e) => setThresholdHighInput(e.target.value)}
                placeholder="未設定"
              />
            </label>
            <label className="field">
              <span>下限閾値</span>
              <input
                type="number"
                step="0.1"
                value={thresholdLowInput}
                onChange={(e) => setThresholdLowInput(e.target.value)}
                placeholder="未設定"
              />
            </label>
            <label className="setting-checkbox">
              <input
                type="checkbox"
                checked={alertEnabled}
                onChange={(e) => setAlertEnabled(e.target.checked)}
              />
              <span>通知を有効化（Slack Webhook）</span>
            </label>
            <label className="field">
              <span>取得間隔（秒）</span>
              <input
                type="number"
                min="1"
                step="1"
                value={fetchIntervalInput}
                onChange={(e) => setFetchIntervalInput(e.target.value)}
              />
            </label>
            <label className="field">
              <span>異常確定条件（連続回数）</span>
              <input
                type="number"
                min="1"
                step="1"
                value={anomalyConfirmInput}
                onChange={(e) => setAnomalyConfirmInput(e.target.value)}
              />
            </label>
            <label className="field">
              <span>通知クールダウン（分）</span>
              <input
                type="number"
                min="0"
                step="1"
                value={notifyCooldownInput}
                onChange={(e) => setNotifyCooldownInput(e.target.value)}
              />
            </label>
            <label className="field">
              <span>遅延判定（秒）</span>
              <input
                type="number"
                min="1"
                step="1"
                value={statusDelayInput}
                onChange={(e) => setStatusDelayInput(e.target.value)}
              />
            </label>
            <label className="field">
              <span>断判定（秒）</span>
              <input
                type="number"
                min="1"
                step="1"
                value={statusDownInput}
                onChange={(e) => setStatusDownInput(e.target.value)}
              />
            </label>
            <button className="primary" type="button" onClick={handleSaveMeter} disabled={meterSaving || !selectedCamera}>
              {meterSaving ? '保存中...' : '通知設定を保存'}
            </button>
            {meterMessage && <p className="muted">{meterMessage}</p>}
          </div>
        </div>
      </div>

      <div className="dashboard-card">
        <div className="dashboard-toolbar">
          <h3>データエクスポート</h3>
          <button
            className="ghost"
            type="button"
            onClick={handleExportCsv}
            disabled={!filteredRows.length}
          >
            CSVダウンロード
          </button>
        </div>
        <p className="muted">選択中のカメラ・日付・領域の履歴をCSV出力します。</p>
      </div>
    </div>
  );
}

export default DashboardPage;
