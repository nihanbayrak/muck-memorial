# 🐾 Muck — Forever in Our Hearts

A memorial page for Muck. Light candles, share memories with photos, and leave messages. All data is persisted to disk.

## Features

- **🕯️ Candle counter** — Light a candle, every one is counted and saved
- **📸 Memories** — Upload photos with titles and notes
- **💬 Messages** — Leave heartfelt notes for Muck
- **🖼️ Endless Gallery** — Infinite scrolling gallery of all uploaded photos
- **📱 Mobile-friendly** — Works on all devices, auto-converts HEIC photos
- **🔒 Security** — Rate limiting, input sanitization, security headers

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Deploy to Render (One-Click)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New** → **Blueprint**
3. Connect your GitHub repo
4. Render reads `render.yaml` and deploys automatically with a persistent disk

Or manually:
- **New Web Service** → Connect repo → **Docker** runtime
- Add a **Disk**: mount path `/data`, size 1 GB
- Environment: `DATA_DIR=/data`

## Project Structure

```
muck/
  server.js          # Express server (production-hardened)
  Dockerfile         # Docker config for Render
  render.yaml        # Render Blueprint (one-click deploy)
  package.json
  public/
    index.html       # Main memorial page
    gallery.html     # Endless gallery page
    muck-photo.png   # Hero image
    css/             # Gallery styles
    js/              # Gallery engine
  data/              # Created at runtime (gitignored)
    db.json          # JSON data store
    uploads/         # Uploaded photos
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/candles` | Get candle count |
| POST | `/api/candles` | Light a candle |
| GET | `/api/memories` | List all memories |
| POST | `/api/memories` | Add memory (multipart: photo, title, note, author) |
| GET | `/api/messages` | List all messages |
| POST | `/api/messages` | Add message (JSON: text, author) |
| GET | `/api/gallery` | Get gallery media items |

## Rate Limits

- General API: 200 requests / 15 min per IP
- Uploads & messages: 30 / hour per IP
- Candles: 10 / minute per IP

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `./data` | Path to data directory |
| `NODE_ENV` | `development` | Environment mode |
