import React, { useEffect, useMemo, useState } from 'react';

import { fetchStreamCameras, fetchStreamDates, fetchStreamReadings } from './api';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
  }, [selectedCamera, selectedDate]);

  return (
    <div className="dashboard-shell">
      <div className="dashboard-toolbar">
        <h2>Meter Dashboard</h2>
        <button className="ghost" type="button" onClick={loadCameras} disabled={loading}>
          {loading ? '更新中...' : '再読み込み'}
        </button>
      </div>

      {error && <p className="error-line">{error}</p>}

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

      <ReadingsChart points={filteredRows} />
    </div>
  );
}

export default DashboardPage;
