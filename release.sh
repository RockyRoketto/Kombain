#!/usr/bin/env bash
# Выпуск новой версии: release.cmd 1.6.0 (или bash release.sh 1.6.0 "- что нового")
# Меняет версию в update.go и winres.json, дописывает CHANGELOG.md, делает коммит, тег vX.Y.Z и git push.
# Дальше GitHub Actions сам соберёт Konvertor.exe и выложит релиз — у коллег программа предложит обновиться.
set -euo pipefail
cd "$(dirname "$(cygpath -u "$0" 2>/dev/null || echo "$0")")"

die() { echo "Ошибка: $*" >&2; exit 1; }

cur=$(grep -oE 'appVersion *= *"[0-9]+\.[0-9]+\.[0-9]+"' update.go | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
ver=${1:-}
[ -n "$ver" ] || read -rp "Сейчас версия $cur. Новая версия (например 1.5.0): " ver
ver=${ver#[vV]}
[[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "версия должна быть вида 1.5.0, а не «$ver»"
newest=$(printf '%s\n%s\n' "$cur" "$ver" | sort -V | tail -1)
[ "$ver" != "$cur" ] && [ "$newest" = "$ver" ] || die "новая версия $ver должна быть больше текущей $cur"
! git rev-parse -q --verify "refs/tags/v$ver" >/dev/null || die "тег v$ver уже есть"

# что нового: из аргумента или в Блокноте
notes=${2:-}
if [ -z "$notes" ]; then
  tmp=$(mktemp --suffix=.txt)
  printf -- '- ' >"$tmp"
  echo 'Открываю Блокнот: напиши, что нового (по пункту на строку), сохрани и закрой.'
  notepad.exe "$(cygpath -w "$tmp")"
  notes=$(sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' "$tmp")
  rm -f "$tmp"
fi
notes=$(printf '%s\n' "$notes" | sed -e 's/[[:space:]]*$//' | sed -e '/./,$!d')
[ -n "$notes" ] && [ "$notes" != "-" ] || notes='- Исправления и улучшения.'

# версия в коде и в свойствах exe
re=${cur//./\\.}
sed -i -E "s/(appVersion *= *\")$re\"/\1$ver\"/" update.go
sed -i -e "s/\"$re\.0\"/\"$ver.0\"/g" -e "s/\"$re\"/\"$ver\"/g" winres/winres.json

# CHANGELOG.md: новый раздел над прошлыми
printf -v section '## %s\n\n%s\n' "$ver" "$notes"
SEC=$section awk 'BEGIN { s = ENVIRON["SEC"] } !done && /^## / { print s; done = 1 } { print } END { if (!done) print "\n" s }' \
  CHANGELOG.md >CHANGELOG.md.part
mv CHANGELOG.md.part CHANGELOG.md

git add -A .
git commit -q -m "Версия $ver"
git tag "v$ver"
git push
git push origin "v$ver"

remote=$(git remote get-url origin)
remote=${remote%.git}
echo
echo "Готово: версия $ver отправлена на GitHub."
echo "Сборка идёт тут (3-5 минут): $remote/actions"
echo "Потом релиз появится здесь:  $remote/releases"
