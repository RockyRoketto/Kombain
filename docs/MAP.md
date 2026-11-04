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
| Новый формат вывода | `formats.go` (`formats`, `Kind` задаёт видимые настройки) + `web/js/core.js` (`FORMATS`, `GROUPS`). Только то, что есть в сборке essentials. `formats_test.go` сверяет списки и конвертирует в каждый формат |
| Ограничения кодеков | `ffargs.go` (`fitCodecLimits`, `isStandardFPS`), `formats.go` (поле `Filter`) |
| Новый пресет | `web/js/core.js` (`PRESETS`, значения по умолчанию в `PRESET_BASE`) |
| Свои пресеты | `web/js/settings.js` (`userPresets`, `buildPresets`, `presetOf`), хранятся в `localStorage` |
| Обрезка | окно: `web/js/trim.js`, `web/index.html` (`#trim`); запрос: `web/js/start.js` (`trims`); ffmpeg: `state.go` (`StartReq.trim`), `ffargs.go` (`buildArgs`), `convert.go` (`convert`); просмотр: `media.go` (`mediaHandler`) |
| Плеер по клику на превью | `web/js/preview.js` (`openPreview`, `pvPlayer`), `web/index.html` (`#prev`), стили `.stage`, `.ctl` |
| Сохранение кадра в PNG | `snapshot.go` (`saveFrame`, `snapPlan`, `snapArgs`), `web/js/player.js` (`saveShot`, `frameTime`), кнопки `pvShot`, `trShot` в `web/index.html` |
| Форматы, которые окно не играет | копия для просмотра: `proxy.go` (`proxyStatus`, `proxyArgs`), `web/js/player.js` (`attachMedia`), `media.go` (`proxy=1`) |
| Файлы снаружи, второй запуск | `main.go` (`argPaths`), `ui_windows.go` (`activateRunning`, `receivePaths`), `state.go` (`addIncoming`), `web/js/poll.js` (`incoming`) |
| «Отправить» в меню Windows | `install_windows.go` (`addSendTo`, `shortcutFolders`) |
| Конец пачки | `web/js/poll.js` (`doneSeq`), `state.go` (`batchSeq`) |
| Звуки окончания и ошибки | `web/js/sounds.js` (`batchSound`, `playSound`, `beep`, `renderSounds`), список Windows: `sounds.go`, диалог: `ui_windows.go` (`pickSound`), играет через `/media` |
| Новое входное расширение | `formats.go` (`videoExt`, `audioExt`, `imageExt`; маску диалога даёт `mediaFilter`), `web/js/core.js` (`MEDIA`), `web/js/trim.js` (`TRIMMABLE`) |
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
| Тексты и язык | страница: `web/i18n.json`, в разметке метки `data-i18n`, в коде `t()` и `tn()` из `web/js/i18n.js`; Go: `i18n_strings.go`, `tr()`, `errT()`, `logT()` из `i18n.go`; переключатель: `web/js/settings.js` (`renderLang`) |
| Сводки в заголовках разделов | `web/js/settings.js` (`applyKind`, `renderParamSum`, `renderPresets`, `renderOut`) |
| Список файлов | `web/js/filelist.js` |
| Всплывашки, итог пачки | `web/js/toasts.js` |
| Плашки обновлений и «Что нового» | `web/js/updates.js`; логика — `update.go`, `selfupdate.go`, `whatsnew.go` |
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
| `main.go` | `main`, `argPaths`, `startServer`, `stopAll`, `idleExit`, `openBrowser` |
| `state.go` | типы `Server`, `FileState`, `StartReq`, `Trim`, `DL`, `FileInfo`; `begin`, `addIncoming`, `addLog`, `logT` |
| `formats.go` | `Format`, `fm`, `formats`, `compressFormat`, `presets`, `videoExt`, `audioExt`, `imageExt`, `mediaExt`, `mediaFilter` |
| `files.go` | `dataDir`, `dropDir`, `findFFmpeg`, `isTemp`, `fileExists`, `fileSize`, `walkMedia`, `expandPaths`, `openFolder`, `safeName`, `outPath` |
| `ffargs.go` | `probe`, `planRate`, `rateArgs`, `fitCodecLimits`, `isStandardFPS`, `buildArgs`, `num`, `mbStr` |
| `convert.go` | `run`, `convert`, `encodeTarget`, `runFF`, `set`, `kept` |
| `fferrors.go` | `friendlyErr` (для человека), `errSummary` (для лога) |
| `ffdownload.go` | `download` (общее скачивание, защита от зависания), `downloadFFmpeg`, `tryDownload` |
| `api.go` | `routes` (все ручки), `api` (проверка токена и Host), `writeJSON` |
| `web.go` | сборка страницы на каждом языке `pages`, `buildPage`, `localize`, порядок скриптов `webJS` |
| `banner.go` | `runBanners`, `shrinkPNG`, `replaceFile`, `bannerNames`, `bannerWanted`, `bannerDims`, `bannerBase`, `bannerFind`, `bannerDirs` (где папки JPEG и WebP), `rememberBannerDirs`, `ffQuiet` |
| `media.go` | `parseMediaInfo`, `getMediaInfo`, `makeThumb`, `thumbHandler`, `mediaHandler` |
| `proxy.go` | копия для просмотра: `proxyDir`, `proxyPath`, `proxyArgs`, `proxyStatus`, `proxyStop`, `proxyPrune`, `proxyCleanup` |
| `snapshot.go` | кадр в PNG: `saveFrame`, `snapPlan` (декодер и формат с прозрачностью), `snapArgs`, `snapName`, `snapPublish` |
| `sounds.go` | `systemSounds`: какие звуки Windows есть на компьютере |
| `update.go` | `appVersion`, `Settings`, `cmpVer`, `latestFFmpeg`, `checkFFmpeg`, `checkLatestFF`, `httpGet`, `InstallInfo` |
| `theme.go` | значения темы, `validTheme`, `normTheme`, цвет фона окна `bgDark`, `bgLight` |
| `i18n.go`, `i18n_strings.go` | язык интерфейса: `normLang`, `setLang`, `tr`, `errT`; словарь `goDict` |
| `selfupdate.go` | `updateRepo`, `splitNotes`, `latestApp`, `checkApp`, `updateEvery`, `watchUpdates` (повторная проверка, пока программа открыта), `updateApp`, `fetchApp` |
| `whatsnew.go` | плашка «Что нового»: `changelogSince` (разбор вшитых `CHANGELOG.md` и `CHANGELOG.en.md`), `whatsNewSince`, `initNews`, `newsSeen` |
| `install_windows.go` | `doInstall`, `createShortcut`, `addSendTo`, `writeUninstallEntry`, `replaceSelf`, `restartSelf`, `afterUpdate`, `runUninstall` |
| `ui_windows.go` | `runUI`, `wndProc`, `activateRunning` и `receivePaths` (второй запуск), `applyWindowTheme` (заголовок и фон окна), `onWebMessage` (перетаскивание), `showDialog`, `pickFiles`, `pickFolder`, `pickSound`, `comCall` |
| `install_other.go`, `ui_other.go`, `hide_*.go` | заглушки не для Windows и запуск процессов без окна |

Тесты лежат рядом (`*_test.go`). `compress_test.go`, `banner_test.go` и `media_test.go` используют настоящий ffmpeg.

## Интерфейс: web/

Страница собирается в один HTML при запуске (`web.go`): `index.html` + `style.css` + скрипты по порядку из `webJS`.
Скрипты обычные, не модули: переменные общие, а порядок важен. Новый файл в `web/js` надо добавить в `webJS`, иначе упадёт тест.

| Файл | Что внутри |
|---|---|
| `index.html` | разметка всех экранов и окон без текстов (метки `data-i18n`); метки `__CSS__`, `__JS__`, `__LANG__`; в `<head>` — `applyTheme` (тема до первой отрисовки, значение `__THEME__` подставляет `routes`) |
| `style.css` | все стили; цвета только в переменных тем в начале файла |
| `i18n.json` | тексты страницы на обоих языках; значения могут содержать HTML, подстановки `{имя}`, формы числа через `|` |
| `js/i18n.js` | словарь в странице, `lang`, `t`, `tn`, `applyLang` (смена языка без перезапуска) |
| `js/core.js` | `TOKEN`, `FORMATS`, `fmtName`, `GROUPS`, `PRESET_BASE`, `PRESETS`, общие переменные `files`, `fmt`, `snap`; `api`, `esc`, `fmtSize` |
| `js/settings.js` | `save`, `load`, `renderOut`, `renderParamSum`, `renderPresets`, `applyKind`, `buildFormats`, свои пресеты (`userPresets`, `buildPresets`), разделы-аккордеон, `setPanel`, `renderTheme`, `renderLang`, обработчики настроек |
| `js/filelist.js` | `render`, `addInfos`, `dropItems`, выделение |
| `js/drop.js` | `dialog`, кнопки «+ Файлы»/«+ Папка», перетаскивание, `enqueueUpload` |
| `js/start.js` | `currentReq`, `startBatch`, кнопки «Конвертировать», «Стоп», ffmpeg |
| `js/toasts.js` | `toast`, `say`, `batchEvents`, `batchDone` |
| `js/player.js` | общее для плеера и обрезки: `mediaUrl`, `attachMedia` (файл или копия для просмотра), `videoSeek`, `keepSeeking`, `trackFrame`, `frameTime`, `saveShot`, `bindVolume` |
| `js/preview.js` | окно плеера: `openPreview`, `pvPlayer`, `pvRelease`, `pvToggle`, `outLine`, `thumbUrl` |
| `js/trim.js` | окно обрезки: `openTrim`, `closeTrim`, `trimSet`, `trimSeek`, `trimStep`, `trimUseFrames`, `trimBound`, `trimFmt`, `trimParse`, `trimTag` |
| `js/setup.js` | окно установки: `openSetup`, `renderSetup`, `ffSetupRow` |
| `js/updates.js` | `ffBanner`, `appBanner` |
| `js/sounds.js` | звуки: `batchSound`, `playSound`, `beep` (запасной сигнал), `renderSounds`; выбор в `localStorage` |
| `js/poll.js` | `poll`, `updateButtons`, `renderSummary`, кнопки «Закрыть программу» (только в браузере) и «лог» |
| `js/bannertab.js` | вкладка «Баннеры»: `setTab`, `bAdd`, `bRender`, `bRenderDirs`, `bSyncDirs` (поиск папок), `bBadSize` и `bCheckSizes` (проверка размеров), `bDone` |
| `js/boot.js` | первый запуск отрисовки и опроса |

## HTTP API

Все ручки `/api/*` требуют заголовок `X-Token` и правильный Host, описаны в `routes` (`api.go`).

| Группа | Ручки |
|---|---|
| Пачка | `start`, `banners`, `banner-dirs`, `cancel`, `state` |
| Звуки | `sounds`, `pick-sound` |
| Файлы | `pick-files`, `pick-folder`, `upload`, `discard`, `info`, `proxy`, `proxy-stop`, `snapshot`, `open-output`, `open-dir` |
| ffmpeg | `download-ffmpeg`, `ffmpeg-skip` |
| Программа | `settings`, `app-update`, `app-skip`, `news-seen`, `install`, `setup-later`, `exit` |

Вне `/api`: `/` (страница), `/hero.jpg`, `/favicon.png`, `/thumb` и `/media` (токен в параметре `t`). Адреса картинок в `index.html` содержат метку `__VER__`, её подставляет `routes`: иначе после обновления окно показывает старые из кэша.

## Сборка, выпуск, прочее

| Файл | Зачем |
|---|---|
| `release.cmd`, `release.sh` | выпуск версии одной командой |
| `.github/workflows/release.yml` | проверки, сборка exe, релиз по тегу |
| `CHANGELOG.md`, `CHANGELOG.en.md` | что нового на двух языках; разделы версии становятся текстом релиза и плашек в программе (`splitNotes` в `selfupdate.go`) |
| `winres/`, `rsrc_windows_amd64.syso` | иконка, манифест и свойства exe |
| `tools/setversion.py` | правка версии в syso без go-winres |
| `assets-original/` | исходники фото и иконки |

## Проверка

```
gofmt -l .        # должно быть пусто
go vet .          # в Windows: 3 предупреждения unsafe.Pointer в ui_windows.go — норма
go test ./...
```
