import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ─── In-memory cache (SQLite dihapus karena tidak kompatibel di Vercel) ───
let regionsCache: any[] = [];
let isSeeding = false;
let seedingPromise: Promise<void> | null = null;

async function seedDatabase(): Promise<void> {
  if (regionsCache.length > 0) return;
  if (isSeeding && seedingPromise) return seedingPromise;

  isSeeding = true;
  seedingPromise = (async () => {
    try {
      console.log("Fetching region data from GitHub...");
      const response = await fetch(
        "https://raw.githubusercontent.com/RRafly/Kode-Wilayah-CSV-to-JSON/main/wilayah_id.json"
      );
      if (!response.ok) throw new Error("Failed to fetch region data");
      regionsCache = await response.json();
      console.log(`Seeded ${regionsCache.length} provinces into memory.`);
    } catch (error) {
      console.error("Error seeding region data:", error);
    } finally {
      isSeeding = false;
    }
  })();

  return seedingPromise;
}

// Seed on cold start
seedDatabase();

// ─── Helper: ensure data is loaded ───────────────────────────────────────────
async function ensureData() {
  if (regionsCache.length === 0) await seedDatabase();
}

// ─── Helper: resolve region from address parts ───────────────────────────────
function resolveRegion(
  village: any,
  district: any,
  city: any,
  province: any
) {
  const v = String(village || "").toLowerCase();
  const d = String(district || "").toLowerCase();
  const c = String(city || "").toLowerCase();

  for (const prov of regionsCache) {
    for (const ct of prov.kota || []) {
      for (const kec of ct.kecamatan || []) {
        // Village + district match
        if (v && d && kec.kecamatan.toLowerCase().includes(d)) {
          for (const desa of kec.desa || []) {
            if (desa.desa.toLowerCase().includes(v)) {
              return {
                code: desa.kode_wilayah.join("."),
                name: desa.desa,
                type: "village",
                province: prov.provinsi,
                city: ct.kota,
                district: kec.kecamatan,
                village: desa.desa,
              };
            }
          }
        }
        // District match
        if (d && kec.kecamatan.toLowerCase().includes(d)) {
          return {
            code: kec.kode_wilayah.join("."),
            name: kec.kecamatan,
            type: "district",
            province: prov.provinsi,
            city: ct.kota,
            district: kec.kecamatan,
          };
        }
      }
      // City match
      if (c && ct.kota.toLowerCase().includes(c)) {
        return {
          code: ct.kode_wilayah.join("."),
          name: ct.kota,
          type: ct.type,
          province: prov.provinsi,
          city: ct.kota,
        };
      }
    }
  }
  return null;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get("/api/provinces", async (req, res) => {
  await ensureData();
  const provinces = Array.from(new Set(regionsCache.map((p) => p.provinsi))).sort();
  res.json(provinces.map((p) => ({ name: p })));
});

app.get("/api/cities", async (req, res) => {
  const { province } = req.query;
  if (!province) return res.status(400).json({ error: "Province required" });

  await ensureData();
  const prov = regionsCache.find((p) => p.provinsi === province);
  if (!prov) return res.json([]);

  const cities = (prov.kota || [])
    .map((c: any) => ({
      name: c.kota,
      type: c.type,
      code: c.kode_wilayah.join("."),
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  res.json(cities);
});

app.get("/api/districts", async (req, res) => {
  const { city } = req.query;
  if (!city) return res.status(400).json({ error: "City required" });

  await ensureData();
  for (const prov of regionsCache) {
    const c = (prov.kota || []).find((ct: any) => ct.kota === city);
    if (c) {
      const districts = (c.kecamatan || [])
        .map((k: any) => ({
          name: k.kecamatan,
          code: k.kode_wilayah.join("."),
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      return res.json(districts);
    }
  }
  res.json([]);
});

app.get("/api/search-region", async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  await ensureData();
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

  const filtered = type ? results.filter((r) => r.type === type) : results;
  res.json(filtered.slice(0, 20));
});

app.get("/api/db-status", async (req, res) => {
  await ensureData();
  res.json({ count: regionsCache.length, type: "memory" });
});

app.get("/api/resolve-region", async (req, res) => {
  const { village, district, city, province } = req.query;
  await ensureData();

  const result = resolveRegion(village, district, city, province);
  if (result) {
    res.json(result);
  } else {
    res.status(404).json({ error: "Region not found" });
  }
});

app.get("/api/weather", async (req, res) => {
  const { adm4 } = req.query;
  if (!adm4) return res.status(400).json({ error: "adm4 parameter required" });

  try {
    const sAdm4 = String(adm4);
    const cleanCode = sAdm4.replace(/\./g, "");

    let r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(sAdm4)}`);
    if (r.ok) {
      const d = await r.json();
      if (d?.data?.length > 0) return res.json(d);
    }

    r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(cleanCode)}`);
    if (r.ok) {
      const d = await r.json();
      if (d?.data?.length > 0) return res.json(d);
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
    await ensureData();

    const revRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "BMKG-Weather-App/1.0" } }
    );
    if (!revRes.ok) throw new Error("Failed to reverse geocode");

    const revData = await revRes.json();
    const addr = revData.address || {};

    const village = addr.village || addr.suburb || addr.neighbourhood || addr.hamlet;
    const district = addr.city_district || addr.district || addr.suburb;
    const city = addr.city || addr.town || addr.municipality || addr.county;
    const state = addr.state;

    const region = resolveRegion(village, district, city, state);
    if (!region) {
      return res.status(404).json({ error: "Region not found in BMKG database", address: addr });
    }

    const adm4 = String(region.code);
    const cleanCode = adm4.replace(/\./g, "");

    let weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(adm4)}`);
    if (!weatherRes.ok) {
      weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(cleanCode)}`);
    }
    if (!weatherRes.ok) {
      return res.status(404).json({ error: "Weather data not found for this region", region });
    }

    const weatherData = await weatherRes.json();
    res.json({ region, address: addr, weather: weatherData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/weather/ip", async (req, res) => {
  const lat = req.headers["x-vercel-ip-latitude"];
  const lon = req.headers["x-vercel-ip-longitude"];

  if (!lat || !lon) {
    return res.status(404).json({
      error: "Location headers not found. This feature requires Vercel deployment.",
    });
  }

  try {
    await ensureData();

    const revRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "BMKG-Weather-App/1.0" } }
    );
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
    const cleanCode = adm4.replace(/\./g, "");

    let weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(adm4)}`);
    if (!weatherRes.ok) {
      weatherRes = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(cleanCode)}`);
    }
    if (!weatherRes.ok) {
      return res.status(404).json({ error: "Weather data not found for IP region", region });
    }

    const weatherData = await weatherRes.json();
    res.json({ region, address: addr, weather: weatherData, source: "vercel-ip-headers" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default app;
