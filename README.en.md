<img src="winres/icon.png" width="88" alt="">

# Kombain

[Русский](README.md) · **English**

Batch video, audio and image converter for Windows, built on ffmpeg. Plus a player, a multitrack editor, colour tools, utilities and an image generator that runs on your own GPU. Drop files or a folder into the window, pick a format and press "Convert".

**[⬇ Download](https://github.com/RockyRoketto/Kombain/releases/latest/download/Konvertor.exe)** · [What's new](CHANGELOG.en.md)

## Getting started

1. Download `Konvertor.exe` and run it (Windows 10 or 11). If Windows says "Unknown publisher" (the exe is not code-signed), click "More info" → "Run anyway".
2. The app offers to install itself (Start menu, "Send to"). You can also work without installing.
3. The app downloads ffmpeg by itself (about 100 MB, once).
4. For the image generator it checks your hardware and downloads a model (about 10 GB, once).

Theme, language and settings are behind the gear icon in the top right.

## Features

### Converter

90+ output formats: MP4 (H.264, H.265, AV1), WebM, MOV, MKV, editing formats (ProRes, DNxHR), photos (JPG, PNG, WEBP, AVIF and more), GIF and animated WEBP, audio (MP3, AAC, Opus, FLAC, WAV and more).

- Compress to a target size in MB (for email, say); quality is picked automatically.
- Frame-accurate trimming, ready-made and custom presets, up to 4 files at once.
- The original is never changed: by default the result is saved next to it.
- Video to PNG sequence and back, fine control of codec, CRF, FPS and bitrate.

### Player

Video and audio from a file or folder, a drag-and-drop queue, a frame to PNG in one click, send a file to the converter, trimming or the editor. Formats the window cannot play itself (ProRes, for example) are prepared for viewing.

### Editor

A timeline desk: files on the left, preview in the centre, inspector on the right, tracks below.

- Clips sit freely: move, cut, copy, up to 100 undo steps. Video with sound is placed as a linked pair.
- Text and shapes (rectangle, ellipse, line, arrow, Bézier pen), transitions between clips.
- Keyframes with easing curves, ready-made animations, speed 0.25–8×, reverse.
- Colour correction and chroma key, blur, shadow, blend modes, audio with a level meter.
- Subtitles from speech (whisper.cpp, works offline), line editing, effects such as Karaoke, Typewriter, Glitch and ready-made styles.
- Sizes for Full HD, 4K, 9:16, square, 4:5, safe zones for Reels, Shorts and TikTok. Projects are saved as `.kb`; after a crash the app offers to restore it.

### Colour

Gradients (linear, radial, conic, OKLCH blending) and mesh gradients, palettes built on colour-wheel rules, an on-screen eyedropper, colours from a photo, WCAG contrast check, a 50–950 shade scale. Export to PNG, SVG, CSS, JSON and ASE (Photoshop, Illustrator, InDesign).

### Utilities

- **Favicons:** a full website set from one icon, with `site.webmanifest` and a ready `head.html`.
- **Remove background** and **Upscale ×2 / ×4** with neural networks, transparency is kept.
- **Fix cutout:** when the neural network misses, clean up the edge with an eraser or bring back what it erased (hair, fine details) with a brush that paints from the original. You can also feather, shrink or expand the edge and remove the fringe left by the old background. The result is saved as a separate PNG and the original stays as it is. The same window opens from the generator gallery.
- **Image batch:** size, format, metadata removal and a watermark for a whole pile.
- **Banners** and **Banner builder:** one picture is placed on all 14 templates inside its safe zone, with a background element, shadow and glow, mouse editing and saving into `month\day\match` folders.
- **PDF:** images to PDF, compress to a target size, merge and split, repair, watermark, page numbers, AES-256 password.

### Image generator

Offline text-to-image, no subscriptions and no limits.

- Models: FLUX.2 klein (default), Z-Image Turbo, SDXL, Qwen-Image, ERNIE-Image, Chroma1-HD. Downloads resume and files are verified.
- Write your request in Russian or English: the assistant rewrites it into a detailed English prompt that you can edit. Flags and countries are drawn in their real colours.
- 39 styles with sample pictures and a sample request in each, including "Sports banner" and "Sports 3D" for banners.
- Up to 8 references with roles "Base", "Style", "Character" and a strength slider.
- Gallery with search and favourites, variations, "Repaint a part", "Outpaint", "Remove background" and "Fix" for the cutout, "Upscale". Settings are stored inside the PNG: drop the picture back and the fields fill in.

Only the generator needs an NVIDIA, AMD or Intel GPU with 4 GB+ of video memory (8 GB is comfortable); everything else runs on any PC.

## For developers

A single Go exe: a local server and a WebView2 window with the UI from `web/`. Code map: [docs/MAP.md](docs/MAP.md).

```powershell
$env:GOOS='windows'; $env:CGO_ENABLED='0'; go build -trimpath -ldflags "-s -w -H=windowsgui" -o Konvertor.exe .
```

Checks: `gofmt -l .` is empty, `go test ./...`. Release: `release.cmd X.Y`, then GitHub Actions builds it.

---

© Dmitrii Trudnikov
