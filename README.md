# Anime Catalogs (Titled Posters) — Stremio addon

Anime catalogs from AniList with the **title printed on each poster**, plus a badge
(next episode countdown for airing shows, score for others).

Catalogs (pick them from the Discover dropdown, each also filterable by genre):
Airing Now · Trending · Popular · Top Rated · This Season · Upcoming ·
Anime Movies – Popular · Anime Movies – Top Rated · Anime Search

Items use `kitsu:` IDs, so anime stream addons (Torrentio, etc.) work with them.

## Deploy (free, from your phone) — Render
1. Put this folder in a GitHub repo.
2. render.com → New → Web Service → pick the repo. It detects the Dockerfile. Free plan is fine.
3. When it's live, open `https://YOUR-APP.onrender.com` and tap **Install in Stremio**
   (or paste `https://YOUR-APP.onrender.com/manifest.json` into Stremio's addon search).

Note: Render's free tier sleeps after ~15 min idle, so the first load can take ~30–50 s.

## Run locally
    npm install && npm start      # http://localhost:7000/manifest.json
Stremio on a phone needs HTTPS, so for phone use deploy it (or tunnel with cloudflared/ngrok).

## Options (environment variables)
- `TITLE_LANG` = `english` (default) or `romaji`
- `PUBLIC_URL` = force the public base URL if poster links come out wrong behind a proxy
