#!/bin/sh

# Video pool directory inside the container
VIDEO_DIR="${MOCK_VIDEO_DIR:-/data/Video_BE.mp4}"

# Selection modes: fixed (default) | random | first
MOCK_VIDEO_MODE="${MOCK_VIDEO_MODE:-fixed}"

resolve_by_name() {
  name="$1"
  [ -n "$name" ] || return 1

  case "$name" in
    /*)
      if [ -f "$name" ]; then
        echo "$name"
        return 0
      fi
      return 1
      ;;
  esac

  base=$(basename "$name")
  case "$base" in
    *.mp4) ;;
    *) base="${base}.mp4" ;;
  esac

  if [ -f "${VIDEO_DIR}/${base}" ]; then
    echo "${VIDEO_DIR}/${base}"
    return 0
  fi

  found=$(find "$VIDEO_DIR" -maxdepth 1 -type f -name "$base" 2>/dev/null | head -n 1)
  if [ -n "$found" ] && [ -f "$found" ]; then
    echo "$found"
    return 0
  fi

  return 1
}

list_videos() {
  if [ -d "$VIDEO_DIR" ]; then
    find "$VIDEO_DIR" -maxdepth 1 -type f -name '*.mp4' 2>/dev/null | sort
    return
  fi
  find /data -type f -name '*.mp4' 2>/dev/null | sort
}

pick_first() {
  list_videos | head -n 1
}

pick_random() {
  videos=$(list_videos)
  [ -n "$videos" ] || return 1

  count=$(printf '%s\n' "$videos" | wc -l)
  if [ "$count" -le 1 ]; then
    printf '%s\n' "$videos" | head -n 1
    return 0
  fi

  idx=$(( ($(date +%s) + $$) % count + 1 ))
  printf '%s\n' "$videos" | sed -n "${idx}p"
}

select_video() {
  # 1) Full path override
  if [ -n "${MOCK_VIDEO_FILE:-}" ] && [ -f "$MOCK_VIDEO_FILE" ]; then
    echo "$MOCK_VIDEO_FILE"
    return 0
  fi

  # 2) Filename / basename (office.mp4, office, /data/.../office.mp4)
  if [ -n "${MOCK_VIDEO_NAME:-}" ]; then
    if resolved=$(resolve_by_name "$MOCK_VIDEO_NAME"); then
      echo "$resolved"
      return 0
    fi
    echo "ERROR: MOCK_VIDEO_NAME not found: ${MOCK_VIDEO_NAME}" >&2
    echo "Available videos:" >&2
    list_videos >&2
    return 1
  fi

  # 3) Mode-based selection
  case "$MOCK_VIDEO_MODE" in
    random)
      pick_random
      return
      ;;
    first)
      pick_first
      return
      ;;
    fixed)
      pick_first
      return
      ;;
    *)
      echo "ERROR: invalid MOCK_VIDEO_MODE=${MOCK_VIDEO_MODE} (use fixed|random|first)" >&2
      return 1
      ;;
  esac
}

VIDEO=$(select_video)

if [ -z "$VIDEO" ] || [ ! -f "$VIDEO" ]; then
  echo "ERROR: no .mp4 file found under ${VIDEO_DIR}" >&2
  echo "Set MOCK_VIDEO_NAME, MOCK_VIDEO_FILE, or MOCK_VIDEO_MODE=random" >&2
  exit 1
fi

echo "mock_camera: mode=${MOCK_VIDEO_MODE} selected $(basename "$VIDEO")"

while true; do
  echo "mock_camera: streaming ${VIDEO} -> rtsp://mediamtx:8554/source"
  ffmpeg -hide_banner -loglevel warning \
    -re -stream_loop -1 -i "$VIDEO" \
    -an -c:v copy \
    -f rtsp -rtsp_transport tcp \
    rtsp://mediamtx:8554/source
  echo "mock_camera: disconnected, retrying in 2s..."
  sleep 2
done
