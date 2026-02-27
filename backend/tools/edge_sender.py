#!/usr/bin/env python3
import argparse
import time

import cv2
import requests


def parse_args():
    parser = argparse.ArgumentParser(description="Capture webcam image and send to API periodically")
    parser.add_argument("--api", default="http://127.0.0.1:5050", help="API base URL")
    parser.add_argument("--meter-id", default="default", help="meter_id form value")
    parser.add_argument("--model-type", default="dummy", choices=["dummy", "yolo"], help="model_type form value")
    parser.add_argument("--interval", type=float, default=5.0, help="capture/send interval in seconds")
    parser.add_argument("--camera-index", type=int, default=0, help="camera index for cv2.VideoCapture")
    parser.add_argument("--timeout", type=float, default=10.0, help="HTTP timeout seconds")
    return parser.parse_args()


def main():
    args = parse_args()
    endpoint = f"{args.api.rstrip('/')}/api/v1/images"

    cap = cv2.VideoCapture(args.camera_index)
    if not cap.isOpened():
        print(f"[ERROR] Failed to open camera index={args.camera_index}")
        return 1

    print("[INFO] edge_sender started")
    print(f"[INFO] endpoint={endpoint} meter_id={args.meter_id} model_type={args.model_type} interval={args.interval}s")
    print("[INFO] Press Ctrl+C to stop")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("[WARN] Failed to read frame from camera")
                time.sleep(args.interval)
                continue

            ok, encoded = cv2.imencode(".jpg", frame)
            if not ok:
                print("[WARN] Failed to encode frame as JPEG")
                time.sleep(args.interval)
                continue

            files = {
                "image": ("frame.jpg", encoded.tobytes(), "image/jpeg"),
            }
            data = {
                "meter_id": args.meter_id,
                "model_type": args.model_type,
            }

            try:
                resp = requests.post(endpoint, files=files, data=data, timeout=args.timeout)
                if resp.ok:
                    try:
                        payload = resp.json()
                    except ValueError:
                        payload = {"raw": resp.text}
                    reading = payload.get("reading", {}) if isinstance(payload, dict) else {}
                    print(
                        f"[OK] status={resp.status_code} "
                        f"meter_id={reading.get('meter_id')} value={reading.get('value')} "
                        f"ts={reading.get('ts')} alert_sent={payload.get('alert_sent') if isinstance(payload, dict) else None}"
                    )
                else:
                    print(f"[ERROR] status={resp.status_code} body={resp.text}")
            except requests.RequestException as e:
                print(f"[ERROR] request failed: {e}")

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[INFO] stopped by user")
    finally:
        cap.release()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
