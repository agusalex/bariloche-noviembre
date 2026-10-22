#!/usr/bin/env node
// Search Kayak for round trips and print the cheapest ones that match.

import { parseArgs } from "node:util";
import { chromium } from "playwright";

const HELP = `Search round-trip flights and print the cheapest matches.

  node search.mjs --from BUE --to BRC \\
    --min-depart-date 2026-11-01 --max-depart-date 2026-11-09 \\
    --min-return-date 2026-11-12 --max-return-date 2026-11-21 \\
    --min-days 7 --max-days 12 \\
    --min-depart-hour 8 --max-depart-hour 23 \\
    --min-return-hour 8 --max-return-hour 23

Dates are YYYY-MM-DD. Days are nights between the two departures, inclusive.
Hours are 0-23 or HH:MM, in the local time shown by the airline.
A bare max hour includes that whole hour (17 means through 17:59).

  --from, --to              City or airport code. Default BUE and BRC.
  --min-days, --max-days    Stay length in nights.
  --min-depart-date, --max-depart-date
  --min-return-date, --max-return-date
  --min-depart-hour, --max-depart-hour
  --min-return-hour, --max-return-hour
  --top N                   How many results to print. Default 10.
  --max-pairs N             Safety cap on date pairs. Default 80.
  --one-per-pair            Keep only the cheapest match of each date pair.
  --headed                  Show the browser.
  --json                    Print JSON instead of a table.
`;

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "BUE" },
    to: { type: "string", default: "BRC" },
    "min-days": { type: "string" },
    "max-days": { type: "string" },
    "min-depart-hour": { type: "string" },
    "max-depart-hour": { type: "string" },
    "min-return-hour": { type: "string" },
    "max-return-hour": { type: "string" },
    "min-depart-date": { type: "string" },
    "max-depart-date": { type: "string" },
    "min-return-date": { type: "string" },
    "max-return-date": { type: "string" },
    top: { type: "string", default: "10" },
    "max-pairs": { type: "string", default: "80" },
    "one-per-pair": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseDate(value, flag) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${flag} must be YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(`${flag} is not a real date: ${value}`);
  }
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function nightsBetween(depart, ret) {
  return Math.round((ret - depart) / 86400000);
}

function parseClock(value, flag, endOfHour) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) fail(`${flag} must be an hour (8) or a time (8:30)`);
  const hour = Number(match[1]);
  const minute = match[2] != null ? Number(match[2]) : endOfHour ? 59 : 0;
  if (hour > 23 || minute > 59) fail(`${flag} is out of range: ${value}`);
  return hour * 60 + minute;
}

function integerFlag(value, flag, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) fail(`${flag} must be a whole number`);
  return number;
}

function minutesOf(iso) {
  const match = String(iso).match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function inRange(minutes, min, max) {
  if (minutes == null) return false;
  if (min != null && minutes < min) return false;
  if (max != null && minutes > max) return false;
  return true;
}

function clockLabel(minutes) {
  if (minutes == null) return "any";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const from = values.from.trim().toUpperCase();
const to = values.to.trim().toUpperCase();
if (!/^[A-Z]{3,4}$/.test(from) || !/^[A-Z]{3,4}$/.test(to)) {
  fail("--from and --to must be airport or city codes, like BUE or AEP");
}

const minDays = integerFlag(values["min-days"], "--min-days", 0);
const maxDays = integerFlag(values["max-days"], "--max-days", 366);
const top = integerFlag(values.top, "--top", 10);
const maxPairs = integerFlag(values["max-pairs"], "--max-pairs", 80);
if (minDays > maxDays) fail("--min-days cannot be greater than --max-days");

const departHour = {
  min: parseClock(values["min-depart-hour"], "--min-depart-hour", false),
  max: parseClock(values["max-depart-hour"], "--max-depart-hour", true),
};
const returnHour = {
  min: parseClock(values["min-return-hour"], "--min-return-hour", false),
  max: parseClock(values["max-return-hour"], "--max-return-hour", true),
};
if (departHour.min != null && departHour.max != null && departHour.min > departHour.max) {
  fail("--min-depart-hour cannot be later than --max-depart-hour");
}
if (returnHour.min != null && returnHour.max != null && returnHour.min > returnHour.max) {
  fail("--min-return-hour cannot be later than --max-return-hour");
}

if (!values["min-depart-date"] || !values["max-depart-date"] || !values["min-return-date"] || !values["max-return-date"]) {
  fail("Pass --min-depart-date, --max-depart-date, --min-return-date and --max-return-date.\n\n" + HELP);
}

const minDepart = parseDate(values["min-depart-date"], "--min-depart-date");
const maxDepart = parseDate(values["max-depart-date"], "--max-depart-date");
const minReturn = parseDate(values["min-return-date"], "--min-return-date");
const maxReturn = parseDate(values["max-return-date"], "--max-return-date");
if (minDepart > maxDepart) fail("--min-depart-date cannot be after --max-depart-date");
if (minReturn > maxReturn) fail("--min-return-date cannot be after --max-return-date");

const pairs = [];
for (let depart = minDepart; depart <= maxDepart; depart = addDays(depart, 1)) {
  for (let ret = minReturn; ret <= maxReturn; ret = addDays(ret, 1)) {
    const nights = nightsBetween(depart, ret);
    if (nights < minDays || nights > maxDays) continue;
    pairs.push({ depart: formatDate(depart), ret: formatDate(ret), nights });
  }
}

if (pairs.length === 0) fail("No date pairs match those days and dates.");
if (pairs.length > maxPairs) {
  fail(`${pairs.length} date pairs match. Narrow the dates, or pass --max-pairs ${pairs.length}.`);
}

function legView(data, legId) {
  const leg = data.legs?.[legId];
  if (!leg) return null;
  const segments = (leg.segments || []).map((segment) => data.segments?.[segment.id]).filter(Boolean);
  const first = segments[0];
  const last = segments[segments.length - 1] || first;
  const airlines = [...new Set(segments.map((segment) => data.airlines?.[segment.airline]?.name || segment.airline).filter(Boolean))];
  const flights = segments.map((segment) => `${segment.airline}${segment.flightNumber}`).filter(Boolean);
  return {
    from: first?.origin || null,
    to: last?.destination || null,
    depart: leg.departure,
    arrive: leg.arrival,
    airlines,
    flights,
    stops: Math.max(0, segments.length - 1),
  };
}

function offersFromPoll(data, pair, searchUrl) {
  const cores = (data.results || []).filter((result) => result.type === "core");
  const offers = [];
  for (const core of cores) {
    const options = [...(core.bookingOptions || [])].filter((option) => option.displayPrice?.price > 0);
    options.sort((a, b) => a.displayPrice.price - b.displayPrice.price);
    const option = options[0];
    if (!option) continue;
    const legs = (option.legFarings || []).map((faring) => legView(data, faring.legId)).filter(Boolean);
    if (legs.length < 2) continue;
    const [outbound, inbound] = legs;
    if (!inRange(minutesOf(outbound.depart), departHour.min, departHour.max)) continue;
    if (!inRange(minutesOf(inbound.depart), returnHour.min, returnHour.max)) continue;
    offers.push({
      price: option.displayPrice.price,
      currency: option.displayPrice.currency || "ARS",
      priceLabel: option.displayPrice.localizedPrice || String(option.displayPrice.price),
      seller: data.providers?.[option.providerCode]?.displayName || option.providerCode,
      departDate: pair.depart,
      returnDate: pair.ret,
      nights: pair.nights,
      outbound,
      inbound,
      url: searchUrl,
    });
  }
  offers.sort((a, b) => a.price - b.price);
  const seen = new Set();
  return offers.filter((offer) => {
    const key = [offer.outbound.depart, offer.outbound.flights.join("+"), offer.inbound.depart, offer.inbound.flights.join("+")].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchUrl(depart, ret) {
  return `https://www.kayak.com.ar/flights/${from}-${to}/${depart}/${ret}?sort=price_a`;
}

async function launchBrowser() {
  const options = {
    headless: !values.headed,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch {
    console.error("Google Chrome was not found. Falling back to Playwright's Chromium, which Kayak often blocks.");
    return chromium.launch(options);
  }
}

async function readPair(page, pair) {
  const url = searchUrl(pair.depart, pair.ret);
  let best = null;
  const onResponse = async (response) => {
    if (!response.url().includes("/i/api/search/dynamic/flights/poll")) return;
    let json;
    try {
      json = await response.json();
    } catch {
      return;
    }
    const cores = (json.results || []).filter((result) => result.type === "core").length;
    if (!best || json.status === "complete" || cores > best.cores) {
      best = { json, cores, status: json.status };
    }
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const started = Date.now();
    while (Date.now() - started < 25000) {
      if (best?.status === "complete" && best.cores > 0) {
        await page.waitForTimeout(600);
        break;
      }
      await page.waitForTimeout(400);
    }
    const title = await page.title();
    if (/bot/i.test(title)) {
      fail("Kayak blocked the browser. Rerun with --headed and complete the check if one appears.");
    }
    if (!best?.json) return [];
    return offersFromPoll(best.json, pair, url);
  } finally {
    page.off("response", onResponse);
  }
}

function timeLabel(iso) {
  return String(iso).slice(11, 16);
}

function legLine(label, leg) {
  const stops = leg.stops === 0 ? "direct" : `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`;
  return `${label}  ${timeLabel(leg.depart)} ${leg.from} → ${timeLabel(leg.arrive)} ${leg.to}  ${leg.flights.join(" / ")}  ${leg.airlines.join(" + ")}  ${stops}`;
}

function printTable(matches) {
  if (matches.length === 0) {
    console.log("No flights matched.");
    return;
  }
  matches.forEach((offer, index) => {
    console.log(`${index + 1}. ${offer.priceLabel}  ${offer.nights} nights  ${offer.seller}`);
    console.log(`   ${offer.departDate}  ${legLine("out ", offer.outbound)}`);
    console.log(`   ${offer.returnDate}  ${legLine("back", offer.inbound)}`);
    console.log(`   ${offer.url}`);
  });
}

const browser = await launchBrowser();
const page = await browser.newPage({
  locale: "es-AR",
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
await page.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

console.error(
  `${from} → ${to}  ${pairs.length} date pair${pairs.length === 1 ? "" : "s"}  ` +
    `depart ${clockLabel(departHour.min)}–${clockLabel(departHour.max)}  ` +
    `return ${clockLabel(returnHour.min)}–${clockLabel(returnHour.max)}`,
);

const found = [];
try {
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    console.error(`[${index + 1}/${pairs.length}] ${pair.depart} → ${pair.ret}`);
    const offers = await readPair(page, pair);
    found.push(...(values["one-per-pair"] ? offers.slice(0, 1) : offers));
    if (index < pairs.length - 1) await page.waitForTimeout(800);
  }
} finally {
  await browser.close();
}

found.sort((a, b) => a.price - b.price);
const matches = found.slice(0, top);

if (values.json) {
  console.log(JSON.stringify(matches, null, 2));
} else {
  printTable(matches);
}

if (matches.length === 0) process.exit(1);
