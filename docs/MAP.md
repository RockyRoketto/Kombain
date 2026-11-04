# Карта кода

Цель: найти нужное место, не читая проект целиком. Номеров строк здесь нет, они быстро устаревают: ищи по имени функции.
Добавил, переименовал или перенёс файл — поправь эту карту.

- [Куда смотреть под задачу](#куда-смотреть-под-задачу)
- [Как устроено](#как-устроено)
- [Go: файлы и главные функции](#go-файлы-и-главные-функции)
- [Интерфейс: web/](#интерфейс-web)
- [HTTP API](#http-api)
- [Сборка, выпуск, прочее](#сборка-выпуск-прочее)
- [Проверка](#проверка)

## Куда смотреть под задачу

| Задача | Файлы |
|---|---|
| Новый формат вывода | `formats.go` (`formats`) + `web/js/core.js` (`FORMATS`, `GROUPS`) |
| Новый пресет | `web/js/core.js` (`PRESETS`, значения по умолчанию в `PRESET_BASE`) |
| Новое входное расширение | `formats.go` (`mediaExt`), `web/js/core.js` (`MEDIA`), `ui_windows.go` (фильтр в `showDialog`) |
| Аргументы ffmpeg | `ffargs.go` (`buildArgs`) |
| Режим «Сжать» | `formats.go` (`compressFormat`), `convert.go` (`convert`) |
| «Уложить в N МБ» | `ffargs.go` (`planRate`, `rateArgs`), `convert.go` (`encodeTarget`) |
| Текст ошибок ffmpeg | `fferrors.go` |
| Имя и папка результата | `files.go` (`outPath`) |
| Вкладка «Баннеры» | `banner.go`, `web/js/bannertab.js` |
| Новая настройка в интерфейсе | `web/index.html` + `web/js/settings.js` (`FIELDS`) + `web/js/start.js` (`currentReq`) + `state.go` (`StartReq`) |
| Панель настроек за шестерёнкой | `web/index.html` (`setPanel`, группы `.setp-group`), `web/js/settings.js` (`setPanel`) |
| Тема оформления | цвета: `web/style.css` (`:root`, `:root[data-theme="light"]`); применение: `applyTheme` в `web/index.html`; переключатель: `web/js/settings.js` (`renderTheme`); окно: `ui_windows.go` (`applyWindowTheme`); значения: `theme.go` |
| Настройка, которую должен знать Go | `update.go` (`Settings`), `api.go` (`/api/settings`) |
| Сводки в заголовках разделов | `web/js/settings.js` (`applyKind`, `renderParamSum`, `renderPresets`, `renderOut`) |
| Список файлов | `web/js/filelist.js` |
| Всплывашки, итог пачки | `web/js/toasts.js` |
| Плашки обновлений | `web/js/updates.js`; логика — `update.go`, `selfupdate.go` |
| Установка и удаление | `install_windows.go`, `web/js/setup.js` |
| Окно, перетаскивание, диалоги | `ui_windows.go`, `web/js/drop.js` |
| Превью | `media.go`, `web/js/preview.js` |
| Внешний вид | `web/style.css` (разделы подписаны `/* ----- … ----- */`, ищи по ним) |

## Как устроено

Один exe: локальный HTTP-сервер на `127.0.0.1:47831` и окно WebView2, которое показывает страницу с этого сервера.
Страница каждые 700 мс опрашивает `/api/state` и перерисовывает то, что изменилось. Вся работа — запуск `ffmpeg` с разобранным stdout (`-progress`).

Путь пачки: `/api/start` → `Server.begin` (занять программу) → `run` (имена результатов, очередь) → `convert` на каждый файл → `runFF` или `encodeTarget`. Статусы лежат в `Server.files`, под `Server.mu`.

## Go: файлы и главные функции

| Файл | Что внутри |
|---|---|
| `main.go` | `main`, `startServer`, `stopAll`, `idleExit`, `openBrowser` |
| `state.go` | типы `Server`, `FileState`, `StartReq`, `DL`, `FileInfo`; `begin`, `addLog` |
| `formats.go` | `Format`, `formats`, `compressFormat`, `presets`, `mediaExt` |
| `files.go` | `dataDir`, `dropDir`, `findFFmpeg`, `isTemp`, `fileExists`, `fileSize`, `walkMedia`, `expandPaths`, `openFolder`, `safeName`, `outPath` |
| `ffargs.go` | `probe`, `planRate`, `rateArgs`, `buildArgs`, `num`, `mbStr` |
| `convert.go` | `run`, `convert`, `encodeTarget`, `runFF`, `set`, `kept` |
| `fferrors.go` | `friendlyErr` (для человека), `errSummary` (для лога) |
| `ffdownload.go` | `download` (общее скачивание, защита от зависания), `downloadFFmpeg`, `tryDownload` |
| `api.go` | `routes` (все ручки), `api` (проверка токена и Host), `writeJSON` |
| `web.go` | сборка страницы `buildPage`, порядок скриптов `webJS` |
| `banner.go` | `runBanners`, `shrinkPNG`, `bannerNames`, `bannerWanted`, `bannerDims`, `ffQuiet` |
| `media.go` | `parseMediaInfo`, `getMediaInfo`, `makeThumb`, `thumbHandler` |
| `update.go` | `appVersion`, `Settings`, `cmpVer`, `latestFFmpeg`, `checkFFmpeg`, `httpGet`, `InstallInfo` |
| `theme.go` | значения темы, `validTheme`, `normTheme`, цвет фона окна `bgDark`, `bgLight` |
| `selfupdate.go` | `updateRepo`, `latestApp`, `checkApp`, `updateApp`, `fetchApp` |
| `install_windows.go` | `doInstall`, `createShortcut`, `writeUninstallEntry`, `replaceSelf`, `restartSelf`, `afterUpdate`, `runUninstall` |
| `ui_windows.go` | `runUI`, `wndProc`, `applyWindowTheme` (заголовок и фон окна), `onWebMessage` (перетаскивание), `showDialog`, `pickFiles`, `pickFolder`, `comCall` |
| `install_other.go`, `ui_other.go`, `hide_*.go` | заглушки не для Windows и запуск процессов без окна |

Тесты лежат рядом (`*_test.go`). `compress_test.go`, `banner_test.go` и `media_test.go` используют настоящий ffmpeg.

## Интерфейс: web/

Страница собирается в один HTML при запуске (`web.go`): `index.html` + `style.css` + скрипты по порядку из `webJS`.
Скрипты обычные, не модули: переменные общие, а порядок важен. Новый файл в `web/js` надо добавить в `webJS`, иначе упадёт тест.

| Файл | Что внутри |
|---|---|
| `index.html` | разметка всех экранов и окон; метки `__CSS__`, `__JS__`; в `<head>` — `applyTheme` (тема до первой отрисовки, значение `__THEME__` подставляет `routes`) |
| `style.css` | все стили; цвета только в переменных тем в начале файла |
| `js/core.js` | `TOKEN`, `FORMATS`, `GROUPS`, `PRESET_BASE`, `PRESETS`, общие переменные `files`, `fmt`, `snap`; `api`, `esc`, `fmtSize` |
| `js/settings.js` | `save`, `load`, `renderOut`, `renderParamSum`, `renderPresets`, `applyKind`, `buildFormats`, разделы-аккордеон, `setPanel`, `renderTheme`, обработчики настроек |
| `js/filelist.js` | `render`, `addInfos`, `dropItems`, выделение |
| `js/drop.js` | `dialog`, кнопки «+ Файлы»/«+ Папка», перетаскивание, `enqueueUpload` |
| `js/start.js` | `currentReq`, `startBatch`, кнопки «Конвертировать», «Стоп», ffmpeg |
| `js/toasts.js` | `toast`, `say`, `batchEvents`, `batchDone` |
| `js/preview.js` | `openPreview`, `outLine`, `thumbUrl` |
| `js/setup.js` | окно установки: `openSetup`, `renderSetup`, `ffSetupRow` |
| `js/updates.js` | `ffBanner`, `appBanner` |
| `js/poll.js` | `poll`, `updateButtons`, `beep`, кнопки «Закрыть программу» (только в браузере) и «лог» |
| `js/bannertab.js` | вкладка «Баннеры»: `setTab`, `bAdd`, `bRender`, `bDone` |
| `js/boot.js` | первый запуск отрисовки и опроса |

## HTTP API

Все ручки `/api/*` требуют заголовок `X-Token` и правильный Host, описаны в `routes` (`api.go`).

| Группа | Ручки |
|---|---|
| Пачка | `start`, `banners`, `cancel`, `state` |
| Файлы | `pick-files`, `pick-folder`, `upload`, `discard`, `info`, `open-output`, `open-dir` |
| ffmpeg | `download-ffmpeg`, `ffmpeg-skip` |
| Программа | `settings`, `app-update`, `app-skip`, `install`, `setup-later`, `exit` |

Вне `/api`: `/` (страница), `/hero.jpg`, `/favicon.png`, `/thumb` (токен в параметре `t`).

## Сборка, выпуск, прочее

| Файл | Зачем |
|---|---|
| `release.cmd`, `release.sh` | выпуск версии одной командой |
| `.github/workflows/release.yml` | проверки, сборка exe, релиз по тегу |
| `CHANGELOG.md` | что нового; раздел версии становится текстом релиза и плашки в программе |
| `winres/`, `rsrc_windows_amd64.syso` | иконка, манифест и свойства exe |
| `tools/setversion.py` | правка версии в syso без go-winres |
| `assets-original/` | исходники фото и иконки |

## Проверка

```
gofmt -l .        # должно быть пусто
go vet .          # в Windows: 2 предупреждения unsafe.Pointer в ui_windows.go — норма
go test ./...
```
