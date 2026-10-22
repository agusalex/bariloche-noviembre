#!/usr/bin/env node
// Search Kayak for airport car rentals and print the cheapest of each date pair.

import { parseArgs } from "node:util";
import { chromium } from "playwright";

const HELP = `Search airport car rentals and print the cheapest match of each date pair.

  node cars.mjs --location BRC --pair 2026-11-03/2026-11-12 --pair 2026-11-08/2026-11-16

  --location CODE     Airport code. Default BRC.
  --pair YYYY-MM-DD/YYYY-MM-DD   Repeatable pickup/dropoff dates.
  --headed            Show the browser.
  --json              Print JSON instead of a table.
`;

const { values } = parseArgs({
  options: {
    location: { type: "string", default: "BRC" },
    pair: { type: "string", multiple: true },
    headed: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const location = values.location.trim().toUpperCase();
if (!/^[A-Z]{3}$/.test(location)) fail("--location must be a 3-letter airport code");

const pairs = (values.pair || []).map((raw) => {
  const match = String(raw).match(/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  if (!match) fail(`--pair must be YYYY-MM-DD/YYYY-MM-DD, got ${raw}`);
  return { pickup: match[1], dropoff: match[2] };
});
if (pairs.length === 0) fail("Pass at least one --pair YYYY-MM-DD/YYYY-MM-DD.\n\n" + HELP);

function searchUrl(pair) {
  return `https://www.kayak.com.ar/cars/${location}/${pair.pickup}/${pair.dropoff}?sort=price_a`;
}

function summarize(data, pair, url) {
  const cars = (data.combinedResults || []).filter((row) => row.carType && row.price?.price > 0);
  const offers = cars.map((row) => {
    const provider = row.providers?.[0] || {};
    const vehicle = provider.vehicleDetail || {};
    const agency = data.agencyMap?.[row.agencyCode];
    const loc = data.carLocationMap?.[provider.pickupLocationId];
    return {
      price: row.price.price,
      currency: row.price.currency || "ARS",
      priceLabel: row.price.localizedPrice || String(row.price.price),
      dayPrice: provider.dayPrice?.localizedPrice || row.providers?.[0]?.totalPrice?.localizedPrice || null,
      car: vehicle.brand || row.carType,
      class: vehicle.localizedCarClassName || row.carType,
      automatic: Boolean(vehicle.isAutomatic),
      seats: vehicle.adultCount || null,
      agency: agency?.name || row.agencyCode,
      seller: data.providerMap?.[provider.code]?.displayName || provider.code,
      airport: Boolean(loc?.isAirport),
      pickup: pair.pickup,
      dropoff: pair.dropoff,
      nights: data.nights ?? null,
      url,
    };
  });
  offers.sort((a, b) => a.price - b.price);
  const cheapest = offers[0] || null;
  const automatic = offers.find((offer) => offer.automatic) || null;
  return { cheapest, automatic, count: offers.length };
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
  const url = searchUrl(pair);
  let best = null;
  const onResponse = async (response) => {
    if (!response.url().includes("/i/api/search/v1/cars/poll")) return;
    let json;
    try {
      json = await response.json();
    } catch {
      return;
    }
    const cars = (json.combinedResults || []).filter((row) => row.carType && row.price?.price > 0).length;
    if (!best || json.status === "complete" || cars > best.cars) {
      best = { json, cars, status: json.status };
    }
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const started = Date.now();
    while (Date.now() - started < 25000) {
      if (best?.status === "complete" && best.cars > 0) {
        await page.waitForTimeout(600);
        break;
      }
      await page.waitForTimeout(400);
    }
    const title = await page.title();
    if (/bot/i.test(title)) fail("Kayak blocked the browser. Rerun with --headed.");
    if (!best?.json) return { cheapest: null, automatic: null, count: 0, pickup: pair.pickup, dropoff: pair.dropoff, url };
    return { ...summarize(best.json, pair, url), pickup: pair.pickup, dropoff: pair.dropoff, url };
  } finally {
    page.off("response", onResponse);
  }
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

console.error(`${location}  ${pairs.length} date pair${pairs.length === 1 ? "" : "s"}`);
const found = [];
try {
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    console.error(`[${index + 1}/${pairs.length}] ${pair.pickup} → ${pair.dropoff}`);
    found.push(await readPair(page, pair));
    if (index < pairs.length - 1) await page.waitForTimeout(800);
  }
} finally {
  await browser.close();
}

if (values.json) {
  console.log(JSON.stringify(found, null, 2));
} else {
  for (const row of found) {
    const car = row.cheapest;
    if (!car) {
      console.log(`${row.pickup} → ${row.dropoff}  no cars`);
      continue;
    }
    const auto = row.automatic && row.automatic.price !== car.price
      ? `  | auto ${row.automatic.priceLabel} ${row.automatic.car}`
      : "";
    console.log(
      `${row.pickup} → ${row.dropoff}  ${car.priceLabel}  ${car.car}  ${car.automatic ? "auto" : "manual"}  ${car.agency} via ${car.seller}${auto}`,
    );
    console.log(`  ${row.url}`);
  }
}

if (found.every((row) => !row.cheapest)) process.exit(1);
