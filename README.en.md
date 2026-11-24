<img src="winres/icon.png" width="88" alt="">

# Kombain

[Русский](README.md) · **English**

Batch video, audio and image converter for Windows, built on ffmpeg. Plus a player, an editor, colour tools, utilities and an image generator that runs on your own GPU. Drop files into the window, pick a format and press "Convert".

**[⬇ Download](https://github.com/RockyRoketto/Kombain/releases/latest/download/Konvertor.exe)** · [What's new](CHANGELOG.en.md)

## Getting started

1. Download `Konvertor.exe` and run it (Windows 10 or 11). If Windows says "Unknown publisher", click "More info" → "Run anyway".
2. The app downloads ffmpeg by itself (about 100 MB, once).
3. For the image generator it checks your hardware and downloads a model (about 10 GB, once).

Theme, language and settings are behind the gear icon in the top right.

## Features

| | |
|---|---|
| **Converter** | 90+ formats: video, audio, photos, GIF. Compress to a target size, trim, presets, batch work. The original is never changed. |
| **Player** | Video and audio from a folder, a queue, frame to PNG. |
| **Editor** | Tracks, text and shapes, transitions, keyframes, colour and chroma key, subtitles from speech, export to the converter. |
| **Colour** | Gradients and mesh gradients, palettes, eyedropper, WCAG contrast. Export to PNG, SVG, CSS, ASE. |
| **Utilities** | Favicons, remove background, upscale ×2/×4, image batch, banners, banner builder, PDF. |
| **Generator** | Offline text-to-image: FLUX.2, Z-Image, SDXL and more, references, gallery, 39 styles (including "Sports 3D" for banners), a sample request in every style. |

Only the generator needs an NVIDIA, AMD or Intel GPU with 4 GB+ of video memory (8 GB is comfortable); everything else runs on any PC.

## For developers

A single Go exe: a local server and a WebView2 window with the UI from `web/`. Code map: [docs/MAP.md](docs/MAP.md).

```powershell
$env:GOOS='windows'; $env:CGO_ENABLED='0'; go build -trimpath -ldflags "-s -w -H=windowsgui" -o Konvertor.exe .
```

Checks: `gofmt -l .` is empty, `go test ./...`. Release: `release.cmd X.Y`, then GitHub Actions builds it.

---

© Dmitrii Trudnikov
