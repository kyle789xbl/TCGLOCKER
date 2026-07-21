import fs from "node:fs";
import path from "node:path";

const CATEGORY_URL = "https://magicmadhouse.co.uk/pokemon";
const PAGE_LIMIT = 200;
const MAX_PAGES = 80;
const PAGE_DELAY_MS = 5200;
const RETRY_DELAYS_MS = [15000, 45000];
const SALE_MARKUP_RATE = 0.2;
const OUTPUT_PREFIX = `magicmadhouse-pokemon-refresh-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const fromRawArgIndex = process.argv.indexOf("--from-raw");
const FROM_RAW_PATH = fromRawArgIndex >= 0 ? process.argv[fromRawArgIndex + 1] : "";
const REQUEST_HEADERS = {
  "accept": "text/html,application/xhtml+xml",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function csv(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sql(value) {
  if (value == null) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function salePricePence(priceGbp) {
  return Math.ceil(Math.round(Number(priceGbp || 0) * 100) * (1 + SALE_MARKUP_RATE));
}

function salePriceGbp(priceGbp) {
  return (salePricePence(priceGbp) / 100).toFixed(2);
}

function htmlEntityDecode(text) {
  return String(text || "")
    .replace(/&pound;/g, "£")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function imageUrl(product) {
  const source = product?.image?.data || product?.images?.[0]?.data || "";
  return source.replace("{:size}", "500x659");
}

function customField(product, name) {
  return product?.custom_fields?.find((field) => field.name === name)?.value || "";
}

function categories(product) {
  return Array.isArray(product.category) ? product.category.join(" > ") : "";
}

function textFor(product) {
  return [
    product.name,
    customField(product, "Products"),
    customField(product, "Pokémon Set"),
    categories(product)
  ].filter(Boolean).join(" ").toLowerCase();
}

function isSingle(product) {
  const text = textFor(product);
  return /single|reverse holo|holofoil|non-holo|code card|common|uncommon|rare|ultra rare|secret rare|illustration rare|full art|half art|promo card|energy card|\b\d{1,4}\s*\/\s*\d{1,4}\b/.test(text);
}

function mapType(product) {
  const text = textFor(product);
  if (/code card|online code/.test(text)) return "code_card";
  if (isSingle(product)) return "single";
  if (/\bcase\b/.test(text)) return "case";
  if (/\btin\b|mini tin|collector chest/.test(text)) return "tin";
  if (/bundle|build\s*&\s*battle|build and battle|prerelease pack|battle pack/.test(text)) return "bundle";
  if (/booster pack|sleeved booster|blister pack|blisters|checklane blister|triple blister|single blister/.test(text)) return "booster";
  if (/elite trainer box|\betb\b/.test(text)) return "etb";
  if (/booster box|collection box|box set|battle academy|ultra premium collection|premium collection|ex box|v box|vmax box/.test(text)) return "box";
  if (/deck/.test(text)) return "deck";
  if (/\bplaymat\b|\bplay mat\b|\bsleeves?\b|\bdeck box\b|\bbinder\b|\balbum\b|\bportfolio\b|\bcard holder\b|\bfolder\b|\bstorage\b|\bdice\b|\bmarker\b|\bmat\b/.test(text)) return "accessory";
  if (/\bfunko\b|\bpop!\b|\bfigure\b|\bfigurine\b|\breplica\b|\bplush\b|\btoy\b|\beraser\b|\bmug\b|\bkeyring\b|\bpin badge\b/.test(text)) return "merch";
  return "other";
}

function setName(product) {
  const explicit = customField(product, "Pokémon Set");
  if (explicit) return explicit;
  const setCategory = (product.category || []).find((entry) => entry.includes("Pokémon Sets/"));
  if (setCategory) return setCategory.split("/").filter(Boolean).pop() || "Pokemon";
  const sealedCategory = (product.category || []).find((entry) => entry.includes("Sealed Product/"));
  return sealedCategory ? sealedCategory.split("/").filter(Boolean).pop() || "Pokemon" : "Pokemon";
}

function parseBodl(html, page) {
  const match = html.match(/var\s+BODL\s*=\s*JSON\.parse\("([\s\S]*?)"\);/);
  if (!match) throw new Error(`page ${page}: BODL payload missing`);
  const decoded = JSON.parse(`"${match[1]}"`);
  const bodl = JSON.parse(decoded);
  if (!Array.isArray(bodl.categoryProducts)) {
    throw new Error(`page ${page}: categoryProducts missing`);
  }
  return bodl.categoryProducts;
}

async function fetchPage(page) {
  const url = `${CATEGORY_URL}?limit=${PAGE_LIMIT}&page=${page}`;
  const attempts = [0, ...RETRY_DELAYS_MS];
  let lastError;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    if (attempts[attempt] > 0) await sleep(attempts[attempt]);
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS });
      const html = await response.text();
      if (!response.ok) {
        throw new Error(`page ${page}: HTTP ${response.status}`);
      }
      if (/captcha|access denied|too many requests|rate limit/i.test(html)) {
        throw new Error(`page ${page}: possible throttle/block page`);
      }
      return parseBodl(html, page);
    } catch (error) {
      lastError = error;
      console.warn(`retry ${attempt + 1}/${attempts.length} failed: ${error.message}`);
    }
  }

  throw lastError;
}

function toRawRow(product) {
  const hasStockLevel = product.stock_level !== null && product.stock_level !== undefined && product.stock_level !== "";
  const stockLevel = hasStockLevel && Number.isFinite(Number(product.stock_level)) ? Number(product.stock_level) : null;
  const price = product?.price?.with_tax?.value ?? product?.price?.without_tax?.value ?? null;
  return {
    product_id: product.id,
    sku: product.sku || "",
    name: htmlEntityDecode(product.name || ""),
    price_gbp: price,
    price_display: product?.price?.with_tax?.formatted || product?.price?.without_tax?.formatted || "",
    stock_level: stockLevel,
    stock_status: stockLevel == null ? "not_disclosed_or_not_tracked" : stockLevel > 0 ? "in_stock" : "out_of_stock",
    show_cart_action: Boolean(product.show_cart_action),
    availability: product.availability || "",
    pokemon_set: customField(product, "Pokémon Set"),
    product_type: customField(product, "Products"),
    language: customField(product, "Language"),
    url: product.url || "",
    image_url: imageUrl(product),
    date_added: product.date_added || "",
    categories: categories(product)
  };
}

function stockForImport(row) {
  if (row.stock_level !== null && row.stock_level !== undefined && row.stock_level !== "") {
    const supplierStock = Number(row.stock_level);
    if (!Number.isFinite(supplierStock) || supplierStock <= 1) return null;
    return {
      stockTotal: Math.max(0, supplierStock - 1),
      supplierStock,
      stockSource: "exact"
    };
  }

  if (row.show_cart_action) {
    return {
      stockTotal: 1,
      supplierStock: null,
      stockSource: "addable_undisclosed"
    };
  }

  return null;
}

function importableRow(row, index) {
  const product = {
    name: row.name,
    custom_fields: [
      { name: "Products", value: row.product_type },
      { name: "Pokémon Set", value: row.pokemon_set }
    ],
    category: row.categories ? row.categories.split(" > ") : []
  };
  const type = mapType(product);
  const stock = stockForImport(row);
  if (!type || !stock || stock.stockTotal <= 0 || row.price_gbp == null) return null;

  return {
    index,
    id: `mm-${row.product_id}`,
    name: row.name,
    set_name: setName(product),
    product_type: type,
    stock_total: stock.stockTotal,
    supplier_price_pence: Math.round(Number(row.price_gbp || 0) * 100),
    price_gbp: salePriceGbp(row.price_gbp),
    image_url: row.image_url,
    is_active: true,
    supplier_product_id: row.product_id,
    supplier_sku: row.sku,
    source_url: row.url,
    supplier_stock_level: stock.supplierStock,
    stock_source: stock.stockSource,
    show_cart_action: row.show_cart_action,
    price_pence: salePricePence(row.price_gbp),
    supplier_status: row.stock_status
  };
}

async function main() {
  const seen = new Set();
  const rawRows = FROM_RAW_PATH ? JSON.parse(fs.readFileSync(FROM_RAW_PATH, "utf8")) : [];
  const pageStats = [];
  let aborted = false;

  for (let page = 1; !FROM_RAW_PATH && page <= MAX_PAGES; page += 1) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const products = await fetchPage(page);
    let newRows = 0;

    for (const product of products) {
      if (!product?.id || seen.has(product.id)) continue;
      seen.add(product.id);
      rawRows.push(toRawRow(product));
      newRows += 1;
    }

    const numeric = products.filter((product) => (
      product.stock_level !== null &&
      product.stock_level !== undefined &&
      product.stock_level !== "" &&
      Number.isFinite(Number(product.stock_level))
    )).length;
    pageStats.push({ page, products: products.length, newRows, numericStockRows: numeric });
    console.log(`page ${page}: ${products.length} products, ${newRows} new, ${numeric} numeric stock rows, total ${rawRows.length}`);

    if (products.length === 0 || products.length < PAGE_LIMIT) break;
    if (newRows === 0) {
      aborted = true;
      console.warn(`stopping at page ${page}: no new products, likely catalogue cap/repeated page`);
      break;
    }
  }

  const importRows = rawRows.map((row, index) => importableRow(row, index + 1)).filter(Boolean);
  importRows.forEach((row, index) => { row.index = index + 1; });
  const unmappedPositiveRows = rawRows.filter((row) => {
    const product = {
      name: row.name,
      custom_fields: [
        { name: "Products", value: row.product_type },
        { name: "Pokémon Set", value: row.pokemon_set }
      ],
      category: row.categories ? row.categories.split(" > ") : []
    };
    return false;
  });
  const undisclosedAddableRows = rawRows.filter((row) => row.stock_level == null && row.show_cart_action);

  const rawHeaders = ["product_id", "sku", "name", "price_gbp", "price_display", "stock_level", "stock_status", "show_cart_action", "availability", "pokemon_set", "product_type", "language", "url", "image_url", "date_added", "categories"];
  const importHeaders = ["index", "id", "name", "set_name", "product_type", "stock_total", "price_gbp", "image_url", "is_active"];
  const reviewHeaders = ["product_id", "sku", "name", "price_gbp", "stock_level", "show_cart_action", "pokemon_set", "product_type", "url", "image_url", "categories"];

  const rawCsv = [rawHeaders.join(","), ...rawRows.map((row) => rawHeaders.map((header) => csv(row[header])).join(","))].join("\r\n");
  const importCsv = [importHeaders.join(","), ...importRows.map((row) => importHeaders.map((header) => csv(row[header])).join(","))].join("\r\n");
  const reviewCsv = [reviewHeaders.join(","), ...unmappedPositiveRows.map((row) => reviewHeaders.map((header) => csv(row[header])).join(","))].join("\r\n");
  const undisclosedCsv = [reviewHeaders.join(","), ...undisclosedAddableRows.map((row) => reviewHeaders.map((header) => csv(row[header])).join(","))].join("\r\n");

  fs.writeFileSync(`${OUTPUT_PREFIX}-raw.csv`, rawCsv, "utf8");
  fs.writeFileSync(`${OUTPUT_PREFIX}-raw.json`, JSON.stringify(rawRows, null, 2), "utf8");
  fs.writeFileSync(`${OUTPUT_PREFIX}-import-buffered.csv`, importCsv, "utf8");
  fs.writeFileSync(`${OUTPUT_PREFIX}-unmapped-positive.csv`, reviewCsv, "utf8");
  fs.writeFileSync(`${OUTPUT_PREFIX}-undisclosed-addable.csv`, undisclosedCsv, "utf8");

  const productValues = importRows.map((row) => `(${sql(row.id)}, ${sql(row.name)}, ${sql(row.set_name)}, ${sql(row.product_type)}, ${row.stock_total}, ${sql(String(row.stock_total))}, ${row.price_pence}, ${sql(row.image_url)}, true)`).join(",\n");
  const supplierValues = importRows.map((row) => `(${sql(row.id)}, 'magicmadhouse', ${sql(row.supplier_product_id)}, ${sql(row.supplier_sku)}, ${sql(row.source_url)}, ${row.supplier_stock_level == null ? "null" : row.supplier_stock_level}, ${row.supplier_price_pence}, ${sql(row.supplier_status)}, now(), now() + interval '1 hour', ${sql(row.stock_source)}, ${row.show_cart_action ? "true" : "false"})`).join(",\n");
  const sqlText = `begin;\n\ndelete from public.store_basket_items;\ndelete from public.store_supplier_products;\ndelete from public.store_products;\n\ninsert into public.store_products (id, name, set_name, product_type, stock_total, stock_label, price_pence, image_url, is_active)\nvalues\n${productValues}\non conflict (id) do update\n   set name = excluded.name,\n       set_name = excluded.set_name,\n       product_type = excluded.product_type,\n       stock_total = excluded.stock_total,\n       stock_label = excluded.stock_label,\n       price_pence = excluded.price_pence,\n       image_url = excluded.image_url,\n       is_active = excluded.is_active,\n       updated_at = now();\n\ninsert into public.store_supplier_products (product_id, supplier, supplier_product_id, supplier_sku, source_url, last_stock_level, last_price_pence, last_status, checked_at, next_check_after, stock_source, last_show_cart_action)\nvalues\n${supplierValues}\non conflict (product_id) do update\n   set supplier = excluded.supplier,\n       supplier_product_id = excluded.supplier_product_id,\n       supplier_sku = excluded.supplier_sku,\n       source_url = excluded.source_url,\n       last_stock_level = excluded.last_stock_level,\n       last_price_pence = excluded.last_price_pence,\n       last_status = excluded.last_status,\n       checked_at = excluded.checked_at,\n       next_check_after = excluded.next_check_after,\n       stock_source = excluded.stock_source,\n       last_show_cart_action = excluded.last_show_cart_action,\n       updated_at = now();\n\ncommit;\n`;
  fs.writeFileSync(`${OUTPUT_PREFIX}-apply.sql`, sqlText, "utf8");

  const summary = {
    source: CATEGORY_URL,
    aborted,
    pageStats,
    rawProducts: rawRows.length,
    numericPositiveStockRows: rawRows.filter((row) => Number(row.stock_level) > 0).length,
    numericStockAboveSafetyBufferRows: rawRows.filter((row) => Number(row.stock_level) > 1).length,
    addableUndisclosedRows: undisclosedAddableRows.length,
    importRows: importRows.length,
    totalBufferedUnits: importRows.reduce((total, row) => total + row.stock_total, 0),
    importRowsByStockSource: importRows.reduce((totals, row) => {
      totals[row.stock_source] = (totals[row.stock_source] || 0) + 1;
      return totals;
    }, {}),
    importRowsByType: importRows.reduce((totals, row) => {
      totals[row.product_type] = (totals[row.product_type] || 0) + 1;
      return totals;
    }, {}),
    unmappedPositiveRows: unmappedPositiveRows.length,
    undisclosedAddableRows: undisclosedAddableRows.length,
    outputPrefix: path.resolve(OUTPUT_PREFIX)
  };
  fs.writeFileSync(`${OUTPUT_PREFIX}-summary.json`, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
