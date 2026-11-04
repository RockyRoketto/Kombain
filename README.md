# Конвертер 9000

Программа для Windows: пакетная конвертация видео, аудио и картинок через ffmpeg.
Один exe на Go: локальный HTTP-сервер (127.0.0.1:47831, токен X-Token) + своё окно на WebView2,
которое показывает интерфейс из папки web/.

**Скачать последнюю версию:** https://github.com/RockyRoketto/Konverter-9000/releases/latest/download/Konvertor.exe

При первом запуске Windows может показать «Неизвестный издатель» (exe без цифровой подписи):
«Подробнее» → «Выполнить в любом случае». Дальше программа сама предлагает обновиться, когда выходит новая версия.

## Что где

Полная карта кода: [docs/MAP.md](docs/MAP.md). Коротко:

- Go: `main.go` (запуск), `api.go` (HTTP), `convert.go` и `ffargs.go` (конвертация), `banner.go` (вкладка «Баннеры»), `update.go` и `selfupdate.go` (обновления и настройки), `theme.go` (тема оформления), `install_windows.go` и `ui_windows.go` (установка и окно).
- Интерфейс: `web/` (`index.html`, `style.css`, `js/*.js`), вшит через go:embed и собирается в одну страницу при запуске.
- Выпуск: `release.cmd` / `release.sh`, `.github/workflows/release.yml`, `CHANGELOG.md`.

## Выпуск новой версии

```
release.cmd 1.6.0
```

Скрипт спросит «что нового» (Блокнот), поменяет версию в update.go и winres/winres.json, допишет CHANGELOG.md,
сделает коммит, тег v1.6.0 и push. GitHub Actions за 3–5 минут соберёт Konvertor.exe и выложит релиз.
Нужен установленный Git for Windows.

## Как работает обновление

- При запуске программа в фоне спрашивает api.github.com/repos/RockyRoketto/Konverter-9000/releases/latest.
  Если версия новее — плашка «Вышел Конвертер X / Обновить / Не сейчас / Пропустить эту версию» с текстом релиза.
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
