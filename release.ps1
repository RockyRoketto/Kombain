# Выпуск новой версии: release.cmd 1.5.0
# Меняет версию в update.go и winres.json, дописывает CHANGELOG.md, делает коммит, тег vX.Y.Z и git push.
# Дальше GitHub Actions сам соберёт Konvertor.exe и выложит релиз — у коллег программа предложит обновиться.
param([string]$Version, [string]$Notes)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$utf8 = New-Object Text.UTF8Encoding $false
function ReadText($p) { [IO.File]::ReadAllText((Join-Path $PSScriptRoot $p), $utf8) }
function WriteText($p, $t) { [IO.File]::WriteAllText((Join-Path $PSScriptRoot $p), $t, $utf8) }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Не найден git. Установи Git for Windows: https://git-scm.com/download/win' }

$go = ReadText 'update.go'
$cur = [regex]::Match($go, 'appVersion\s*=\s*"(\d+\.\d+\.\d+)"').Groups[1].Value
if (-not $Version) { $Version = Read-Host "Сейчас версия $cur. Новая версия (например 1.5.0)" }
$Version = $Version.TrimStart('v', 'V')
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Версия должна быть вида 1.5.0, а не «$Version»" }
if ([version]$Version -le [version]$cur) { throw "Новая версия $Version должна быть больше текущей $cur" }

if (git status --porcelain --untracked-files=no -- . 2>$null | Select-String -Quiet '^') {
  Write-Host 'Есть несохранённые в git изменения — они войдут в эту версию.' -ForegroundColor Yellow
}

# что нового: из аргумента или в Блокноте
if (-not $Notes) {
  $tmp = Join-Path $env:TEMP "konvertor-notes-$Version.txt"
  [IO.File]::WriteAllText($tmp, "- ", $utf8)
  Write-Host 'Открываю Блокнот: напиши, что нового (по пункту на строку), сохрани и закрой.'
  Start-Process notepad.exe $tmp -Wait
  $Notes = [IO.File]::ReadAllText($tmp, $utf8).Trim()
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
if (-not $Notes -or $Notes -eq '-') { $Notes = '- Исправления и улучшения.' }

# версия в коде и в свойствах exe
WriteText 'update.go' ($go -replace '(appVersion\s*=\s*")\d+\.\d+\.\d+(")', "`${1}$Version`${2}")
$wr = ReadText 'winres\winres.json'
$wr = $wr -replace ('"' + [regex]::Escape("$cur.0") + '"'), "`"$Version.0`""
$wr = $wr -replace ('"' + [regex]::Escape($cur) + '"'), "`"$Version`""
WriteText 'winres\winres.json' $wr

# CHANGELOG.md: новый раздел над прошлыми
$cl = ReadText 'CHANGELOG.md'
$i = $cl.IndexOf("`n## ")
$section = "## $Version`n`n$($Notes -replace "`r`n", "`n")`n"
$cl = if ($i -ge 0) { $cl.Substring(0, $i + 1) + $section + "`n" + $cl.Substring($i + 1) } else { $cl.TrimEnd() + "`n`n" + $section }
WriteText 'CHANGELOG.md' $cl

git add -A .
git commit -m "Версия $Version" | Out-Null
git tag "v$Version"
git push
git push origin "v$Version"
if ($LASTEXITCODE -ne 0) { throw 'git push не прошёл (см. сообщение выше)' }

$remote = (git remote get-url origin) -replace '\.git$', ''
Write-Host ''
Write-Host "Готово: версия $Version отправлена на GitHub." -ForegroundColor Green
Write-Host "Сборка идёт тут (3-5 минут): $remote/actions"
Write-Host "Потом релиз появится здесь:  $remote/releases"
