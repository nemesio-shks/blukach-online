# Galaxy DB — единая база данных (Render)

Лёгкий сервер: хранит ОДНО состояние карты. Читают все, пишет только редактор (с паролем).

## Эндпоинты
- `GET  /state` — отдать состояние `{ data, ts }` (для всех).
- `POST /login` `{ password }` → `{ ok, token }` (проверка пароля редактора).
- `POST /state` `{ data }` + заголовок `Authorization: Bearer <token>` — записать (только редактор).
- `GET  /ping` — здоровье.

## Хранилище
- **Upstash Redis** (REST) — постоянное, переживает перезапуски. Free tier хватает.
- Если Upstash не настроен → память процесса (сбросится при засыпании на free Render).
  Начальное состояние берётся из `seed.json` (копия сейва карты).

---

## Деплой на Render (free)

1. Залей папку `server/` (или весь репозиторий) на GitHub.
2. Render → **New → Web Service** → подключи репозиторий.
   - **Root Directory:** `server`
   - **Runtime:** Node
   - **Build Command:** (пусто)
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
3. **Environment** (вкладка Environment → Add):
   - `EDITOR_PASSWORD` = твой пароль редактора
   - `UPSTASH_REDIS_REST_URL` = из Upstash
   - `UPSTASH_REDIS_REST_TOKEN` = из Upstash
   - `ALLOW_ORIGIN` = `https://nemesio-shks.github.io` (можно оставить `*`)
4. Deploy. Получишь адрес вида `https://galaxy-map-xxxx.onrender.com`.

### Upstash (бесплатное хранилище)
1. https://upstash.com → Create Database → Redis (Region любой, Free).
2. На странице базы → **REST API** → скопируй `UPSTASH_REDIS_REST_URL` и `..._TOKEN`.
3. Вставь их в Render Environment (см. выше).

> Без Upstash сервер тоже работает, но на free Render засыпает после 15 мин
> простоя и теряет несделанные в Redis правки. Для «настоящей» БД — Upstash обязателен.

---

## Подключение сайта (GitHub Pages)
В `index.html` пропиши адрес сервера:
```html
<meta name="db-url" content="https://galaxy-map-xxxx.onrender.com">
```
Затем `npm run build` в корне проекта и залей `deploy/index.html` на Pages.

## Подключение бота (Discord, локально)
Запускай бота с переменной:
```
GALAXY_DB_URL=https://galaxy-map-xxxx.onrender.com node bot.js
```
Тогда картинки в Discord рисуются по той же общей карте.
