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
| Вкладка «Монтаж» | `web/js/montage.js`: разделитель (`mtSplitSet`), окно файлов (`mtAdd`, `mtRender`, `mtDragFile`), панель клипа (`mtPanel`, `mtTrimClosed`), `mtSend`; `web/js/viewport.js`: вьюпорт; `web/js/tracks.js`: дорожки; `web/index.html` (`#montView`), стили: раздел «вкладка «Монтаж»» в `web/style.css` |
| Дорожки в интерфейсе, хоткеи | `web/js/tracks.js` (`tkRender`, `tkRowDrag`: высота дорожки, `TK_HELP` и `tkHelpOpen`: окно клавиш, `tkLive` и поле дорожки `off`: глаз и динамик, `tkMoveDrag`, `tkTrimDrag`, `tkSplit`, `tkSpot`, `tkDo`, `tkLoad`, `TK_KEYS`, `TK_CTRL_KEYS`) |
| Вьюпорт: слои, звук, рамка слоя, просмотр файла | `web/js/viewport.js` (`mvShow`, `mvSync`, `mvTick`, `mvPrep`, `mvBind`, `mvBox`, `mvFrameDrag`, `mvFileShow`); рамка в рендере: `timeline.go` (`tlBoxChain`, поля `Clip.X`, `Y`, `W`, `H`). Кадр монтажа в PNG: `snapshot.go` (`saveMontFrame`) |
| Качество просмотра | `web/js/viewport.js` (`mvQual`, `mvQualSet`, `mvLowPrep`, `mvLowPoll`, `mvLowOf`, ключ в `mvKey`), холст в `chromaShow`; копии: `proxyPiece.Scale`, `proxyArgs` в `proxy.go`, `scale` в `media.go`. Проверка: `TestProxyScale` |
| Звук просмотра и индикатор громкости | шина Web Audio и общий ползунок: `web/js/viewport.js` (`mvAudio`, `mvGain`, `mvLevel`, `mvVol`), часы за ведущим звуком: `mvFollow`, `mvSync`; столбики L и R, пик, красная метка: `web/js/vumeter.js` (`vuAttach`, `vuKick`, `vuStep`, `vuDraw`) |
| Удаление фона (хромакей) | просмотр на WebGL и пипетка: `web/js/chroma.js` (`chromaShow`, `chromaSweep`, `chromaPickToggle`, `chromaSample`), вызов в `mvLook`; панель: `mtKeyRow`, `mtKeyOn` в `web/js/montage.js`; рендер: `timeline.go` (`tlKeyChain`, `tlKeepsAlpha`, поля `Clip.KeyColor`, `KeySim`, `KeyBlend`, `KeySpill`). Новое поле клипа добавить ещё в `mtClipOut` и `tkLoad`. Проверка: `TestTimelineKey` |
| Цветокоррекция | просмотр: `web/js/chroma.js` (`CHROMA_FRAG`, `chromaGraded`, `chromaShow`); панель: `MT_COLOR` в `web/js/montage.js`; рендер: `timeline.go` (`tlGradeChain`, поля `Clip.ColBri`, `ColCon`, `ColMid`, `ColSat`, `ColTemp`, `ColTint`). Формулы в трёх местах должны совпадать, третье в `gradeCalc` (`timeline_layer_test.go`). Проверка: `TestTimelineGrade` |
| Режимы наложения | просмотр: `mix-blend-mode` в `mvPlace` (`web/js/viewport.js`); панель: `#mtBlend`, список значений ещё в `tkLoad`; рендер: `timeline.go` (`tlBlends`, `tlLayers`, `tlBlendGraph`, `Clip.Blend`). Проверка формул: `timeline_blend_test.go` |
| Размытие и тень | просмотр: `mvFx`, вызов в `mvPlace` (`web/js/viewport.js`), кадрирование с эффектами через `object-view-box`; панель: `mtFxRow`, `#mtShOn` в `web/js/montage.js`; значения ещё в `mtClipOut` и `tkLoad`; рендер: `tlFxChain`, `Clip.Blur`, `ShadowA` и другие в `timeline.go`. Проверка: `timeline_fx_test.go` |
| Переходы на краю клипа | рендер: `transitions.go` (`Trans`, поля `Clip.TrIn`, `TrOut`, `tlTransKinds`, `tlTransitions`, `extend`: запас за краем и стоп-кадр `pad`, звук `tlTransFades`), склейка через `xfade` в `tlVideoGraph` (`timeline.go`). Просмотр: `web/js/mvtrans.js` (`mvTrMap`: те же правила, что `tlTransitions`, `mvSpan` и `mvShown`: клип виден за краем на время стыка, `mvTrAt`, `mvTrLook`: формулы xfade по видам, `mvTrPlace`: clip-path, transform и маска поверх `mvPlace`, `mvTrFrame`: плашки цвета, `mvTrGain`: звук qsin), стоп-кадр до начала файла в `mvSync`; поля в JS: `TK_TRANS` и `tkLoad` в `tracks.js`, `mtClipOut`, разрез в `tkSplit`. Вкладка «Переходы», плашки на дорожке и клавиша D: `web/js/trpanel.js` (`tkTrPut`: поставить, стык у правого клипа, звук связки рядом; `tkTrPaint`: плашки внутри клипов, у стыка две половинки; `tkTrDown`: щелчок и тяга края; `trCardDrag` и `tkTrEdgeAt`: образец на край; `tkTrDefault`: клавиша D; `trDraw`: образец по `mvTrLook`; `trFill`: настройки выбранного, выбор `tkTrSel`), зовутся из `tkRender`, `tkPaint`, `tkDeleteSel` и `mtTabs`. Проверка: `timeline_trans_test.go` (`TestTransKindsJS` сверяет списки видов и названия `tr.k.*`) |
| Ключевые кадры рамки слоя (середина, ширина, поворот), непрозрачности и кривые | `web/js/keyframes.js` (`kfPose`: клип в позу момента, `kfSync`: правка полей уходит в ключ, `kfCanon`, `kfTracks`: для отмены и файла поля в позе начала клипа, `kfPut`, `kfEase`, `kfAt`, ромбики панели `kfDiamonds`, `kfToggle`, `kfMenu`, на клипе `kfPaintClip`, `kfClipDrag`, разрез `kfSplit`, `kfLoad`); вызовы в `mvShow`, `mvTick`, `mvSetCanvas`, `tkSplit`, `tkLoad`, `mtFramePanel`, `ctxItems`; рендер: `keyframes.go` (`Keys`, `kfTrack`, `kfExpr`, `kfPrep`, `kfPlace`: фильтр perspective с номером кадра `in`, только при `Keys.moves`), вызов в `tlClipChain`. Непрозрачность: поле клипа `op` (`Clip.Op`), ключи `o` (`Keys.O`), ряд `mtOpacity` в «Положении и масштабе», просмотр: множитель в `mvLook`; рендер: `tlOpChain` в `timeline.go` (множитель geq на картинке 2×2, умножение альфы через blend), проверка `opacity_test.go`. Формулы кривых в `kfEase` двух файлов должны совпадать. Проверка: `keyframes_test.go`. Готовые появление и исчезание (раздел «Анимация», `data-sec="anim"`): `kfAnimSet` ставит ключи у начала или конца клипа и помнит выбор в `c.anim` = {i, o}: {k, d, e}, ход по видам `kfAPath`, панель `kfAnimFill` (вызов в `mtFramePanel`), из файла `kfAnimLoad` (`tkLoad`), разрез делит `c.anim` в `tkSplit`. Выбранный ромбик на клипе `kfPick`, удаление клавишей Delete `kfPickDrop` (вызов в `tkDeleteSel`) |
| Автосубтитры | `whisper.go` (`whisperStart`, `whisperRun`, `whisperArgs`, адреса и суммы `whisperPkg`, `whisperModels`, тег `whisperTag`), времена слов и реплики: `whisper_words.go` (`whisperWords`, `whisperGroup`, пределы `cueMaxChars` и другие), границы реплик по звуку: `whisper_align.go` (`speechSpans`, `whisperRepair`, `whisperAlign`), кнопка: `mtAutoGo`, `mtAutoWatch` в `web/js/montage.js`. Сырые времена последнего запуска: `cache\whisper-last.json` |
| Меню правой кнопки | `web/js/ctxmenu.js` (`ctxItems`: что где показать, `ctxOpen`), выключение меню браузера и разрешение на чтение буфера: `runUI` в `ui_windows.go` |
| Вид субтитров: цвет, подложка, контейнер, положение | `subsASS`, `Subs.fit` (своя высота рамки `Subs.H`) в `subtitles.go`; просмотр и мышь: `mvSubsDraw`, `mvSubsAt`, `mvSubsPress` в `web/js/viewport.js`; панель: `mtSubsFill` в `web/js/montage.js` (разделы вкладки: `subsSrc` прячется при готовых субтитрах, флаги `mtSubsSrc`, `mtAutoOn`; шапка `#mtSubsHead`; остальные разделы `.mt-subsec`, `#mtCueWrap`). Проверка: `TestTimelineSubsLook` |
| Сетка и безопасные зоны | `mvGuidesSet`, `mvSafeSet`, цифры площадок `MV_ZONES` в `web/js/viewport.js`, `#mvGrid`, `#mvSafe`, кнопки `mvGridBtn`, `mvSafeBtn` |
| Риска и магнит ползунков | `web/js/sliders.js` (`slPlace`, `slEnd`, ширина магнита `SL_ZONE`), значение в `data-origin` у ползунка в `web/index.html`, рисует `::-webkit-slider-runnable-track` в `web/style.css` (`--sl-t`: ширина шарика) |
| Ширина инспектора | `mtVSplitSet`, `mtVSplitPlace` в `web/js/montage.js`, `#mtVSplit`, переменная `--mt-right` |
| Правка субтитров | `web/js/subedit.js`: дорожка S (`mtCueLane`, `mtCueDown`, глаз `#tkSubEye`, поле `tkSubs.off`), выделение нескольких (`mtCueMany`, `mtCuePicked`, `mtCueToggle`, `mtCueAll`, рамка в `tkBandDrag`), список (`mtCuesFill`), `mtCueAdd`, `mtCueSplit`, `mtCueMerge`, `mtCueDelete`, `mtCueDrop`; реплики в `tkSubs.cues` и `Subs.Cues`; файл: `subs-save` |
| Эффекты субтитров (печатная машинка, по слову, караоке, активное слово) | модель `Subs.Fx` (`SubFx`), рендер `subsFxType`, `subsFxStep`, `subsFxState`, `subsFxWord`, `subsFxWordTimes`, `subsFxWordHeads` (группы: предлог — со следующим словом, тире — с предыдущим; зеркало `subFxWordHeads`), `subsFxPeak`, ширина слова `textWidth` (`fonts_windows.go`, GDI) в `subtitles.go`; начала слов `SubCue.W` (из `whisperGroup`, сдвиг `cueWordsMove` в `whisper.go`, со страницы через `WhisperJob.Cues`; при разрезании и склейке `mtCueSplit`, `mtCueMerge`); просмотр и панель: `web/js/subfx.js`, вызов в `mvSubsDraw` и `mtSubsFill`; разметка `#mtSubsFx`, `#mtSubsFxType`, `#mtSubsFxWord`. караоке: `subs_karaoke.go` (`subsFxKar`, куски `subsKarChunks`, перенос `subsKarBreak`, плашки `subsKarPills`, рисунок `subsKarPath`, место блока `subsKarTop`, заливка `subsKarFill`), в просмотре `subFxKar*`, разметка `#mtSubsFxKar`, стили `.mv-subs-kar`, `.mv-subs-k`. Общая раскладка строк караоке и активного слова: `subsKarLayout`, подложка `subsKarBack` (зеркало `subFxKarLay`). Активное слово: `subs_active.go` (`subsFxAct`: событие на каждый отрезок между переходами, `\pos` или `\move`; время `subsActTimes`, доля `subsActLevel`, цвет `subsActMix`), в просмотре `subFxAct*` (поля раздвигают соседей), разметка `#mtSubsFxAct`, стиль `.mv-subs-a`. Проверка: `TestSubsFxType`, `TestSubsFxWord`, `TestSubsFxKar`, `TestSubsFxAct` |
| Инструмент «Текст» и шрифты Windows | `web/js/textclip.js` (`mtTextDraw`: рисует PNG, `mtTextWrap`, рамка как область текста: `text.box`, `mtTextBoxed`, `mtTextBoxMove`, вызов в `mvSetBox`; `mtTextRedraw`, `mtTextRefresh`, `mtFontsLoad`), поле клипа `text`, файл: `saveTextPNG` в `subtitles.go`, шрифты: `fonts_windows.go`, разметка `#mtTextBox`, `#mtText` |
| Субтитры из файла .srt | чтение, вжигание, дорожка: `subtitles.go` (`subsRead`, `subsASS`, `subsPlan`, `Project.Subs`); просмотр: `web/js/viewport.js` (`mvSubsDraw`, `mvSubLine`: высота строки шрифта); панель: `web/js/montage.js` (`mtSubsFill`, `mtCues`), значение `tkSubs` в `web/js/tracks.js`. Размеры в `subsASS` и `mvSubsDraw` должны совпадать. Проверка: `subtitles_test.go` |
| Где лежат данные программы, новая модель или докачиваемая программа | `files.go`: `ffDir`, `cacheDir`, `modelDir`, `toolDir`, перенос из старой раскладки `migrateData` (зовёт `startServer`) |
| Автоочистка кэша | `cache.go`: `cacheTidy` при запуске, `textPrune` (срок и предел `textKeepAge`, `textKeepSize`); копии отдельно: `proxyPrune` |
| Окно настроек: «Хранилище» и «О программе» | Go: `storage.go` (`storageParts` — части полосы, `cacheClear`, `whisperRemove`, статистика `statsAdd` из `finishBatch` в `convert.go`, файл `stats.json`), запросы `storage`, `storage-clear`, `storage-remove` в `api.go`; страница: `web/js/settings.js` (`setpShow`, `storeRender`, `aboutRender`, группы и цвета частей `STORE_GROUP`, `--st-*` в `web/style.css`), очистка с отпуском копий: `mtFreeCache` в `web/js/montage.js` |
| Инспектор (правая панель монтажа): полоса значков-вкладок Кадр, Анимация, Переходы (`trpanel.js`), Цвет, Эффекты, Звук, Клип, Субтитры, Вывод и поиск по настройкам. Новый раздел: `details.mt-sec` с `data-sec` в нужной `.mt-pane`, ключевые слова поиска `mt.kw.<data-sec>` в `web/i18n.json`, свёрнутость запоминается сама; раздел только для одного клипа обернуть в `.mt-one` | `web/js/montage.js` (`mtHas`: какие вкладки доступны, `mtTabs`: вкладки и точка об изменениях, `mtTabGo`, `mtIndexBuild` и `mtFind`: поиск, `mtFramePanel`, `mtFrameFill`, `mtSoundPanel`, `mtSoundFill`, `mtSum`: значение в заголовке раздела, `mtRow`: ползунок, число и Alt с мышью, `mtBoxRow`, `mtFadeRow`), разметка в `web/index.html` (`mtTabs`, `mtFind`, `mtHits`, `.mt-pane`, `.mt-one`); просмотр: `web/js/viewport.js` (`mvPlace`, `mvFadeAt`, `mvLevel`, `mvGain`, `mvLook`, `mvRotDrag`, `mvCropDrag`, `mvHandleDrag`); рендер: `timeline.go` (`tlBoxChain`, `tlFitBox`, `tlFades`, `Clip.Rot`, `CropL`, `Vol`, `FadeIn`). Проверка: `timeline_layer_test.go` |
| Размер холста | кнопка и меню `web/js/viewport.js` (`mvCanvasBtn`, `mvCanvasMenu`, `MV_SIZES`, `mvSetCanvas`), значение `tkCanvas` в `web/js/tracks.js`, рендер: `Project.W`, `H` в `timeline.go` |
| Логотип | `web/js/montage.js` (`mtLogo`, `MT_LOGO_W`), кнопка в `web/index.html` (`#mtLogo`) |
| Метки начала и конца вывода | `web/js/tracks.js` (`tkIn`, `tkOut`, `tkMark`, `tkMarkAt`: что берёт нажатие на шкале, `tkMarksOff`), `web/js/montage.js` (`mtRange`, `mtProject`), `timeline.go` (`Project.In`, `Out`, `tlRange`) |
| Метки на таймлайне и на клипе | `web/js/tracks.js` (`tkMarkers`, поле клипа `marks`, `tkPutMarker`, `tkClipMarks`, `tkPaintMarks`, `tkMarkerDrag`, `tkClipMarkDrag`) |
| Связка картинки и звука | `web/js/tracks.js` (поля клипа `part`, `link`, `tkGroup`, `tkIds`, `tkOne`, `tkTidyLinks`, `tkAddSound`, `tkLinkToggle`, `tkSplitAll`), `web/js/viewport.js` (`mvMuted`), `timeline.go` (`Clip.Part`, `tlPrepare`), волна видеофайла: `media.go` (`makeThumb`, `at` меньше нуля) |
| Проект файлом и автосохранение | `project.go` (`writeProject`, `readProject`), `api.go` (`project-save`, `project-open`), `ui_windows.go` (`pickProjectSave`, `showSaveDialog`), `web/js/montage.js` (`mtProjectSave`, `mtProjectOpen`), `web/js/tracks.js` (`tkFile`, `tkAutosave`, `tkDirty`, `tkMarkSaved`) |
| Чистый запуск, вопрос при закрытии, возврат после сбоя | что переживает запуск: `web/js/settings.js` (`NEW_RUN`, `FIELDS_KEEP`, `load`); окно вопроса и логика: `web/js/session.js` (`askBox`, `__konvClose`); `ui_windows.go` (`wmClose`, `closeWindow`, `closeAck`); метка сбоя: `main.go` (`markRunning`, `markStopped`), `api.go` (`session`, `close-ack`, `close-go`) |
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
| Вкладка «Утилиты» (колонка инструментов слева, как у «Цвета») | разметка `#utilView` в `web/index.html`: колонка `#utTools` (классы `.cl-tool` из «Цвета»), панели `#favView` и `#bannerView` (`.ut-pane`); переключение: `setTab` в `web/js/bannertab.js` (значения `tab`: `util` — фавиконы, `banner` — баннеры; кнопка шапки `data-t="util"` открывает последний инструмент `utl` из `web/js/settings.js`); стили `.ut-main`, `.ut-pane` рядом с `.cl-main` в `web/style.css`. Новый инструмент: кнопка в `#utTools`, панель `.ut-pane`, ветка в `setTab` и `utl` |
| Инструмент «Баннеры» (в «Утилитах») | `banner.go`, `web/js/bannertab.js` |
| Вкладка «Цвет» | `web/js/color.js`: инструменты `cl.tool` (`CL_TOOLS`: `grad`, `pick` здесь; `pal`, `photo`, `shade` в `web/js/colorset.js`), цвет OKLCH (`clLab`, `clLabRgb`, `clLch`, `clFit`, `clMix`), точки для рисования `clDense`, геометрия как в CSS `clGeo`, рисование `clPaint`, выгрузка `clCssCode`, `clSvg`, PNG с шумом; полоса точек `clBarDraw`, точки списком `clChips` (поле цвета из colorpick.js), «Случайно» `clRandom`, форматы `clFormats`, «Мои цвета» `clLib` (`k9000.colorLib`: цвет, градиент или палитра `{p}`, `clLibOk`), состояние `k9000.color`. Палитра, Из фото, Оттенки: `web/js/colorset.js` (правила `CS_RULES`, `csRandom`, колонки `csColsDraw`; ступени `csShades`, `CS_L`, `CS_C`; фото `csPhTake`, `csKmeans`, метки `csPhAt`; общая выгрузка `csList`, `csCss`, `csJson`, `csSvg`, `csPng`; `csUse`, `csPalLoad`, `csToGrad`; состояние `k9000.colorSet`), перетаскивание `csDragIn`, `csDragOut`, `csDrop` из `drop.js`; «Отправить в» `clSendTo`, `clSetOf`, `clOneOf`, `clSendDraw` (`.cl-send`), точка из пипетки `clAddStop` в color.js; отмена `clMark`, `clBack`, `clSnap` (зовут `clSave`, `csSave`, `clLibSet`). Разметка `#colorView` в `web/index.html`, стили: раздел «вкладка «Цвет»» в конце `web/style.css`. Go: `color.go` (`colorFileBytes`, палитра ASE `aseBytes`, `saveColorFile`), запрос `color-save` в `api.go`, диалог `pickColorSave` в `ui_windows.go`. Проверка: `TestColorFileBytes`, `TestColorFileName`, `TestColorASE` |
| Инструмент «Фавиконы» (в «Утилитах») | `web/js/favicon.js` (картинки рисует canvas), `favicon.go` (ICO, ZIP и папка), разметка `#favView` в `web/index.html`, стили: раздел «вкладка «Утилиты»» в конце `web/style.css`. Проверка: `TestBuildICO`, `TestWriteFavZip`, `TestWriteFavFolderAndFreePath` |
| Новая настройка в интерфейсе | `web/index.html` + `web/js/settings.js` (`FIELDS`) + `web/js/start.js` (`currentReq`) + `state.go` (`StartReq`) |
| Панель настроек за шестерёнкой | `web/index.html` (`setPanel`: разделы `.setp-tab` и страницы `.setp-page` с одним `data-p`), `web/js/settings.js` (`setPanel`, `setpShow`, сброс `resetAll` и что он оставляет `RESET_KEEP`, в Go: поле `reset` в `/api/settings`) |
| Тема оформления | цвета: `web/style.css` (`:root`, `:root[data-theme="light"]`); применение: `applyTheme` в `web/index.html`; переключатель: `web/js/settings.js` (`renderTheme`); окно: `ui_windows.go` (`applyWindowTheme`); значения: `theme.go` |
| Настройка, которую должен знать Go | `update.go` (`Settings`), `api.go` (`/api/settings`) |
| Тексты и язык | страница: `web/i18n.json`, в разметке метки `data-i18n`, в коде `t()` и `tn()` из `web/js/i18n.js`; Go: `i18n_strings.go`, `tr()`, `errT()`, `logT()` из `i18n.go`; переключатель: `web/js/settings.js` (`renderLang`) |
| Сводки в заголовках разделов | `web/js/settings.js` (`applyKind`, `renderParamSum`, `renderPresets`, `renderOut`) |
| Список файлов | `web/js/filelist.js` |
| Всплывашки, итог пачки | `web/js/toasts.js` |
| Плашка ffmpeg, окна обновления и «Что нового» | `web/js/updates.js` (окна `#appWin`, `#newsWin` в `web/index.html`); логика — `update.go`, `selfupdate.go`, `whatsnew.go` |
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
| `whisper.go` | автосубтитры: `whisperStart`, `whisperRun`, `whisperFetch`, `whisperUnpack`, `whisperInstall`, `whisperAudio`, `whisperSpeech`, `whisperPlace`, `whisperState`, `whisperStop` |
| `whisper_words.go` | полный JSON whisper.cpp в реплики: `whisperWords`, `whisperGroup`, `whisperClean`, `whisperNoise` |
| `whisper_align.go` | границы реплик по звуку: `speechSpans`, `pcmLevels`, `spansOfLevels`, `whisperRepair`, `whisperAlign` |
| `fonts_windows.go`, `fonts_other.go` | `systemFonts`: список шрифтов Windows |
| `shapes.go` | прорисовка линии: `saveShapeSeq` (кадры `seq-<сумма>-%04d.png`), `shapeSeqOK`, `shapeSeqInput`; поля клипа `Clip.Seq`/`SeqN`/`SeqFps` идут в `tlInput` (`timeline.go`), на странице `seq`/`seqN`/`seqFps` (`mtClipOut`); тест `shapes_test.go` |
| `subtitles.go` | картинка клипа «Текст» `saveTextPNG`; субтитры монтажа: `Subs`, `subsDecode`, `subsParse`, `subsRead`, `subsRange`, `subsASS`, `subsSRT`, `subsTemp`, `subsFilterPath`, `subsTrackCodec`, `subsPlan` |
| `subs_karaoke.go` | эффект субтитров «Караоке»: плашка растёт, прыгает или заливка букв, см. таблицу задач |
| `subs_active.go` | эффект субтитров «Активное слово»: слово цветом и крупнее, соседи расступаются, см. таблицу задач |
| `subs_chunks.go` | «Слов на экране»: `Subs.Chunk`, нарезка реплик на куски `subsChunks` (в `subsPlan` до вжигания и дорожки), времена `subsChunkTimes`; зеркало `subChunks` в `web/js/subfx.js` (вызов в `mvSubsDraw`), список `#mtSubsChunk`. Проверка: `TestSubsChunks` |
| `files.go` | `dataDir`, `ffDir`, `cacheDir`, `modelDir`, `toolDir`, `migrateData`, `dropDir`, `ffPath`, `findFFmpeg`, `isTemp`, `fileExists`, `fileSize`, `walkMedia`, `expandPaths`, `openFolder`, `safeName`, `outPath` |
| `cache.go` | чистка кэша: `cacheTidy`, `textDir`, `textPrune` |
| `storage.go` | что занимает программа, очистка кэша, удаление моделей, статистика: `dirSize`, `storageParts`, `cacheClear`, `whisperRemove`, `Stats`, `statsAdd`, `readStats` |
| `ffargs.go` | `probe`, `gifFilter`, `planRate`, `rateArgs`, `fitCodecLimits`, `isStandardFPS`, `buildArgs`, `num`, `mbStr` |
| `convert.go` | `run`, `finishBatch`, `convert`, `encodeTarget`, `runFF`, `set`, `kept` |
| `fferrors.go` | `friendlyErr` (для человека), `errSummary` (для лога) |
| `ffdownload.go` | `download` (общее скачивание, защита от зависания), `downloadFFmpeg`, `tryDownload`, проверка sha256 архива: `fetchFFSum`, `parseSum`. Проверка: `ffdownload_test.go` |
| `api.go` | `routes` (все ручки), `api` (проверка токена и Host), `writeJSON` |
| `web.go` | сборка страницы на каждом языке `pages`, `buildPage`, `localize`, порядок скриптов `webJS` |
| `favicon.go` | `buildICO` (favicon.ico из PNG), `writeFavZip` (архив; имена только простые), `writeFavFolder`, `favFreePath`, `pngSize`; ручки `favicon-save` и `fav-read`, диалог `pickZipSave` в `ui_windows.go` |
| `color.go` | вкладка «Цвет»: проверка файла от страницы `colorFileBytes` (PNG в base64, SVG текстом, ASE из JSON — `aseBytes`), имя `colorFileName`, запись `saveColorFile`; ручка `color-save`, диалог `pickColorSave` в `ui_windows.go` |
| `banner.go` | `runBanners`, `shrinkPNG`, `replaceFile`, `bannerNames`, `bannerWanted`, `bannerDims`, `bannerBase`, `bannerFind`, `bannerDirs` (где папки JPEG и WebP), `rememberBannerDirs`, `ffQuiet` |
| `media.go` | `parseMediaInfo`, `getMediaInfo`, `makeThumb`, `thumbHandler`, `mediaHandler`, волна на таймлайне: `wavePeaks`, `makeWave`, `waveHandler` (рисует `tkWaveDraw` в `web/js/tracks.js`) |
| `proxy.go` | копии для просмотра: `proxyDir`, `proxyStem`, `proxyPath`, `proxyPiecePath`, `proxyArgs`, `proxyStatus`, `encodeReverse`, `proxyStop`, `proxyPrune`, `proxyUsage`, `proxyClear`, `proxyCleanup` |
| `snapshot.go` | кадр в PNG: `saveFrame`, `saveMontFrame` (кадр монтажа), `snapPlan` (декодер и формат с прозрачностью), `snapArgs`, `snapName`, `snapPublish` |
| `sequence.go` | кадры: видео в папку PNG (`seqPattern`, `seqFrames`, `seqRemove`, `removeResult`, `hasResult`) и картинки в видео (`canJoin`, `joinRate`, `naturalLess`, `joinGroups`, `joinLeads`, `joinStem`, `writeFrameList`, `checkFrameSizes`) |
| `montage.go` | общее для монтажа: `forMontage`, `audioOnly`, `montClip`, `reverseRAM`, `checkReverseRAM`, `atempoChain`, `montGraphArgs` |
| `transitions.go` | переходы на краю клипа: `Trans`, `tlTransKinds`, `tlEdge`, `tlMeet`, `tlTransitions`, `extend`, `shown`, `tlTransFades` |
| `project.go` | файл проекта монтажа: `.kb`, старый `.k9000` читается (`isProjectFile`); `writeProject`, `readProject`; иконка и открытие двойным щелчком: `addProjectType`, `writeProjectType` в `install_windows.go`, приём: `addIncoming` в `state.go`, `mtProjectIncoming` в `web/js/montage.js` |
| `keyframes.go` | ключевые кадры рамки слоя и непрозрачности: `Keys`, `kfEase`, `kfAt`, `kfExpr`, `kfPrep`, `kfPlace` |
| `timeline.go` | дорожки: `Project`, `Track`, `Clip`, `tlRead`, `tlPrepare`, `tlCanvas`, `tlPlace`, `tlRange`, `timelineInfo`, `tlPlan`, `cmdLen`, `spillGraph`, `tlVideoGraph`, `tlClipChain`, `tlBoxChain`, `tlAudioGraph`, строка в очереди `montRow` |
| `mem_windows.go`, `mem_other.go` | `availableRAM`: сколько памяти свободно |
| `sounds.go` | `systemSounds`: какие звуки Windows есть на компьютере |
| `update.go` | `appVersion`, `Settings`, `cmpVer`, `latestFFmpeg`, `checkFFmpeg`, `checkLatestFF`, `httpGet`, `InstallInfo` |
| `theme.go` | значения темы, `validTheme`, `normTheme`, цвет фона окна `bgDark`, `bgLight` |
| `i18n.go`, `i18n_strings.go` | язык интерфейса: `normLang`, `setLang`, `tr`, `errT`; словарь `goDict` |
| `selfupdate.go` | `updateRepo`, `splitNotes`, `latestApp`, `checkApp`, `updateEvery`, `watchUpdates` (повторная проверка, пока программа открыта), `updateApp`, `fetchApp` |
| `whatsnew.go` | окно «Что нового»: `changelogSince` (разбор вшитых `CHANGELOG.md` и `CHANGELOG.en.md`), `whatsNewSince`, `initNews`, `newsSeen` |
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
| `js/anim.js` | переезд выделения вкладки `glideTabs` (`#tabs`, `#mtTabs`); остальные анимации в разделе «лёгкие анимации» в `web/style.css` |
| `js/sliders.js` | риска исходного значения и магнит у ползунков с `data-origin`: `slPlace`, `slEnd` |
| `js/shapes.js` | фигуры и перо: прямоугольник, эллипс, линия, стрелка (заливка, обводка, пунктир, скругление, наконечники), перо с кривыми Безье и замыканием, правка вектора (точки и ручки, `mtPtsOn`, `mtShapePathOf` переводит фигуру в путь), прорисовка линии (`mtShapeTick`, кадры на `/api/shape-seq`), кнопка пера с выбором «перо / правка вектора» (`mtPenMode`, `mtPenMenu`), подсветка одного инструмента (`mtSegSync`, `mtToolBusy`), курсоры; рисует PNG слоя `mtShapeDraw`, поле клипа `shape`, загрузка `tkShapeLoad`; клавиши U, P, A; захват мышью `mvHits`; панель «Фигура» в «Кадре» |
| `js/colorpick.js` | своё окно выбора цвета вместо `<input type="color">`: поле `.cp-sw` (`cpField`, те же `value` и `disabled`), окно (квадрат, оттенок, альфа, HEX, пипетка EyeDropper, недавние в `k9000.cpRecent`), `cpOpen`/`cpClose(ok)`; `cpParse`/`cpHex`/`cpValid` (`#rrggbb` и `#rrggbbaa`). Градиенты у полей с `grad` (заливка и обводка фигур, цвет и обводка текста): значение `{g: 'lin' или 'rad', stops: [{at, c}], p: [x0, y0, x1, y1]}` (точки в долях рамки слоя), вид `cpKind` (`.cp-kinds`), полоса с точками `.cp-gbar`, угол `.cp-ang`, `cpDelStop`; для рисования `cpStyle` (CanvasGradient), `cpSee`, образец `cpCss`, загрузка `cpValidG`; для ручек `cpGradEdit`, `cpGradP`, `cpHook`. В монтаже поле подключает `mtColor` (montage.js): просмотр без шага отмены, «ОК» — `tkCommit`, «Отмена» — `tkRestore` |
| `js/gradhandles.js` | ручки градиента поверх кадра (`#mvGrad`), пока открыто окно цвета с градиентом у выбранного слоя: `mtGradDraw` (зовёт `mvFrameDraw` и `cpHook`), `mtGradTool` (на время правки градиента в панели включён «Градиент», «Выбор» погашен), `mtGradPx`/`mtGradUv` (доли рамки ↔ пиксели холста с поворотом), тяга на `pointerdown` окна, Shift — 45° |
| `js/kinetic.js` | перетаскивание с инерцией и наклоном, ничего не знает про вкладки: `kinFollow` (элемент на пружине, `still` без неё: так идут клипы на таймлайне), `kinSort` (порядок в списке, соседи расступаются; `busy` и `flip`), `kinCalm` (настройка «меньше движения»), настройки `KIN` |
| `js/player.js` | общее для плеера и обрезки: `mediaUrl`, `attachMedia` (файл или копия для просмотра), `videoSeek`, `keepSeeking`, `trackFrame`, `frameTime`, `saveShot`, `bindVolume`, `thumbUrl`, `fmtDur`, `makePlayer` (плеер на элементах с приставкой `pv` или `pl`) |
| `js/preview.js` | окно плеера: `openPreview`, `outLine` |
| `js/playertab.js` | вкладка «Плеер»: очередь `plFiles`, `plAdd`, `plPlay`, `plRemove`, `plRender`, `plMove`, `plButtons`, `plHold` (отпустить файл ради другого окна), `plTabChanged`, `plSend` (в конвертацию) |
| `js/tracks.js` | дорожки монтажа: модель `tkTracks`, отрисовка `tkRender`, `tkPaint`, `tkRuler`; прилипание `tkSnapBy`; места `tkSpot`, `tkPush`; действия `tkSplit`, `tkRemove`, `tkInsert`; мышь `tkDrag`, `tkMoveDrag`, `tkTrimDrag`, `tkBandDrag`; отмена `tkDo`, `tkCommit`, `tkBack`; метки вывода `tkMark`, `tkMarkAt`, `tkMarksOff`; метки `tkPutMarker`, `tkClipMarks`, `tkMarkerDrag`, `tkClipMarkDrag`; связка `tkGroup`, `tkAddSound`, `tkLinkToggle`, `tkSplitAll`; сохранение `tkFile`, `tkLoad`, `tkAutosave`; хоткеи `TK_KEYS`, `TK_CTRL_KEYS` |
| `js/rulers.js` | линейки и направляющие вьюпорта: `mvRulersDraw`, `mvRulerPaint`, `mvGuidesPaint`, `mvGuideDrag`, значение `tkGuides` в `tracks.js`, магнит: третий аргумент `mvSnap` |
| `js/viewzoom.js` | вид вьюпорта: сдвиг и масштаб `mvView` (используется в `mvSizeCanvas`), `mvZoomTo`, `mvViewFit` (Shift + \ в `tracks.js`), кнопка `#mvZoomBtn`, Ctrl + колёсико; показать слой `mvShowLayer` (F, меню клипа в `ctxmenu.js`), стрелка у края `mvOffDraw` (`#mvOffArrow`, зовётся из `mvFrameDraw`); предел ухода за кадр `MV_FAR` в `viewport.js` и `tlFarOut` в `timeline.go`; рука: `mvHandDown` (пробел из `TK_KEYS`), `mvHandUp`, перехват `pointerdown` в фазе захвата. Приглушение за краем кадра: `.mv-canvas::after` в `style.css` |
| `js/viewport.js` | вьюпорт монтажа: `mv`, холст `mvCanvasDims`, `mvSizeCanvas`; проверка файлов и копии `mvPrep`; набор `<video>` `mvBind`, `mvRelease`; кадр `mvShow`, синхронизация `mvSync`, `mvTick`, `mvPlay`, `mvPause`; рамка `mvBox`, `mvFrameDraw`, `mvFrameDrag`, `mvSnap`; файл из окна файлов `mvFileShow`, `mvFileOff`; звук `mvAudio` |
| `js/mvtrans.js` | переходы на краю клипа в просмотре: `mvTrMap`, `mvSpan`, `mvShown`, `mvTrAt`, `mvTrLook`, `mvClipPoly`, `mvTrPlace`, `mvTrFrame`, `mvTrOpacity`, `mvTrGain` |
| `js/trpanel.js` | переходы на краю клипа в интерфейсе: вкладка «Переходы» (`trCards`, `trDraw`, `trFill`), плашки на дорожке (`tkTrPaint`, `tkTrDown`), перетаскивание образца (`trCardDrag`, `tkTrEdgeAt`), `tkTrPut`, `tkTrRemove`, клавиша D `tkTrDefault` |
| `js/vumeter.js` | индикатор громкости монтажа: `vuAttach`, `vuKick`, `vuStep`, `vuDraw` |
| `js/keyframes.js` | ключевые кадры: поза клипа `kfPose`, ромбики в панели и на клипе, меню кривой `kfMenu`, готовые появление и исчезание `kfAnimSet`, `kfAPath`, `kfAnimFill`; см. таблицу задач |
| `js/chroma.js` | удаление фона и цветокоррекция в просмотре: `chromaLayer`, `chromaShow`, `chromaGraded`, `chromaSweep`; пипетка: `chromaPickToggle`, `chromaSample` |
| `js/montage.js` | вкладка «Монтаж»: окно файлов `mtFiles`, `mtAdd`, `mtShow`, `mtRender`, `mtDragFile`; файлы из Проводника на дорожку `mtDropHover`, `mtAddAt` (вызов из `drop.js`, `dropAim`); панель клипа `mtPanel`, `mtInfo`, `mtCopies`, `mtTrimClosed`; проект `mtProjectSave`, `mtProjectOpen`; отправка `mtProject`, `mtSend` |
| `js/textclip.js` | инструмент «Текст»: `mtTextDraw`, `mtTextMake`, `mtTextRedraw`, `mtTextRefresh`, `mtTextPatch`, `mtTextFill`; режим `mtTextTool` (кнопка, T, щелчок в кадр → `mtTextAdd`); шрифты `mtFontsLoad`, `mtFontPut` |
| `js/subedit.js` | правка субтитров: дорожка S и список реплик, см. таблицу задач |
| `js/subfx.js` | эффекты субтитров (печатная машинка, по слову, караоке `subFxKar*`, раскладка `subFxKarLay`, активное слово `subFxAct*`), куски «Слов на экране» `subChunks`: расчёт `subFxStep`, `subFxState`, `subFxWordTimes`, `subFxWordHeads`, `subFxWordAt`, `subFxBounce` как в `subtitles.go`, просмотр `subFxParts`, `subFxPaint`, `subFxWordPaint`, панель `subFxFill`, загрузка `subFxLoad` |
| `js/ctxmenu.js` | меню правой кнопки: `ctxOpen`, `ctxClose`, `ctxItems`, `ctxText`, `ctxCue`, `ctxClip` |
| `js/trim.js` | окно обрезки: `openTrim`, `closeTrim`, `trimSet`, `trimSeek`, `trimStep`, `trimUseFrames`, `trimBound`, `trimFmt`, `trimParse`, `trimTag` |
| `js/setup.js` | окно установки: `openSetup`, `renderSetup`, `ffSetupRow` |
| `js/updates.js` | `ffBanner` (плашка ffmpeg), `appBanner` и `newsBanner` (окна поверх программы «Вышел Kombain» и «Что нового»), `notesHtml` (список из CHANGELOG) |
| `js/sounds.js` | звуки: `batchSound`, `playSound`, `beep` (запасной сигнал), `renderSounds`; выбор в `localStorage` |
| `js/poll.js` | `poll`, `updateButtons`, `renderSummary`, кнопки «Закрыть программу» (только в браузере) и «лог» |
| `js/color.js` | вкладка «Цвет»: градиент, пипетка и форматы, «Мои цвета»; подробно в таблице задач |
| `js/colorset.js` | вкладка «Цвет»: Палитра, Из фото, Оттенки и их общая выгрузка (CSS, JSON, ASE, SVG, PNG); подробно в таблице задач |
| `js/favicon.js` | вкладка «Фавиконы», выбор файла окном Windows (`fvPick`, чтобы знать папку оригинала), состояние `fv` (`FV_DEF`), иконки `fvImg` (светлая и тёмная), приём файла `fvTake` и `fvDrop` (из `drop.js`), рисование `fvDraw`, `fvSvg` (обёртка со сменой темы), `fvManifest`, `fvHtml`, отрисовка вкладки `fvPaint`, сохранение по `#fvSave`; память в localStorage `konv9000.fav2`, `konv9000.favImg` |
| `js/bannertab.js` | «Баннеры» и переключение вкладок и инструментов «Утилит»: `setTab`, `bAdd`, `bRender`, `bRenderDirs`, `bSyncDirs` (поиск папок), `bBadSize` и `bCheckSizes` (проверка размеров), `bDone` |
| `js/boot.js` | первый запуск отрисовки и опроса |

## HTTP API

Все ручки `/api/*` требуют заголовок `X-Token` и правильный Host, описаны в `routes` (`api.go`).

| Группа | Ручки |
|---|---|
| Пачка | `start`, `banners`, `banner-dirs`, `cancel`, `state` |
| Звуки | `sounds`, `pick-sound` |
| Файлы | `pick-files`, `pick-folder`, `project-save`, `project-open`, `subs-pick`, `subs-read`, `subs-save`, `favicon-save`, `fav-read`, `whisper-info`, `whisper-start`, `whisper-state`, `whisper-cancel`, `fonts`, `text-png`, `upload`, `discard`, `info`, `proxy`, `proxy-stop`, `proxy-usage`, `proxy-clear`, `snapshot`, `snapshot-montage`, `open-output`, `open-dir`, `open-data` |
| ffmpeg | `download-ffmpeg`, `ffmpeg-skip` |
| Фигуры | `shape-seq` (кадры прорисовки линии: страница шлёт PNG, Go кладёт `seq-<сумма>-%04d.png` в кэш текста, `shapes.go`) |
| Программа | `settings`, `app-update`, `app-skip`, `news-seen`, `install`, `setup-later`, `exit`, `storage`, `storage-clear`, `storage-remove` |

Вне `/api`: `/` (страница), `/favicon.png`, `/thumb`, `/wave` и `/media` (токен в параметре `t`). Адреса картинок в `index.html` содержат метку `__VER__`, её подставляет `routes`: иначе после обновления окно показывает старые из кэша.

## Сборка, выпуск, прочее

| Файл | Зачем |
|---|---|
| `release.cmd`, `release.sh` | выпуск версии одной командой |
| `.github/workflows/release.yml` | проверки, сборка exe, релиз по тегу |
| `CHANGELOG.md`, `CHANGELOG.en.md` | что нового на двух языках; разделы версии становятся текстом релиза и плашек в программе (`splitNotes` в `selfupdate.go`) |
| `winres/`, `rsrc_windows_amd64.syso` | иконка, манифест и свойства exe |
| `assets-original/` | исходники старого фото и иконки |

## Проверка

```
gofmt -l .        # должно быть пусто
go vet .          # в Windows: 3 предупреждения unsafe.Pointer в ui_windows.go — норма
go test ./...
```
