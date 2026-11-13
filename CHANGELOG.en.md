# What's new

English version of CHANGELOG.md, with the same "## X.Y" sections. release.cmd adds new versions at the top.
A section goes into the GitHub release text and into the program's update windows when English is selected.

## 6.1

- AI images: the tooltip behind the «?» icon now appears next to the icon instead of the top left corner of the window.

## 6.0

- New tool: the «AI images» tab. Pictures from a text prompt right on your graphics card, no internet or subscriptions. On first launch the program checks your hardware, offers a folder and downloads the engine and the Z-Image Turbo model by itself (about 10 GB, once); downloads resume where they stopped.
- AI images: 18 styles with sample pictures, aspect ratios, up to 4 pictures at a time, an «Improve» button (the helper writes a detailed prompt), the picture appears on the canvas step by step, a graphics card load panel.
- AI images: a gallery with search and favorites, «More like this», «Variations», repeat settings, copying the prompt, the request and all settings to the clipboard. Settings are stored inside the PNG and come back when you drop the picture on the tab.
- AI images: a model manager with plain-language licenses, models listed in «Storage».
- Banners: JPEG and WebP are encoded from the original PNG with the highest quality that keeps the file within 500 KB (WebP used to look noticeably worse). A recompressed PNG from the AI gallery keeps its generation settings.
- Color: the bottom render panel now sits under the work area. The README is shorter and clearer.

## 5.0

- Utilities: new "PDF" tool. Compress (presets, custom quality, "To size", size forecast before you start and before / after), Images → PDF, To images (PNG, JPG, WebP), Pages (merge, split, reorder, rotate, delete and duplicate in a thumbnail grid), Layout (watermark, page numbers, margins, metadata, password), Repair for damaged files. Everything works offline.

## 4.0

- New Color tab: gradients (linear, radial, conic) and mesh gradients with draggable points, noise, halftone, hatch, steps and pixel styles, export to PNG, SVG and CSS.
- Palette, Shades, Mix (OKLCH), Contrast (AA/AAA), eyedropper with a loupe and HEX, RGB, HSL, OKLCH, CMYK formats, colors from a photo, My colors and Send to.
- Utilities: Banners and Favicons in one tab, the Favicons tool checks that the icon is visible on light and dark browser tabs.
- Montage: readability check for text and subtitles over the frame, outline or backdrop in one click.

## 3.1

- Favicons: preview polished. Icons sit centered in the phone mockups, phones have a fixed height, rounding is removed, and the dark Google card shows the dark icon.

## 3.0

- New Favicons tab: one icon makes the whole site set (favicon.ico, SVG, PNG for iPhone and Android, manifest and head code) with previews in a browser tab, Google, iPhone and Android.
- You can add a dark version of the icon. iPhone and Android icons are full-bleed by default, with no white border.
- Save next to the original or to a place you choose, as a ZIP archive or a folder of files.
- All settings fit in one window, and while dragging, the cell where the icon will land is highlighted.

## 2.5

- The montage toolbar is clearer: no frames, and the pen button has a list with Pen and Vector editing.
- Only one tool is selected at a time. While you edit a gradient on the frame, the toolbar shows Gradient and the cursor over its points is a move cross.

## 2.4

- The montage toolbar is clearer: no frames, and the pen button has a list with Pen and Vector editing.
- Only one tool is selected at a time. While you edit a gradient on the frame, the toolbar shows Gradient and the cursor over its points is a move cross.

## 2.3

- Inspector instead of the long panel: icon tabs on the left, settings search (Ctrl+F)
- Transitions between clips and at clip edges: dissolve, wipes, slides, circle, zoom; a bar on the track, D key
- Layer opacity and its keyframes
- Timeline snapping: playhead, keys, In/Out marks and transition edges
- Clicking a subtitle cue no longer moves the playhead

## 2.2

- Editor: layer blend modes, blur and drop shadow
- Rulers and guides in the viewport: layers, text and subtitles snap to them
- Preview quality Full, 1/2, 1/4: smoother editing with large files, the final file is not affected
- Safe zones for Instagram Reels and Stories, YouTube Shorts and TikTok
- Drop files from Explorer straight onto an editor track, right where you need them
- Text and subtitles wrap to the width of their frame; subtitles have their own frame that does not depend on the font
- The eye on the subtitle track hides them in the viewport and in the result
- The program now opens clean every time, offers to save the project on closing and restores an unsaved project after a crash
- Sliders have a mark at the original value, and the handle gently snaps to it
- Settings now have a button to open the program folder and a settings reset
- The cache cleans itself at startup
- Subtle interface animations: tabs, windows and sections appear smoothly

## 2.1

- Auto subtitles: the app recognizes speech and creates the cues itself, offline after a single download. Cue start and end are checked against the audio
- Subtitles in the editor: .srt files, a cue editor on the track, burned into the picture or added as a separate track in the file
- Text tool: captions in any Windows font, with an outline
- Clip color correction and color background removal, visible in the viewport right away
- The effects panel is split into Video, Audio and Clip tabs
- Left and right channel level meter
- Rule-of-thirds grid and safe zones in the viewport, a resizable effects panel
- Custom right-click menu on clips, cues and text fields
- Projects are now saved as .kb files, old .k9000 files still open
- App data is arranged into folders automatically on first launch

## 2.0.0

- Cleaner header: no icon, the name in an orange frame and the version on the left, tabs in the center
- The audio waveform on the timeline is sharp at any zoom
- Video and audio tracks have the same height and equal spacing
- The program icon changes right after an update, without the old picture from the Windows cache
- The GitHub description is organized into sections

## 1.10.0

- New name: the program is now called Kombain and has a new icon. Shortcuts update by themselves
- New Edit tab: video and audio tracks, layers, effects, markers, project files, the result goes to the converter
- New Player tab: watch files without adding them to the conversion
- Premiere-style effects panel: groups and collapsible sections, a collapsed section shows when something in it was changed
- Clips on the timeline follow the mouse exactly, without wobbling
- More than 90 output formats, saving a frame to PNG, video to a PNG folder and images back to video, transparency
- Player on preview click and trimming with preview; formats the window cannot play are prepared automatically
- All tabs use the full screen, the window remembers its size and position
- Fixed: timeline zoom no longer leads into empty space without a ruler, scrollbars no longer flicker during box selection, all digits are visible in the custom frame size fields, the rotate 90° right button works

## 1.9.0

- Trim video and audio: click the scissors in a file row, drag the limits on the timeline and preview the part. The original stays untouched
- Your own presets: pick settings in the converter and save them under any name
- Banners: the app remembers where the JPEG and WebP folders are relative to the PNG folder and fills in the path
- Banners: if the folders do not exist, the switch creates them next to the PNG folder, not inside it
- Banners: the real image size is checked against the size in the file name
- Launch from File Explorer: select files and choose Send to → Konverter 9000
- If the app is already open, a new launch adds the files to it and brings its window to the front
- Custom finish and error sounds: behind the gear icon, pick and preview a Windows sound or your own file
- New header: round photo, with the version and author under the name
- The What's new window now appears once per version

## 1.8.0

- New compact interface: everything fits in the window without scrolling, rarely used settings are collapsed or moved behind the gear icon
- Quick presets rebuilt around common tasks
- Light theme: choose dark, light, or match Windows behind the gear icon
- English language: switch it in the same place, instantly and without a restart
- The Exit button is gone: close the program with the X
- The program notices new versions even if it stays open: it checks every 6 hours
- After an update, it shows what's new, including any versions you skipped
- Banners: if a PNG is briefly in use by another program, the converter waits instead of showing an "Access is denied" error

## 1.7.0

- New Banners tab: drop in PNGs, select folders for JPEG and WebP, and get a ready set of 10 banners with one button
- PNGs over 500 KB are automatically shrunk to the size in their name and overwritten in place

## 1.6.0

- New "Compress, keep format" mode: video gets many times smaller with no visible quality loss, images and audio are compressed too. If the file cannot get smaller, the original stays as is
- "Fit video into N MB": the program calculates the quality so the file fits, for example, in an email (and lowers the resolution if there is not enough room)
- "Compress without quality loss" and "Video up to 25 MB for email" presets

## 1.5.0

- The program checks for updates by itself and offers to update in one click
- New name: Konverter 9000, and the button is now Convert
- The install window now says that the program keeps track of its own updates and of ffmpeg

## 1.4.0

- File previews, pop-up hints, "Make a copy" and "Overwrite".
