# Browser media fixtures

`codec-fixture.mp4` is a 0.6-second synthetic 96×64 test pattern with mono audio. It contains H.264 Baseline video and AAC-LC audio in an MP4 container, so it does not contain third-party media.

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
