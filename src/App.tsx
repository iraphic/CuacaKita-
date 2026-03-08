/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { MapPin, RefreshCw, Search, Droplets, Wind, Cloud, Eye, Compass, Info } from 'lucide-react';

// ── WEATHER MAPPING ──
const WX: Record<number, { e: string; l: string; t: string }> = {
  0: { e: '☀️', l: 'Cerah', t: 'theme-sunny' },
  1: { e: '🌤️', l: 'Cerah Berawan', t: 'theme-sunny' },
  2: { e: '⛅', l: 'Cerah Berawan', t: 'theme-sunny' },
  3: { e: '🌥️', l: 'Berawan', t: 'theme-cloudy' },
  4: { e: '☁️', l: 'Berawan Tebal', t: 'theme-cloudy' },
  5: { e: '🌫️', l: 'Udara Kabur', t: 'theme-cloudy' },
  10: { e: '🌫️', l: 'Asap', t: 'theme-cloudy' },
  45: { e: '🌫️', l: 'Kabut', t: 'theme-cloudy' },
  60: { e: '🌦️', l: 'Hujan Ringan', t: 'theme-rain' },
  61: { e: '🌧️', l: 'Hujan Sedang', t: 'theme-rain' },
  63: { e: '🌧️', l: 'Hujan Lebat', t: 'theme-rain' },
  80: { e: '🌦️', l: 'Hujan Lokal', t: 'theme-rain' },
  95: { e: '⛈️', l: 'Hujan Petir', t: 'theme-storm' },
  97: { e: '⛈️', l: 'Hujan Petir Lebat', t: 'theme-storm' },
};

const WARR: Record<string, string> = {
  'N': '↑', 'NE': '↗', 'E': '→', 'SE': '↘', 'S': '↓', 'SW': '↙', 'W': '←', 'NW': '↖',
  'UTARA': '↑', 'TIMUR LAUT': '↗', 'TIMUR': '→', 'TENGGARA': '↘', 'SELATAN': '↓', 'BARAT DAYA': '↙', 'BARAT': '←', 'BARAT LAUT': '↖', 'VARIABLE': '↻'
};

function wxInfo(code: number, desc: string) {
  const d = (desc || '').toLowerCase();
  let i = WX[code];
  if (!i) {
    if (d.includes('petir') || d.includes('guntur')) i = WX[95];
    else if (d.includes('hujan lebat')) i = WX[63];
    else if (d.includes('hujan')) i = WX[60];
    else if (d.includes('kabut') || d.includes('asap')) i = WX[45];
    else if (d.includes('berawan')) i = WX[3];
    else if (d.includes('cerah')) i = WX[0];
    else i = { e: '🌤️', l: desc || 'Tidak Diketahui', t: 'theme-sunny' };
  }
  const h = new Date().getHours();
  if ((h < 6 || h >= 18) && i.t === 'theme-sunny') return { ...i, e: '🌙', t: 'theme-night' };
  return i;
}

const warr = (d: string) => WARR[(d || '').toUpperCase()] || d || '–';

interface Forecast {
  local_datetime: string;
  utc_datetime: string;
  weather: number;
  weather_desc: string;
  weather_desc_en?: string;
  t: number;
  hu: number;
  ws: number;
  tcc: number;
  vs_text?: string;
  wd: string;
  analysis_date?: string;
}

interface WeatherData {
  data: Array<{
    lokasi: {
      kecamatan: string;
      kotkab: string;
      provinsi: string;
    };
    cuaca: Forecast[][] | Forecast[];
  }>;
}

export default function App() {
  const [screen, setScreen] = useState<'loading' | 'error' | 'weather'>('loading');
  const [loadTitle, setLoadTitle] = useState('Mendeteksi lokasi...');
  const [loadStep, setLoadStep] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [locationLabel, setLocationLabel] = useState('');
  const [theme, setTheme] = useState('theme-sunny');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  };

  const probeBMKG = async (adm4: string) => {
    const cleanCode = adm4.replace(/\./g, '');
    try {
      // Try with dots first
      let r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${adm4}`);
      if (r.ok) {
        const d = await r.json();
        if (d && d.data && d.data.length > 0 && d.data[0].cuaca && d.data[0].cuaca.length > 0) return d;
      }
      
      // Try without dots
      r = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${cleanCode}`);
      if (r.ok) {
        const d = await r.json();
        if (d && d.data && d.data.length > 0 && d.data[0].cuaca && d.data[0].cuaca.length > 0) return d;
      }
      
      return null;
    } catch { return null; }
  };

  const nomDetails = async (placeId: number) => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/details?place_id=${placeId}&format=json&addressdetails=0&accept-language=id`,
        { headers: { 'User-Agent': 'CuacaBMKGApp/2.0' } });
      if (!r.ok) return {};
      const d = await r.json();
      return d.extratags || {};
    } catch { return {}; }
  };

  const overpassRef = async (lat: number, lon: number) => {
    setLoadStep('Mencari batas wilayah administratif...');
    const q = `[out:json][timeout:10];(relation["boundary"="administrative"]["admin_level"~"^[78]$"]["ref:kemendagri"](around:8000,${lat},${lon}););out tags 5;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.elements || []).sort((a: any, b: any) => (b.tags?.admin_level || 0) - (a.tags?.admin_level || 0));
  };

  const resolveADM4 = async (nom: any): Promise<{ adm4: string, displayName: string, weatherData: WeatherData }> => {
    setLoadTitle('Mencari kode wilayah BMKG...');
    const addr = nom.address || {};
    const village = addr.village || addr.suburb || addr.hamlet || addr.neighbourhood || '';
    const district = addr.district || addr.city_district || '';
    const city = addr.city || addr.town || addr.county || addr.state_district || '';
    const state = addr.state || addr.region || '';
    const locDisp = [district || village, city].filter(Boolean).join(', ') || nom.display_name?.split(',').slice(0, 2).join(',') || 'Lokasi Anda';
    
    setLoadStep(`📍 ${locDisp}`);

    try {
      // Call our new backend API for reliable resolution
      const params = new URLSearchParams({
        village: village,
        district: district,
        city: city,
        province: state
      });
      
      setLoadStep(`Mencari di database wilayah...`);
      const res = await fetch(`/api/resolve-region?${params.toString()}`);
      if (res.ok) {
        const region = await res.json();
        setLoadStep(`Ditemukan: ${region.name} (${region.code})`);
        const wd = await probeBMKG(region.code);
        if (wd) return { adm4: region.code, displayName: region.name, weatherData: wd };
        else setLoadStep(`Data BMKG tidak tersedia untuk ${region.code}`);
      } else {
        const errData = await res.json().catch(() => ({}));
        console.warn("Backend resolution failed:", errData.error);
        setLoadStep(`Wilayah tidak ditemukan di database lokal.`);
      }
    } catch (e) {
      console.warn("Backend resolution error:", e);
    }

    // Fallback to OSM/Overpass if backend fails or doesn't find it
    if (nom.place_id) {
      setLoadStep('Memeriksa data wilayah OSM...');
      const tags = await nomDetails(nom.place_id);
      const ref = tags['ref:kemendagri'] || '';
      if (ref.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        const wd = await probeBMKG(ref);
        if (wd) return { adm4: ref, displayName: locDisp, weatherData: wd };
      }
    }

    const lat = nom.lat, lon = nom.lon;
    const els = await overpassRef(lat, lon);
    
    for (const el of els) {
      const ref = el.tags?.['ref:kemendagri'] || '';
      if (!ref) continue;
      if (ref.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        setLoadStep(`Mencoba kode wilayah: ${ref}`);
        const wd = await probeBMKG(ref);
        if (wd) return { adm4: ref, displayName: locDisp, weatherData: wd };
      }
      if (ref.match(/^\d+\.\d+\.\d+$/)) {
        setLoadStep(`Mencoba kecamatan ${el.tags?.name || ''} (${ref})...`);
        for (const sfx of ['1001', '2001', '3001', '1002', '2002', '1003', '0001', '0002', '1004', '2004']) {
          const probe = `${ref}.${sfx}`;
          const wd = await probeBMKG(probe);
          if (wd) return { adm4: probe, displayName: locDisp, weatherData: wd };
        }
      }
    }

    throw new Error(`Kode wilayah BMKG tidak ditemukan untuk lokasi ini.\n\nSilakan gunakan fitur pencarian manual di bawah untuk memilih lokasi terdekat.`);
  };

  const startApp = useCallback(async () => {
    setScreen('loading');
    setLoadTitle('Mendeteksi lokasi...');
    setLoadStep('Meminta izin GPS...');
    setIsRefreshing(true);
    try {
      // Check database status
      const dbStatus = await fetch('/api/db-status').then(r => r.json()).catch(() => ({ count: 0 }));
      if (dbStatus.count === 0) {
        setLoadStep('Menunggu database wilayah siap...');
        // Give it a moment to seed if it's the first run
        await new Promise(r => setTimeout(r, 3000));
      }

      const pos = await new Promise<GeolocationPosition>((ok, fail) => {
        if (!navigator.geolocation) return fail(new Error('GPS tidak didukung'));
        navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 15000, enableHighAccuracy: false, maximumAge: 90000 });
      });
      const { latitude: lat, longitude: lon } = pos.coords;
      
      setLoadTitle('Menentukan wilayah...');
      setLoadStep(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&accept-language=id&zoom=14`,
        { headers: { 'User-Agent': 'CuacaBMKGApp/2.0' } });
      if (!r.ok) throw new Error('Reverse geocode gagal');
      const nom = await r.json();
      
      const res = await resolveADM4(nom);
      handleWeatherData(res.weatherData, res.displayName);
    } catch (err: any) {
      console.error(err);
      let msg = err.message || 'Terjadi kesalahan.';
      if (err.code === 1) msg = 'Izin lokasi ditolak.\nAktifkan GPS di pengaturan browser Anda.';
      else if (err.code === 2) msg = 'Posisi tidak tersedia.\nPastikan GPS aktif.';
      else if (err.code === 3) msg = 'Waktu GPS habis. Coba lagi.';
      setErrorMsg(msg);
      setScreen('error');
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const handleWeatherData = (wd: WeatherData, loc: string) => {
    setWeatherData(wd);
    const bl = (wd.data?.[0]?.lokasi || {}) as { kecamatan?: string; kotkab?: string; provinsi?: string };
    const kec = bl.kecamatan || '';
    const kota = bl.kotkab || '';
    const prov = bl.provinsi || '';
    const label = [kec, kota || prov].filter(Boolean).join(', ') || loc;
    setLocationLabel(label);
    
    const { all, ni } = parseForecasts(wd);
    if (all.length > 0) {
      const cur = all[ni];
      const info = wxInfo(cur.weather, cur.weather_desc);
      setTheme(info.t);
    }
    
    setScreen('weather');
    showToast(`📍 ${label}`);
  };

  const parseForecasts = (data: WeatherData) => {
    let all: Forecast[] = [];
    for (const area of (data.data || [])) {
      for (const day of (area.cuaca || [])) {
        if (Array.isArray(day)) all.push(...day);
        else all.push(day as Forecast);
      }
    }
    all.sort((a, b) => new Date(a.local_datetime || a.utc_datetime).getTime() - new Date(b.local_datetime || b.utc_datetime).getTime());
    const now = Date.now();
    let ni = 0;
    for (let i = 0; i < all.length; i++) {
      if (new Date(all[i].local_datetime || all[i].utc_datetime).getTime() <= now) ni = i;
    }
    return { all, ni };
  };

  const doSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchResults([]);
    try {
      // 1. Search Nominatim for general places
      const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery + ', Indonesia')}&format=json&addressdetails=1&limit=5&accept-language=id`,
        { headers: { 'User-Agent': 'CuacaBMKGApp/2.0' } });
      const nomRes = await r.json();
      
      // 2. Search our backend for specific BMKG regions
      const br = await fetch(`/api/search-region?q=${encodeURIComponent(searchQuery)}`);
      const backRes = await br.json();
      
      // Combine results, marking backend ones
      const combined = [
        ...backRes.map((b: any) => ({ ...b, isBackend: true, display_name: `${b.name}, ${b.district || b.city}, ${b.province}` })),
        ...nomRes
      ];
      
      setSearchResults(combined);
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setIsSearching(false);
    }
  };

  const selectPlace = async (place: any) => {
    setScreen('loading');
    setLoadTitle('Mengambil data cuaca...');
    setLoadStep(place.display_name || place.name);
    setIsRefreshing(true);
    try {
      if (place.isBackend) {
        // Direct selection from our database
        const wd = await probeBMKG(place.code);
        if (!wd) throw new Error('Data cuaca tidak tersedia untuk wilayah ini');
        handleWeatherData(wd, place.name);
      } else {
        // Selection from Nominatim
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${place.lat}&lon=${place.lon}&format=json&addressdetails=1&accept-language=id&zoom=14`,
          { headers: { 'User-Agent': 'CuacaBMKGApp/2.0' } });
        if (!r.ok) throw new Error('Reverse geocode gagal');
        const nom = await r.json();
        const res = await resolveADM4(nom);
        handleWeatherData(res.weatherData, place.display_name.split(',')[0]);
      }
    } catch (e: any) {
      setErrorMsg(e.message);
      setScreen('error');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    startApp();
  }, [startApp]);

  if (screen === 'loading') {
    return (
      <div 
        id="app" 
        className={`${theme} min-h-dvh flex flex-col transition-all duration-1000`}
        style={{
          background: `linear-gradient(175deg, var(--g1, #0c4a6e) 0%, var(--g2, #0ea5e9) 45%, #07111f 100%)`
        }}
      >
        <div className="flex-1 flex flex-col items-center justify-center gap-7 px-8 py-12 text-center">
          <div className="relative w-24 h-24">
            <div className="absolute inset-0 rounded-full border-2 border-white/10 animate-lring"></div>
            <div className="absolute -inset-3.5 rounded-full border-2 border-white/5 animate-lring [animation-delay:0.3s]"></div>
            <div className="absolute -inset-7 rounded-full border-2 border-white/3 animate-lring [animation-delay:0.6s]"></div>
            <div className="absolute inset-0 flex items-center justify-center text-4xl animate-bob">🛰️</div>
          </div>
          <div>
            <div className="text-base font-medium text-white/85">{loadTitle}</div>
            <div className="text-xs text-white/40 mt-1.5 min-h-[18px]">{loadStep}</div>
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'error') {
    return (
      <div 
        id="app" 
        className={`${theme} min-h-dvh flex flex-col transition-all duration-1000`}
        style={{
          background: `linear-gradient(175deg, var(--g1, #0c4a6e) 0%, var(--g2, #0ea5e9) 45%, #07111f 100%)`
        }}
      >
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center gap-3.5">
          <div className="text-5xl">📡</div>
          <div className="text-xl font-semibold">Lokasi Tidak Ditemukan</div>
          <div className="text-sm text-white/55 leading-relaxed max-w-[280px] whitespace-pre-line">{errorMsg}</div>
          <button className="px-8 py-3 bg-sky-500/90 border-none rounded-full text-white text-sm font-semibold cursor-pointer mt-1 shadow-xl shadow-sky-500/35" onClick={startApp}>
            🔄 &nbsp;Coba Lagi
          </button>
          <div className="text-xs text-white/30 mt-1">— atau cari manual —</div>
          <div className="w-full flex gap-2 mt-1">
            <input 
              className="flex-1 px-4 py-3 bg-white/7 border border-white/12 rounded-2xl text-white text-sm outline-none placeholder:text-white/30" 
              placeholder="Nama kecamatan / kota..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button className="px-4 py-3 bg-sky-500/70 border-none rounded-2xl text-white text-lg cursor-pointer" onClick={doSearch}>
              <Search size={20} />
            </button>
          </div>
          <div className="w-full flex flex-col gap-1.5 max-h-[220px] overflow-y-auto no-scrollbar">
            {isSearching && <div className="text-xs text-white/40 p-2">Mencari...</div>}
            {searchResults.map((res: any, idx) => (
              <div 
                key={idx} 
                className="p-3 bg-white/7 border border-white/8 rounded-xl cursor-pointer flex items-center gap-3 active:bg-white/10 transition-colors text-left"
                onClick={() => selectPlace(res)}
              >
                <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-xs shrink-0">
                  {res.isBackend ? '📍' : '🗺️'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/90 font-medium truncate">{res.isBackend ? res.name : res.display_name.split(',')[0]}</div>
                  <div className="text-[10px] text-white/40 truncate mt-0.5">{res.isBackend ? `${res.district || res.city}, ${res.province}` : res.display_name.split(',').slice(1).join(',').trim()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'weather' && weatherData) {
    const { all, ni } = parseForecasts(weatherData);
    
    if (all.length === 0) {
      return (
        <div id="app" className={`${theme} min-h-dvh flex flex-col items-center justify-center p-10 text-center bg-[#07111f]`}>
          <div className="text-xl font-semibold mb-4">Data Cuaca Tidak Tersedia</div>
          <button className="px-6 py-2 bg-sky-500 rounded-full" onClick={startApp}>Coba Lagi</button>
        </div>
      );
    }

    const cur = all[ni];
    const info = wxInfo(cur.weather, cur.weather_desc);
    const bl = (weatherData.data?.[0]?.lokasi || {}) as { kecamatan?: string; kotkab?: string; provinsi?: string };
    const updDate = new Date(cur.local_datetime || cur.utc_datetime);
    const analysisDate = cur.analysis_date ? new Date(cur.analysis_date) : null;

    // Group by day for daily list
    const byDay: Record<string, Forecast[]> = {};
    for (const f of all) {
      const k = (f.local_datetime || f.utc_datetime || '').slice(0, 10);
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(f);
    }
    const dkeys = Object.keys(byDay).slice(0, 4);

    return (
      <div 
        id="app" 
        className={`${theme} min-h-dvh flex flex-col transition-all duration-1000`}
        style={{
          background: `linear-gradient(175deg, var(--g1, #0c4a6e) 0%, var(--g2, #0ea5e9) 45%, #07111f 100%)`
        }}
      >
        <div className="px-5 pt-12 pb-4 flex items-start justify-between fi">
          <div className="flex items-center gap-2 bg-white/10 backdrop-blur-xl border border-white/10 rounded-full px-4 py-2 cursor-pointer max-w-[65vw]" onClick={() => setIsSearchOpen(true)}>
            <MapPin size={14} className="text-white/80" />
            <span className="text-xs font-medium whitespace-nowrap overflow-hidden text-ellipsis">{locationLabel}</span>
          </div>
          <div className="flex gap-2">
            <button className="w-10 h-10 rounded-full bg-white/10 border border-white/10 flex items-center justify-center cursor-pointer text-white" onClick={() => setIsSearchOpen(true)}>
              <Search size={18} />
            </button>
            <button className={`w-10 h-10 rounded-full bg-white/10 border border-white/10 flex items-center justify-center cursor-pointer text-white ${isRefreshing ? 'animate-spin-slow' : ''}`} onClick={startApp}>
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        <div className="px-5 pt-1 pb-7 fi">
          <div className="text-8xl leading-none drop-shadow-2xl animate-float">{info.e}</div>
          <div className="text-8xl font-bold leading-none tracking-tighter mt-1">
            {Math.round(cur.t ?? 0)}<span className="text-4xl font-light align-super tracking-normal">°</span>
          </div>
          <div className="text-lg font-normal text-white/80 mt-2">{cur.weather_desc || info.l}</div>
          <div className="text-xs text-white/40 mt-1">{[bl.kecamatan, bl.kotkab, bl.provinsi].filter(Boolean).join(' · ')}</div>
          <div className="text-[11px] text-white/30 mt-2 pl-0.5">
            Data pukul {updDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} · {updDate.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' })}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 px-4.5 pb-4.5 fi2">
          <div className="bg-white/7 border border-white/7 rounded-2xl p-3.5 text-center">
            <Droplets size={18} className="mx-auto" />
            <div className="text-[10px] text-white/40 uppercase tracking-wider mt-1.5">Lembapan</div>
            <div className="text-base font-semibold mt-1">{cur.hu ?? '--'}%</div>
          </div>
          <div className="bg-white/7 border border-white/7 rounded-2xl p-3.5 text-center">
            <Wind size={18} className="mx-auto" />
            <div className="text-[10px] text-white/40 uppercase tracking-wider mt-1.5">Angin</div>
            <div className="text-base font-semibold mt-1">{cur.ws ?? '--'} km/j</div>
          </div>
          <div className="bg-white/7 border border-white/7 rounded-2xl p-3.5 text-center">
            <Cloud size={18} className="mx-auto" />
            <div className="text-[10px] text-white/40 uppercase tracking-wider mt-1.5">Tutupan</div>
            <div className="text-base font-semibold mt-1">{cur.tcc ?? '--'}%</div>
          </div>
        </div>

        <div className="px-4.5 pb-4.5 fi3">
          <div className="text-[10px] font-semibold text-white/35 uppercase tracking-[1.8px] mb-3">Prakiraan Per 3 Jam</div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
            {all.slice(ni, ni + 9).map((f, i) => {
              const fi = wxInfo(f.weather, f.weather_desc);
              const time = new Date(f.local_datetime || f.utc_datetime);
              return (
                <div key={i} className={`shrink-0 w-16 rounded-2xl p-3 text-center border ${i === 0 ? 'bg-sky-500/20 border-sky-500/40' : 'bg-white/6 border-white/6'}`}>
                  <div className="text-[10px] text-white/45">{i === 0 ? 'Kini' : time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
                  <div className="text-2xl my-1">{fi.e}</div>
                  <div className="text-sm font-semibold">{Math.round(f.t ?? 0)}°</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-4.5 pb-4.5 fi4">
          <div className="text-[10px] font-semibold text-white/35 uppercase tracking-[1.8px] mb-3">3 Hari ke Depan</div>
          <div className="bg-white/5 border border-white/6 rounded-2xl overflow-hidden">
            {dkeys.map((k, i) => {
              const df = byDay[k];
              const temps = df.map(f => f.t || 0);
              const hi = Math.max(...temps), lo = Math.min(...temps);
              const mid = df[Math.floor(df.length / 2)] || df[0];
              const di = wxInfo(mid.weather, mid.weather_desc);
              const dayLabel = i === 0 ? 'Hari Ini' : i === 1 ? 'Besok' : new Date(k).toLocaleDateString('id-ID', { weekday: 'long' });
              return (
                <div key={i} className="flex items-center gap-2.5 px-4 py-3 border-b border-white/5 last:border-none">
                  <div className="shrink-0 w-16 text-sm font-medium">{dayLabel}</div>
                  <div className="text-xl shrink-0">{di.e}</div>
                  <div className="flex-1 text-[11px] text-white/40 leading-tight px-1">{mid.weather_desc || di.l}</div>
                  <div>
                    <span className="text-sm font-semibold">{Math.round(hi)}°</span>
                    <span className="text-xs text-white/35 ml-1.5">{Math.round(lo)}°</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-4.5 pb-4.5 fi5">
          <div className="text-[10px] font-semibold text-white/35 uppercase tracking-[1.8px] mb-3">Detail</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
              <div className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
                <Eye size={12} /> Jarak Pandang
              </div>
              <div className="text-2xl font-bold mt-2 mb-1">{cur.vs_text || '--'}</div>
              <div className="text-[11px] text-white/40">kilometer</div>
            </div>
            <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
              <div className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
                <Compass size={12} /> Arah Angin
              </div>
              <div className="text-3xl font-bold mt-1 mb-1">{warr(cur.wd)}</div>
              <div className="text-[11px] text-white/40">dari {cur.wd || '--'}</div>
            </div>
            <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
              <div className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
                <Info size={12} /> Kondisi (EN)
              </div>
              <div className="text-sm font-medium mt-2 leading-tight">{cur.weather_desc_en || '--'}</div>
              <div className="text-[11px] text-white/40 mt-1">english</div>
            </div>
            <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
              <div className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
                <RefreshCw size={12} /> Update BMKG
              </div>
              <div className="text-sm font-medium mt-2 leading-tight">
                {analysisDate ? analysisDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '--'}
              </div>
              <div className="text-[11px] text-white/40 mt-1">produksi data</div>
            </div>
          </div>
        </div>

        <div className="px-5 pt-1.5 pb-7 text-center text-[10.5px] text-white/20">
          Data cuaca oleh <b className="text-white/35">BMKG</b> · Badan Meteorologi, Klimatologi, dan Geofisika
        </div>

        {toastMsg && (
          <div className="fixed bottom-9 left-1/2 -translate-x-1/2 bg-[#0a1428]/92 border border-white/10 backdrop-blur-2xl rounded-full px-5 py-2 text-[12.5px] text-white/80 z-[999] pointer-events-none whitespace-nowrap animate-in fade-in slide-in-from-bottom-2 duration-300">
            {toastMsg}
          </div>
        )}

        {isSearchOpen && (
          <div className="fixed inset-0 bg-[#07111f]/95 backdrop-blur-xl z-[1000] flex flex-col p-6 animate-in fade-in duration-300">
            <div className="flex items-center justify-between mb-6">
              <div className="text-lg font-semibold">Cari Lokasi</div>
              <button className="text-white/40 text-sm" onClick={() => setIsSearchOpen(false)}>Tutup</button>
            </div>
            <div className="flex gap-2 mb-4">
              <input 
                autoFocus
                className="flex-1 px-4 py-3 bg-white/7 border border-white/12 rounded-2xl text-white text-sm outline-none placeholder:text-white/30" 
                placeholder="Nama kecamatan / kota..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doSearch()}
              />
              <button className="px-4 py-3 bg-sky-500/70 border-none rounded-2xl text-white text-lg cursor-pointer" onClick={doSearch}>
                <Search size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-2">
              {isSearching && <div className="text-xs text-white/40 p-2">Mencari...</div>}
              {searchResults.length === 0 && !isSearching && searchQuery && (
                <div className="text-center py-10 text-white/30 text-sm">Tidak ada hasil.</div>
              )}
              {searchResults.map((res: any, idx) => (
                <div 
                  key={idx} 
                  className="p-4 bg-white/5 border border-white/8 rounded-2xl cursor-pointer flex items-center gap-4 active:bg-white/10 transition-colors"
                  onClick={() => {
                    selectPlace(res);
                    setIsSearchOpen(false);
                  }}
                >
                  <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-sm shrink-0">
                    {res.isBackend ? '📍' : '🗺️'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white/90 font-medium truncate">{res.isBackend ? res.name : res.display_name.split(',')[0]}</div>
                    <div className="text-[11px] text-white/40 truncate mt-0.5">{res.isBackend ? `${res.district || res.city}, ${res.province}` : res.display_name.split(',').slice(1).join(',').trim()}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-white/5 flex items-center gap-2 text-[10px] text-white/20">
              <MapPin size={10} /> Gunakan GPS untuk lokasi saat ini
              <button className="ml-auto text-sky-400/60 font-medium" onClick={() => { startApp(); setIsSearchOpen(false); }}>Deteksi Otomatis</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div id="app" className={`${theme} min-h-dvh flex flex-col items-center justify-center p-10 text-center bg-[#07111f]`}>
      <div className="text-xl font-semibold mb-4">Memuat Aplikasi...</div>
      <div className="text-sm text-white/40">Jika layar tetap kosong, silakan segarkan halaman.</div>
    </div>
  );
}
