#!/bin/sh
# Generates small test clips for the mock provider (needs ffmpeg with libvpx + libopus).
# VP9/Opus is used so the open-source Chromium used in tests can decode it; real TVs get H.264 from providers.
set -e
OUT="${1:-$(dirname "$0")/media}"
mkdir -p "$OUT/hls"
cd "$OUT"
FF="ffmpeg -hide_banner -loglevel error -y"
SRC="-f lavfi -i testsrc2=size=640x360:rate=25"
TONE="-f lavfi -i sine=frequency=440:sample_rate=48000"
TONE2="-f lavfi -i sine=frequency=660:sample_rate=48000"
VP9="-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 400k -g 50 -keyint_min 50"

[ -f hls/index.m3u8 ] || $FF $SRC $TONE -t 30 $VP9 -c:a libopus -b:a 64k -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'hls/seg%03d.m4s' hls/index.m3u8
[ -f movie.mp4 ] || $FF $SRC $TONE -t 40 $VP9 -c:a libopus -b:a 64k -movflags +faststart movie.mp4

cat > sv.srt <<'EOF'
1
00:00:01,000 --> 00:00:04,000
Hej och välkommen!

2
00:00:05,000 --> 00:00:09,000
Det här är en svensk undertext.

3
00:00:20,000 --> 00:00:25,000
Tjugo sekunder in i filmen.
EOF
cat > en.srt <<'EOF'
1
00:00:01,000 --> 00:00:04,000
Hello and welcome!

2
00:00:20,000 --> 00:00:25,000
Twenty seconds into the movie.
EOF
[ -f movie.mkv ] || $FF $SRC $TONE $TONE2 -i sv.srt -i en.srt -t 40 \
  -map 0:v -map 1:a -map 2:a -map 3:s -map 4:s $VP9 -c:a libopus -b:a 64k -c:s srt \
  -metadata:s:a:0 language=swe -metadata:s:a:1 language=eng -metadata:s:s:0 language=swe -metadata:s:s:1 language=eng movie.mkv
[ -f ac3.mp4 ] || $FF $SRC $TONE -t 30 -c:v mpeg4 -q:v 5 -c:a ac3 -b:a 192k ac3.mp4
[ -f clip.ts ] || $FF $SRC $TONE -t 10 -c:v libx264 -preset ultrafast -c:a aac -f mpegts clip.ts
ls -la . hls | head -40
