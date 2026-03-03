const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5050';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }
  return response.json();
}

export function fetchLatestReadings() {
  return request('/api/v1/readings/latest');
}

export function fetchReadings(meterId, fromTs, toTs) {
  const params = new URLSearchParams({ meter_id: meterId });
  if (fromTs) params.set('from', fromTs);
  if (toTs) params.set('to', toTs);
  return request(`/api/v1/readings?${params.toString()}`);
}

export function fetchStreamCameras() {
  return request('/api/v1/stream/cameras');
}

export function fetchStreamDates(cameraName) {
  const params = new URLSearchParams({ camera_name: cameraName });
  return request(`/api/v1/stream/dates?${params.toString()}`);
}

export function fetchStreamReadings(cameraName, date, regionId) {
  const params = new URLSearchParams({ camera_name: cameraName, date });
  if (regionId) params.set('region_id', regionId);
  return request(`/api/v1/stream/readings?${params.toString()}`);
}

export function fetchMeters() {
  return request('/api/v1/meters');
}

export function updateMeter(meterId, payload) {
  return request(`/api/v1/meters/${encodeURIComponent(meterId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

export { API_BASE_URL };
