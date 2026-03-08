import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Use process.cwd() for Vercel compatibility
const PROJECT_ROOT = process.cwd();
const DB_PATH = process.env.NODE_ENV === "production" 
  ? "/tmp/regions.db" 
  : (fs.existsSync(path.join(PROJECT_ROOT, "regions.db")) 
      ? path.join(PROJECT_ROOT, "regions.db") 
      : path.join(PROJECT_ROOT, "api", "regions.db"));
const LOCAL_DB_PATHS = [
  path.join(PROJECT_ROOT, "regions.db"),
  path.join(PROJECT_ROOT, "api", "regions.db"),
  path.join(__dirname, "regions.db"),
  path.join(__dirname, "api", "regions.db")
];

// In-memory cache for regions as fallback for SQLite issues on Vercel
let regionsCache: any[] = [];
let isSeeding = false;

// Initialize Database
let db: any;
try {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS regions (
      code TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      province TEXT,
      city TEXT,
      district TEXT,
      village TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_name ON regions(name);
  `);
} catch (e) {
  console.error("Database initialization failed, using in-memory database:", e);
  try {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS regions (
        code TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        province TEXT,
        city TEXT,
        district TEXT,
        village TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_name ON regions(name);
    `);
  } catch (e2) {
    console.error("Critical: SQLite failed completely. Falling back to pure JSON in memory.");
    db = null;
  }
}

async function seedDatabase() {
  if (isSeeding) return;
  isSeeding = true;
  
  try {
    if (db) {
      const count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
      if (count.count > 0) {
        console.log("Database already seeded.");
        isSeeding = false;
        return;
      }
    }

    console.log("Seeding database from GitHub...");
    console.log("PROJECT_ROOT:", PROJECT_ROOT);
    console.log("LOCAL_DB_PATHS:", LOCAL_DB_PATHS);
    console.log("DB_PATH:", DB_PATH);
    
    // Check if we can just copy the local regions.db to /tmp if it exists and we are in production
    if (db && process.env.NODE_ENV === "production" && DB_PATH === "/tmp/regions.db") {
      try {
        let foundPath = LOCAL_DB_PATHS.find(p => fs.existsSync(p));
        if (foundPath) {
          console.log("Copying local regions.db to /tmp from:", foundPath);
          fs.copyFileSync(foundPath, DB_PATH);
          db = new Database(DB_PATH);
          const count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
          if (count.count > 0) {
            console.log("Database restored from local file.");
            isSeeding = false;
            return;
          }
        } else {
          console.warn("Local regions.db not found in any of:", LOCAL_DB_PATHS);
        }
      } catch (e) {
        console.warn("Failed to copy local DB, falling back to fetch:", e);
      }
    }

    const response = await fetch("https://raw.githubusercontent.com/RRafly/Kode-Wilayah-CSV-to-JSON/main/wilayah_id.json");
    if (!response.ok) throw new Error("Failed to fetch region data");
    
    const data = await response.json();
    regionsCache = data; // Keep in memory as fallback
    
    if (db) {
      const insert = db.prepare("INSERT OR REPLACE INTO regions (code, name, type, province, city, district, village) VALUES (?, ?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (const prov of data) {
          const provCode = prov.kode_wilayah.join(".");
          insert.run(provCode, prov.provinsi, "province", prov.provinsi, null, null, null);
          
          for (const city of prov.kota || []) {
            const cityCode = city.kode_wilayah.join(".");
            insert.run(cityCode, city.kota, city.type, prov.provinsi, city.kota, null, null);
            
            for (const kec of city.kecamatan || []) {
              const kecCode = kec.kode_wilayah.join(".");
              insert.run(kecCode, kec.kecamatan, "district", prov.provinsi, city.kota, kec.kecamatan, null);
              
              for (const desa of kec.desa || []) {
                const desaCode = desa.kode_wilayah.join(".");
                insert.run(desaCode, desa.desa, "village", prov.provinsi, city.kota, kec.kecamatan, desa.desa);
              }
            }
          }
        }
      })();
      console.log("Database seeding complete.");
    } else {
      console.log("Pure JSON seeding complete (SQLite disabled).");
    }
  } catch (error) {
    console.error("Error seeding database:", error);
  } finally {
    isSeeding = false;
  }
}

seedDatabase();

app.use(express.json());

// API Routes
app.get("/api/provinces", (req, res) => {
  if (db) {
    try {
      const results = db.prepare("SELECT DISTINCT province as name FROM regions WHERE province IS NOT NULL ORDER BY province ASC").all();
      return res.json(results);
    } catch (e) {
      console.error("SQLite provinces failed:", e);
    }
  }
  
  const provinces = Array.from(new Set(regionsCache.map(p => p.provinsi))).sort();
  res.json(provinces.map(p => ({ name: p })));
});

app.get("/api/cities", (req, res) => {
  const { province } = req.query;
  if (!province) return res.status(400).json({ error: "Province required" });

  if (db) {
    try {
      const results = db.prepare("SELECT DISTINCT city as name, type, code FROM regions WHERE province = ? AND city IS NOT NULL AND (type = 'kota' OR type = 'kabupaten') ORDER BY city ASC").all(province);
      return res.json(results);
    } catch (e) {
      console.error("SQLite cities failed:", e);
    }
  }

  const prov = regionsCache.find(p => p.provinsi === province);
  if (!prov) return res.json([]);
  
  const cities = (prov.kota || []).map((c: any) => ({
    name: c.kota,
    type: c.type,
    code: c.kode_wilayah.join(".")
  })).sort((a: any, b: any) => a.name.localeCompare(b.name));
  
  res.json(cities);
});

app.get("/api/districts", (req, res) => {
  const { city } = req.query;
  if (!city) return res.status(400).json({ error: "City required" });

  if (db) {
    try {
      const results = db.prepare("SELECT DISTINCT district as name, code FROM regions WHERE city = ? AND district IS NOT NULL AND type = 'district' ORDER BY district ASC").all(city);
      return res.json(results);
    } catch (e) {
      console.error("SQLite districts failed:", e);
    }
  }

  for (const prov of regionsCache) {
    const c = (prov.kota || []).find((ct: any) => ct.kota === city);
    if (c) {
      const districts = (c.kecamatan || []).map((k: any) => ({
        name: k.kecamatan,
        code: k.kode_wilayah.join(".")
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));
      return res.json(districts);
    }
  }
  
  res.json([]);
});

app.get("/api/search-region", (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  if (db) {
    let query = "SELECT * FROM regions WHERE name LIKE ? ";
    const params: any[] = [`%${q}%`];

    if (type) {
      query += " AND type = ?";
      params.push(type);
    }

    query += " LIMIT 20";
    
    try {
      const results = db.prepare(query).all(...params);
      return res.json(results);
    } catch (e) {
      console.error("SQLite search failed:", e);
    }
  }

  // Fallback to in-memory search if SQLite fails or is disabled
  const query = String(q).toLowerCase();
  const results: any[] = [];
  
  for (const prov of regionsCache) {
    if (prov.provinsi.toLowerCase().includes(query)) {
      results.push({ code: prov.kode_wilayah.join("."), name: prov.provinsi, type: "province", province: prov.provinsi });
    }
    for (const city of prov.kota || []) {
      if (city.kota.toLowerCase().includes(query)) {
        results.push({ code: city.kode_wilayah.join("."), name: city.kota, type: city.type, province: prov.provinsi, city: city.kota });
      }
      for (const kec of city.kecamatan || []) {
        if (kec.kecamatan.toLowerCase().includes(query)) {
          results.push({ code: kec.kode_wilayah.join("."), name: kec.kecamatan, type: "district", province: prov.provinsi, city: city.kota, district: kec.kecamatan });
        }
        for (const desa of kec.desa || []) {
          if (desa.desa.toLowerCase().includes(query)) {
            results.push({ code: desa.kode_wilayah.join("."), name: desa.desa, type: "village", province: prov.provinsi, city: city.kota, district: kec.kecamatan, village: desa.desa });
          }
          if (results.length >= 20) break;
        }
        if (results.length >= 20) break;
      }
      if (results.length >= 20) break;
    }
    if (results.length >= 20) break;
  }
  res.json(results);
});

app.get("/api/db-status", async (req, res) => {
  if (db) {
    try {
      let count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
      if (count.count === 0) {
        await seedDatabase();
        count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
      }
      return res.json({ count: count.count, type: 'sqlite' });
    } catch (e) {
      console.error("DB Status SQLite check failed:", e);
    }
  }
  
  if (regionsCache.length === 0) await seedDatabase();
  res.json({ count: regionsCache.length, type: 'memory' });
});

function resolveRegion(village: any, district: any, city: any, province: any) {
  if (db) {
    try {
      // Try to find the most specific match
      let result = null;
      
      // 1. Exact village + district match
      if (village && district) {
        result = db.prepare("SELECT * FROM regions WHERE village LIKE ? AND district LIKE ? AND type = 'village'").get(`${village}`, `${district}`);
      }
      
      // 2. Fuzzy village + district match
      if (!result && village && district) {
        result = db.prepare("SELECT * FROM regions WHERE village LIKE ? AND district LIKE ? AND type = 'village'").get(`%${village}%`, `%${district}%`);
      }

      // 3. Village only match (if unique enough)
      if (!result && village) {
        result = db.prepare("SELECT * FROM regions WHERE village LIKE ? AND type = 'village'").get(`${village}`);
        if (!result) {
          result = db.prepare("SELECT * FROM regions WHERE village LIKE ? AND type = 'village'").get(`%${village}%`);
        }
      }
      
      // 4. District + City match
      if (!result && district && city) {
        result = db.prepare("SELECT * FROM regions WHERE district LIKE ? AND city LIKE ? AND type = 'district'").get(`${district}`, `${city}`);
        if (!result) {
          result = db.prepare("SELECT * FROM regions WHERE district LIKE ? AND city LIKE ? AND type = 'district'").get(`%${district}%`, `%${city}%`);
        }
      }

      // 5. District only match
      if (!result && district) {
        result = db.prepare("SELECT * FROM regions WHERE district LIKE ? AND type = 'district'").get(`${district}`);
        if (!result) {
          result = db.prepare("SELECT * FROM regions WHERE district LIKE ? AND type = 'district'").get(`%${district}%`);
        }
      }
      
      // 6. City only match
      if (!result && city) {
        result = db.prepare("SELECT * FROM regions WHERE city LIKE ? AND (type = 'kota' OR type = 'kabupaten')").get(`${city}`);
        if (!result) {
          result = db.prepare("SELECT * FROM regions WHERE city LIKE ? AND (type = 'kota' OR type = 'kabupaten')").get(`%${city}%`);
        }
      }

      if (result) return result;
    } catch (e) {
      console.error("SQLite resolve failed:", e);
    }
  }

  // Pure JSON fallback
  const v = String(village || '').toLowerCase();
  const d = String(district || '').toLowerCase();
  const c = String(city || '').toLowerCase();
  const p = String(province || '').toLowerCase();

  for (const prov of regionsCache) {
    for (const city of prov.kota || []) {
      for (const kec of city.kecamatan || []) {
        if (v && d && kec.kecamatan.toLowerCase().includes(d)) {
          for (const desa of kec.desa || []) {
            if (desa.desa.toLowerCase().includes(v)) {
              return { code: desa.kode_wilayah.join("."), name: desa.desa, type: "village", province: prov.provinsi, city: city.kota, district: kec.kecamatan, village: desa.desa };
            }
          }
        }
        if (d && kec.kecamatan.toLowerCase().includes(d)) {
          return { code: kec.kode_wilayah.join("."), name: kec.kecamatan, type: "district", province: prov.provinsi, city: city.kota, district: kec.kecamatan };
        }
      }
      if (c && city.kota.toLowerCase().includes(c)) {
        return { code: city.kode_wilayah.join("."), name: city.kota, type: city.type, province: prov.provinsi, city: city.kota };
      }
    }
  }

  return null;
}

app.get("/api/resolve-region", (req, res) => {
  const { village, district, city, province } = req.query;
  console.log("Resolving region:", { village, district, city, province });
  
  const result = resolveRegion(village, district, city, province);

  if (result) {
    console.log("Found region:", result.name, result.code);
    res.json(result);
  } else {
    console.log("Region not found for query");
    res.status(404).json({ error: "Region not found" });
  }
});

app.get("/api/weather", async (req, res) => {
  const { adm4 } = req.query;
  if (!adm4) return res.status(400).json({ error: "adm4 parameter required" });

  try {
    const sAdm4 = String(adm4);
    const cleanCode = sAdm4.replace(/\./g, '');
    // Try with dots
    let r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(sAdm4)}`);
    if (r.ok) {
      const d = await r.json();
      if (d && d.data && d.data.length > 0) return res.json(d);
    }
    
    // Try without dots
    r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(cleanCode)}`);
    if (r.ok) {
      const d = await r.json();
      if (d && d.data && d.data.length > 0) return res.json(d);
    }

    res.status(404).json({ error: "Weather data not found for this code" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/weather/ip", async (req, res) => {
  const lat = req.headers['x-vercel-ip-latitude'] || req.headers['x-forwarded-for-lat'];
  const lon = req.headers['x-vercel-ip-longitude'] || req.headers['x-forwarded-for-lon'];

  if (!lat || !lon) {
    return res.status(404).json({ error: "Location headers not found. This feature requires Vercel deployment." });
  }

  try {
    // Reuse the forecast logic
    const revRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, {
      headers: { 'User-Agent': 'BMKG-Weather-App/1.0' }
    });
    
    if (!revRes.ok) throw new Error("Failed to reverse geocode IP location");
    const revData = await revRes.json();
    const addr = revData.address || {};
    
    const village = addr.village || addr.suburb || addr.neighbourhood || addr.hamlet;
    const district = addr.city_district || addr.district || addr.suburb;
    const city = addr.city || addr.town || addr.municipality || addr.county;
    const state = addr.state;

    const region = resolveRegion(village, district, city, state);
    if (!region) {
      return res.status(404).json({ error: "IP location region not found in BMKG database", address: addr });
    }

    const adm4 = String(region.code);
    const cleanCode = adm4.replace(/\./g, '');
    
    let weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(adm4)}`);
    if (!weatherRes.ok) {
      weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(cleanCode)}`);
    }

    if (!weatherRes.ok) {
      return res.status(404).json({ error: "Weather data not found for IP region", region });
    }

    const weatherData = await weatherRes.json();
    res.json({
      region,
      address: addr,
      weather: weatherData,
      source: 'vercel-ip-headers'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/weather/forecast", async (req, res) => {
  const { lat, long, lon } = req.query;
  const latitude = lat;
  const longitude = long || lon;

  if (!latitude || !longitude) {
    return res.status(400).json({ error: "lat and long parameters required" });
  }

  try {
    // 1. Reverse Geocode via Nominatim
    const revRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`, {
      headers: { 'User-Agent': 'BMKG-Weather-App/1.0' }
    });
    
    if (!revRes.ok) throw new Error("Failed to reverse geocode");
    const revData = await revRes.json();
    const addr = revData.address || {};
    
    const village = addr.village || addr.suburb || addr.neighbourhood || addr.hamlet;
    const district = addr.city_district || addr.district || addr.suburb;
    const city = addr.city || addr.town || addr.municipality || addr.county;
    const state = addr.state;

    // 2. Resolve to BMKG Region Code
    const region = resolveRegion(village, district, city, state);
    if (!region) {
      return res.status(404).json({ 
        error: "Region not found in BMKG database", 
        address: addr 
      });
    }

    // 3. Fetch Weather from BMKG
    const adm4 = String(region.code);
    const cleanCode = adm4.replace(/\./g, '');
    
    let weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(adm4)}`);
    if (!weatherRes.ok) {
      weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(cleanCode)}`);
    }

    if (!weatherRes.ok) {
      return res.status(404).json({ error: "Weather data not found for this region", region });
    }

    const weatherData = await weatherRes.json();
    res.json({
      region,
      address: addr,
      weather: weatherData
    });

  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(__dirname, "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

export default app;

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
} else {
  // In production (like Cloud Run), we still need to listen
  // But on Vercel, we export the app.
  // We can check if we are in a serverless environment.
  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}
