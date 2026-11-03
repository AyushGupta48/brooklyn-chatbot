// Backend for the Brooklyn Donuts chatbot demo.
// Runs as a Netlify Function at /api/chat. The browser never sees the API key.
//
// Flow: browser sends the conversation -> we add instructions + tools -> Gemini replies.
// If Gemini asks to use a tool (e.g. "find nearest store"), we run that tool here in
// normal code, send the result back, and let Gemini write the final answer.

import stores from "../../data/stores.json" with { type: "json" };
import menu from "../../data/menu.json" with { type: "json" };

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const API_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const MAX_MESSAGES = 20;        // only send the last N messages (keeps cost/quota down)
const MAX_MESSAGE_CHARS = 1000; // ignore huge pasted messages
const MAX_TOOL_ROUNDS = 4;      // safety stop so a confused model can't loop forever

// ---------- Instructions (the "system prompt") ----------
const SYSTEM_PROMPT = `You are Brooklyn Bot, the friendly assistant for Brooklyn Donuts in Australia.

What you can help with:
- Finding the nearest store (use the find_nearest_stores tool)
- Store phone numbers, addresses and opening hours (use find_nearest_stores or list_stores)
- Menu questions and prices (use get_menu). Drinks have sizes (Small, Regular, Large) and add-ons (milk, syrups, extra shot, cream); get_menu lists them with prices.
- Building an order (use update_order). This is a DEMO: orders are not really sent to a store.

Rules:
- Only state store details, prices and menu items that come from your tools. Never invent a phone number, price, address or item.
- If a value says "TODO", say that detail isn't available yet and suggest calling or visiting the store.
- Allergens, dietary or medical questions: do not guess. Tell the customer to ask staff in store.
- Ordering drinks: ask for the size if the customer didn't say one, and ask for any required choice (e.g. coffee type, chocolate type, tea type). Milk defaults to Full Cream if not mentioned. Only offer sizes and add-ons that get_menu lists for that drink.
- After update_order, if it returns any "problems" before the customer has confirmed, ask about them. Use the prices update_order returns; never add up prices yourself.
- Before confirming an order, read back the items, quantities, store and total, and ask the customer to confirm.
- When the customer confirms (e.g. "yes", "confirm", "place it"), call update_order with confirmed=true and the same items again. This is a demo and confirmation always succeeds: if no store was chosen, the code uses the customer's nearest store automatically. Never tell the customer there was a problem confirming.
- After a confirmed order, reply with a short, upbeat confirmation that includes the order number, store and ready time from the tool result, and mention it's a demo so nothing was actually sent.
- Opening hours: every store from your tools includes "open_now" and "today" (worked out by code from the real clock). Always use those to say whether a store is open or when it closes. Never work out the day or time yourself.
- For a different day ("tomorrow", "on Sunday"), read that day from the store's "hours" field, using the current date below to know which day it is.
- Mention that hours can change on public holidays if the customer asks about one.
- Keep replies short and friendly (2-4 sentences), Australian English, prices in AUD.
- If asked about something unrelated to Brooklyn Donuts, politely steer back.`;

// The AI has no clock, so every request we tell it the current Sydney date and time.
function buildSystemPrompt(now) {
  return `${SYSTEM_PROMPT}

Current date and time (Sydney, where all stores are): ${now.label}.`;
}

// ---------- Opening hours (plain code, no AI) ----------
const TZ = "Australia/Sydney";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Current day (0 = Monday) and minutes since midnight, in Sydney time.
function sydneyNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const day = DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3));
  const minutes = (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
  const label = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
  return { day, minutes, label };
}

// "7:30am" -> 450 (minutes since midnight)
function toMinutes(t) {
  const m = t.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3] === "pm") h += 12;
  return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

// 1260 -> "9:00pm"
function fmt(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

// "Mon-Wed 8:00am-6:00pm; Thu 8:00am-9:00pm" -> [ {open, close} for Mon ... Sun ]
// Handles ranges that wrap round the week, like "Fri-Wed".
function parseHours(text) {
  const week = Array(7).fill(null);
  for (const seg of String(text || "").split(";")) {
    const m = seg.trim().match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(.+?)\s*-\s*(.+)$/i);
    if (!m) continue;
    const from = DAYS.indexOf(m[1].toLowerCase());
    const to = m[2] ? DAYS.indexOf(m[2].toLowerCase()) : from;
    const open = toMinutes(m[3]), close = toMinutes(m[4]);
    if (from < 0 || to < 0 || open == null || close == null) continue;
    for (let d = from; ; d = (d + 1) % 7) {
      week[d] = { open, close };
      if (d === to) break;
    }
  }
  return week;
}

// Is the store open right now, and what are today's hours?
function storeStatus(store, now) {
  const week = parseHours(store.hours);
  if (week.every((d) => !d)) return { open_now: "unknown", today: "Hours not available, please call the store" };
  const today = week[now.day];
  if (today && now.minutes >= today.open && now.minutes < today.close) {
    return { open_now: true, today: `Open today ${fmt(today.open)} to ${fmt(today.close)}`, closes_at: fmt(today.close) };
  }
  if (today && now.minutes < today.open) {
    return { open_now: false, today: `Closed now. Opens today at ${fmt(today.open)} (until ${fmt(today.close)})` };
  }
  for (let i = 1; i <= 7; i++) {
    const d = (now.day + i) % 7;
    if (week[d]) {
      const when = i === 1 ? "tomorrow" : DAY_NAMES[d];
      return { open_now: false, today: `Closed now. Opens ${when} at ${fmt(week[d].open)}` };
    }
  }
  return { open_now: false, today: "Closed" };
}

// ---------- Tools the AI can ask us to run ----------
const TOOL_DECLARATIONS = [
  {
    name: "find_nearest_stores",
    description:
      "Find the closest Brooklyn Donuts stores to the customer. Uses the customer's shared location if available. Returns stores with address, phone, hours and distance.",
    parameters: {
      type: "object",
      properties: {
        suburb: {
          type: "string",
          description: "Suburb or area the customer mentioned, if they didn't share their location",
        },
      },
    },
  },
  {
    name: "list_stores",
    description: "List every Brooklyn Donuts store with address, phone and hours.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_menu",
    description: "Get the full menu: every item with its id, category and price (or size prices), plus the add-on option groups each drink allows and what each add-on costs.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "update_order",
    description:
      "Set the customer's current order (replaces the whole cart). Use item ids from get_menu. For drinks with sizes, give the size. Put every add-on or choice (e.g. 'Latte', 'Oat Milk', 'Caramel', 'Extra Shot') in choices, using the exact names from get_menu. Code works out the prices. Set confirmed=true only after the customer explicitly confirms. When confirming you can resend the items, or send an empty items list to confirm the current cart.",
    parameters: {
      type: "object",
      properties: {
        store_id: { type: "string", description: "Store id for pickup" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item_id: { type: "string" },
              quantity: { type: "integer" },
              size: { type: "string", description: "Small, Regular or Large (drinks with sizes only)" },
              choices: { type: "array", items: { type: "string" }, description: "Chosen options by name, e.g. Latte, Oat Milk, Caramel" },
            },
            required: ["item_id", "quantity"],
          },
        },
        confirmed: { type: "boolean" },
      },
    },
  },
];

// Distance between two lat/lng points in km (Haversine formula). Plain maths, no AI.
function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// What the AI sees for a store: details + live open/closed status (no raw coordinates).
function publicStore(s, now, extra = {}) {
  const { lat, lng, ...rest } = s;
  return { ...rest, ...storeStatus(s, now), ...extra };
}

// ---------- Pricing an item with its size and add-ons (plain code, no AI) ----------
const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// req = { item_id, size?, choices?: ["Latte", "Oat Milk", ...] }
// Returns { item, label, unit, problems } or { error }.
// Find a menu item by id or by name (forgiving about spelling/case).
function findItem(ref) {
  const n = norm(ref);
  return menu.items.find((m) => m.id === ref) || menu.items.find((m) => norm(m.id) === n || norm(m.name) === n)
    || menu.items.find((m) => n && (norm(m.name).includes(n) || n.includes(norm(m.name))));
}

// Find a store by id or name ("chatswood", "Brooklyn Donuts Chatswood", ...).
function findStore(ref) {
  const n = norm(ref).replace(/^brooklyndonuts/, "");
  if (!n) return null;
  return stores.find((s) => s.id === ref) || stores.find((s) => norm(s.id) === n || norm(s.name).replace(/^brooklyndonuts/, "") === n)
    || stores.find((s) => norm(s.name).includes(n));
}

function nearestStore(location) {
  if (!location) return null;
  return stores.map((s) => ({ s, d: distanceKm(location, s) })).sort((a, b) => a.d - b.d)[0].s;
}

// Demo order number like BD-4821 and a ready time ~10 minutes from now (Sydney time).
function demoOrderDetails() {
  const number = "BD-" + String(Math.floor(1000 + Math.random() * 9000));
  const ready = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(Date.now() + 10 * 60 * 1000));
  return { order_number: number, ready_in: "about 10 minutes", ready_at: ready };
}

// lenient=true (used when confirming): fill in a sensible default instead of failing,
// e.g. Regular size and the first option for a required choice.
function priceItem(req, lenient = false) {
  const item = findItem(req.item_id);
  if (!item) return { error: `Unknown item id "${req.item_id}"` };
  const problems = [];
  let unit;
  let sizeName = "";

  if (item.sizes) {
    sizeName = Object.keys(item.sizes).find((k) => norm(k) === norm(req.size));
    if (!sizeName) {
      const keys = Object.keys(item.sizes);
      if (!lenient) problems.push(`Which size for the ${item.name}? Options: ${keys.join(", ")}`);
      sizeName = lenient && keys.includes("Regular") ? "Regular" : keys[0];
    }
    unit = item.sizes[sizeName];
  } else {
    unit = item.price;
  }

  const allowed = (item.options || []).map((g) => [g, menu.option_groups[g]]);
  const picked = {}; // group key -> [choice names]
  for (const want of req.choices || []) {
    let found = null;
    for (const [key, group] of allowed) {
      const c = group.choices.find((c) => norm(c.name) === norm(want));
      if (c) { found = { key, group, c }; break; }
    }
    if (!found) { if (!lenient) problems.push(`"${want}" isn't an option for the ${item.name}`); continue; }
    (picked[found.key] ||= []).push(found.c.name);
    unit += found.c.price;
  }

  for (const [key, group] of allowed) {
    const got = picked[key] || [];
    if (group.pick === "one" && got.length > 1) {
      if (!lenient) problems.push(`Only one ${group.label.toLowerCase()} can be chosen for the ${item.name}`);
      else { // keep the first choice only, and remove the extra cost
        for (const extra of got.slice(1)) unit -= group.choices.find((c) => c.name === extra).price;
        picked[key] = got.slice(0, 1);
      }
    }
    if (group.required && got.length === 0) {
      if (!lenient) problems.push(`Ask which ${group.label.toLowerCase()} for the ${item.name}: ${group.choices.map((c) => c.name).join(", ")}`);
      else picked[key] = [group.choices[0].name];
    }
  }

  // e.g. "Large Coffee (Latte, Oat Milk, Caramel)"
  const extras = Object.values(picked).flat();
  const label = `${sizeName ? sizeName + " " : ""}${item.name}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  return { item, label, unit: +unit.toFixed(2), problems };
}

// Runs a tool and returns { result, cart? }. `ctx` holds things like the user's location.
function runTool(name, args, ctx) {
  switch (name) {
    case "find_nearest_stores": {
      if (ctx.location) {
        const ranked = stores
          .map((s) => ({ s, d: distanceKm(ctx.location, s) }))
          .sort((x, y) => x.d - y.d)
          .slice(0, 3)
          .map(({ s, d }) => publicStore(s, ctx.now, { distance_km: Math.round(d * 10) / 10 }));
        return { result: { based_on: "customer's shared location", stores: ranked } };
      }
      const q = (args.suburb || "").toLowerCase().trim();
      const matches = q
        ? stores.filter((s) => `${s.name} ${s.address}`.toLowerCase().includes(q))
        : [];
      return {
        result: {
          based_on: q ? `suburb text "${args.suburb}"` : "no location given",
          stores: (matches.length ? matches : stores).map((s) => publicStore(s, ctx.now)),
          tip: matches.length
            ? undefined
            : "No exact match. Suggest the customer taps 'Share my location' for accurate results, or pick from all stores.",
        },
      };
    }

    case "list_stores":
      return { result: { stores: stores.map((s) => publicStore(s, ctx.now)) } };

    case "get_menu":
      return { result: menu };

    case "update_order": {
      const confirming = Boolean(args.confirmed);
      let requested = Array.isArray(args.items) ? args.items : [];
      // Confirming with no items = confirm the cart the customer already has (sent back by the browser).
      if (!requested.length && ctx.cart?.lines?.length) requested = ctx.cart.lines.map((l) => l.request).filter(Boolean);

      const lines = [];
      const problems = [];
      for (const req of requested) {
        const qty = Math.max(0, Math.min(50, parseInt(req.quantity, 10) || 0));
        const priced = priceItem(req, confirming);
        if (priced.error) { if (!confirming) problems.push(priced.error); continue; }
        problems.push(...priced.problems);
        if (qty > 0)
          lines.push({
            id: priced.item.id, name: priced.label, quantity: qty, unit_price: priced.unit,
            line_total: +(priced.unit * qty).toFixed(2),
            request: { item_id: priced.item.id, quantity: qty, size: req.size, choices: req.choices || [] },
          });
      }

      // Store: the one asked for, else the one already on the cart, else the nearest, else Chatswood (demo default).
      let store = findStore(args.store_id) || findStore(ctx.cart?.store_id);
      if (!store && confirming) store = nearestStore(ctx.location) || stores.find((s) => s.id === "chatswood") || stores[0];
      if (args.store_id && !findStore(args.store_id) && !confirming) problems.push(`Unknown store "${args.store_id}"`);

      const total = +lines.reduce((sum, l) => sum + l.line_total, 0).toFixed(2);
      const confirmed = confirming && lines.length > 0;
      const cart = {
        store: store ? store.name : null,
        store_id: store ? store.id : null,
        lines,
        total,
        confirmed,
        demo: true,
        ...(confirmed ? demoOrderDetails() : {}),
      };
      if (confirming && !lines.length) problems.push("The cart is empty, ask what they'd like to order.");
      return { result: { cart, problems: confirmed ? [] : problems }, cart };
    }

    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}

async function callGemini(contents, systemPrompt) {
  const res = await fetch(API_URL(MODEL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!process.env.GEMINI_API_KEY)
    return json({ error: "Server is missing GEMINI_API_KEY. See README step 4." }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Browser sends: { messages: [{role: "user"|"model", text: "..."}], location?: {lat, lng} }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  const contents = messages
    .filter((m) => typeof m?.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.role === "model" ? "model" : "user",
      parts: [{ text: m.text.slice(0, MAX_MESSAGE_CHARS) }],
    }));
  if (!contents.length || contents.at(-1).role !== "user")
    return json({ error: "Last message must be from the user" }, 400);

  const loc = body.location;
  const ctx = {
    location:
      loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
        ? { lat: loc.lat, lng: loc.lng }
        : null,
    now: sydneyNow(), // fresh clock reading for every message
    cart: body.cart && Array.isArray(body.cart.lines) ? body.cart : null, // current cart from the browser
  };
  const systemPrompt = buildSystemPrompt(ctx.now);

  let cart;
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const data = await callGemini(contents, systemPrompt);
      const content = data?.candidates?.[0]?.content;
      const parts = content?.parts || [];
      const calls = parts.filter((p) => p.functionCall);

      if (!calls.length) {
        const text = parts.map((p) => p.text || "").join("").trim();
        return json({ reply: text || "Sorry, I didn't catch that. Could you rephrase?", cart });
      }
      if (round === MAX_TOOL_ROUNDS) break;

      // Send the model's turn back exactly as received (Gemini 3 needs its "thought signatures").
      contents.push(content);
      const responses = calls.map(({ functionCall }) => {
        const out = runTool(functionCall.name, functionCall.args || {}, ctx);
        if (out.cart) cart = out.cart;
        return { functionResponse: { name: functionCall.name, response: out.result } };
      });
      contents.push({ role: "user", parts: responses });
    }
    return json({ reply: "Sorry, I got a bit tangled up there. Could you try again?", cart });
  } catch (err) {
    console.error("Gemini error:", err.message);
    const friendly =
      err.status === 429
        ? "I'm getting a lot of questions right now (free-tier limit). Try again in a minute."
        : "Something went wrong talking to the AI. Check the function logs.";
    return json({ error: friendly, detail: err.message }, 502);
  }
};

export const config = { path: "/api/chat" };

// Exported for the local test script only.
export { runTool, distanceKm, sydneyNow, parseHours, storeStatus, priceItem, findItem, findStore };