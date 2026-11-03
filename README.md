# Конвертер 9000

Программа для Windows: пакетная конвертация видео, аудио и картинок через ffmpeg.
Один exe на Go: локальный HTTP-сервер (127.0.0.1:47831, токен X-Token) + своё окно на WebView2,
которое показывает интерфейс index.html.

**Скачать последнюю версию:** https://github.com/RockyRoketto/Konverter-9000/releases/latest/download/Konvertor.exe

При первом запуске Windows может показать «Неизвестный издатель» (exe без цифровой подписи):
«Подробнее» → «Выполнить в любом случае». Дальше программа сама предлагает обновиться, когда выходит новая версия.

## Что где

| Файл | Что в нём |
|---|---|
| main.go | форматы, состояние, скачивание ffmpeg, buildArgs, probe (длительность, разрешение, звук, альфа), convert/runFF (повтор в безопасном режиме), режим «Сжать» (compressFormat; результат не меньше оригинала — удаляется, статус kept), «уложить в N МБ» (planRate → два прохода с битрейтом, при нехватке — меньше разрешение), errSummary, outPath, HTTP API, main() |
| update.go | версия программы (appVersion), settings.json, проверка свежего ffmpeg (gyan.dev release-version → GitHub BtbN), сравнение версий |
| selfupdate.go | обновление самой программы: последний релиз этого репозитория → скачать Konvertor.exe (размер + sha256) → заменить себя → перезапуск `--updated` |
| install_windows.go | установка для пользователя без админа: %LOCALAPPDATA%\Programs\Konvertor, ярлыки «Пуск»/рабочий стол, запись в «Установленные приложения», удаление `Konvertor.exe --uninstall`, замена exe при обновлении |
| install_other.go | заглушки для Linux/macOS; `FFB_FAKE_INSTALL=1` — показать окно установки при тестах |
| media.go | превью (`/thumb`: кадр видео, картинка, обложка или волна звука) и сведения о файле (`/api/info`), кэш в памяти |
| ui_windows.go | окно Win32 + WebView2 (github.com/wailsapp/go-webview2), перетаскивание с настоящими путями, диалоги выбора файлов, запасной режим через браузер |
| ui_other.go | Linux/macOS: открывает вкладку браузера; `FFB_NO_BROWSER=1` печатает URL и токен |
| hide_windows.go / hide_other.go | запуск ffmpeg без окон консоли |
| index.html | весь интерфейс (HTML/CSS/JS), вшит через go:embed; `__TOKEN__` заменяется токеном |
| hero.jpg, favicon.png | фото шапки и иконка вкладки (go:embed) |
| winres/ | winres.json + icon*.png: иконка exe, манифест (DPI per-monitor v2, Common Controls v6), версия |
| rsrc_windows_amd64.syso | собранные ресурсы (go-winres), Go подхватывает сам |
| assets-original/ | исходники фото шапки и иконки |
| tools/setversion.py | прописывает appVersion в rsrc_windows_amd64.syso без go-winres (если длина номера версии не изменилась) |
| *_test.go | тесты: разбор версий и источников ffmpeg, релизов GitHub, `ffmpeg -i`, превью, сжатие и «уложить в N МБ» с настоящим ffmpeg (`go test ./...`) |
| .github/workflows/release.yml | GitHub Actions: по тегу vX.Y.Z проверки, go-winres, сборка exe, релиз с текстом из CHANGELOG.md |
| release.cmd / release.sh | выпуск версии одной командой (release.cmd запускает release.sh через bash из Git for Windows) |
| CHANGELOG.md | что нового по версиям |

## Выпуск новой версии

```
release.cmd 1.6.0
```

Скрипт спросит «что нового» (Блокнот), поменяет версию в update.go и winres/winres.json, допишет CHANGELOG.md,
сделает коммит, тег v1.6.0 и push. GitHub Actions за 3–5 минут соберёт Konvertor.exe и выложит релиз.
Нужен установленный Git for Windows.

## Как работает обновление

- При запуске программа в фоне спрашивает api.github.com/repos/RockyRoketto/Konverter-9000/releases/latest.
  Если версия новее — плашка «Вышел Конвертор X / Обновить / Не сейчас / Пропустить эту версию» с текстом релиза.
- «Обновить»: exe качается во временную папку программы, проверяются размер, sha256 (digest от GitHub) и заголовок «MZ».
  Свой exe переименовывается в Konvertor.exe.old, новый встаёт на его место и запускается с `--updated`
  (ждёт, пока старый отпустит порт 47831), старый закрывается. .old удаляет новый процесс; если программа
  установлена — он же обновляет версию в «Установленных приложениях». Во время конвертации обновлять нельзя.
- ffmpeg обновляется отдельно: при запуске сравнивается `ffmpeg -version` со свежим релизом gyan.dev / BtbN.
- Проверка без интернета: `FFB_FEED=http://127.0.0.1:PORT` — программа берёт `/app-release.json`
  (формат как у GitHub API), `/release-version`, `/ffmpeg.zip`, `/btbn.json`, `/master.zip` с этого адреса.

## Сборка вручную

Нужен Go 1.21+.

```powershell
go install github.com/tc-hib/go-winres@latest
go-winres make --in winres/winres.json --arch amd64 --out rsrc   # если менялись иконка, версия или названия
$env:GOOS='windows'; $env:CGO_ENABLED='0'; go build -trimpath -ldflags "-s -w -H=windowsgui" -o Konvertor.exe .
```

Проверки: `gofmt -l .` пусто; `go test ./...`; `GOOS=windows go vet .`
(2 предупреждения про unsafe.Pointer в ui_windows.go — ожидаемо).

---

© Dmitrii Trudnikov
