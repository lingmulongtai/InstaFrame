# Browser media fixtures

`fragmented-opus.mp4` is a one-second synthetic 96×64 H.264 test pattern with an Opus tone in fragmented MP4. It tests conversion of recorder output to a regular MP4 with AAC audio. FFmpeg 8.0.1 was used:

```text
ffmpeg -f lavfi -i "testsrc2=size=96x64:rate=30:duration=1" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1" -c:v libx264 -pix_fmt yuv420p -g 30 -c:a libopus -b:a 48k -movflags empty_moov+default_base_moof+frag_keyframe -f mp4 fragmented-opus.mp4
```

SHA-256: `526497965b907bd055f99e9616da9b9316dafa43404a77eceb8519508091d6fa`

`fragmented-short-audio.mp4` uses the same command but changes the sine's `duration=1` to `duration=0.2`. It tests rejection of a recording whose audio ends before the source audio.

SHA-256: `7fdb865ab0d2696836e1d1ed2f7a99f1cd38550b83149622fb2e48524cc4f676`

`offline-60fps.mp4` is a one-second 320×180 H.264/AAC synthetic video at 60 fps. Four coloured quadrants identify orientation; a white flash and a 1 kHz tone both start at 0.5 seconds. `offline-60fps-rotated.mp4` contains the same streams with a 90-degree display matrix. FFmpeg 8.0.1 was used:

```text
ffmpeg -f lavfi -i "color=c=blue:s=320x180:r=60:d=1" -f lavfi -i "aevalsrc=if(between(t\,0.5\,0.55)\,0.8*sin(2*PI*1000*t)\,0):s=48000:d=1" -vf "drawbox=x=0:y=0:w=iw/2:h=ih/2:color=red:t=fill,drawbox=x=iw/2:y=0:w=iw/2:h=ih/2:color=lime:t=fill,drawbox=x=0:y=ih/2:w=iw/2:h=ih/2:color=yellow:t=fill,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,0.5,0.55)'" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart offline-60fps.mp4
ffmpeg -display_rotation 90 -i offline-60fps.mp4 -map 0 -c copy offline-60fps-rotated.mp4
```

SHA-256: `07fd34240385aed0f58bc79198e07980c89ae15c81dc175d555254aa35e33e68`

SHA-256: `e7490a18f3c7b745140687e332fe66e57697ab58007e80e83bc746f8261a5a71`

`codec-fixture.mp4` is a 0.6-second synthetic 96×64 test pattern with mono audio. It contains H.264 Baseline video and AAC-LC audio in an MP4 container, so it does not contain third-party media.

The cross-browser contract proves that Chromium, Firefox, and Microsoft Edge decode a video frame from this fixture; WebKit may instead report an explicit codec error. It does not assert that the input AAC track was decoded or preserved. Audio-track preservation is covered separately by the Linux Chromium WebM export test.

It was generated with FFmpeg 8.0.1:

```text
ffmpeg -f lavfi -i "testsrc2=size=96x64:rate=10" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 0.6 -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -preset veryfast -movflags +faststart -c:a aac -b:a 32k codec-fixture.mp4
```

SHA-256: `bafb62332a0b45612eb8697cdd229e4ba46baf39bd04e6a916c20cc5e8382e08`

`codec-fixture.mov` contains the same synthetic tracks in a QuickTime MOV container. It was remuxed without re-encoding:

```text
ffmpeg -i codec-fixture.mp4 -map 0 -c copy -f mov -movflags +faststart codec-fixture.mov
```

SHA-256: `54ae77851ba75bb017bbca24fbb946c79f7b091868b5687583481f304e78cd85`

The M4V contract reuses `codec-fixture.mp4` with the `.m4v` extension and `video/x-m4v` MIME type. M4V is an MP4-family container, so a duplicate binary fixture is unnecessary.

`audio-fixture.webm` is a 0.8-second 160×90 VP8 video with a mono 48 kHz Opus track. The Linux Chromium export test uses it to verify that a browser-decoded input audio track is routed into the framed video output.

SHA-256: `30c623393fb53d487477a6c900797270c71e0fd16bee8ac10b89591da9edea05`

The unit suite verifies all documented hashes before any browser contract uses these files. If a fixture is regenerated, update its description and hash in this document in the same change.

`hevc-10bit.mov` is a one-frame 64×36 solid-colour HEVC Main 10 video in a QuickTime container, tagged `hvc1` like iPhone recordings. Browsers without HEVC decoding use it to verify that a failed video names its codec and how to open it.

```text
ffmpeg -f lavfi -i "color=c=0x3366aa:s=64x36:r=1" -frames:v 1 -c:v libx265 -pix_fmt yuv420p10le -tag:v hvc1 hevc-10bit.mov
```

SHA-256: `226772af30769ff1ae924c76f80645cd755d585c280ea31c9f0269522be1cef7`

`heic-plain.heic` is a 96×64 synthetic HEIC (blue stripes with a yellow disc), encoded with pillow-heif 0.22.0 (libheif 1.19.7, x265) at quality 90. It checks that HEIC opens in browsers without native HEIC decoding.

SHA-256: `ca669c14c3bdd9a724049b340a435c5b706984b907e1ab94138cf15737979c7d`

`heic-spatial.heic` is a 160×120 stereo pair shaped like a spatial photo: two HEVC images in a `ster` entity group with camera intrinsics (`cmin`) and extrinsics (`cmex`). The disc sits 4 px right in the left eye and 4 px left in the right eye (8 px of crossed disparity). Each eye was encoded like `heic-plain.heic`, then assembled with `node tests/e2e/make-spatial-fixture.cjs left.heic right.heic heic-spatial.heic`, which uses the app's own HEIF writer.

SHA-256: `6f18ecc570c27ff9213154ffd39f948ddb171a8f9a1e29e61c36d5de71bbfbc0`
