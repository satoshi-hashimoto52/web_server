import React, { useEffect, useMemo, useState } from 'react';

import { fetchLatestReadings, fetchMeters, fetchReadings, updateMeter } from './api';

const jstFormat = (ts) => {
  if (!ts) return '-';
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return ts;
  return dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
};

const jstShortFormat = (ts) => {
  if (!ts) return '';
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return String(ts);
  return dt.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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

  return (
    <div className="dashboard-card">
      <h3>時系列グラフ</h3>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="meter history chart">
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.35)" />
          <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="rgba(255,255,255,0.35)" />
          <polyline fill="none" stroke="#3bd7a6" strokeWidth="2.5" points={polyline} />
          {points.map((p, idx) => {
            const x = toX(idx);
            const y = toY(Number(p.value ?? 0));
            return (
              <g key={`${p.ts}-${idx}`}>
                <circle cx={x} cy={y} r="3.5" fill="#3aa0ff" />
                <text
                  x={x}
                  y={Math.min(height - 4, y + 14)}
                  textAnchor="middle"
                  fontSize="9"
                  fill="rgba(248,251,255,0.85)"
                >
                  {jstShortFormat(p.ts)}
                </text>
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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedMeter = useMemo(
    () => meters.find((m) => m.meter_id === selectedMeterId) || null,
    [meters, selectedMeterId],
  );

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
        const rows = await fetchReadings(selectedMeterId);
        setReadingHistory(Array.isArray(rows) ? rows : []);
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

      <ReadingsChart points={readingHistory} />

      <MeterSettingsPanel meter={selectedMeter} onSave={handleSaveMeter} saving={saving} />
    </div>
  );
}

export default DashboardPage;
