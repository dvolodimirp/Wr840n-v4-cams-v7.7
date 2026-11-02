#!/usr/bin/env bash
# Run from the OpenWrt source root. Enables ehci/ohci (and usbphy, if present)
# in the TL-WR840N v4 device tree. The board DTS normally disables USB.
set -euo pipefail
dtsdir=target/linux/ramips/dts
mapfile -t files < <(find "$dtsdir" -iname '*wr840n*v4*.dts' -o -iname '*wr840nv4*.dts' | sort -u)
if [ "${#files[@]}" -ne 1 ]; then
  echo "Expected exactly one WR840N v4 DTS, found ${#files[@]}:" >&2
  printf '  %s\n' "${files[@]}" >&2
  exit 1
fi
dts="${files[0]}"
echo "Patching $dts"
if grep -q 'USB enabled by wr840n-v4-cams' "$dts"; then echo "already patched"; exit 0; fi
{
  echo
  echo "/* USB enabled by wr840n-v4-cams */"
  echo '&ehci { status = "okay"; };'
  echo '&ohci { status = "okay"; };'
  if grep -rqE '^\s*usbphy\s*:' "$dtsdir"/mt7628an.dtsi "$dtsdir"/mt76x8.dtsi 2>/dev/null; then
    echo '&usbphy { status = "okay"; };'
  fi
} >> "$dts"
tail -8 "$dts"
