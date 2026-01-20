# *********************************************************
# backend/list_cameras.py
# *********************************************************

import cv2

def main():
    print("Scanning camera indices 0-9...")
    for index in range(10):
        cap = cv2.VideoCapture(index)
        if cap.isOpened():
            print(f"Available: {index}")
            cap.release()
        else:
            cap.release()

if __name__ == "__main__":
    main()
