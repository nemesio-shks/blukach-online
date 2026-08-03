// ==========================================================================
//  Galaxy Map — единая база данных (Render free web service).
//
//  • Хранит ОДНО состояние карты (data) — общая БД для всех.
//  • Игроки (GitHub Pages) читают:  GET  /state
//  • Редактор пишет (нужен пароль):  POST /state  + Authorization: Bearer <TOKEN>
//  • Проверка пароля редактора:      POST /login  { password }
//
//  Хранилище: Upstash Redis (REST). Если не настроен — держим в памяти
//  (переживёт до перезапуска; на free Render этого достаточно для теста).
//
//  ENV (задать в Render → Environment):
//    EDITOR_PASSWORD        — пароль полного редактора (правит всё)
//    OPS_PASSWORD           — пароль ограниченного редактора (правит ТОЛЬКО
//                             операторов экипажа — ship.operators/crewStatus)
//    UPSTASH_REDIS_REST_URL — из Upstash (Redis → REST API)
//    UPSTASH_REDIS_REST_TOKEN
//    ALLOW_ORIGIN           — необязательно; по умолчанию "*"
// ==========================================================================

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3778;
const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || "changeme";
const OPS_PASSWORD = process.env.OPS_PASSWORD || "";   // пусто = роль отключена
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const U_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const U_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_KEY = "galaxy:state";

// токен-сессия редактора (выдаётся на /login, живёт в памяти процесса)
// значение — роль: "full" (всё) | "ops" (только операторы экипажа)
const editorTokens = new Map();

// --------------------------------------------------------------------------
//  Хранилище
// --------------------------------------------------------------------------
let memState = null; // резерв в памяти

async function redis(cmd) {
  // cmd — массив, напр. ["GET","galaxy:state"]
  const r = await fetch(U_URL + "/" + cmd.map(encodeURIComponent).join("/"), {
    headers: { Authorization: "Bearer " + U_TOKEN },
  });
  if (!r.ok) throw new Error("upstash " + r.status);
  return (await r.json()).result;
}
async function redisSet(key, val) {
  const r = await fetch(U_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + U_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(["SET", key, val]),
  });
  if (!r.ok) throw new Error("upstash set " + r.status);
  return (await r.json()).result;
}

async function loadState() {
  if (U_URL && U_TOKEN) {
    try {
      const raw = await redis(["GET", REDIS_KEY]);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.error("Redis GET fail:", e.message); }
  }
  if (memState) return memState;
  // сид: начальный сейв из deploy/galaxy-data.json (если есть рядом)
  try {
    const seed = fs.readFileSync(path.join(__dirname, "seed.json"), "utf8");
    return JSON.parse(seed);
  } catch { return null; }
}

async function saveState(data) {
  memState = data;
  if (U_URL && U_TOKEN) {
    try { await redisSet(REDIS_KEY, JSON.stringify(data)); }
    catch (e) { console.error("Redis SET fail:", e.message); }
  }
}

// --------------------------------------------------------------------------
//  HTTP
// --------------------------------------------------------------------------
function cors(res, extra) {
  res.writeHead(extra?.code || 200, {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    ...(extra?.headers || {}),
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 12e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function tokenRole(req) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  return t ? (editorTokens.get(t) || null) : null;
}

// ограниченная роль "ops" может менять ТОЛЬКО ship.operators/crewStatus.
// ⚠ РАНЬШЕ это проверялось строгим сравнением «всё остальное совпадает с prev»
// и при малейшей гонке (пока ops-клиент правил операторов, где-то на сервере успело
// измениться что-то ещё — обычный тик игры/другой редактор) запись блокировалась 403,
// клиент терял токен и editOps() «ломался» (падал в read-only) — тот самый баг.
// Теперь вместо сравнения — просто МЕРЖИМ: берём свежий prev из БД «как есть» и
// накладываем поверх него только operators/crewStatus из присланных данных.
// Гонка становится невозможной в принципе — ops физически не может задеть ничего,
// кроме этих двух полей, независимо от того, что успело поменяться параллельно.
function mergeOpsOnly(prev, next) {
  const base = JSON.parse(JSON.stringify(prev || next || {}));
  if (!base.ship) base.ship = {};
  const src = (next && next.ship) || {};
  base.ship.operators = src.operators;
  base.ship.crewStatus = src.crewStatus;
  return base;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res, { code: 204 }); return res.end(); }

  try {
    // здоровье
    if (req.method === "GET" && req.url === "/ping") {
      cors(res); return res.end(JSON.stringify({ ok: true, store: (U_URL ? "redis" : "memory") }));
    }

    // чтение состояния (всем)
    if (req.method === "GET" && (req.url === "/state" || req.url.startsWith("/state?"))) {
      const data = await loadState();
      cors(res);
      return res.end(JSON.stringify({ data, ts: Date.now() }));
    }

    // логин редактора → выдаём временный токен + роль ("full" полный / "ops" только операторы)
    if (req.method === "POST" && req.url === "/login") {
      const body = await readBody(req);
      const pass = String(body.password || "");
      let role = null;
      if (pass === EDITOR_PASSWORD) role = "full";
      else if (OPS_PASSWORD && pass === OPS_PASSWORD) role = "ops";
      if (role) {
        const token = crypto.randomBytes(24).toString("hex");
        editorTokens.set(token, role);
        cors(res);
        return res.end(JSON.stringify({ ok: true, token, role }));
      }
      cors(res, { code: 401 });
      return res.end(JSON.stringify({ ok: false, error: "bad password" }));
    }

    // запись состояния (редактор full — всё; редактор ops — только операторы экипажа)
    if (req.method === "POST" && req.url === "/state") {
      const role = tokenRole(req);
      if (!role) { cors(res, { code: 403 }); return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
      const body = await readBody(req);
      if (!body || !body.data) { cors(res, { code: 400 }); return res.end(JSON.stringify({ ok: false, error: "no data" })); }
      let toSave = body.data;
      if (role === "ops") {
        const prev = await loadState();
        toSave = mergeOpsOnly(prev, body.data);
      }
      await saveState(toSave);
      cors(res);
      return res.end(JSON.stringify({ ok: true }));
    }

    cors(res, { code: 404 });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    cors(res, { code: 500 });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Galaxy DB server on :${PORT}  store=${U_URL ? "redis" : "memory"}`);
});
