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
| Плеер по клику на превью | `web/js/preview.js` (`openPreview`), сам плеер `web/js/player.js` (`makePlayer`), `web/index.html` (`#prev`), стили `.stage`, `.ctl` |
| Вкладка «Плеер» | `web/js/playertab.js` (`plAdd`, `plPlay`, `plRender`, `plHold`), плеер `makePlayer`, приём файлов `web/js/drop.js` (`__konvDrop`), `web/index.html` (`#playView`) |
| Вкладка «Монтаж» | `web/js/montage.js`: окно файлов (`mtAdd`, `mtRender`, `mtDragFile`), панель клипа (`mtPanel`, `mtTrimClosed`), `mtSend`; `web/js/viewport.js`: вьюпорт; `web/js/tracks.js`: дорожки; `web/index.html` (`#montView`), стили: раздел «вкладка «Монтаж»» в `web/style.css` |
| Дорожки в интерфейсе, хоткеи | `web/js/tracks.js` (`tkRender`, `tkMoveDrag`, `tkTrimDrag`, `tkSplit`, `tkSpot`, `tkDo`, `tkLoad`, `TK_KEYS`, `TK_CTRL_KEYS`) |
| Вьюпорт: слои, звук, рамка слоя, просмотр файла | `web/js/viewport.js` (`mvShow`, `mvSync`, `mvTick`, `mvPrep`, `mvBind`, `mvBox`, `mvFrameDrag`, `mvFileShow`); рамка в рендере: `timeline.go` (`tlBoxChain`, поля `Clip.X`, `Y`, `W`, `H`). Кадр монтажа в PNG: `snapshot.go` (`saveMontFrame`) |
| Метки начала и конца вывода | `web/js/tracks.js` (`tkIn`, `tkOut`, `tkMark`, `tkMarksOff`), `web/js/montage.js` (`mtRange`, `mtProject`), `timeline.go` (`Project.In`, `Out`, `tlRange`) |
| Проект файлом и автосохранение | `project.go` (`writeProject`, `readProject`), `api.go` (`project-save`, `project-open`), `ui_windows.go` (`pickProjectSave`, `showSaveDialog`), `web/js/montage.js` (`mtProjectSave`, `mtProjectOpen`), `web/js/tracks.js` (`tkFile`, `tkAutosave`) |
| Движок дорожек и строка монтажа в очереди | `timeline.go` (`Project`, `Track`, `Clip`, `timelineInfo`, `tlPlan`, `tlVideoGraph`, `tlAudioGraph`, `spillGraph`: длинный граф файлом, `montRow`), `convert.go` (`run`, `convert`, `runFF`), `state.go` (`StartReq.Montages`), `web/js/filelist.js` (`addMontage`), `web/js/montage.js` (`mtProject`, `mtSend`), `web/js/start.js` (`currentReq`). Проверка: `timeline_test.go` |
| Перетаскивание строк | `web/js/kinetic.js` (`kinSort`, настройки силы в `KIN`), подключение: `plSort` в `web/js/playertab.js`; `kinFollow` в `tkMoveDrag` и `mtDragFile`, стили: раздел `kin-` в `web/style.css` |
| Сохранение кадра в PNG | `snapshot.go` (`saveFrame`, `snapPlan`, `snapArgs`), `web/js/player.js` (`saveShot`, `frameTime`), кнопки `pvShot`, `trShot` в `web/index.html` |
| Видео в папку PNG | `sequence.go` (`seqPattern`, `seqFrames`, `seqRemove`, `hasResult`), `ffargs.go` (`buildArgs`, вид `seq`), `files.go` (`seqOutPath`) |
| Картинки в одно видео | `sequence.go` (`joinGroups`, `joinStem`, `writeFrameList`, `checkFrameSizes`), `convert.go` (`run`, `convert`), галочка: `web/js/settings.js` (`renderJoin`, `joinOn`), состояние строк: `web/js/filelist.js` (`joined`, `resOf`) |
| Прозрачность | `ffargs.go` (`probe`: `si.alpha`, `si.decoder`, `si.pngFmt`; `buildArgs`), определение: `snapshot.go` (`snapPlan`), проверка пикселей: `sequence_test.go` (`alphaOf`) |
| Палитра GIF | `ffargs.go` (`gifFilter`), поле `gifPalette` в `web/index.html` |
| Форматы, которые окно не играет, реверс | копии для просмотра: `proxy.go` (`proxyStatus`, `proxyArgs`, `encodeReverse`, `proxyPrune`), `web/js/player.js` (`attachMedia`), `media.go` (`proxy=1`, `rev=1`), место и очистка: `mtCopies` в `web/js/montage.js` |
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
| Превью | `media.go`, `web/js/player.js` (`makePlayer`), `web/js/preview.js` |
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
| `ffargs.go` | `probe`, `gifFilter`, `planRate`, `rateArgs`, `fitCodecLimits`, `isStandardFPS`, `buildArgs`, `num`, `mbStr` |
| `convert.go` | `run`, `finishBatch`, `convert`, `encodeTarget`, `runFF`, `set`, `kept` |
| `fferrors.go` | `friendlyErr` (для человека), `errSummary` (для лога) |
| `ffdownload.go` | `download` (общее скачивание, защита от зависания), `downloadFFmpeg`, `tryDownload` |
| `api.go` | `routes` (все ручки), `api` (проверка токена и Host), `writeJSON` |
| `web.go` | сборка страницы на каждом языке `pages`, `buildPage`, `localize`, порядок скриптов `webJS` |
| `banner.go` | `runBanners`, `shrinkPNG`, `replaceFile`, `bannerNames`, `bannerWanted`, `bannerDims`, `bannerBase`, `bannerFind`, `bannerDirs` (где папки JPEG и WebP), `rememberBannerDirs`, `ffQuiet` |
| `media.go` | `parseMediaInfo`, `getMediaInfo`, `makeThumb`, `thumbHandler`, `mediaHandler` |
| `proxy.go` | копии для просмотра: `proxyDir`, `proxyStem`, `proxyPath`, `proxyPiecePath`, `proxyArgs`, `proxyStatus`, `encodeReverse`, `proxyStop`, `proxyPrune`, `proxyUsage`, `proxyClear`, `proxyCleanup` |
| `snapshot.go` | кадр в PNG: `saveFrame`, `saveMontFrame` (кадр монтажа), `snapPlan` (декодер и формат с прозрачностью), `snapArgs`, `snapName`, `snapPublish` |
| `sequence.go` | кадры: видео в папку PNG (`seqPattern`, `seqFrames`, `seqRemove`, `removeResult`, `hasResult`) и картинки в видео (`canJoin`, `joinRate`, `naturalLess`, `joinGroups`, `joinLeads`, `joinStem`, `writeFrameList`, `checkFrameSizes`) |
| `montage.go` | общее для монтажа: `forMontage`, `audioOnly`, `montClip`, `reverseRAM`, `checkReverseRAM`, `atempoChain`, `montGraphArgs` |
| `project.go` | файл проекта монтажа: `writeProject`, `readProject`; иконка и открытие двойным щелчком: `addProjectType`, `writeProjectType` в `install_windows.go`, приём: `addIncoming` в `state.go`, `mtProjectIncoming` в `web/js/montage.js` |
| `timeline.go` | дорожки: `Project`, `Track`, `Clip`, `tlRead`, `tlPrepare`, `tlCanvas`, `tlPlace`, `tlRange`, `timelineInfo`, `tlPlan`, `cmdLen`, `spillGraph`, `tlVideoGraph`, `tlClipChain`, `tlBoxChain`, `tlAudioGraph`, строка в очереди `montRow` |
| `mem_windows.go`, `mem_other.go` | `availableRAM`: сколько памяти свободно |
| `sounds.go` | `systemSounds`: какие звуки Windows есть на компьютере |
| `update.go` | `appVersion`, `Settings`, `cmpVer`, `latestFFmpeg`, `checkFFmpeg`, `checkLatestFF`, `httpGet`, `InstallInfo` |
| `theme.go` | значения темы, `validTheme`, `normTheme`, цвет фона окна `bgDark`, `bgLight` |
| `i18n.go`, `i18n_strings.go` | язык интерфейса: `normLang`, `setLang`, `tr`, `errT`; словарь `goDict` |
| `selfupdate.go` | `updateRepo`, `splitNotes`, `latestApp`, `checkApp`, `updateEvery`, `watchUpdates` (повторная проверка, пока программа открыта), `updateApp`, `fetchApp` |
| `whatsnew.go` | плашка «Что нового»: `changelogSince` (разбор вшитых `CHANGELOG.md` и `CHANGELOG.en.md`), `whatsNewSince`, `initNews`, `newsSeen` |
| `install_windows.go` | `doInstall`, `createShortcut`, `addSendTo`, `writeUninstallEntry`, `replaceSelf`, `restartSelf`, `afterUpdate`, `runUninstall` |
| `ui_windows.go` | `runUI`, `wndProc`, `activateRunning` и `receivePaths` (второй запуск), `applyWindowTheme` (заголовок и фон окна), `onWebMessage` (перетаскивание), `showDialog`, `pickFiles`, `pickFolder`, `pickSound`, `comCall` |
| `winplace.go` | размер и положение окна между запусками: `winPlace`, `loadWinPlace`, `saveWinPlace`, `fit`; вызовы Windows: `saveWindowPlace`, `showMainWindow` в `ui_windows.go` |
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
| `js/filelist.js` | `render`, `addInfos`, `addMontage` (строка монтажа), `dropItems`, выделение |
| `js/drop.js` | `dialog`, кнопки «+ Файлы»/«+ Папка», перетаскивание, `enqueueUpload` |
| `js/start.js` | `currentReq`, `startBatch`, кнопки «Конвертировать», «Стоп», ffmpeg |
| `js/toasts.js` | `toast`, `say`, `batchEvents`, `batchDone` |
| `js/kinetic.js` | перетаскивание с инерцией и наклоном, ничего не знает про вкладки: `kinFollow` (элемент на пружине, пригодится для дорожек), `kinSort` (порядок в списке, соседи расступаются; `busy` и `flip`), `kinCalm` (настройка «меньше движения»), настройки `KIN` |
| `js/player.js` | общее для плеера и обрезки: `mediaUrl`, `attachMedia` (файл или копия для просмотра), `videoSeek`, `keepSeeking`, `trackFrame`, `frameTime`, `saveShot`, `bindVolume`, `thumbUrl`, `fmtDur`, `makePlayer` (плеер на элементах с приставкой `pv` или `pl`) |
| `js/preview.js` | окно плеера: `openPreview`, `outLine` |
| `js/playertab.js` | вкладка «Плеер»: очередь `plFiles`, `plAdd`, `plPlay`, `plRemove`, `plRender`, `plMove`, `plButtons`, `plHold` (отпустить файл ради другого окна), `plTabChanged`, `plSend` (в конвертацию) |
| `js/tracks.js` | дорожки монтажа: модель `tkTracks`, отрисовка `tkRender`, `tkPaint`, `tkRuler`; прилипание `tkSnapBy`; места `tkSpot`, `tkPush`; действия `tkSplit`, `tkRemove`, `tkInsert`; мышь `tkDrag`, `tkMoveDrag`, `tkTrimDrag`, `tkBandDrag`; отмена `tkDo`, `tkCommit`, `tkBack`; метки вывода `tkMark`, `tkMarksOff`; сохранение `tkFile`, `tkLoad`, `tkAutosave`; хоткеи `TK_KEYS`, `TK_CTRL_KEYS` |
| `js/viewport.js` | вьюпорт монтажа: `mv`, холст `mvCanvasDims`, `mvSizeCanvas`; проверка файлов и копии `mvPrep`; набор `<video>` `mvBind`, `mvRelease`; кадр `mvShow`, синхронизация `mvSync`, `mvTick`, `mvPlay`, `mvPause`; рамка `mvBox`, `mvFrameDraw`, `mvFrameDrag`, `mvSnap`; файл из окна файлов `mvFileShow`, `mvFileOff` |
| `js/montage.js` | вкладка «Монтаж»: окно файлов `mtFiles`, `mtAdd`, `mtShow`, `mtRender`, `mtDragFile`; панель клипа `mtPanel`, `mtInfo`, `mtCopies`, `mtTrimClosed`; проект `mtProjectSave`, `mtProjectOpen`; отправка `mtProject`, `mtSend` |
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
| Файлы | `pick-files`, `pick-folder`, `project-save`, `project-open`, `upload`, `discard`, `info`, `proxy`, `proxy-stop`, `proxy-usage`, `proxy-clear`, `snapshot`, `snapshot-montage`, `open-output`, `open-dir` |
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
