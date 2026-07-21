const SUPABASE_URL = "https://vfyipmvaejrnhrqckgvn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fKWNwL1s1WWp1TnufoCCng_F9Bz9pot";
const PRODUCT_IMAGE_BUCKET = "store-product-images";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const panelMode = document.body.dataset.panel;
const authCard = document.querySelector("#authCard");
const appShell = document.querySelector("#appShell");
const loginForm = document.querySelector("#loginForm");
const signOutButton = document.querySelector("#signOutButton");
const statusEl = document.querySelector("#status");

let products = [];
let orders = [];
let issues = [];
let movements = [];
let procurements = [];
let profitRules = { settings: null, bands: [] };
let deleteMode = false;
const selectedDeleteProductIds = new Set();
const completeOrderConfirmTimers = new Map();
const cancelOrderConfirmStages = new Map();
const COMPLETE_ORDER_CONFIRM_SECONDS = 3;
const COMPLETE_ORDER_CONFIRM_READY_MS = 6000;
const CANCEL_ORDER_CONFIRM_LABELS = ["ARE YOU SURE?", "REALLY?", "SUBMIT REFUND"];
const PROCUREMENT_FUNCTION = "search-ebay-procurement";
let currentProcurementOrderId = "";
let currentProcurementPayload = null;
const shipmentFilters = {
  status: "active",
  query: ""
};

const STOCK_CSV_COLUMNS = [
  "index",
  "id",
  "name",
  "set_name",
  "product_type",
  "stock_total",
  "price_gbp",
  "image_url",
  "is_active"
];

const CSV_GRID_SIZE_STORAGE_KEY = "card-vault-stock-csv-grid-size";
const DEFAULT_CSV_COLUMN_WIDTHS = {
  index: 72,
  id: 190,
  name: 360,
  set_name: 220,
  product_type: 150,
  stock_total: 130,
  price_gbp: 130,
  image_url: 460,
  is_active: 130
};

const csvColumnWidths = { ...DEFAULT_CSV_COLUMN_WIDTHS };
let csvRowHeights = {};
let csvDefaultRowHeight = 44;

function loadCsvGridSizePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(CSV_GRID_SIZE_STORAGE_KEY) || "{}");
    for (const column of STOCK_CSV_COLUMNS) {
      const width = Number(saved.columns?.[column]);
      if (Number.isFinite(width)) csvColumnWidths[column] = Math.max(72, width);
    }

    if (saved.rows && typeof saved.rows === "object") {
      csvRowHeights = Object.fromEntries(
        Object.entries(saved.rows)
          .map(([row, height]) => [row, Math.max(36, Number(height) || 0)])
          .filter(([, height]) => height >= 36)
      );
    }

    const defaultHeight = Number(saved.defaultRowHeight);
    if (Number.isFinite(defaultHeight)) csvDefaultRowHeight = Math.max(36, defaultHeight);
  } catch (error) {
    csvRowHeights = {};
  }
}

function saveCsvGridSizePreferences() {
  try {
    localStorage.setItem(CSV_GRID_SIZE_STORAGE_KEY, JSON.stringify({
      columns: csvColumnWidths,
      rows: csvRowHeights,
      defaultRowHeight: csvDefaultRowHeight
    }));
  } catch (error) {
    // Local sizing is a convenience, so failure should not block CSV editing.
  }
}

function csvColumnTemplate() {
  return STOCK_CSV_COLUMNS
    .map((column) => `${Math.max(csvColumnWidths[column] || DEFAULT_CSV_COLUMN_WIDTHS[column] || 140, 72)}px`)
    .join(" ");
}

function applyCsvColumnWidths(grid = document.querySelector("#stockCsvGrid")) {
  grid?.style.setProperty("--csv-columns", csvColumnTemplate());
}

loadCsvGridSizePreferences();

function moneyFromPence(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(value) || 0) / 100);
}

function gbpInputFromPence(value) {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function penceFromGbpInput(value) {
  const parsed = Number(String(value || "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100));
}

function percentInputFromBasisPoints(value) {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function basisPointsFromPercentInput(value) {
  const parsed = Number(String(value || "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100));
}

function setStatus(message = "", isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function formValue(form, name) {
  return String(new FormData(form).get(name) || "").trim();
}

function autoStockLabel(stockTotal) {
  const amount = Math.max(0, Math.floor(Number(stockTotal) || 0));
  if (amount >= 500) return "500+";
  if (amount >= 300) return "300+";
  if (amount >= 100) return "100+";
  return String(amount);
}

function hasManualStockLabel(product) {
  const label = String(product?.stock_label || "").trim();
  if (!label) return false;
  const total = Number(product?.stock_total || 0);
  return label !== String(total) && label !== autoStockLabel(total);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stockCsvRows() {
  return products.map((product, index) => ({
    index: index + 1,
    id: product.id,
    name: product.name,
    set_name: product.set_name || "",
    product_type: product.product_type || "booster",
    stock_total: product.stock_total ?? 0,
    price_gbp: ((Number(product.price_pence) || 0) / 100).toFixed(2),
    image_url: product.image_url || "",
    is_active: product.is_active ? "TRUE" : "FALSE"
  }));
}

function stockCsvTextFromRows(rows) {
  return [
    STOCK_CSV_COLUMNS.join(","),
    ...rows.map((row) => STOCK_CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","))
  ].join("\r\n");
}

function stockCsvText() {
  return stockCsvTextFromRows(stockCsvRows());
}

function csvObjectsFromText(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((row, rowIndex) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, String(row[index] || "").trim()]));
    return Object.fromEntries(STOCK_CSV_COLUMNS.map((column) => [
      column,
      column === "index" ? record[column] || rowIndex + 1 : record[column] || ""
    ]));
  });
}

function renderStockCsvGrid(rows = stockCsvRows()) {
  const grid = document.querySelector("#stockCsvGrid");
  if (!grid) return;
  applyCsvColumnWidths(grid);
  grid.style.setProperty("--csv-row-height", `${csvDefaultRowHeight}px`);

  grid.innerHTML = `
    <thead>
      <tr>
        <th class="csv-row-control"></th>
        ${STOCK_CSV_COLUMNS.map((column) => `
          <th data-csv-resize-column="${escapeHtml(column)}">
            <span>${escapeHtml(column)}</span>
            <button class="csv-col-resize" type="button" aria-label="Resize ${escapeHtml(column)} column" data-csv-resize-handle="${escapeHtml(column)}"></button>
          </th>
        `).join("")}
      </tr>
    </thead>
    <tbody>
      ${rows.map((row, rowIndex) => `
        <tr data-csv-row="${rowIndex}" style="height: ${Math.max(Number(csvRowHeights[rowIndex]) || csvDefaultRowHeight, 36)}px">
          <td class="csv-row-control">
            <span>${rowIndex + 1}</span>
            <button class="csv-row-resize" type="button" aria-label="Resize row ${rowIndex + 1}" data-csv-row-resize="${rowIndex}"></button>
          </td>
          ${STOCK_CSV_COLUMNS.map((column) => `
            <td>
              ${column === "index"
                ? `<input data-csv-column="${escapeHtml(column)}" value="${escapeHtml(row[column])}" readonly />`
                : `<textarea data-csv-column="${escapeHtml(column)}" spellcheck="false">${escapeHtml(row[column])}</textarea>`}
            </td>
          `).join("")}
        </tr>
      `).join("")}
    </tbody>
  `;
}

function readStockCsvGridRows() {
  const grid = document.querySelector("#stockCsvGrid");
  if (!grid) return stockCsvRows();

  return Array.from(grid.querySelectorAll("tbody tr")).map((row, rowIndex) => {
    const record = {};
    for (const column of STOCK_CSV_COLUMNS) {
      const input = row.querySelector(`[data-csv-column="${column}"]`);
      record[column] = column === "index" ? rowIndex + 1 : input?.value.trim() || "";
    }
    return record;
  });
}

function startCsvColumnResize(event, column) {
  const startX = event.clientX;
  const startWidth = csvColumnWidths[column] || DEFAULT_CSV_COLUMN_WIDTHS[column] || 140;
  document.body.classList.add("resizing-csv", "resizing-csv-column");

  const onMove = (moveEvent) => {
    csvColumnWidths[column] = Math.max(72, startWidth + moveEvent.clientX - startX);
    applyCsvColumnWidths();
  };

  const onUp = () => {
    document.body.classList.remove("resizing-csv", "resizing-csv-column");
    saveCsvGridSizePreferences();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function startCsvRowResize(event, rowIndex) {
  const rowKey = String(rowIndex);
  const row = document.querySelector(`#stockCsvGrid tbody tr[data-csv-row="${rowIndex}"]`);
  if (!row) return;

  const startY = event.clientY;
  const startHeight = row.getBoundingClientRect().height;
  document.body.classList.add("resizing-csv", "resizing-csv-row");

  const onMove = (moveEvent) => {
    const nextHeight = Math.max(36, startHeight + moveEvent.clientY - startY);
    csvRowHeights[rowKey] = nextHeight;
    row.style.height = `${nextHeight}px`;
  };

  const onUp = () => {
    document.body.classList.remove("resizing-csv", "resizing-csv-row");
    saveCsvGridSizePreferences();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function activeStockCsvText() {
  return stockCsvTextFromRows(readStockCsvGridRows());
}

function updateStockCsvPreview() {
  const preview = document.querySelector("#stockCsvPreview");
  const text = stockCsvText();
  if (preview) preview.value = text;
  renderStockCsvGrid(stockCsvRows());
}

function defaultProfitBand() {
  return {
    label: "New band",
    min_supplier_cost_pence: 0,
    max_supplier_cost_pence: null,
    markup_basis_points: 2000,
    minimum_profit_pence: 150,
    sort_order: (profitRules.bands?.length || 0) * 10 + 10
  };
}

function renderProfitRulesForm() {
  const form = document.querySelector("#profitRulesForm");
  if (!form || !profitRules.settings) return;

  const settings = profitRules.settings;
  form.querySelector("[name='checkout_fee_gbp']").value = gbpInputFromPence(settings.checkout_fee_pence);
  form.querySelector("[name='minimum_checkout_gbp']").value = gbpInputFromPence(settings.minimum_checkout_subtotal_pence);
  form.querySelector("[name='outbound_shipping_gbp']").value = gbpInputFromPence(settings.outbound_shipping_cost_pence);
  form.querySelector("[name='packaging_order_gbp']").value = gbpInputFromPence(settings.packaging_cost_per_order_pence);
  form.querySelector("[name='packaging_item_gbp']").value = gbpInputFromPence(settings.packaging_cost_per_item_pence);
  form.querySelector("[name='payment_fee_percent']").value = percentInputFromBasisPoints(settings.payment_fee_basis_points);
  form.querySelector("[name='payment_fee_fixed_gbp']").value = gbpInputFromPence(settings.payment_fee_fixed_pence);
  form.querySelector("[name='minimum_profit_gbp']").value = gbpInputFromPence(settings.minimum_profit_pence);
  form.querySelector("[name='minimum_margin_percent']").value = percentInputFromBasisPoints(settings.minimum_margin_basis_points);
  form.querySelector("[name='vat_rate_percent']").value = percentInputFromBasisPoints(settings.default_vat_rate_basis_points);
  form.querySelector("[name='supplier_stale_minutes']").value = settings.supplier_price_stale_after_minutes || 60;
  form.querySelector("[name='vat_registered']").checked = Boolean(settings.vat_registered);
  form.querySelector("[name='margin_scheme_enabled']").checked = Boolean(settings.margin_scheme_enabled);
  form.querySelector("[name='block_checkout_on_stale_supplier']").checked = Boolean(settings.block_checkout_on_stale_supplier);

  renderProfitBands();
}

function renderProfitBands() {
  const list = document.querySelector("#profitBandList");
  if (!list) return;

  const bands = profitRules.bands?.length ? profitRules.bands : [defaultProfitBand()];
  list.innerHTML = bands.map((band, index) => `
    <div class="profit-band-row" data-profit-band-row="${index}">
      <label>Label
        <input name="band_label" value="${escapeHtml(band.label || `Band ${index + 1}`)}" />
      </label>
      <label>From GBP
        <input name="band_min_gbp" type="number" min="0" step="0.01" value="${gbpInputFromPence(band.min_supplier_cost_pence)}" />
      </label>
      <label>To GBP
        <input name="band_max_gbp" type="number" min="0" step="0.01" placeholder="No limit" value="${band.max_supplier_cost_pence === null || band.max_supplier_cost_pence === undefined ? "" : gbpInputFromPence(band.max_supplier_cost_pence)}" />
      </label>
      <label>Markup %
        <input name="band_markup_percent" type="number" min="0" step="0.01" value="${percentInputFromBasisPoints(band.markup_basis_points)}" />
      </label>
      <label>Min profit GBP
        <input name="band_min_profit_gbp" type="number" min="0" step="0.01" value="${gbpInputFromPence(band.minimum_profit_pence)}" />
      </label>
      <button class="danger" type="button" data-remove-profit-band="${index}" title="Remove band">x</button>
    </div>
  `).join("");
}

function readProfitBands() {
  return Array.from(document.querySelectorAll("[data-profit-band-row]")).map((row, index) => ({
    label: row.querySelector("[name='band_label']")?.value.trim() || `Band ${index + 1}`,
    min_supplier_cost_pence: penceFromGbpInput(row.querySelector("[name='band_min_gbp']")?.value),
    max_supplier_cost_pence: row.querySelector("[name='band_max_gbp']")?.value.trim()
      ? penceFromGbpInput(row.querySelector("[name='band_max_gbp']")?.value)
      : null,
    markup_basis_points: basisPointsFromPercentInput(row.querySelector("[name='band_markup_percent']")?.value),
    minimum_profit_pence: penceFromGbpInput(row.querySelector("[name='band_min_profit_gbp']")?.value),
    sort_order: (index + 1) * 10
  }));
}

async function loadProfitRules() {
  const form = document.querySelector("#profitRulesForm");
  if (!form) return;

  try {
    const payload = await rpc("admin_get_store_profit_rules");
    profitRules = {
      settings: payload?.settings || null,
      bands: Array.isArray(payload?.bands) ? payload.bands : []
    };
    renderProfitRulesForm();
  } catch (error) {
    console.warn("Could not load profit rules", error);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseCsvBoolean(value, fallback = true) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return fallback;
  return ["true", "yes", "y", "1", "active"].includes(text);
}

function csvRowsToProducts(text) {
  const records = csvObjectsFromText(text);
  return records.map((record, rowIndex) => {
    const name = record.name;
    const id = record.id || slugify(name);
    const pricePence = record.price_pence
      ? Math.round(Number(record.price_pence))
      : Math.round(Number(record.price_gbp || 0) * 100);
    const stockTotal = Number(record.stock_total || 0);
    const existingProduct = products.find((product) => product.id === id);

    if (!name) throw new Error(`CSV row ${rowIndex + 2} needs a name.`);
    if (!id) throw new Error(`CSV row ${rowIndex + 2} needs an id or a name that can make one.`);

    return {
      id,
      name,
      set_name: record.set_name || "",
      product_type: record.product_type || "booster",
      stock_total: stockTotal,
      stock_label: hasManualStockLabel(existingProduct) ? existingProduct.stock_label : autoStockLabel(stockTotal),
      price_pence: pricePence,
      image_url: record.image_url || "",
      is_active: parseCsvBoolean(record.is_active, true)
    };
  });
}

function downloadStockCsv() {
  const blob = new Blob([activeStockCsvText()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "card-vault-stock.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function orderProcessingLabel(order) {
  return order.order_number ? `#${order.order_number}` : "Unnumbered";
}

function orderSortValue(order) {
  return Number(order.order_number || Number.MAX_SAFE_INTEGER);
}

function productById(productId) {
  return products.find((product) => product.id === productId);
}

function storagePathFromProductImage(url = "") {
  try {
    const parsed = new URL(url);
    const marker = `/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/`;
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex === -1) return "";
    return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
  } catch {
    return "";
  }
}

async function removeDeletedProductImages(deletedProductIds) {
  const paths = products
    .filter((product) => deletedProductIds.includes(product.id))
    .map((product) => storagePathFromProductImage(product.image_url))
    .filter(Boolean);

  if (!paths.length) return;

  const { error } = await supabaseClient.storage.from(PRODUCT_IMAGE_BUCKET).remove(paths);
  if (error) setStatus(`Products deleted, but image cleanup failed: ${error.message}`, true);
}

function imageExtension(file) {
  const byType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  if (byType[file.type]) return byType[file.type];
  return String(file.name || "").split(".").pop()?.toLowerCase() || "jpg";
}

function setProductImagePreview(src = "") {
  const preview = document.querySelector("#productImagePreview");
  if (!preview) return;
  preview.innerHTML = src
    ? `<img src="${src}" alt="Selected product image preview" />`
    : "<span>No upload selected</span>";
}

async function uploadProductImage(form, productId) {
  const file = form.querySelector("[name='image_file']")?.files?.[0];
  if (!file) return formValue(form, "image_url");

  if (!file.type.startsWith("image/")) throw new Error("Please upload an image file.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image upload must be 5 MB or smaller.");

  const path = `products/${productId}/${Date.now()}.${imageExtension(file)}`;
  const { error } = await supabaseClient.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(path, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: false
    });

  if (error) throw error;

  const { data } = supabaseClient.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function openModal(modalId) {
  document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
  document.querySelector(`#${modalId}`)?.classList.remove("hidden");
}

function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
}

function openProductModal() {
  const form = document.querySelector("#productForm");
  form?.reset();
  const active = form?.querySelector("[name='is_active']");
  if (active) active.checked = true;
  const vatMode = form?.querySelector("[name='supplier_vat_mode']");
  if (vatMode) vatMode.value = "unknown";
  setProductImagePreview("");
  document.querySelector("#productModalTitle").textContent = "Add item";
  document.querySelector("#productModalSubtitle").textContent = "Use the same Product ID to update an existing item.";
  openModal("productModal");
}

function openEditProductModal(productId) {
  const product = productById(productId);
  const form = document.querySelector("#productForm");
  if (!product || !form) return;

  form.querySelector("[name='id']").value = product.id || "";
  form.querySelector("[name='name']").value = product.name || "";
  form.querySelector("[name='set_name']").value = product.set_name || "";
  form.querySelector("[name='product_type']").value = product.product_type || "booster";
  form.querySelector("[name='stock_total']").value = product.stock_total ?? 0;
  form.querySelector("[name='stock_label']").value = product.stock_label || "";
  form.querySelector("[name='price']").value = ((Number(product.price_pence) || 0) / 100).toFixed(2);
  form.querySelector("[name='supplier_vat_mode']").value = product.supplier_vat_mode || "unknown";
  form.querySelector("[name='image_url']").value = product.image_url || "";
  form.querySelector("[name='image_file']").value = "";
  form.querySelector("[name='is_active']").checked = Boolean(product.is_active);
  setProductImagePreview(product.image_url || "");
  document.querySelector("#productModalTitle").textContent = "Edit item";
  document.querySelector("#productModalSubtitle").textContent = "Swap the image URL, price, stock label, or product details.";
  openModal("productModal");
}

function openAdjustModal(productId) {
  const product = productById(productId);
  if (!product) return;

  const form = document.querySelector("#stockAdjustForm");
  form.reset();
  form.querySelector("[name='product_id']").value = product.id;
  document.querySelector("#adjustModalProduct").textContent =
    `${product.name} - ${product.available_stock} available, ${product.stock_total} total`;
  openModal("adjustModal");
}

function updateDeleteControls() {
  const modeButton = document.querySelector("#deleteModeButton");
  const deleteButton = document.querySelector("#deleteSelectedButton");
  const count = document.querySelector("#deleteSelectedCount");
  const selectedCount = selectedDeleteProductIds.size;

  document.body.classList.toggle("delete-mode", deleteMode);
  if (modeButton) {
    modeButton.textContent = deleteMode ? "Cancel delete" : "Delete mode";
    modeButton.classList.toggle("danger", deleteMode);
  }
  if (deleteButton) {
    deleteButton.classList.toggle("hidden", !deleteMode);
    deleteButton.disabled = selectedCount === 0;
  }
  if (count) {
    count.classList.toggle("hidden", !deleteMode);
    count.textContent = `${selectedCount} selected`;
  }
}

function setDeleteMode(enabled) {
  deleteMode = enabled;
  if (!deleteMode) selectedDeleteProductIds.clear();
  renderProducts();
  updateDeleteControls();
}

async function rpc(name, args = {}) {
  const { data, error } = await supabaseClient.rpc(name, args);
  if (error) throw error;
  return data;
}

async function ensureAdminSession() {
  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) {
    authCard.classList.remove("hidden");
    appShell.classList.add("hidden");
    return false;
  }

  const isAdmin = await rpc("is_store_admin");
  if (!isAdmin) {
    authCard.classList.remove("hidden");
    appShell.classList.add("hidden");
    setStatus("Signed in, but this account is not on the store admin list.", true);
    return false;
  }

  authCard.classList.add("hidden");
  appShell.classList.remove("hidden");
  return true;
}

async function loadProducts() {
  try {
    products = await rpc("admin_list_store_products_json");
  } catch (error) {
    products = await rpc("admin_list_store_products");
  }
  products = Array.isArray(products) ? products : [];
  movements = await rpc("admin_list_store_stock_movements", { p_limit: 80 });
  for (const selectedId of Array.from(selectedDeleteProductIds)) {
    if (!products.some((product) => product.id === selectedId)) selectedDeleteProductIds.delete(selectedId);
  }
  renderProducts();
  renderProductSelects();
  renderMovements();
  updateStockCsvPreview();
}

async function importBulkCatalogFromQuery() {
  if (panelMode !== "stock") return null;

  const params = new URLSearchParams(window.location.search);
  const catalogPath = params.get("bulk_catalog");
  if (!catalogPath) return null;

  const catalogUrl = new URL(catalogPath, window.location.href);
  if (catalogUrl.origin !== window.location.origin || !catalogUrl.pathname.endsWith(".json")) {
    throw new Error("Bulk catalog import must use a local JSON file.");
  }

  const importKey = `tcglocker-bulk-catalog:${catalogUrl.pathname}:${params.get("bulk_force") || ""}`;
  if (sessionStorage.getItem(importKey) === "done" && params.get("bulk_force") !== "1") {
    return null;
  }

  setStatus("Loading bulk catalogue file...");
  const response = await fetch(catalogUrl.href, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load bulk catalogue JSON (${response.status}).`);

  const payload = await response.json();
  if (!Array.isArray(payload.products) || !Array.isArray(payload.suppliers)) {
    throw new Error("Bulk catalogue JSON must include products and suppliers arrays.");
  }

  setStatus(`Replacing catalogue with ${payload.products.length} products...`);
  const result = await rpc("admin_replace_store_catalog", {
    p_products: payload.products,
    p_suppliers: payload.suppliers
  });

  sessionStorage.setItem(importKey, "done");
  return result || { products: payload.products.length, supplier_links: payload.suppliers.length };
}

function renderProducts() {
  const list = document.querySelector("#productList");
  if (!list) return;

  list.innerHTML = products.map((product, index) => `
    <article class="item-card stock-card ${selectedDeleteProductIds.has(product.id) ? "selected-delete" : ""}" data-product-card="${product.id}">
      <label class="delete-check">
        <input type="checkbox" data-delete-select="${product.id}" ${selectedDeleteProductIds.has(product.id) ? "checked" : ""} />
        <span>Delete</span>
      </label>
      <div class="stock-thumb">
        ${product.image_url ? `<img src="${product.image_url}" alt="${product.name}" loading="lazy" />` : `<span>No image</span>`}
      </div>
      <div class="item-head">
        <div>
          <strong>${product.name}</strong>
          <div class="meta">
            <span>CSV #${index + 1}</span>
            <span>${product.id}</span>
            <span>${product.set_name || "No set"}</span>
            <span>${product.product_type}</span>
          </div>
        </div>
        <span class="pill ${product.available_stock <= 3 ? "hot" : "good"}">${product.available_stock} available</span>
      </div>
      <div class="meta">
        <span>Total ${product.stock_total}</span>
        <span>Reserved ${product.reserved_stock}</span>
        <span>${moneyFromPence(product.price_pence)}</span>
        ${product.supplier_price_pence ? `<span>Supplier ${moneyFromPence(product.supplier_price_pence)}</span>` : "<span>No supplier cost</span>"}
        ${product.minimum_sale_price_pence ? `<span>Min ${moneyFromPence(product.minimum_sale_price_pence)}</span>` : ""}
        <span>VAT ${product.supplier_vat_mode || "unknown"}</span>
        <span>${product.is_active ? "Active" : "Hidden"}</span>
      </div>
      <div class="stock-actions">
        <button type="button" data-edit-product="${product.id}" ${deleteMode ? "disabled" : ""}>Edit</button>
        <button class="primary" type="button" data-adjust-product="${product.id}" ${deleteMode ? "disabled" : ""}>Adjust</button>
      </div>
    </article>
  `).join("") || "<p>No products found.</p>";
  updateDeleteControls();
}

function renderProductSelects() {
  document.querySelectorAll("[data-product-select]").forEach((select) => {
    select.innerHTML = products.map((product) => `
      <option value="${product.id}">${product.name} (${product.stock_total})</option>
    `).join("");
  });
}

function renderMovements() {
  const list = document.querySelector("#movementList");
  if (!list) return;

  list.innerHTML = movements.map((movement) => `
    <article class="movement-row">
      <div>
        <strong>${movement.product_name || movement.product_id}</strong>
        <div class="meta">
          <span>${new Date(movement.created_at).toLocaleString()}</span>
          <span>${movement.reason}</span>
          <span>${movement.admin_email || "No admin email"}</span>
        </div>
        ${movement.note ? `<p>${movement.note}</p>` : ""}
      </div>
      <div class="movement-delta ${movement.delta >= 0 ? "positive" : "negative"}">
        ${movement.delta >= 0 ? "+" : ""}${movement.delta}
        <span>${movement.stock_after} after</span>
      </div>
    </article>
  `).join("") || "<p>No stock adjustments logged yet.</p>";
}

async function loadOrders() {
  orders = await rpc("admin_list_store_orders");
  issues = await rpc("admin_list_store_order_issues");
  await loadProcurements();
  orders.sort((a, b) => orderSortValue(a) - orderSortValue(b) || new Date(a.created_at) - new Date(b.created_at));
  pruneCompleteOrderConfirmations();
  renderOrders();
  renderIssues();
  renderOrderSelects();
}

async function loadProcurements() {
  try {
    procurements = await rpc("admin_list_store_procurements");
  } catch (error) {
    procurements = [];
    console.warn("Could not load supplier purchases", error);
  }
}

function orderAddress(order) {
  const address = order.address || {};
  return [address.line1, address.line2, address.city, address.county, address.postcode, address.country]
    .filter(Boolean)
    .join(", ");
}

function isCompletedOrder(order) {
  return order.fulfilment_status === "completed" || order.status === "fulfilled";
}

function isCancelledOrder(order) {
  return order.fulfilment_status === "cancelled" || ["cancelled", "refunded"].includes(order.status);
}

function isTerminalOrder(order) {
  return isCompletedOrder(order) || isCancelledOrder(order);
}

function isConfirmedSupplierPurchase(entry) {
  return !["cancelled", "issue"].includes(entry.status) &&
    Boolean(String(entry.supplier_order_ref || "").trim()) &&
    Boolean(String(entry.listing_url || "").trim());
}

function hasSupplierPurchase(order) {
  return procurementsForOrder(order.id).some(isConfirmedSupplierPurchase);
}

function isPendingDeliveryOrder(order) {
  return !isTerminalOrder(order) && hasSupplierPurchase(order);
}

function isActiveUnorderedOrder(order) {
  return !isTerminalOrder(order) && !isPendingDeliveryOrder(order);
}

function fulfilmentLabel(status) {
  const labels = {
    paid: "Active",
    processing: "Awaiting stock for delivery",
    completed: "Complete",
    cancelled: "Cancelled / refund queued",
    issue: "Issue"
  };
  return labels[status] || status || "Order";
}

function orderSearchText(order) {
  const address = order.address || {};
  const tracking = order.tracking || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const supplierPurchases = procurementsForOrder(order.id);
  return [
    order.order_number ? `#${order.order_number}` : "",
    order.order_ref,
    order.email,
    order.customer_name,
    order.fulfilment_status,
    order.status,
    address.phone,
    address.line1,
    address.line2,
    address.city,
    address.county,
    address.postcode,
    address.country,
    tracking.carrier,
    tracking.number,
    tracking.url,
    ...items.flatMap((item) => [item.product_id, item.name]),
    ...supplierPurchases.flatMap((entry) => [
      entry.supplier,
      entry.supplier_order_ref,
      entry.supplier_item_id,
      entry.listing_url,
      entry.listing_title,
      procurementDisplayStatus(entry.status)
    ])
  ].filter(Boolean).join(" ").toLowerCase();
}

function filteredOrders() {
  const query = shipmentFilters.query.trim().toLowerCase();
  return orders.filter((order) => {
    const statusMatch =
      (shipmentFilters.status === "active" && isActiveUnorderedOrder(order)) ||
      (shipmentFilters.status === "pending" && isPendingDeliveryOrder(order)) ||
      (shipmentFilters.status === "completed" && isCompletedOrder(order)) ||
      (shipmentFilters.status === "refunds" && isCancelledOrder(order));
    const queryMatch = !query || orderSearchText(order).includes(query);
    return statusMatch && queryMatch;
  });
}

function orderFilterLabel() {
  if (shipmentFilters.status === "pending") return "pending delivery orders";
  if (shipmentFilters.status === "refunds") return "refund orders";
  if (shipmentFilters.status === "completed") return "complete orders";
  return "active not ordered orders";
}

function renderOrderFilterControls() {
  const activeCount = orders.filter(isActiveUnorderedOrder).length;
  const pendingCount = orders.filter(isPendingDeliveryOrder).length;
  const completedCount = orders.filter(isCompletedOrder).length;
  const refundCount = orders.filter(isCancelledOrder).length;
  const counts = {
    active: activeCount,
    pending: pendingCount,
    completed: completedCount,
    refunds: refundCount
  };

  document.querySelectorAll("[data-order-count]").forEach((entry) => {
    entry.textContent = counts[entry.dataset.orderCount] ?? 0;
  });

  document.querySelectorAll("[data-order-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.orderFilter === shipmentFilters.status);
  });

  const input = document.querySelector("#orderSearchInput");
  if (input && input.value !== shipmentFilters.query) input.value = shipmentFilters.query;
}

function clearCompleteOrderConfirmation(orderId) {
  const timer = completeOrderConfirmTimers.get(orderId);
  if (!timer) return;
  if (timer.interval) clearInterval(timer.interval);
  if (timer.resetTimeout) clearTimeout(timer.resetTimeout);
  completeOrderConfirmTimers.delete(orderId);
  resetCompleteOrderButton(orderId);
}

function clearAllCompleteOrderConfirmations() {
  Array.from(completeOrderConfirmTimers.keys()).forEach(clearCompleteOrderConfirmation);
}

function completeOrderButtonFor(orderId) {
  return Array.from(document.querySelectorAll("[data-finish-order]"))
    .find((button) => button.dataset.finishOrder === orderId);
}

function resetCompleteOrderButton(buttonOrOrderId) {
  const button = typeof buttonOrOrderId === "string" ? completeOrderButtonFor(buttonOrOrderId) : buttonOrOrderId;
  if (!button) return;
  button.disabled = false;
  button.classList.remove("confirming", "confirm-ready");
  button.textContent = "Sent complete";
  delete button.dataset.confirmReady;
}

function resetCancelOrderButton(buttonOrOrderId) {
  const button = typeof buttonOrOrderId === "string"
    ? Array.from(document.querySelectorAll("[data-cancel-order]")).find((entry) => entry.dataset.cancelOrder === buttonOrOrderId)
    : buttonOrOrderId;
  if (!button) return;
  button.classList.remove("confirming", "confirm-ready", "refund-submit-ready");
  button.textContent = "Cancel/refund";
  delete button.dataset.cancelConfirmStage;
}

function applyCancelOrderButtonState(button) {
  const stage = Number(cancelOrderConfirmStages.get(button.dataset.cancelOrder) || 0);
  if (!stage) {
    resetCancelOrderButton(button);
    return;
  }

  button.classList.add("confirming");
  button.classList.toggle("refund-submit-ready", stage >= CANCEL_ORDER_CONFIRM_LABELS.length);
  button.dataset.cancelConfirmStage = String(stage);
  button.textContent = CANCEL_ORDER_CONFIRM_LABELS[Math.min(stage - 1, CANCEL_ORDER_CONFIRM_LABELS.length - 1)];
}

function applyCompleteOrderButtonState(button) {
  const orderId = button.dataset.finishOrder;
  const timer = completeOrderConfirmTimers.get(orderId);
  if (!timer) {
    resetCompleteOrderButton(button);
    return;
  }

  if (timer.stage === "ready") {
    button.disabled = false;
    button.classList.remove("confirming");
    button.classList.add("confirm-ready");
    button.dataset.confirmReady = "true";
    button.textContent = "Confirm sent";
    return;
  }

  button.disabled = true;
  button.classList.add("confirming");
  button.classList.remove("confirm-ready");
  delete button.dataset.confirmReady;
  button.textContent = `ARE YOU SURE (${timer.seconds})`;
}

function pruneCompleteOrderConfirmations() {
  const activeOrderIds = new Set(orders.filter((order) => !isTerminalOrder(order)).map((order) => order.id));
  Array.from(completeOrderConfirmTimers.keys()).forEach((orderId) => {
    if (!activeOrderIds.has(orderId)) clearCompleteOrderConfirmation(orderId);
  });
}

function startCompleteOrderConfirmation(button) {
  const orderId = button.dataset.finishOrder;
  clearCompleteOrderConfirmation(orderId);

  const timer = {
    stage: "countdown",
    seconds: COMPLETE_ORDER_CONFIRM_SECONDS,
    interval: undefined,
    resetTimeout: undefined
  };
  completeOrderConfirmTimers.set(orderId, timer);
  applyCompleteOrderButtonState(button);

  const interval = setInterval(() => {
    const currentTimer = completeOrderConfirmTimers.get(orderId);
    if (!currentTimer) {
      clearInterval(interval);
      return;
    }

    currentTimer.seconds -= 1;
    if (currentTimer.seconds > 0) {
      const currentButton = completeOrderButtonFor(orderId);
      if (currentButton) applyCompleteOrderButtonState(currentButton);
      return;
    }

    clearInterval(interval);
    currentTimer.stage = "ready";
    currentTimer.interval = undefined;

    const currentButton = completeOrderButtonFor(orderId);
    if (currentButton) applyCompleteOrderButtonState(currentButton);

    const resetTimeout = setTimeout(() => {
      clearCompleteOrderConfirmation(orderId);
    }, COMPLETE_ORDER_CONFIRM_READY_MS);
    currentTimer.resetTimeout = resetTimeout;
  }, 1000);

  timer.interval = interval;
}

function trackingValue(order, key) {
  const tracking = order.tracking || {};
  if (key === "carrier") return tracking.carrier || "Royal Mail";
  return tracking[key] || "";
}

function orderItemThumbnail(item) {
  const name = escapeHtml(item.name || item.product_id || "Order item");
  return `
    <div class="order-item-thumb">
      ${item.image_url
        ? `<img src="${escapeHtml(item.image_url)}" alt="${name}" loading="lazy" />`
        : `<span>${escapeHtml(String(item.quantity || 1))}x</span>`}
    </div>
  `;
}

function orderItemsMarkup(items) {
  return items.map((item) => `
    <div class="order-item-line">
      ${orderItemThumbnail(item)}
      <div>
        <strong>${escapeHtml(item.quantity || 1)}x ${escapeHtml(item.name || item.product_id || "Unknown item")}</strong>
        <span>${moneyFromPence(item.line_total_pence || ((item.unit_price_pence || 0) * (item.quantity || 1)))}</span>
      </div>
    </div>
  `).join("");
}

function procurementsForOrder(orderId, confirmedOnly = false) {
  const matches = procurements.filter((entry) => entry.order_id === orderId);
  return confirmedOnly ? matches.filter(isConfirmedSupplierPurchase) : matches;
}

function procurementsForLine(orderId, productId) {
  return procurementsForOrder(orderId).filter((entry) => entry.product_id === productId);
}

function procurementStatusClass(status) {
  if (["received", "dispatched"].includes(status)) return "good";
  if (["cancelled", "issue"].includes(status)) return "hot";
  if (status === "purchased") return "complete";
  return "";
}

function procurementDisplayStatus(status) {
  const labels = {
    watching: "Not ordered",
    purchased: "Awaiting stock for delivery",
    dispatched: "Supplier dispatched",
    received: "Arrived to us",
    cancelled: "Cancelled",
    issue: "Issue"
  };
  return labels[status] || status || "Not ordered";
}

function procurementSummaryMarkup(order) {
  const saved = procurementsForOrder(order.id, true);
  if (!saved.length) {
    return `<div class="procurement-mini muted"><strong>Active</strong><span>Not ordered from supplier yet.</span></div>`;
  }

  const totalCost = saved.reduce((sum, entry) => sum + (Number(entry.total_cost_pence) || 0), 0);
  const counts = saved.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});

  return `
    <div class="procurement-mini procurement-detail-mini">
      <div class="procurement-mini-head">
        <strong>Awaiting stock for delivery</strong>
        <span>${saved.length} supplier order${saved.length === 1 ? "" : "s"}</span>
        <span>${moneyFromPence(totalCost)} supplier cost</span>
        <span>${Object.entries(counts).map(([status, count]) => `${count} ${procurementDisplayStatus(status)}`).join(" / ")}</span>
      </div>
      <div class="procurement-purchase-lines">
        ${saved.map((entry) => `
          <article class="procurement-purchase-line">
            <div>
              <strong>${escapeHtml(entry.supplier_order_ref || "No supplier order ID")}</strong>
              <span>${escapeHtml(entry.supplier || "Supplier")} ${entry.purchased_at || entry.created_at ? `- ${new Date(entry.purchased_at || entry.created_at).toLocaleDateString()}` : ""}</span>
            </div>
            <span>${moneyFromPence(entry.total_cost_pence || 0)} paid</span>
            <span class="pill ${procurementStatusClass(entry.status)}">${escapeHtml(procurementDisplayStatus(entry.status))}</span>
            ${entry.listing_url
              ? `<a class="button-link" href="${escapeHtml(entry.listing_url)}" target="_blank" rel="noreferrer">Open</a>`
              : `<span class="muted-link">No URL</span>`}
          </article>
        `).join("")}
      </div>
    </div>
  `;
}

function cancellationEmailBody() {
  return [
    "Sorry but the items ordered seem to have had an internal stock issue. We are really sorry for the inconvenience. A total refund will be back in your bank within 3-5 working days, and could be sooner depending on your provider.",
    "",
    "Thanks for shopping with us."
  ].join("\n");
}

function refundStatusLabel(status) {
  const labels = {
    not_required: "No Stripe refund needed",
    stripe_refund_ready: "Stripe refund ready",
    requested: "Stripe refund requested",
    pending: "Stripe refund pending",
    succeeded: "Refund complete",
    failed: "Refund failed",
    cancelled: "Refund cancelled"
  };
  return labels[status] || status || "No refund state";
}

function cancellationSummaryMarkup(order) {
  if (!isCancelledOrder(order)) return "";
  const cancellation = order.cancellation || {};
  const refund = order.refund || {};
  return `
    <div class="cancel-summary">
      <div>
        <strong>Cancelled customer order</strong>
        <span>${escapeHtml(cancellation.reason || "Unable to secure replacement stock online")}</span>
      </div>
      <div>
        <strong>${moneyFromPence(refund.amount_pence || order.total_pence || 0)}</strong>
        <span>${escapeHtml(refundStatusLabel(refund.status))}</span>
      </div>
      <div>
        <strong>Email ${escapeHtml(cancellation.email_status || "queued")}</strong>
        <span>${escapeHtml(cancellation.email_to || order.email || "No customer email")}</span>
      </div>
      ${order.stripe_payment_intent_id ? `<div><strong>PaymentIntent</strong><span>${escapeHtml(order.stripe_payment_intent_id)}</span></div>` : ""}
    </div>
  `;
}

function procurementRecordsMarkup(orderId, line) {
  const records = procurementsForLine(orderId, line.product_id);
  if (!records.length) return "";

  return `
    <div class="procurement-records">
      ${records.map((record) => `
        <article class="procurement-record">
          <div>
            <strong>${escapeHtml(record.supplier_order_ref || record.supplier_item_id || "Supplier purchase")}</strong>
            <div class="meta">
              <span>${escapeHtml(record.supplier || "supplier")}</span>
              <span>${escapeHtml(record.listing_title || record.product_name || line.product_name || "No title")}</span>
              <span>${moneyFromPence(record.total_cost_pence || 0)} total</span>
              ${record.tracking_number ? `<span>${escapeHtml(record.tracking_carrier || "Tracking")} ${escapeHtml(record.tracking_number)}</span>` : ""}
              ${record.eta_date ? `<span>ETA ${escapeHtml(record.eta_date)}</span>` : ""}
            </div>
            ${record.notes ? `<p>${escapeHtml(record.notes)}</p>` : ""}
          </div>
          <div class="procurement-record-actions">
            <span class="pill ${procurementStatusClass(record.status)}">${escapeHtml(procurementDisplayStatus(record.status))}</span>
            ${record.listing_url ? `<a class="button-link" href="${escapeHtml(record.listing_url)}" target="_blank" rel="noreferrer">Listing</a>` : ""}
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function procurementLineThumbnail(line) {
  const name = escapeHtml(line.product_name || line.product_id || "Order item");
  return `
    <div class="procurement-row-thumb">
      ${line.image_url
        ? `<img src="${escapeHtml(line.image_url)}" alt="${name}" loading="lazy" />`
        : `<span>${escapeHtml(String(line.quantity || 1))}x</span>`}
    </div>
  `;
}

function supplierSearchButtons(line, urls) {
  const itemName = escapeHtml(line.product_name || line.product_id || "item");
  return `
    <div class="supplier-search-actions" aria-label="Supplier searches">
      <a class="supplier-icon supplier-ebay" href="${escapeHtml(urls.ebay)}" target="_blank" rel="noreferrer" title="Search eBay for ${itemName}" aria-label="Search eBay for ${itemName}">
        <span>e</span>
      </a>
      <a class="supplier-icon supplier-amazon" href="${escapeHtml(urls.amazon)}" target="_blank" rel="noreferrer" title="Search Amazon for ${itemName}" aria-label="Search Amazon for ${itemName}">
        <span>a</span>
      </a>
      <a class="supplier-icon supplier-magic" href="${escapeHtml(urls.magic)}" target="_blank" rel="noreferrer" title="Search Magic Madhouse for ${itemName}" aria-label="Search Magic Madhouse for ${itemName}">
        <span>M</span>
      </a>
    </div>
  `;
}

function procurementSaveFormMarkup(order, line, searchUrls) {
  const quantity = Math.max(1, Number(line.quantity) || 1);
  const addressText = orderAddress(order);
  return `
    <form class="procurement-save-form procurement-order-row">
      <input type="hidden" name="order_id" value="${escapeHtml(order.id)}" />
      <input type="hidden" name="product_id" value="${escapeHtml(line.product_id || "")}" />
      <input type="hidden" name="status" value="purchased" />
      ${procurementLineThumbnail(line)}
      <div class="procurement-row-summary">
        <span>Quantity ordered ${escapeHtml(quantity)}</span>
        <strong>${escapeHtml(line.product_name || line.product_id || "Order item")}</strong>
        <span>Customer paid ${moneyFromPence(line.line_total_pence || ((line.unit_price_pence || 0) * quantity))}</span>
        <span>${escapeHtml(addressText || "No delivery address")}</span>
      </div>
      <div class="procurement-row-fields">
        <div class="procurement-row-top">
          <label>Supplier
            <select name="supplier">
              <option value="eBay">eBay</option>
              <option value="Magic Madhouse">Magic Madhouse</option>
              <option value="Other">Other</option>
            </select>
          </label>
          <label>Product cost GBP
            <input name="unit_cost_gbp" inputmode="decimal" value="${gbpInputFromPence(line.magic_price_pence || 0)}" />
          </label>
          <label>Delivery cost GBP
            <input name="shipping_gbp" inputmode="decimal" value="0.00" />
          </label>
          <span>Date saved = ordered date</span>
          ${supplierSearchButtons(line, searchUrls)}
        </div>
        <input required name="listing_url" placeholder="Order URL/s" />
        <div class="procurement-row-bottom">
          <input required name="supplier_order_ref" placeholder="Order ID/s, in case multiple suppliers" />
          <button class="primary" type="submit">Save</button>
        </div>
        <input type="hidden" name="quantity" value="${escapeHtml(quantity)}" />
        <details class="procurement-row-extra">
          <summary>ETA / notes</summary>
          <div class="procurement-extra-grid">
            <label>ETA
              <input name="eta_date" type="date" />
            </label>
            <label class="wide">Notes
              <textarea name="notes" placeholder="Supplier messages, arrival checks, condition notes..."></textarea>
            </label>
          </div>
        </details>
        <input type="hidden" name="supplier_item_id" />
        <input type="hidden" name="listing_title" value="${escapeHtml(line.product_name || line.product_id || "")}" />
        <input type="hidden" name="tracking_carrier" value="Royal Mail" />
        <input type="hidden" name="tracking_number" />
        <input type="hidden" name="tracking_url" />
      </div>
    </form>
  `;
}

function procurementLineMarkup(order, line) {
  const query = line.product_name || line.product_id || "pokemon cards";
  const searchUrls = {
    ebay: ebaySearchUrl(query),
    amazon: amazonSearchUrl(query),
    magic: magicMadhouseSearchUrl(query)
  };
  return `
    <section class="procurement-line">
      ${procurementSaveFormMarkup(order, line, searchUrls)}
      ${procurementRecordsMarkup(order.id, line)}
    </section>
  `;
}

function ebaySearchUrl(query) {
  const url = new URL("https://www.ebay.co.uk/sch/i.html");
  url.searchParams.set("_nkw", query);
  url.searchParams.set("LH_BIN", "1");
  url.searchParams.set("LH_ItemCondition", "1000");
  return url.toString();
}

function amazonSearchUrl(query) {
  const url = new URL("https://www.amazon.co.uk/s");
  url.searchParams.set("k", query);
  return url.toString();
}

function magicMadhouseSearchUrl(query) {
  const url = new URL("https://magicmadhouse.co.uk/search");
  url.searchParams.set("q", query);
  return url.toString();
}

function procurementFallbackLines(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.map((item) => ({
    product_id: item.product_id,
    product_name: item.name || item.product_id || "Order item",
    quantity: item.quantity || 1,
    unit_price_pence: item.unit_price_pence || 0,
    line_total_pence: item.line_total_pence || 0,
    image_url: item.image_url || "",
    magic_price_pence: null,
    magic_source_url: "",
    listings: []
  }));
}

function procurementListingMarkup(line, listing) {
  const total = Number.isFinite(listing.total_pence) ? moneyFromPence(listing.total_pence) : "No GBP price";
  const price = Number.isFinite(listing.price_pence) ? moneyFromPence(listing.price_pence) : "Unknown";
  const shipping = Number.isFinite(listing.shipping_pence) ? moneyFromPence(listing.shipping_pence) : "Unknown";
  const beatsMagic = listing.beats_magic === true;
  const missesMagic = listing.beats_magic === false;
  const score = Number(listing.match_score || 0);
  const itemId = listing.legacy_item_id || listing.item_id || "";
  const listingUrl = listing.url || ebaySearchUrl(line.product_name);

  return `
    <article class="procurement-listing ${beatsMagic ? "beats-magic" : ""} ${missesMagic ? "misses-magic" : ""}">
      <a class="procurement-thumb" href="${escapeHtml(listingUrl)}" target="_blank" rel="noreferrer">
        ${listing.image_url ? `<img src="${escapeHtml(listing.image_url)}" alt="" loading="lazy" />` : "<span>eBay</span>"}
      </a>
      <div class="procurement-listing-info">
        <strong>${escapeHtml(listing.title || "Open matching eBay search")}</strong>
        <div class="meta">
          <span>ID ${escapeHtml(itemId || "unknown")}</span>
          <span>${escapeHtml(listing.condition || "Condition unknown")}</span>
          <span>${escapeHtml(listing.seller || "Seller unknown")}</span>
          ${listing.feedback_percentage ? `<span>${escapeHtml(listing.feedback_percentage)} feedback</span>` : ""}
          <span>${score}% match</span>
        </div>
        <div class="procurement-price-row">
          <span>Item ${price}</span>
          <span>Delivery ${shipping}</span>
          <strong>Total ${total}</strong>
          ${listing.margin_gain_pence !== null && listing.margin_gain_pence !== undefined
            ? `<span class="${listing.margin_gain_pence > 0 ? "saving" : "loss"}">${listing.margin_gain_pence > 0 ? "+" : ""}${moneyFromPence(listing.margin_gain_pence)} vs Magic</span>`
            : ""}
        </div>
      </div>
      <div class="procurement-listing-actions">
        <button type="button"
          data-use-procurement-listing
          data-item-id="${escapeHtml(itemId)}"
          data-url="${escapeHtml(listingUrl)}"
          data-title="${escapeHtml(listing.title || "")}"
          data-unit-cost-pence="${escapeHtml(listing.price_pence || 0)}"
          data-shipping-pence="${escapeHtml(listing.shipping_pence || 0)}">Use listing</button>
        <a class="button-link primary-link" href="${escapeHtml(listingUrl)}" target="_blank" rel="noreferrer">Open listing</a>
        ${itemId ? `<button type="button" data-copy-text="${escapeHtml(itemId)}">Copy ID</button>` : ""}
      </div>
    </article>
  `;
}

function renderProcurement(order, payload = null, loading = false, errorMessage = "") {
  const body = document.querySelector("#procurementBody");
  const title = document.querySelector("#procurementModalTitle");
  const subtitle = document.querySelector("#procurementModalSubtitle");
  if (!body || !order) return;

  const orderName = `${orderProcessingLabel(order)} ${order.order_ref || ""}`.trim();
  if (title) title.textContent = `Order stock ${orderName}`;
  if (subtitle) {
    subtitle.textContent = "Search, order to us, paste the URL and order ID.";
  }

  const lines = procurementFallbackLines(order);
  body.innerHTML = `
    <div class="procurement-summary compact">
      <strong>${escapeHtml(orderName || "Order")}</strong>
      <span>${escapeHtml(order.customer_name || order.email || "No name")}</span>
      <span>${moneyFromPence(order.total_pence || 0)} customer paid</span>
    </div>
    ${errorMessage ? `<p class="procurement-notice warn">${escapeHtml(errorMessage)}</p>` : ""}
    <div class="procurement-lines">
      ${lines.map((line) => procurementLineMarkup(order, line)).join("")}
    </div>
    <button class="primary procurement-save-all" type="button" data-save-all-procurements>Save all and set awaiting delivery</button>
  `;
}

async function openProcurementModal(orderId) {
  const order = orders.find((entry) => entry.id === orderId);
  if (!order) return;

  currentProcurementOrderId = orderId;
  currentProcurementPayload = null;
  openModal("procurementModal");
  renderProcurement(order);
}

function renderOrders() {
  const list = document.querySelector("#orderList");
  if (!list) return;
  renderOrderFilterControls();

  const visibleOrders = filteredOrders();
  list.innerHTML = visibleOrders.map((order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    const addressText = orderAddress(order);
    const rawFulfilmentStatus = order.fulfilment_status || "paid";
    const completed = isCompletedOrder(order);
    const cancelled = isCancelledOrder(order);
    const fulfilmentStatus = completed
      ? "completed"
      : cancelled
        ? "cancelled"
      : isPendingDeliveryOrder(order) && !["cancelled", "issue"].includes(rawFulfilmentStatus)
        ? "processing"
        : rawFulfilmentStatus;
    const procurementMarkup = procurementSummaryMarkup(order);
    const cancellationMarkup = cancellationSummaryMarkup(order);

    return `
      <article class="item-card order-card ${completed || cancelled ? "completed" : ""} ${cancelled ? "cancelled" : ""}" data-order-id="${escapeHtml(order.id)}">
        <div class="item-head">
          <div>
            <strong>${escapeHtml(orderProcessingLabel(order))}</strong>
            <div class="meta">
              <span>${escapeHtml(order.order_ref || "No reference")}</span>
              <span>${escapeHtml(order.customer_name || "No name")}</span>
              <span>${escapeHtml(order.email || "No email")}</span>
              <span>${new Date(order.created_at).toLocaleString()}</span>
            </div>
          </div>
          <span class="pill ${completed ? "complete" : cancelled ? "hot" : order.issue_count ? "hot" : "good"}">${escapeHtml(fulfilmentLabel(fulfilmentStatus))}</span>
        </div>
        <div class="order-card-main">
          <div class="order-items">
            ${orderItemsMarkup(items) || "<p>No order items.</p>"}
          </div>
          <div class="order-destination">
            <strong>${moneyFromPence(order.total_pence)}</strong>
            <span>${escapeHtml(addressText || "No delivery address on order")}</span>
          </div>
        </div>
        ${procurementMarkup}
        ${cancellationMarkup}
        <form class="order-update-form">
          <div class="order-control-grid">
            <label>Status
              <select name="fulfilment_status">
                ${["paid", "processing", "completed", "issue"].map((status) => `
                  <option value="${status}" ${status === fulfilmentStatus ? "selected" : ""}>${fulfilmentLabel(status)}</option>
                `).join("")}
              </select>
            </label>
            <label>Carrier
              <input name="tracking_carrier" value="${escapeHtml(trackingValue(order, "carrier"))}" />
            </label>
            <label>Tracking number
              <input name="tracking_number" value="${escapeHtml(trackingValue(order, "number"))}" placeholder="Optional" />
            </label>
            <label>Tracking URL
              <input name="tracking_url" value="${escapeHtml(trackingValue(order, "url"))}" placeholder="Optional" />
            </label>
          </div>
          <label>Ops notes
            <textarea name="admin_notes">${escapeHtml(order.admin_notes || "")}</textarea>
          </label>
          <div class="order-actions">
            <button type="button" data-order-cards="${escapeHtml(order.id)}">Order stock</button>
            <button type="button" data-print-label="${escapeHtml(order.id)}">Print label</button>
            ${cancelled
              ? `<button type="button" disabled>Cancelled</button>`
              : completed
              ? `<button type="button" class="warn-action" data-undo-complete="${escapeHtml(order.id)}">Undo sent</button>`
              : `<button type="button" class="good-action" data-finish-order="${escapeHtml(order.id)}">Sent complete</button>`}
            ${completed || cancelled ? "" : `<button type="button" class="warn-action" data-cancel-order="${escapeHtml(order.id)}">Cancel/refund</button>`}
            <button class="primary" type="submit">Save</button>
          </div>
        </form>
      </article>
    `;
  }).join("") || `<p>No ${orderFilterLabel()} found${shipmentFilters.query ? " for that search" : ""}.</p>`;

  document.querySelectorAll("[data-finish-order]").forEach(applyCompleteOrderButtonState);
  document.querySelectorAll("[data-cancel-order]").forEach(applyCancelOrderButtonState);
}

async function saveOrderFromForm(form, fulfilmentStatus = formValue(form, "fulfilment_status")) {
  const card = form.closest("[data-order-id]");
  await rpc("admin_update_store_order_fulfilment", {
    p_order_id: card.dataset.orderId,
    p_fulfilment_status: fulfilmentStatus,
    p_tracking_carrier: formValue(form, "tracking_carrier") || "Royal Mail",
    p_tracking_number: formValue(form, "tracking_number"),
    p_tracking_url: formValue(form, "tracking_url"),
    p_admin_notes: formValue(form, "admin_notes")
  });
}

async function cancelCustomerOrder(orderId) {
  const order = orders.find((entry) => entry.id === orderId);
  if (!order) return;

  const body = cancellationEmailBody();
  setStatus("Cancelling order and preparing refund...");
  await rpc("admin_cancel_store_order", {
    p_order_id: orderId,
    p_reason: "Unable to secure replacement stock online",
    p_refund_amount_pence: order.total_pence || 0,
    p_email_body: body
  });

  cancelOrderConfirmStages.delete(orderId);
  shipmentFilters.status = "refunds";
  await loadOrders();
  setStatus("Order cancelled. Customer email queued and Stripe refund marked ready.");
}

async function setOrderFulfilmentStatus(orderId, fulfilmentStatus) {
  const order = orders.find((entry) => entry.id === orderId);
  const tracking = order?.tracking || {};
  await rpc("admin_update_store_order_fulfilment", {
    p_order_id: orderId,
    p_fulfilment_status: fulfilmentStatus,
    p_tracking_carrier: tracking.carrier || "Royal Mail",
    p_tracking_number: tracking.number || "",
    p_tracking_url: tracking.url || "",
    p_admin_notes: order?.admin_notes || ""
  });
}

async function saveProcurementForm(form, options = {}) {
  const { refreshAfter = true, updateOrderStatus = true } = options;
  const status = formValue(form, "status") || "purchased";
  const orderId = formValue(form, "order_id");

  await rpc("admin_upsert_store_procurement", {
    p_id: null,
    p_order_id: orderId,
    p_product_id: formValue(form, "product_id") || null,
    p_supplier: formValue(form, "supplier") || "eBay",
    p_supplier_order_ref: formValue(form, "supplier_order_ref"),
    p_supplier_item_id: formValue(form, "supplier_item_id"),
    p_listing_url: formValue(form, "listing_url"),
    p_listing_title: formValue(form, "listing_title"),
    p_quantity: Math.max(1, Number(formValue(form, "quantity")) || 1),
    p_unit_cost_pence: penceFromGbpInput(formValue(form, "unit_cost_gbp")),
    p_shipping_pence: penceFromGbpInput(formValue(form, "shipping_gbp")),
    p_status: status,
    p_tracking_carrier: formValue(form, "tracking_carrier") || "Royal Mail",
    p_tracking_number: formValue(form, "tracking_number"),
    p_tracking_url: formValue(form, "tracking_url"),
    p_eta_date: formValue(form, "eta_date") || null,
    p_purchased_at: ["purchased", "dispatched", "received"].includes(status) ? new Date().toISOString() : null,
    p_received_at: status === "received" ? new Date().toISOString() : null,
    p_notes: formValue(form, "notes")
  });

  if (updateOrderStatus) await setOrderFulfilmentStatus(orderId, "processing");

  if (refreshAfter) {
    shipmentFilters.status = "pending";
    await loadOrders();
    await loadProcurements();
    const order = orders.find((entry) => entry.id === currentProcurementOrderId || entry.id === orderId);
    if (order) renderProcurement(order, currentProcurementPayload, false, "Supplier purchase saved. Customer order is now awaiting delivery.");
    renderOrders();
  }
}

function printOrderLabel(orderId) {
  const order = orders.find((entry) => entry.id === orderId);
  if (!order) return;

  const address = order.address || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const printArea = document.querySelector("#printArea");
  if (!printArea) return;

  printArea.innerHTML = `
    <div class="dispatch-label">
      <div class="dispatch-label-head">
        <strong>tcglocker</strong>
        <span>${escapeHtml(orderProcessingLabel(order))} ${escapeHtml(order.order_ref || "")}</span>
      </div>
      <div class="dispatch-label-grid">
        <section>
          <span>Ship to</span>
          <strong>${escapeHtml(order.customer_name || "Customer")}</strong>
          <p>
            ${[
              address.line1,
              address.line2,
              address.city,
              address.county,
              address.postcode,
              address.country
            ].filter(Boolean).map(escapeHtml).join("<br />")}
          </p>
          ${address.phone ? `<p>${escapeHtml(address.phone)}</p>` : ""}
        </section>
        <section>
          <span>Service</span>
          <strong>${escapeHtml(trackingValue(order, "carrier"))}</strong>
          <p>${trackingValue(order, "number") ? `Tracking: ${escapeHtml(trackingValue(order, "number"))}` : "Tracking not added"}</p>
        </section>
      </div>
      <section class="dispatch-label-items">
        <span>Items</span>
        ${items.map((item) => `<p>${escapeHtml(item.quantity || 1)}x ${escapeHtml(item.name || item.product_id || "Order item")}</p>`).join("")}
      </section>
    </div>
  `;
  window.print();
}

function renderIssues() {
  const list = document.querySelector("#issueList");
  if (!list) return;

  list.innerHTML = issues.map((issue) => `
    <article class="item-card" data-issue-id="${issue.id}">
      <div class="item-head">
        <div>
          <strong>${issue.order_number ? `#${issue.order_number}` : issue.order_ref || "No order"} - ${issue.summary}</strong>
          <div class="meta">
            <span>${issue.order_ref || "No reference"}</span>
            <span>${issue.customer_email || "No email"}</span>
            <span>${new Date(issue.created_at).toLocaleString()}</span>
          </div>
        </div>
        <span class="pill ${issue.status === "open" ? "hot" : "good"}">${issue.status}</span>
      </div>
      <p>${issue.notes || ""}</p>
      <form class="issue-update-form">
        <label>Status
          <select name="status">
            ${["open", "waiting_customer", "resolved", "closed"].map((status) => `
              <option value="${status}" ${status === issue.status ? "selected" : ""}>${status}</option>
            `).join("")}
          </select>
        </label>
        <label>Notes
          <textarea name="notes">${issue.notes || ""}</textarea>
        </label>
        <button type="submit">Update issue</button>
      </form>
    </article>
  `).join("") || "<p>No order issues logged.</p>";
}

function renderOrderSelects() {
  document.querySelectorAll("[data-order-select]").forEach((select) => {
    select.innerHTML = orders.map((order) => `
      <option value="${order.id}">${orderProcessingLabel(order)} - ${order.email || "No email"}</option>
    `).join("");
  });
}

async function initAdminPanel() {
  if (!(await ensureAdminSession())) return;
  setStatus("Loading admin data...");

  const bulkImportResult = await importBulkCatalogFromQuery();
  if (panelMode === "stock") {
    await loadProfitRules();
    await loadProducts();
  }
  if (panelMode === "shipments") await loadOrders();

  if (bulkImportResult) {
    setStatus(`Bulk import complete: ${bulkImportResult.products} products, ${bulkImportResult.supplier_links} supplier links.`);
  } else {
    setStatus("Ready.");
  }
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus("Signing in...");

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: formValue(form, "email"),
      password: formValue(form, "password")
    });
    if (error) throw error;
    await initAdminPanel();
  } catch (error) {
    setStatus(error.message || "Could not sign in.", true);
  }
});

signOutButton?.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  window.location.reload();
});

document.querySelector("#productForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = formValue(form, "name");
  const id = formValue(form, "id") || slugify(name);

  setStatus("Saving product...");
  try {
    const imageUrl = await uploadProductImage(form, id);
    await rpc("admin_upsert_store_product", {
      p_id: id,
      p_name: name,
      p_set_name: formValue(form, "set_name"),
      p_product_type: formValue(form, "product_type"),
      p_stock_total: Number(formValue(form, "stock_total")),
      p_stock_label: formValue(form, "stock_label") || autoStockLabel(formValue(form, "stock_total")),
      p_price_pence: Math.round(Number(formValue(form, "price")) * 100),
      p_image_url: imageUrl,
      p_is_active: form.querySelector("[name='is_active']").checked
    });
    await rpc("admin_set_store_supplier_vat_mode", {
      p_product_id: id,
      p_supplier_vat_mode: formValue(form, "supplier_vat_mode") || "unknown"
    });
    form.reset();
    form.querySelector("[name='is_active']").checked = true;
    await loadProducts();
    closeModals();
    setStatus("Product saved.");
  } catch (error) {
    setStatus(error.message || "Could not save product.", true);
  }
});

document.querySelector("#productForm [name='image_file']")?.addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) {
    setProductImagePreview(formValue(document.querySelector("#productForm"), "image_url"));
    return;
  }

  if (!file.type.startsWith("image/")) {
    setStatus("Please choose an image file.", true);
    event.currentTarget.value = "";
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    setStatus("Image upload must be 5 MB or smaller.", true);
    event.currentTarget.value = "";
    return;
  }

  setProductImagePreview(URL.createObjectURL(file));
});

document.querySelector("#stockAdjustForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;

  setStatus("Adjusting stock...");
  try {
    await rpc("admin_adjust_store_stock", {
      p_product_id: formValue(form, "product_id"),
      p_delta: Number(formValue(form, "delta")),
      p_note: formValue(form, "note")
    });
    form.reset();
    await loadProducts();
    closeModals();
    setStatus("Stock adjusted.");
  } catch (error) {
    setStatus(error.message || "Could not adjust stock.", true);
  }
});

document.querySelector("#downloadStockCsv")?.addEventListener("click", downloadStockCsv);

document.querySelector("#copyStockCsv")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(activeStockCsvText());
    setStatus("Stock CSV copied.");
  } catch (error) {
    setStatus(error.message || "Could not copy CSV.", true);
  }
});

document.querySelector("#stockCsvFile")?.addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const text = await file.text();
  document.querySelector("#stockCsvPreview").value = text;
  renderStockCsvGrid(csvObjectsFromText(text));
  setStatus(`Loaded ${file.name}. Review it, then import.`);
});

document.querySelector("#stockCsvImportForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const csv = activeStockCsvText();
  document.querySelector("#stockCsvPreview").value = csv;
  const importedProducts = csvRowsToProducts(csv);

  if (!importedProducts.length) {
    setStatus("CSV has no product rows to import.", true);
    return;
  }

  setStatus(`Importing ${importedProducts.length} CSV rows...`);
  try {
    for (const product of importedProducts) {
      await rpc("admin_upsert_store_product", {
        p_id: product.id,
        p_name: product.name,
        p_set_name: product.set_name,
        p_product_type: product.product_type,
        p_stock_total: product.stock_total,
        p_stock_label: product.stock_label,
        p_price_pence: product.price_pence,
        p_image_url: product.image_url,
        p_is_active: product.is_active
      });
    }
    await loadProducts();
    closeModals();
    setStatus(`Imported ${importedProducts.length} stock rows.`);
  } catch (error) {
    setStatus(error.message || "Could not import stock CSV.", true);
  }
});

document.querySelector("#profitRulesForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus("Saving profit rules...");

  const settings = {
    checkout_fee_pence: penceFromGbpInput(formValue(form, "checkout_fee_gbp")),
    minimum_checkout_subtotal_pence: penceFromGbpInput(formValue(form, "minimum_checkout_gbp")),
    outbound_shipping_cost_pence: penceFromGbpInput(formValue(form, "outbound_shipping_gbp")),
    packaging_cost_per_order_pence: penceFromGbpInput(formValue(form, "packaging_order_gbp")),
    packaging_cost_per_item_pence: penceFromGbpInput(formValue(form, "packaging_item_gbp")),
    payment_fee_basis_points: basisPointsFromPercentInput(formValue(form, "payment_fee_percent")),
    payment_fee_fixed_pence: penceFromGbpInput(formValue(form, "payment_fee_fixed_gbp")),
    minimum_profit_pence: penceFromGbpInput(formValue(form, "minimum_profit_gbp")),
    minimum_margin_basis_points: basisPointsFromPercentInput(formValue(form, "minimum_margin_percent")),
    default_vat_rate_basis_points: basisPointsFromPercentInput(formValue(form, "vat_rate_percent")),
    supplier_price_stale_after_minutes: Number(formValue(form, "supplier_stale_minutes")) || 60,
    vat_registered: form.querySelector("[name='vat_registered']").checked,
    margin_scheme_enabled: form.querySelector("[name='margin_scheme_enabled']").checked,
    block_checkout_on_stale_supplier: form.querySelector("[name='block_checkout_on_stale_supplier']").checked
  };

  try {
    const payload = await rpc("admin_save_store_profit_rules", {
      p_settings: settings,
      p_bands: readProfitBands()
    });
    profitRules = {
      settings: payload?.settings || settings,
      bands: Array.isArray(payload?.bands) ? payload.bands : readProfitBands()
    };
    renderProfitRulesForm();
    await loadProducts();
    closeModals();
    setStatus("Profit rules saved.");
  } catch (error) {
    setStatus(error.message || "Could not save profit rules.", true);
  }
});

document.querySelector("#addProfitBand")?.addEventListener("click", () => {
  profitRules.bands = readProfitBands();
  profitRules.bands.push(defaultProfitBand());
  renderProfitBands();
});

document.querySelector("#profitBandList")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-profit-band]");
  if (!button) return;

  profitRules.bands = readProfitBands().filter((_, index) => index !== Number(button.dataset.removeProfitBand));
  if (!profitRules.bands.length) profitRules.bands.push(defaultProfitBand());
  renderProfitBands();
});

document.querySelector("#addStockCsvRow")?.addEventListener("click", () => {
  const rows = readStockCsvGridRows();
  rows.push(Object.fromEntries(STOCK_CSV_COLUMNS.map((column) => [column, column === "index" ? rows.length + 1 : ""])));
  renderStockCsvGrid(rows);
  document.querySelector("#stockCsvPreview").value = stockCsvTextFromRows(rows);
});

document.querySelector("#resetStockCsvGrid")?.addEventListener("click", () => {
  updateStockCsvPreview();
  setStatus("CSV grid reset from live stock.");
});

document.querySelector("#stockCsvGrid")?.addEventListener("input", () => {
  document.querySelector("#stockCsvPreview").value = activeStockCsvText();
});

document.querySelector("#stockCsvGrid")?.addEventListener("pointerdown", (event) => {
  const columnHandle = event.target.closest("[data-csv-resize-handle]");
  const rowHandle = event.target.closest("[data-csv-row-resize]");

  if (columnHandle) {
    event.preventDefault();
    startCsvColumnResize(event, columnHandle.dataset.csvResizeHandle);
    return;
  }

  if (rowHandle) {
    event.preventDefault();
    startCsvRowResize(event, rowHandle.dataset.csvRowResize);
  }
});

document.querySelector("#productList")?.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-product]");
  const adjustButton = event.target.closest("[data-adjust-product]");

  if (deleteMode) return;
  if (editButton) openEditProductModal(editButton.dataset.editProduct);
  if (adjustButton) openAdjustModal(adjustButton.dataset.adjustProduct);
});

document.querySelector("#productList")?.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-delete-select]");
  if (!checkbox) return;

  if (checkbox.checked) selectedDeleteProductIds.add(checkbox.dataset.deleteSelect);
  else selectedDeleteProductIds.delete(checkbox.dataset.deleteSelect);

  checkbox.closest("[data-product-card]")?.classList.toggle("selected-delete", checkbox.checked);
  updateDeleteControls();
});

document.querySelectorAll("[data-open-modal]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.openModal === "productModal") openProductModal();
    else openModal(button.dataset.openModal);
  });
});

document.querySelectorAll("[data-close-modal]").forEach((button) => {
  button.addEventListener("click", closeModals);
});

document.querySelectorAll(".modal").forEach((modal) => {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModals();
  });
});

document.querySelector("#bottomRefreshButton")?.addEventListener("click", initAdminPanel);

document.querySelector("#deleteModeButton")?.addEventListener("click", () => {
  setDeleteMode(!deleteMode);
});

document.querySelector("#deleteSelectedButton")?.addEventListener("click", async () => {
  const productIds = Array.from(selectedDeleteProductIds);
  if (!productIds.length) return;

  const productNames = productIds
    .map((productId) => productById(productId)?.name || productId)
    .slice(0, 6)
    .join("\n");
  const extraCount = Math.max(productIds.length - 6, 0);
  const confirmed = window.confirm(
    `Delete ${productIds.length} selected item${productIds.length === 1 ? "" : "s"}?\n\n${productNames}${extraCount ? `\n...and ${extraCount} more` : ""}\n\nProducts in active baskets, checkout, or paid order history will be blocked.`
  );

  if (!confirmed) return;

  setStatus(`Deleting ${productIds.length} selected item${productIds.length === 1 ? "" : "s"}...`);
  try {
    const results = await rpc("admin_delete_store_products", { p_product_ids: productIds });
    const deletedIds = results.filter((result) => result.deleted).map((result) => result.product_id);
    await removeDeletedProductImages(deletedIds);
    selectedDeleteProductIds.clear();
    deleteMode = false;
    await loadProducts();

    const blocked = results.filter((result) => !result.deleted);
    if (blocked.length) {
      setStatus(
        `Deleted ${deletedIds.length}. Blocked ${blocked.length}: ${blocked.map((result) => `${result.product_id} (${result.message})`).join("; ")}`,
        true
      );
    } else {
      setStatus(`Deleted ${deletedIds.length} item${deletedIds.length === 1 ? "" : "s"}.`);
    }
  } catch (error) {
    setStatus(error.message || "Could not delete selected products.", true);
  }
});

document.querySelector("#orderList")?.addEventListener("submit", async (event) => {
  const form = event.target.closest(".order-update-form");
  if (!form) return;
  event.preventDefault();

  setStatus("Saving order...");

  try {
    await saveOrderFromForm(form);
    await loadOrders();
    setStatus("Order updated.");
  } catch (error) {
    setStatus(error.message || "Could not update order.", true);
  }
});

document.querySelector("#orderList")?.addEventListener("click", async (event) => {
  const cardsButton = event.target.closest("[data-order-cards]");
  const printButton = event.target.closest("[data-print-label]");
  const finishButton = event.target.closest("[data-finish-order]");
  const undoButton = event.target.closest("[data-undo-complete]");
  const cancelButton = event.target.closest("[data-cancel-order]");

  if (cardsButton) {
    openProcurementModal(cardsButton.dataset.orderCards);
    return;
  }

  if (printButton) {
    printOrderLabel(printButton.dataset.printLabel);
    return;
  }

  if (cancelButton) {
    const orderId = cancelButton.dataset.cancelOrder;
    const nextStage = Number(cancelOrderConfirmStages.get(orderId) || 0) + 1;
    cancelOrderConfirmStages.set(orderId, nextStage);
    applyCancelOrderButtonState(cancelButton);

    if (nextStage < CANCEL_ORDER_CONFIRM_LABELS.length) {
      setStatus(nextStage === 1 ? "Confirm refund cancellation: are you sure?" : "Second confirmation required before submitting refund.");
    } else {
      try {
        await cancelCustomerOrder(orderId);
      } catch (error) {
        resetCancelOrderButton(cancelButton);
        cancelOrderConfirmStages.delete(orderId);
        setStatus(error.message || "Could not cancel order.", true);
      }
    }
    return;
  }

  if (undoButton) {
    const form = undoButton.closest("[data-order-id]")?.querySelector(".order-update-form");
    if (!form) return;

    setStatus("Moving order back to awaiting delivery...");
    try {
      form.querySelector("[name='fulfilment_status']").value = "processing";
      await saveOrderFromForm(form, "processing");
      shipmentFilters.status = "active";
      await loadOrders();
      setStatus("Order moved back to awaiting delivery.");
    } catch (error) {
      setStatus(error.message || "Could not undo completed order.", true);
    }
    return;
  }

  if (!finishButton) return;
  if (finishButton.dataset.confirmReady !== "true") {
    startCompleteOrderConfirmation(finishButton);
    return;
  }

  const form = finishButton.closest("[data-order-id]")?.querySelector(".order-update-form");
  if (!form) return;

  setStatus("Marking order sent complete...");
  try {
    clearCompleteOrderConfirmation(finishButton.dataset.finishOrder);
    form.querySelector("[name='fulfilment_status']").value = "completed";
    await saveOrderFromForm(form, "completed");
    await loadOrders();
    setStatus("Order marked sent complete.");
  } catch (error) {
    setStatus(error.message || "Could not complete order.", true);
  }
});

document.querySelector("#orderSearchInput")?.addEventListener("input", (event) => {
  shipmentFilters.query = event.currentTarget.value;
  renderOrders();
});

document.querySelector("#orderStatusFilters")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-order-filter]");
  if (!button) return;
  shipmentFilters.status = button.dataset.orderFilter;
  renderOrders();
});

document.querySelector("#clearOrderSearch")?.addEventListener("click", () => {
  shipmentFilters.query = "";
  shipmentFilters.status = "active";
  renderOrders();
});

document.querySelector("#issueForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;

  setStatus("Creating issue...");
  try {
    await rpc("admin_create_store_order_issue", {
      p_order_id: formValue(form, "order_id") || null,
      p_customer_email: formValue(form, "customer_email"),
      p_summary: formValue(form, "summary"),
      p_notes: formValue(form, "notes")
    });
    form.reset();
    await loadOrders();
    setStatus("Issue logged.");
  } catch (error) {
    setStatus(error.message || "Could not create issue.", true);
  }
});

document.querySelector("#issueList")?.addEventListener("submit", async (event) => {
  const form = event.target.closest(".issue-update-form");
  if (!form) return;
  event.preventDefault();

  const card = form.closest("[data-issue-id]");
  setStatus("Saving issue...");
  try {
    await rpc("admin_update_store_order_issue", {
      p_issue_id: card.dataset.issueId,
      p_status: formValue(form, "status"),
      p_notes: formValue(form, "notes")
    });
    await loadOrders();
    setStatus("Issue updated.");
  } catch (error) {
    setStatus(error.message || "Could not update issue.", true);
  }
});

document.querySelector("#procurementBody")?.addEventListener("click", async (event) => {
  const saveAllButton = event.target.closest("[data-save-all-procurements]");
  const useListingButton = event.target.closest("[data-use-procurement-listing]");
  const copyButton = event.target.closest("[data-copy-text]");

  if (saveAllButton) {
    const forms = Array.from(document.querySelectorAll("#procurementBody .procurement-save-form"));
    const filledForms = forms.filter((form) => formValue(form, "listing_url") || formValue(form, "supplier_order_ref"));

    if (!filledForms.length) {
      setStatus("Add at least one order URL or supplier order ID first.", true);
      return;
    }

    for (const form of filledForms) {
      if (!form.reportValidity()) return;
    }

    setStatus("Saving supplier orders...");
    try {
      for (const form of filledForms) {
        await saveProcurementForm(form, { refreshAfter: false, updateOrderStatus: false });
      }
      await setOrderFulfilmentStatus(currentProcurementOrderId || formValue(filledForms[0], "order_id"), "processing");
      shipmentFilters.status = "pending";
      await loadOrders();
      await loadProcurements();
      const order = orders.find((entry) => entry.id === currentProcurementOrderId || entry.id === formValue(filledForms[0], "order_id"));
      if (order) renderProcurement(order, currentProcurementPayload, false, "Supplier orders saved. Customer order is now awaiting delivery.");
      renderOrders();
      setStatus("Supplier orders saved. Customer order moved to awaiting delivery.");
    } catch (error) {
      setStatus(error.message || "Could not save supplier orders.", true);
    }
    return;
  }

  if (useListingButton) {
    const form = useListingButton.closest(".procurement-line")?.querySelector(".procurement-save-form");
    if (!form) return;

    form.querySelector("[name='supplier_item_id']").value = useListingButton.dataset.itemId || "";
    form.querySelector("[name='listing_url']").value = useListingButton.dataset.url || "";
    form.querySelector("[name='listing_title']").value = useListingButton.dataset.title || "";
    form.querySelector("[name='unit_cost_gbp']").value = gbpInputFromPence(useListingButton.dataset.unitCostPence || 0);
    form.querySelector("[name='shipping_gbp']").value = gbpInputFromPence(useListingButton.dataset.shippingPence || 0);
    form.querySelector("[name='status']").value = "watching";
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setStatus("Listing details copied into the supplier purchase form.");
    return;
  }

  if (!copyButton) return;

  try {
    await navigator.clipboard.writeText(copyButton.dataset.copyText || "");
    copyButton.textContent = "Copied";
    setTimeout(() => {
      copyButton.textContent = "Copy ID";
    }, 1400);
  } catch (error) {
    setStatus(error.message || "Could not copy eBay item ID.", true);
  }
});

document.querySelector("#procurementBody")?.addEventListener("submit", async (event) => {
  const form = event.target.closest(".procurement-save-form");
  if (!form) return;
  event.preventDefault();

  setStatus("Saving supplier purchase...");

  try {
    await saveProcurementForm(form);
    setStatus("Supplier purchase saved. Customer order moved to awaiting delivery.");
  } catch (error) {
    setStatus(error.message || "Could not save supplier purchase.", true);
  }
});

document.querySelector("#refreshButton")?.addEventListener("click", initAdminPanel);

initAdminPanel().catch((error) => setStatus(error.message || "Could not load admin panel.", true));
