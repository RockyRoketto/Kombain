# What's new

English version of CHANGELOG.md, with the same "## X.Y.Z" sections. release.cmd adds new versions at the top.
A section goes into the GitHub release text and into the program's update banners when English is selected.

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
