# shared helpers for the cams-* scripts
V4L=${V4L:-/sys/class/video4linux}
BIN=${CAMS_BIN:-/usr/sbin}
CFG=${CAMS_CFG:-/etc/config/cams}

# stable UCI section name derived from the camera name
cam_sec() {
  printf 'cam_%s' "$(printf '%s' "$(cat "$1/name" 2>/dev/null)" | tr -c 'A-Za-z0-9' '_' | tr 'A-Z' 'a-z')"
}

# capture nodes only (newer kernels also expose metadata nodes with index != 0)
cam_nodes() {
  for n in "$V4L"/video*; do
    [ -e "$n/index" ] || continue
    [ "$(cat "$n/index")" = "0" ] && echo "$n"
  done
}

cg() { uci -q get "cams.$1.$2" 2>/dev/null; }
