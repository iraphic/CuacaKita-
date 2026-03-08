import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, "regions.db");

// Initialize Database
const db = new Database(DB_PATH);
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

async function seedDatabase() {
  const count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
  if (count.count > 0) {
    console.log("Database already seeded.");
    return;
  }

  console.log("Seeding database from GitHub...");
  try {
    const response = await fetch("https://raw.githubusercontent.com/RRafly/Kode-Wilayah-CSV-to-JSON/main/wilayah_id.json");
    if (!response.ok) throw new Error("Failed to fetch region data");
    
    const data = await response.json();
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
  } catch (error) {
    console.error("Error seeding database:", error);
  }
}

seedDatabase();

app.use(express.json());

// API Routes
app.get("/api/search-region", (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  let query = "SELECT * FROM regions WHERE name LIKE ? ";
  const params: any[] = [`%${q}%`];

  if (type) {
    query += " AND type = ?";
    params.push(type);
  }

  query += " LIMIT 20";
  
  const results = db.prepare(query).all(...params);
  res.json(results);
});

app.get("/api/db-status", async (req, res) => {
  let count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
  if (count.count === 0) {
    console.log("Database empty, re-triggering seed...");
    await seedDatabase();
    count = db.prepare("SELECT COUNT(*) as count FROM regions").get() as { count: number };
  }
  res.json({ count: count.count });
});

function resolveRegion(village: any, district: any, city: any, province: any) {
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

  return result;
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
    const cleanCode = (adm4 as string).replace(/\./g, '');
    // Try with dots
    let r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${adm4}`);
    if (r.ok) {
      const d = await r.json();
      if (d && d.data && d.data.length > 0) return res.json(d);
    }
    
    // Try without dots
    r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${cleanCode}`);
    if (r.ok) {
      const d = await r.json();
      if (d && d.data && d.data.length > 0) return res.json(d);
    }

    res.status(404).json({ error: "Weather data not found for this code" });
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
    const adm4 = region.code;
    const cleanCode = adm4.replace(/\./g, '');
    
    let weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${adm4}`);
    if (!weatherRes.ok) {
      weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${cleanCode}`);
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
