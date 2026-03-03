import React, { useEffect, useMemo, useState } from 'react';

import { fetchLatestReadings, fetchMeters, fetchReadings, updateMeter } from './api';

const jstFormat = (ts) => {
  if (!ts) return '-';
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return ts;
  return dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
};

const toJstDateKey = (ts) => {
  if (!ts) return '';
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric' });
  const m = dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit' });
  const d = dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', day: '2-digit' });
  return `${y}-${m}-${d}`;
};

function LatestReadingsTable({ readings }) {
  return (
    <div className="dashboard-card">
      <h3>最新値一覧</h3>
      {readings.length === 0 ? (
        <p className="muted">データがありません。</p>
      ) : (
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>meter_id</th>
              <th>value</th>
              <th>ts (JST)</th>
              <th>confidence</th>
            </tr>
          </thead>
          <tbody>
            {readings.map((item) => (
              <tr key={`${item.meter_id}-${item.ts}`}>
                <td>{item.meter_id}</td>
                <td>{item.value ?? '-'}</td>
                <td>{jstFormat(item.ts)}</td>
                <td>{item.confidence ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReadingsChart({ points }) {
  if (!points.length) {
    return (
      <div className="dashboard-card">
        <h3>時系列グラフ</h3>
        <p className="muted">表示できるデータがありません。</p>
      </div>
    );
  }

  const width = 680;
  const height = 240;
  const padding = 26;
  const values = points.map((p) => Number(p.value ?? 0));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const isFlat = maxValue === minValue;
  const range = maxValue - minValue || 1;

  const toX = (idx) => {
    if (points.length <= 1) return padding;
    return padding + (idx / (points.length - 1)) * (width - padding * 2);
  };

  const toY = (value) => {
    if (isFlat) {
      return height / 2;
    }
    const normalized = (value - minValue) / range;
    return height - padding - normalized * (height - padding * 2);
  };

  const polyline = points
    .map((p, idx) => `${toX(idx)},${toY(Number(p.value ?? 0))}`)
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
          {points.map((p, idx) => {
            const x = toX(idx);
            const y = toY(Number(p.value ?? 0));
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
        <span>件数: {points.length}</span>
      </div>
    </div>
  );
}

function MeterSettingsPanel({ meter, onSave, saving }) {
  const [thresholdHigh, setThresholdHigh] = useState('');
  const [thresholdLow, setThresholdLow] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setThresholdHigh(meter?.threshold_high ?? '');
    setThresholdLow(meter?.threshold_low ?? '');
    setEnabled(Number(meter?.enabled ?? 1) === 1);
  }, [meter]);

  if (!meter) {
    return (
      <div className="dashboard-card">
        <h3>閾値設定</h3>
        <p className="muted">meterを選択してください。</p>
      </div>
    );
  }

  const toNumberOrNull = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
  };

  return (
    <div className="dashboard-card">
      <h3>閾値設定</h3>
      <p className="muted">meter_id: {meter.meter_id}</p>
      <div className="settings-grid">
        <label className="field">
          <span>threshold_high</span>
          <input
            type="number"
            step="0.01"
            value={thresholdHigh}
            onChange={(e) => setThresholdHigh(e.target.value)}
          />
        </label>
        <label className="field">
          <span>threshold_low</span>
          <input
            type="number"
            step="0.01"
            value={thresholdLow}
            onChange={(e) => setThresholdLow(e.target.value)}
          />
        </label>
        <label className="field field-toggle">
          <span>enabled</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </label>
      </div>
      <button
        className="primary"
        type="button"
        disabled={saving}
        onClick={() =>
          onSave(meter.meter_id, {
            threshold_high: toNumberOrNull(thresholdHigh),
            threshold_low: toNumberOrNull(thresholdLow),
            enabled,
          })
        }
      >
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  );
}

function DashboardPage() {
  const [latestReadings, setLatestReadings] = useState([]);
  const [meters, setMeters] = useState([]);
  const [selectedMeterId, setSelectedMeterId] = useState('');
  const [readingHistory, setReadingHistory] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedMeter = useMemo(
    () => meters.find((m) => m.meter_id === selectedMeterId) || null,
    [meters, selectedMeterId],
  );
  const dateOptions = useMemo(() => {
    const unique = new Set(
      readingHistory
        .map((row) => toJstDateKey(row.ts))
        .filter((key) => key),
    );
    return Array.from(unique).sort((a, b) => (a < b ? 1 : -1));
  }, [readingHistory]);
  const filteredHistory = useMemo(() => {
    if (!selectedDate) return readingHistory;
    return readingHistory.filter((row) => toJstDateKey(row.ts) === selectedDate);
  }, [readingHistory, selectedDate]);

  const loadDashboard = async () => {
    setLoading(true);
    setError('');
    try {
      const [latest, meterList] = await Promise.all([fetchLatestReadings(), fetchMeters()]);
      setLatestReadings(Array.isArray(latest) ? latest : []);
      setMeters(Array.isArray(meterList) ? meterList : []);

      const meterCandidates = (Array.isArray(meterList) ? meterList : []).map((m) => m.meter_id);
      const latestCandidates = (Array.isArray(latest) ? latest : []).map((r) => r.meter_id);
      const candidate = selectedMeterId || meterCandidates[0] || latestCandidates[0] || '';
      setSelectedMeterId(candidate);
    } catch (e) {
      setError('データ取得に失敗しました。');
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  useEffect(() => {
    if (!selectedMeterId) {
      setReadingHistory([]);
      return;
    }

    const loadHistory = async () => {
      setError('');
      try {
        const toTs = new Date().toISOString();
        const fromTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const rows = await fetchReadings(selectedMeterId, fromTs, toTs);
        const nextRows = Array.isArray(rows) ? rows : [];
        setReadingHistory(nextRows);
        const nextDateOptions = Array.from(
          new Set(nextRows.map((row) => toJstDateKey(row.ts)).filter((key) => key)),
        ).sort((a, b) => (a < b ? 1 : -1));
        setSelectedDate((prev) => (prev && nextDateOptions.includes(prev) ? prev : (nextDateOptions[0] || '')));
      } catch (e) {
        setError('履歴取得に失敗しました。');
        console.error(e);
      }
    };

    loadHistory();
  }, [selectedMeterId]);

  const handleSaveMeter = async (meterId, payload) => {
    setSaving(true);
    setError('');
    try {
      await updateMeter(meterId, payload);
      await loadDashboard();
    } catch (e) {
      setError('メータ設定の保存に失敗しました。');
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-shell">
      <div className="dashboard-toolbar">
        <h2>Meter Dashboard</h2>
        <button className="ghost" type="button" onClick={loadDashboard} disabled={loading}>
          {loading ? '更新中...' : '再読み込み'}
        </button>
      </div>

      {error && <p className="error-line">{error}</p>}

      <LatestReadingsTable readings={latestReadings} />

      <div className="dashboard-card">
        <h3>meter選択</h3>
        <select
          value={selectedMeterId}
          onChange={(e) => setSelectedMeterId(e.target.value)}
          disabled={loading || (meters.length === 0 && latestReadings.length === 0)}
        >
          {(meters.length ? meters : latestReadings).map((item) => {
            const id = item.meter_id;
            return (
              <option value={id} key={id}>
                {id}
              </option>
            );
          })}
        </select>
      </div>

      <div className="dashboard-card">
        <h3>日付選択</h3>
        <select
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          disabled={dateOptions.length === 0}
        >
          {dateOptions.length === 0 ? (
            <option value="">データなし</option>
          ) : (
            dateOptions.map((date) => (
              <option value={date} key={date}>
                {date}
              </option>
            ))
          )}
        </select>
      </div>

      <ReadingsChart points={filteredHistory} />

      <MeterSettingsPanel meter={selectedMeter} onSave={handleSaveMeter} saving={saving} />
    </div>
  );
}

export default DashboardPage;
