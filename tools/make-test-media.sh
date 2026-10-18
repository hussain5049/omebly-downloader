#!/usr/bin/env bash
# Makes the test site's media (videos, audio, an HLS stream, photos, files) with FFmpeg. Run once before the tests.
set -e
cd "$(dirname "$0")/../test-site" && mkdir -p media/hls && cd media
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest lesson-1.mp4
for i in 2 3 4 5 6; do cp lesson-1.mp4 lesson-$i.mp4; done; cp lesson-1.mp4 locked-final-project.mp4
ffmpeg -loglevel error -y -f lavfi -i sine=frequency=330 -t 8 -c:a libmp3lame morning-raga.mp3
ffmpeg -loglevel error -y -f lavfi -i testsrc=size=854x480:rate=25 -f lavfi -i sine=frequency=550 -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -f hls -hls_time 2 -hls_playlist_type vod hls/stream.m3u8
for s in 4000x2667:0x3E6E8E 3200x2133:0xC9824F 1920x1280:0x8E5C7A 1200x800:0x6A7F94 64x64:0x2EF2B3; do ffmpeg -loglevel error -y -f lavfi -i color=c=${s##*:}:s=${s%%:*} -frames:v 1 photo-${s%%:*}.jpg; done
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > science-notes.pdf; cp science-notes.pdf formula-sheet.pdf
head -c 300000 /dev/urandom > past-papers.zip; printf 'Project template' > project-template.docx
echo "test media made"
