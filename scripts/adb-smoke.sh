#!/usr/bin/env bash
# Phone smoke check. Usage: scripts/adb-smoke.sh [apk] ; shots go to $OUT (default /tmp/adb-smoke).
# Prereq: VS Code with JustCode running, setting justCode.phoneServer = true (the phone server; there is no
# "justCode.mobile" setting), phone and computer on the same Wi-Fi. The android/ app must be built first.
set -euo pipefail
DEV=${DEV:-R8YL104VK6R}; OUT=${OUT:-/tmp/adb-smoke}; APK=${1:-android/app/build/outputs/apk/debug/app-debug.apk}
mkdir -p "$OUT"; A="adb -s $DEV"
shot() { $A exec-out screencap -p > "$OUT/$1.png"; echo "saved $OUT/$1.png - open it and confirm: $2"; }
$A get-state
shot 00-device "device awake, unlocked"
[ -f "$APK" ] || { echo "APK missing: build with (cd android && ./gradlew assembleDebug)"; exit 1; }
$A install -r "$APK"
PKG=$(aapt dump badging "$APK" | sed -n "s/package: name='\([^']*\)'.*/\1/p")
$A shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 3; shot 01-app-open "pairing screen"
echo "Manual: enter address + token from VS Code (or scan QR), then tap through:"
read -rp "paired? [enter] "; shot 02-paired "board visible"
read -rp "create task, enter when done "; shot 03-task-created "task listed"
read -rp "run task, enter when running "; shot 04-running "task running"
read -rp "approve the permission request, enter when done "; shot 05-approved "permission approved"
read -rp "merge task, enter when done "; shot 06-merged "task merged"
