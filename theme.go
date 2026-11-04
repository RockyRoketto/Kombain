package main

// Тема оформления. Выбор лежит в settings.json, потому что его должен знать Go:
// страница получает тему при отдаче, окно красит по ней заголовок и фон.

const (
	themeDark   = "dark"
	themeLight  = "light"
	themeSystem = "system" // как в Windows
)

// Цвет страницы (--bg в web/style.css): этим цветом закрашено окно, пока страница не загрузилась.
var (
	bgDark  = [3]uint8{0x0c, 0x0c, 0x0e}
	bgLight = [3]uint8{0xee, 0xec, 0xe7}
)

func validTheme(t string) bool {
	return t == themeDark || t == themeLight || t == themeSystem
}

// normTheme: пустое и неизвестное значение (старый или испорченный settings.json) — тёмная тема
func normTheme(t string) string {
	if validTheme(t) {
		return t
	}
	return themeDark
}

func themeBg(light bool) [3]uint8 {
	if light {
		return bgLight
	}
	return bgDark
}
