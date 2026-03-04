require('dotenv').config();
const express = require('express');

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

// --- Firebase Initialization ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  const keyPath = path.join(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(keyPath)) {
    serviceAccount = require(keyPath);
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('🔥 Firebase Admin (Firestore) initialized');
} else {
  console.warn('⚠️ Firebase credentials not found. Falling back to local data (ephemeral on Render Free).');
}

// --- Cloudinary Initialization ---
if (process.env.CLOUDINARY_URL) {
  // Use the auto-config URL if provided
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}
console.log('☁️ Cloudinary initialized');

const db = serviceAccount ? admin.firestore() : null;

app.set('trust proxy', 1);

// --- Security & Performance ---
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://firebasestorage.googleapis.com", "https://*.firebasestorage.app", "https://res.cloudinary.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://firestore.googleapis.com", "https://*.firebaseio.com"]
    }
  }
}));
app.use(compression());

// Rate limiting: general API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Increased for cloud calls
  message: { error: 'Too many requests, please try again later.' }
});

// Rate limiting: uploads (stricter)
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 150, // Graceful limit for ~50 expected users
  message: { error: 'Too many uploads. Please try again in an hour.' }
});

// Rate limiting: candles (prevent spam clicking)
const candleLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'Easy there! Try again in a moment.' }
});

// --- Data Directory Setup (Fallback for local legacy imports) ---
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const dbPath = path.join(dataDir, 'db.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- Cloudinary Helpers ---
async function uploadToCloud(localPath, filename) {
  if (!process.env.CLOUDINARY_API_KEY && !process.env.CLOUDINARY_URL) {
    return `/uploads/${filename}`;
  }
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder: 'muck-memorial',
      public_id: filename.split('.')[0],
      resource_type: 'auto'
    });
    return result.secure_url;
  } catch (err) {
    console.error(`Cloudinary upload failed for ${filename}:`, err.message);
    return `/uploads/${filename}`; // Fallback to local
  }
}

async function getStats() {
  if (!serviceAccount) return loadDb();
  const doc = await db.collection('memorial').doc('stats').get();
  return doc.exists ? doc.data() : { candleCount: 0 };
}

async function incrementCandles() {
  if (!serviceAccount) {
    const local = loadDb();
    local.candleCount = (local.candleCount || 0) + 1;
    saveDb(local);
    return local.candleCount;
  }
  const statsRef = db.collection('memorial').doc('stats');
  await statsRef.set({ candleCount: admin.firestore.FieldValue.increment(1) }, { merge: true });
  const updated = await statsRef.get();
  return updated.data().candleCount;
}

// --- Data Migration Logic (Legacy -> Cloud) ---
async function migrateToCloud() {
  if (!serviceAccount) return;

  const statsDoc = await db.collection('memorial').doc('stats').get();
  if (statsDoc.exists) return; // Already migrated or initialized

  console.log('📦 Starting one-time cloud migration...');
  const localDb = loadDb();

  // 1. Migrate Stats
  await db.collection('memorial').doc('stats').set({ candleCount: localDb.candleCount || 0 });

  // 2. Migrate Photos (the ones in uploads folder)
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    for (const f of files) {
      if (f === '.DS_Store') continue;
      console.log(`   Cloud syncing ${f}...`);
      await uploadToCloud(path.join(uploadsDir, f), f);
    }
  }

  // 3. Migrate Memories
  if (localDb.memories && localDb.memories.length > 0) {
    const batch = db.batch();
    localDb.memories.forEach(m => {
      const ref = db.collection('memories').doc(String(m.id));
      batch.set(ref, m);
    });
    await batch.commit();
  }

  // 4. Migrate Messages
  if (localDb.messages && localDb.messages.length > 0) {
    const batch = db.batch();
    localDb.messages.forEach(m => {
      const ref = db.collection('messages').doc(String(m.id));
      batch.set(ref, m);
    });
    await batch.commit();
  }

  console.log('✅ Cloud migration complete');
}

// Run migration on startup
migrateToCloud().catch(err => console.error('Migration failed:', err));

// --- Simple JSON Store (Fallback/Legacy) ---
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .trim()
    .slice(0, maxLen);
}

// --- HEIC Conversion (cross-platform) ---
function convertHeicToJpeg(heicPath, jpegPath) {
  const platform = process.platform;
  const { execFileSync } = require('child_process');
  try {
    if (platform === 'darwin') {
      // macOS: use built-in sips (safe array args)
      execFileSync('sips', ['-s', 'format', 'jpeg', heicPath, '--out', jpegPath], { timeout: 30000 });
    } else {
      // Linux/Render: use ImageMagick (safe array args)
      execFileSync('convert', [heicPath, jpegPath], { timeout: 30000 });
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
    // Basic mimetype check
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }

    // Strict extension whitelist to prevent .html or execution scripts
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only standard images allowed.'));
    }
  }
});

// --- Middleware ---
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0, // Disable long caching so HTML and CSP updates immediately
  etag: true
}));
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '7d', // Cache uploads for 7 days
  etag: true
}));

// --- API: Candles ---
app.get('/api/candles', apiLimiter, async (req, res) => {
  const stats = await getStats();
  res.json({ count: stats.candleCount || 0 });
});

app.post('/api/candles', candleLimiter, async (req, res) => {
  const count = await incrementCandles();
  res.json({ count });
});

// --- API: Memories ---
app.get('/api/memories', apiLimiter, async (req, res) => {
  if (!serviceAccount) {
    const db = loadDb();
    const memories = (db.memories || []).map(m => ({
      ...m,
      photo: m.photo_filename ? `/uploads/${m.photo_filename}` : ''
    })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return res.json(memories);
  }

  const snapshot = await db.collection('memories').orderBy('timestamp', 'desc').get();
  const memories = snapshot.docs.map(doc => {
    const data = doc.data();
    return {
      ...data,
      photo: data.photo_url || (data.photo_filename ? `/uploads/${data.photo_filename}` : '')
    };
  });
  res.json(memories);
});

app.post('/api/memories', uploadLimiter, upload.single('photo'), async (req, res) => {
  const title = sanitize(req.body.title, 200);
  if (!title) return res.status(400).json({ error: 'Title is required' });

  let photoFilename = req.file ? req.file.filename : null;
  let photoUrl = '';

  // Convert HEIC/HEIF to JPEG
  if (req.file && /\.(heic|heif)$/i.test(req.file.filename)) {
    const origPath = path.join(uploadsDir, req.file.filename);
    const jpegName = req.file.filename.replace(/\.(heic|heif)$/i, '.jpg');
    const jpegPath = path.join(uploadsDir, jpegName);
    if (convertHeicToJpeg(origPath, jpegPath)) {
      try { fs.unlinkSync(origPath); } catch { }
      photoFilename = jpegName;
    }
  }

  if (photoFilename) {
    const localPath = path.join(uploadsDir, photoFilename);
    photoUrl = await uploadToCloud(localPath, photoFilename);
  }

  const memory = {
    id: Date.now(),
    title,
    note: sanitize(req.body.note, 1000),
    author: sanitize(req.body.author, 100),
    photo_filename: photoFilename,
    photo_url: photoUrl,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    timestamp: Date.now()
  };

  if (!serviceAccount) {
    const db = loadDb();
    db.memories = db.memories || [];
    db.memories.unshift(memory);
    saveDb(db);
  } else {
    await db.collection('memories').doc(String(memory.id)).set(memory);
  }

  res.json({
    ...memory,
    photo: photoUrl || (memory.photo_filename ? `/uploads/${memory.photo_filename}` : '')
  });
});

// --- API: Messages ---
app.get('/api/messages', apiLimiter, async (req, res) => {
  if (!serviceAccount) {
    const db = loadDb();
    const messages = (db.messages || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return res.json(messages);
  }
  const snapshot = await db.collection('messages').orderBy('timestamp', 'desc').get();
  const messages = snapshot.docs.map(doc => doc.data());
  res.json(messages);
});

app.post('/api/messages', uploadLimiter, async (req, res) => {
  const text = sanitize(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Message text is required' });

  const msg = {
    id: Date.now(),
    author: sanitize(req.body.author, 100),
    text,
    timestamp: Date.now()
  };

  if (!serviceAccount) {
    const db = loadDb();
    db.messages = db.messages || [];
    db.messages.unshift(msg);
    saveDb(db);
  } else {
    await db.collection('messages').doc(String(msg.id)).set(msg);
  }

  res.json(msg);
});

// --- API: Gallery (for Endless Gallery page) ---
app.get('/api/gallery', apiLimiter, async (req, res) => {
  let memories = [];
  if (!serviceAccount) {
    const local = loadDb();
    memories = local.memories || [];
  } else {
    const snapshot = await db.collection('memories').orderBy('timestamp', 'desc').get();
    memories = snapshot.docs.map(doc => doc.data());
  }

  const mediaItems = memories
    .filter(m => m.photo_filename || m.photo_url)
    .map(m => ({
      id: String(m.id),
      src: m.photo_url || `/uploads/${m.photo_filename}`,
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
