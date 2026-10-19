import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TOMTOM_KEY = process.env.TOMTOM_KEY || "ISI_KEY_TOMTOM";
const TOMTOM_URL = "https://api.tomtom.com";

const sukses = (res, data) => res.json({ success: true, data });
const gagal = (res, code, msg) => res.status(code).json({ success: false, error: msg });

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// 1. TRAFFIC
app.get("/api/traffic", async (req, res) => {
  try {
    const area = req.query.area;
    if (!area) return gagal(res, 400, "Nama daerah wajib diisi");

    const geo = await axios.get(`${TOMTOM_URL}/search/2/geocode/${encodeURIComponent(area)}.json`, { params: { key: TOMTOM_KEY, limit: 1, countrySet: "ID" } });
    const pos = geo.data?.results?.[0]?.position;
    if (!pos) return gagal(res, 404, "Daerah tidak ditemukan");

    const d = 0.08; const bbox = `${pos.lon - d},${pos.lat - d},${pos.lon + d},${pos.lat + d}`;
    const inc = await axios.get(`${TOMTOM_URL}/traffic/services/5/incidentDetails`, { params: { key: TOMTOM_KEY, bbox, language: "id-ID", timeValidityFilter: "present", fields: "{incidents{geometry{coordinates},properties{iconCategory,magnitudeOfDelay,events{description},from,to,delay,length,roadNumbers}}}" } });

    const incidents = (inc.data?.incidents || []).map(i => {
      const coords = i.geometry?.coordinates?.[0] || [pos.lon, pos.lat];
      const mag = i.properties?.magnitudeOfDelay || 0;
      return { 
        deskripsi: i.properties?.events?.[0]?.description || "Gangguan", 
        penyebab: i.properties?.iconCategory === 1 ? "Kecelakaan" : (i.properties?.iconCategory === 6 ? "Macet" : (i.properties?.iconCategory === 9 ? "Banjir" : "Perbaikan/Gangguan")),
        keparahan: mag >= 3 ? "Parah" : (mag === 2 ? "Sedang" : "Ringan"),
        delayMenit: Math.round((i.properties?.delay || 0) / 60),
        jalan: i.properties?.roadNumbers?.join(", ") || "Area Lokasi",
        dari: i.properties?.from || "-", ke: i.properties?.to || "-",
        lat: coords[1], lon: coords[0]
      };
    });
    sukses(res, { status: incidents.length === 0 ? "LANCAR" : "MACET", insiden: incidents.slice(0, 12) });
  } catch (e) { gagal(res, 500, "Gagal cek macet"); }
});

// 2. ROUTE
app.get("/api/route", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return gagal(res, 400, "Asal & tujuan wajib diisi");
    
    const geo = async (q) => (await axios.get(`${TOMTOM_URL}/search/2/geocode/${encodeURIComponent(q)}.json`, { params: { key: TOMTOM_KEY, limit: 1, countrySet: "ID" } })).data?.results?.[0]?.position;
    const p1 = await geo(from), p2 = await geo(to);
    if (!p1 || !p2) return gagal(res, 404, "Lokasi tidak ditemukan");
    
    const route = await axios.get(`${TOMTOM_URL}/routing/1/calculateRoute/${p1.lat},${p1.lon}:${p2.lat},${p2.lon}/json`, { params: { key: TOMTOM_KEY, traffic: true, travelMode: "car", routeType: "fastest", instructionsType: "text", language: "id-ID" } });
    const r = route.data?.routes?.[0];
    const s = r.summary; const delay = Math.round((s.trafficDelayInSeconds || 0) / 60);
    const langkah = (r.guidance?.instructions || []).slice(0, 6).map(step => `${step.message}`);

    sukses(res, { 
      jarakKm: +(s.lengthInMeters / 1000).toFixed(1), 
      estimasiMenit: Math.round(s.travelTimeInSeconds / 60), 
      delayMenit: delay, 
      macet: delay >= 5, 
      saran: delay >= 5 ? "Ada kemacetan parah. Disarankan mencari jalan alternatif." : "Lalu lintas lancar.", 
      langkah 
    });
  } catch (e) { gagal(res, 500, "Gagal hitung rute"); }
});

// 3. JADWAL SOLAT
app.get("/api/prayer", async (req, res) => {
  try {
    const r = await axios.get("https://api.aladhan.com/v1/timingsByCity", { params: { city: req.query.city, country: "Indonesia", method: 20 } });
    sukses(res, { 
      kota: req.query.city, 
      tanggal: r.data.data.date.readable, 
      hijriah: `${r.data.data.date.hijri.day} ${r.data.data.date.hijri.month.en} ${r.data.data.date.hijri.year} H`, 
      jadwal: { Subuh: r.data.data.timings.Fajr, Dzuhur: r.data.data.timings.Dhuhr, Ashar: r.data.data.timings.Asr, Maghrib: r.data.data.timings.Maghrib, Isya: r.data.data.timings.Isha } 
    });
  } catch (e) { gagal(res, 500, "Gagal ambil jadwal"); }
});

// 4. GEMPA
app.get("/api/gempa", async (req, res) => {
  try {
    const r = await axios.get("https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json");
    const g = r.data.Infogempa.gempa;
    sukses(res, { waktu: `${g.Tanggal} - ${g.Jam}`, magnitudo: g.Magnitude, lokasi: g.Wilayah, kedalaman: g.Kedalaman, potensi: g.Potensi, dirasakan: g.Dirasakan || "Tidak dilaporkan" });
  } catch (e) { gagal(res, 500, "Gagal ambil gempa"); }
});

// 5. CUACA
app.get("/api/cuaca", async (req, res) => {
  try {
    const geo = await axios.get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(req.query.city)}&count=1&language=id`);
    if (!geo.data.results) return gagal(res, 404, "Kota tidak ditemukan");
    const { latitude, longitude, name, admin1 } = geo.data.results[0];
    const w = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
    
    const weatherCodes = { 0: "Cerah", 1: "Cerah Berawan", 2: "Berawan", 3: "Mendung", 45: "Berkabut", 51: "Gerimis", 61: "Hujan Ringan", 63: "Hujan Sedang", 65: "Hujan Lebat", 80: "Hujan Lokal", 95: "Badai Petir" };
    sukses(res, { kota: name, provinsi: admin1 || "Indonesia", suhu: w.data.current_weather.temperature, angin: w.data.current_weather.windspeed, kondisi: weatherCodes[w.data.current_weather.weathercode] || "Tidak Diketahui" });
  } catch (e) { gagal(res, 500, "Gagal ambil cuaca"); }
});

// 6. KURS
app.get("/api/kurs", async (req, res) => {
  try {
    const r = await axios.get("https://open.er-api.com/v6/latest/USD");
    const idr = r.data.rates.IDR; const format = (val) => (idr / val).toFixed(0);
    sukses(res, { usd: idr.toLocaleString('id-ID'), sgd: format(r.data.rates.SGD), myr: format(r.data.rates.MYR), eur: format(r.data.rates.EUR), jpy: format(r.data.rates.JPY), update: r.data.time_last_update_utc });
  } catch (e) { gagal(res, 500, "Gagal ambil kurs"); }
});

// 7. CEK USERNAME
app.get("/api/username", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return gagal(res, 400, "Username wajib diisi");
    
    const platforms = [
      { name: "GitHub", url: `https://github.com/${username}` },
      { name: "Instagram", url: `https://www.instagram.com/${username}/` },
      { name: "TikTok", url: `https://www.tiktok.com/@${username}` },
      { name: "Twitter (X)", url: `https://twitter.com/${username}` },
      { name: "Reddit", url: `https://www.reddit.com/user/${username}` },
      { name: "Pinterest", url: `https://www.pinterest.com/${username}/` }
    ];

    const results = await Promise.all(platforms.map(async (p) => {
      try {
        const r = await axios.get(p.url, { validateStatus: () => true, timeout: 5000 });
        return { platform: p.name, found: r.status === 200, url: p.url };
      } catch { return { platform: p.name, found: false, url: p.url }; }
    }));

    sukses(res, { username, results });
  } catch (e) { gagal(res, 500, "Gagal cek username"); }
});

// 8. URL SCANNER
app.get("/api/urlscan", async (req, res) => {
  try {
    let url = req.query.url;
    if (!url.startsWith("http")) url = "https://" + url;
    const start = Date.now();
    const r = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    const time = Date.now() - start;
    sukses(res, { status: r.status, time, server: r.headers['server'] || "Unknown", csp: r.headers['content-security-policy'] ? "Aktif" : "Tidak Aktif" });
  } catch (e) { gagal(res, 500, "Website mati atau tidak bisa diakses"); }
});

// 9. SYNC USER
app.post("/api/user/sync", async (req, res) => {
  try {
    const { email, name, avatar } = req.body;
    if (supabase) await supabase.from("users").upsert({ email, name, avatar, last_login: new Date().toISOString() }, { onConflict: "email" });
    sukses(res, { saved: true });
  } catch (e) { gagal(res, 500, "Gagal simpan user"); }
});

app.listen(PORT, () => console.log(`Oracle Backend Nyala di Port ${PORT}`));