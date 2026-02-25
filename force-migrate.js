require('dotenv').config();
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

const keyPath = path.join(__dirname, 'firebase-service-account.json');
let serviceAccount;
if (fs.existsSync(keyPath)) {
    serviceAccount = require(keyPath);
}

if (!serviceAccount) {
    console.log('No firebase credentials');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const db = admin.firestore();

const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const dbPath = path.join(dataDir, 'db.json');

async function uploadToCloud(localPath, filename) {
    try {
        const result = await cloudinary.uploader.upload(localPath, {
            folder: 'muck-memorial',
            public_id: filename.split('.')[0],
            resource_type: 'auto'
        });
        return result.secure_url;
    } catch (err) {
        console.error(`Cloudinary upload failed for ${filename}:`, err.message);
        return null;
    }
}

function loadDb() {
    try {
        const raw = fs.readFileSync(dbPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return { candleCount: 0, memories: [], messages: [] };
    }
}

async function run() {
    console.log('Force migrating...');
    const localDb = loadDb();

    // 1. Photos
    const photoMap = {};
    if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir);
        for (const f of files) {
            if (f === '.DS_Store') continue;
            console.log(`Cloud syncing ${f}...`);
            const url = await uploadToCloud(path.join(uploadsDir, f), f);
            if (url) photoMap[f] = url;
        }
    }

    // 2. Memories
    if (localDb.memories && localDb.memories.length > 0) {
        const batch = db.batch();
        localDb.memories.forEach(m => {
            // update photo_url if we uploaded it
            if (m.photo_filename && photoMap[m.photo_filename]) {
                m.photo_url = photoMap[m.photo_filename];
            }
            const ref = db.collection('memories').doc(String(m.id));
            batch.set(ref, m);
        });
        await batch.commit();
        console.log(`Migrated ${localDb.memories.length} memories`);
    }

    // 3. Messages
    if (localDb.messages && localDb.messages.length > 0) {
        const batch = db.batch();
        localDb.messages.forEach(m => {
            const ref = db.collection('messages').doc(String(m.id));
            batch.set(ref, m);
        });
        await batch.commit();
        console.log(`Migrated ${localDb.messages.length} messages`);
    }

    console.log('Done.');
    process.exit(0);
}

run();
