# Tools

Вспомогательные скрипты для подготовки ассетов Chrome Web Store.

---

## generate_screenshots.py

Генерирует скриншоты для CWS: накладывает фразы хоопонопоно на базовое изображение для каждого из 52 языков.

### Результат

`docs/img/{lang_code}/1.png` … `4.png` — 208 изображений (52 языка × 4 фразы), 1280×800 px.

### Запуск

```bash
uv run tools/generate_screenshots.py
```

Зависимости устанавливаются автоматически через `uv` (PEP 723 inline metadata): только `Pillow`.

### Источники данных

| Файл | Роль |
|------|------|
| `docs/img/screen_CWS.png` | Базовый шаблон 1280×800 |
| `docs/lang/Хоопонопоно анзвание и фразы - ....csv` | Колонка 1 — код языка, колонка 4 — 4 фразы через запятую |

### Шрифты

Скрипт выбирает шрифт автоматически по коду языка. Все используемые шрифты — системные, macOS:

| Скрипты | Шрифт |
|---------|-------|
| Latin, Cyrillic | Helvetica |
| Chinese (zh_CN, zh_TW) | STHeiti Light |
| Japanese | Hiragino Sans GB |
| Korean | AppleSDGothicNeo |
| Arabic, Persian | GeezaPro |
| Hebrew | ArialHB |
| Thai | Thonburi |
| Devanagari (Hindi) | Kohinoor |
| Bengali, Gujarati, Telugu, Kannada | Kohinoor* |
| Myanmar | NotoSansMyMyanmar |
| Armenian | NotoSansArmenian |
| Amharic | KefaIII |
| Остальные (Georgian и др.) | Arial Unicode (23 MB, универсальный фолбэк) |

### Параметры (в начале файла)

```python
FONT_SIZE = 140       # размер шрифта в pt
SHADOW_OFFSET = 4     # смещение тени в px
```
