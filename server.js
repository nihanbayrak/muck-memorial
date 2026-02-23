const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (needed for rate limiting behind reverse proxies like Render)
app.set('trust proxy', 1);

// --- Security & Performance ---
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(compression());

// Rate limiting: general API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});

// Rate limiting: uploads (stricter)
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 uploads per hour per IP
  message: { error: 'Too many uploads. Please try again in an hour.' }
});

// Rate limiting: candles (prevent spam clicking)
const candleLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Easy there! Try again in a moment.' }
});

// --- Data Directory Setup ---
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const dbPath = path.join(dataDir, 'db.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- Simple JSON Store ---
function loadDb() {
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { candleCount: 0, memories: [], messages: [] };
  }
}

function saveDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

// --- Input Sanitization ---
function sanitize(str, maxLen = 500) {
  if (!str) return '';
  return str
    .replace(/[<>]/g, '') // Strip HTML-like chars
    .trim()
    .slice(0, maxLen);
}

// --- HEIC Conversion (cross-platform) ---
function convertHeicToJpeg(heicPath, jpegPath) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      // macOS: use built-in sips
      execSync(`sips -s format jpeg "${heicPath}" --out "${jpegPath}"`, { timeout: 30000 });
    } else {
      // Linux/Render: use ImageMagick (installed via Dockerfile)
      execSync(`convert "${heicPath}" "${jpegPath}"`, { timeout: 30000 });
    }
    return true;
  } catch (err) {
    console.error('HEIC conversion failed:', err.message);
    return false;
  }
}

// --- Multer Config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB (iPhone photos can be large)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// --- Middleware ---
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', // Cache static assets for 1 day
  etag: true
}));
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '7d', // Cache uploads for 7 days
  etag: true
}));

// --- API: Candles ---
app.get('/api/candles', apiLimiter, (req, res) => {
  const db = loadDb();
  res.json({ count: db.candleCount || 0 });
});

app.post('/api/candles', candleLimiter, (req, res) => {
  const db = loadDb();
  db.candleCount = (db.candleCount || 0) + 1;
  saveDb(db);
  res.json({ count: db.candleCount });
});

// --- API: Memories ---
app.get('/api/memories', apiLimiter, (req, res) => {
  const db = loadDb();
  const memories = (db.memories || []).map(m => ({
    ...m,
    photo: m.photo_filename ? `/uploads/${m.photo_filename}` : ''
  })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json(memories);
});

app.post('/api/memories', uploadLimiter, upload.single('photo'), async (req, res) => {
  const title = sanitize(req.body.title, 200);
  if (!title) return res.status(400).json({ error: 'Title is required' });

  let photoFilename = req.file ? req.file.filename : null;

  // Convert HEIC/HEIF to JPEG so browsers can display them
  if (req.file && /\.(heic|heif)$/i.test(req.file.filename)) {
    const origPath = path.join(uploadsDir, req.file.filename);
    const jpegName = req.file.filename.replace(/\.(heic|heif)$/i, '.jpg');
    const jpegPath = path.join(uploadsDir, jpegName);
    if (convertHeicToJpeg(origPath, jpegPath)) {
      try { fs.unlinkSync(origPath); } catch { }
      photoFilename = jpegName;
    }
  }

  const db = loadDb();
  db.memories = db.memories || [];

  const memory = {
    id: Date.now(),
    title,
    note: sanitize(req.body.note, 1000),
    author: sanitize(req.body.author, 100) || 'Anonymous',
    photo_filename: photoFilename,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    timestamp: Date.now()
  };
  db.memories.unshift(memory);
  saveDb(db);

  res.json({
    ...memory,
    photo: memory.photo_filename ? `/uploads/${memory.photo_filename}` : ''
  });
});

// --- API: Messages ---
app.get('/api/messages', apiLimiter, (req, res) => {
  const db = loadDb();
  const messages = (db.messages || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json(messages);
});

app.post('/api/messages', uploadLimiter, (req, res) => {
  const text = sanitize(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Message text is required' });

  const db = loadDb();
  db.messages = db.messages || [];

  const msg = {
    id: Date.now(),
    author: sanitize(req.body.author, 100) || 'Anonymous',
    text,
    timestamp: Date.now()
  };
  db.messages.unshift(msg);
  saveDb(db);

  res.json(msg);
});

// --- API: Gallery (for Endless Gallery page) ---
app.get('/api/gallery', apiLimiter, (req, res) => {
  const db = loadDb();
  const memories = db.memories || [];

  const mediaItems = memories
    .filter(m => m.photo_filename)
    .map(m => ({
      id: String(m.id),
      src: `/uploads/${m.photo_filename}`,
      type: 'image',
      aspectRatio: 1.2 + (Math.sin(m.id) * 0.5)
    }));

  res.json(mediaItems);
});

// --- Error Handling ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum 10MB allowed.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Server error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐾 Muck memorial running at http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Data dir: ${dataDir}`);
});
