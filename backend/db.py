import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")


def init_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY,
                meter_id TEXT,
                ts DATETIME,
                value REAL,
                confidence REAL,
                image_path TEXT,
                model_type TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meters (
                meter_id TEXT PRIMARY KEY,
                name TEXT,
                location TEXT,
                threshold_high REAL,
                threshold_low REAL,
                enabled INTEGER
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alert_states (
                meter_id TEXT PRIMARY KEY,
                last_notified_ts DATETIME
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS stream_readings (
                id INTEGER PRIMARY KEY,
                camera_name TEXT NOT NULL,
                region_id TEXT NOT NULL,
                region_name TEXT,
                ts DATETIME NOT NULL,
                value_text TEXT,
                value_num REAL,
                confidence REAL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def insert_reading(
    meter_id: str,
    value: Optional[float],
    confidence: float,
    image_path: str,
    model_type: str,
) -> Dict[str, object]:
    ts = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO readings (meter_id, ts, value, confidence, image_path, model_type)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (meter_id, ts, value, confidence, image_path, model_type),
        )
        conn.commit()
        reading_id = cursor.lastrowid
    finally:
        conn.close()

    return {
        "id": reading_id,
        "meter_id": meter_id,
        "ts": ts,
        "value": value,
        "confidence": confidence,
        "image_path": image_path,
        "model_type": model_type,
    }


def get_latest_readings() -> List[Dict[str, object]]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT r.id, r.meter_id, r.ts, r.value, r.confidence, r.image_path, r.model_type
            FROM readings r
            INNER JOIN (
                SELECT meter_id, MAX(ts) AS max_ts
                FROM readings
                GROUP BY meter_id
            ) latest
            ON r.meter_id = latest.meter_id
            AND r.ts = latest.max_ts
            ORDER BY r.meter_id ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def get_readings(
    meter_id: str,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
) -> List[Dict[str, object]]:
    effective_to = to_ts or datetime.now(timezone.utc).isoformat()
    effective_from = from_ts or (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, meter_id, ts, value, confidence, image_path, model_type
            FROM readings
            WHERE meter_id = ?
              AND ts >= ?
              AND ts <= ?
            ORDER BY ts ASC
            """,
            (meter_id, effective_from, effective_to),
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def get_meters() -> List[Dict[str, object]]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT meter_id, name, location, threshold_high, threshold_low, enabled
            FROM meters
            ORDER BY meter_id ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def upsert_meter(
    meter_id: str,
    threshold_high: Optional[float],
    threshold_low: Optional[float],
    enabled: Optional[bool],
) -> Dict[str, object]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute(
            """
            INSERT INTO meters (
                meter_id, name, location, threshold_high, threshold_low, enabled
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(meter_id) DO UPDATE SET
                threshold_high = COALESCE(excluded.threshold_high, meters.threshold_high),
                threshold_low = COALESCE(excluded.threshold_low, meters.threshold_low),
                enabled = COALESCE(excluded.enabled, meters.enabled)
            """,
            (
                meter_id,
                meter_id,
                "",
                threshold_high,
                threshold_low,
                1 if enabled is True else 0 if enabled is False else None,
            ),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT meter_id, name, location, threshold_high, threshold_low, enabled
            FROM meters
            WHERE meter_id = ?
            """,
            (meter_id,),
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else {}


def get_meter_by_id(meter_id: str) -> Optional[Dict[str, object]]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT meter_id, name, location, threshold_high, threshold_low, enabled
            FROM meters
            WHERE meter_id = ?
            """,
            (meter_id,),
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def get_last_alert_ts(meter_id: str) -> Optional[str]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT last_notified_ts
            FROM alert_states
            WHERE meter_id = ?
            """,
            (meter_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return row["last_notified_ts"]


def set_last_alert_ts(meter_id: str, ts: str) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO alert_states (meter_id, last_notified_ts)
            VALUES (?, ?)
            ON CONFLICT(meter_id) DO UPDATE SET
                last_notified_ts = excluded.last_notified_ts
            """,
            (meter_id, ts),
        )
        conn.commit()
    finally:
        conn.close()


def insert_stream_reading(
    camera_name: str,
    region_id: str,
    region_name: str,
    value_text: str,
    confidence: Optional[float] = None,
) -> Dict[str, object]:
    ts = datetime.now(timezone.utc).isoformat()
    value_num = None
    try:
        value_num = float(value_text)
    except (TypeError, ValueError):
        value_num = None

    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO stream_readings
            (camera_name, region_id, region_name, ts, value_text, value_num, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                camera_name,
                region_id,
                region_name,
                ts,
                value_text,
                value_num,
                confidence,
            ),
        )
        conn.commit()
        row_id = cursor.lastrowid
    finally:
        conn.close()

    return {
        "id": row_id,
        "camera_name": camera_name,
        "region_id": region_id,
        "region_name": region_name,
        "ts": ts,
        "value_text": value_text,
        "value_num": value_num,
        "confidence": confidence,
    }


def get_stream_camera_names() -> List[str]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT camera_name
            FROM stream_readings
            ORDER BY camera_name ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return [str(row["camera_name"]) for row in rows if row["camera_name"]]


def get_stream_dates(camera_name: str) -> List[str]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT ts
            FROM stream_readings
            WHERE camera_name = ?
            ORDER BY ts DESC
            """,
            (camera_name,),
        ).fetchall()
    finally:
        conn.close()

    dates = set()
    jst = ZoneInfo("Asia/Tokyo")
    for row in rows:
        ts = row["ts"]
        try:
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dates.add(dt.astimezone(jst).strftime("%Y-%m-%d"))
        except ValueError:
            continue
    return sorted(list(dates), reverse=True)


def get_stream_readings(
    camera_name: str,
    date: str,
    region_id: Optional[str] = None,
) -> List[Dict[str, object]]:
    try:
        day = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return []

    jst = ZoneInfo("Asia/Tokyo")
    day_start_jst = day.replace(tzinfo=jst)
    day_end_jst = day_start_jst + timedelta(days=1)
    from_ts = day_start_jst.astimezone(timezone.utc).isoformat()
    to_ts = day_end_jst.astimezone(timezone.utc).isoformat()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        if region_id:
            rows = conn.execute(
                """
                SELECT id, camera_name, region_id, region_name, ts, value_text, value_num, confidence
                FROM stream_readings
                WHERE camera_name = ?
                  AND region_id = ?
                  AND ts >= ?
                  AND ts < ?
                ORDER BY ts ASC
                """,
                (camera_name, region_id, from_ts, to_ts),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, camera_name, region_id, region_name, ts, value_text, value_num, confidence
                FROM stream_readings
                WHERE camera_name = ?
                  AND ts >= ?
                  AND ts < ?
                ORDER BY ts ASC
                """,
                (camera_name, from_ts, to_ts),
            ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]
