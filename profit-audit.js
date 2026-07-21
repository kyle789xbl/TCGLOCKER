const SUPABASE_URL = "https://vfyipmvaejrnhrqckgvn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fKWNwL1s1WWp1TnufoCCng_F9Bz9pot";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const authCard = document.querySelector("#authCard");
const appShell = document.querySelector("#appShell");
const loginForm = document.querySelector("#loginForm");
const signOutButton = document.querySelector("#signOutButton");
const refreshButton = document.querySelector("#refreshButton");
const statusEl = document.querySelector("#status");

let orders = [];
let procurements = [];
let issues = [];
let exportCache = {
  orders: [],
  suppliers: [],
  refunds: [],
  vat: []
};

function moneyFromPence(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(value) || 0) / 100);
}

function numberFromPence(value) {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function penceFromGbpInput(value) {
  const parsed = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function setStatus(message = "", isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
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

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function periodBounds(preset) {
  const now = new Date();
  if (preset === "month") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: now
    };
  }

  if (preset === "quarter") {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return {
      from: new Date(now.getFullYear(), quarterStartMonth, 1),
      to: now
    };
  }

  if (preset === "tax-year") {
    const taxStartYear = now >= new Date(now.getFullYear(), 3, 6) ? now.getFullYear() : now.getFullYear() - 1;
    return {
      from: new Date(taxStartYear, 3, 6),
      to: now
    };
  }

  return { from: null, to: null };
}

function setPresetDates() {
  const preset = document.querySelector("#periodPreset")?.value || "all";
  if (preset === "custom") return;

  const fromInput = document.querySelector("#dateFrom");
  const toInput = document.querySelector("#dateTo");
  const bounds = periodBounds(preset);
  fromInput.value = bounds.from ? isoDate(bounds.from) : "";
  toInput.value = bounds.to ? isoDate(bounds.to) : "";
}

function currentFilters() {
  const fromValue = document.querySelector("#dateFrom")?.value;
  const toValue = document.querySelector("#dateTo")?.value;
  return {
    from: fromValue ? startOfDay(new Date(`${fromValue}T00:00:00`)) : null,
    to: toValue ? endOfDay(new Date(`${toValue}T00:00:00`)) : null,
    vatRate: Number(document.querySelector("#vatRate")?.value || 0),
    processorPercent: Number(document.querySelector("#processorPercent")?.value || 0),
    processorFixedPence: penceFromGbpInput(document.querySelector("#processorFixed")?.value)
  };
}

function orderDate(order) {
  return new Date(order.created_at || order.updated_at || Date.now());
}

function inPeriod(order, filters) {
  const date = orderDate(order);
  if (filters.from && date < filters.from) return false;
  if (filters.to && date > filters.to) return false;
  return true;
}

function orderLabel(order) {
  return order.order_number ? `#${order.order_number}` : order.order_ref || String(order.id || "").slice(0, 8);
}

function orderAddress(order) {
  const address = order.address || {};
  return [address.line1, address.line2, address.city, address.county, address.postcode, address.country]
    .filter(Boolean)
    .join(", ");
}

function orderItemsText(order) {
  return (Array.isArray(order.items) ? order.items : [])
    .map((item) => `${item.quantity || 1}x ${item.name || item.product_id || "Item"}`)
    .join("; ");
}

function orderItems(order) {
  return Array.isArray(order.items) ? order.items : [];
}

function profitSnapshots(order) {
  return orderItems(order).map((item) => item.profit).filter(Boolean);
}

function hasProfitSnapshots(order) {
  return profitSnapshots(order).length > 0;
}

function profitSnapshotSum(order, key) {
  return profitSnapshots(order).reduce((sum, profit) => sum + Number(profit?.[key] || 0), 0);
}

function isCancelledOrder(order) {
  return order.fulfilment_status === "cancelled" || ["cancelled", "refunded"].includes(order.status);
}

function isCompletedOrder(order) {
  return order.fulfilment_status === "completed" || order.status === "fulfilled";
}

function isConfirmedSupplierPurchase(entry) {
  return !["cancelled", "issue"].includes(entry.status) &&
    Boolean(String(entry.supplier_order_ref || "").trim()) &&
    Boolean(String(entry.listing_url || "").trim());
}

function orderProcurements(orderId) {
  return procurements.filter((entry) => entry.order_id === orderId);
}

function hasConfirmedSupplierPurchase(orderId) {
  return orderProcurements(orderId).some(isConfirmedSupplierPurchase);
}

function operationalState(order) {
  if (isCancelledOrder(order)) return "Refunds";
  if (isCompletedOrder(order)) return "Complete";
  if (hasConfirmedSupplierPurchase(order.id)) return "Pending delivery";
  return "Active (not ordered)";
}

function refundAmountPence(order) {
  const refund = order.refund || {};
  if (Number(refund.amount_pence) > 0) return Number(refund.amount_pence);
  if (isCancelledOrder(order)) return Number(order.total_pence || 0);
  return 0;
}

function supplierCostForOrder(orderId) {
  const order = orders.find((entry) => entry.id === orderId);
  if (order && hasProfitSnapshots(order)) return profitSnapshotSum(order, "supplier_cost_total_pence");

  return orderProcurements(orderId)
    .filter(isConfirmedSupplierPurchase)
    .reduce((sum, entry) => sum + Number(entry.total_cost_pence || 0), 0);
}

function processorFeeForOrder(order, filters) {
  const gross = Number(order.total_pence || 0);
  if (gross <= 0 || isCancelledOrder(order)) return 0;
  return Math.round((gross * Math.max(filters.processorPercent, 0)) / 100) + Math.max(filters.processorFixedPence, 0);
}

function vatFromGross(grossPence, vatRate) {
  const rate = Math.max(Number(vatRate) || 0, 0);
  if (!grossPence || !rate) return 0;
  return Math.round((grossPence * rate) / (100 + rate));
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function calculateAudit() {
  const filters = currentFilters();
  const selectedOrders = orders.filter((order) => inPeriod(order, filters));
  const selectedOrderIds = new Set(selectedOrders.map((order) => order.id));
  const selectedProcurements = procurements.filter((entry) => selectedOrderIds.has(entry.order_id));
  const selectedIssues = issues.filter((issue) => selectedOrderIds.has(issue.order_id));

  let grossSalesPence = 0;
  let refundPence = 0;
  let supplierCostPence = 0;
  let processorFeePence = 0;
  let vatPence = 0;

  for (const order of selectedOrders) {
    const gross = Number(order.total_pence || 0);
    const refund = refundAmountPence(order);
    const net = Math.max(0, gross - refund);
    const hasSnapshots = hasProfitSnapshots(order);
    const orderVat = hasSnapshots ? profitSnapshotSum(order, "vat_due_pence") : vatFromGross(net, filters.vatRate);
    const orderSupplierCost = supplierCostForOrder(order.id);
    const orderProcessorFee = hasSnapshots ? profitSnapshotSum(order, "payment_fee_pence") : processorFeeForOrder(order, filters);

    grossSalesPence += gross;
    refundPence += refund;
    supplierCostPence += orderSupplierCost;
    processorFeePence += orderProcessorFee;
    vatPence += orderVat;
  }

  const netSalesPence = Math.max(0, grossSalesPence - refundPence);
  const exVatSalesPence = Math.max(0, netSalesPence - vatPence);
  const profitPence = exVatSalesPence - supplierCostPence - processorFeePence;
  const margin = exVatSalesPence ? (profitPence / exVatSalesPence) * 100 : 0;

  return {
    filters,
    selectedOrders,
    selectedProcurements,
    selectedIssues,
    grossSalesPence,
    refundPence,
    netSalesPence,
    vatPence,
    exVatSalesPence,
    supplierCostPence,
    processorFeePence,
    profitPence,
    margin
  };
}

function kpi(label, value, note = "", tone = "") {
  return `
    <article class="panel audit-kpi ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function renderKpis(model) {
  document.querySelector("#kpiGrid").innerHTML = [
    kpi("Gross customer sales", moneyFromPence(model.grossSalesPence), `${model.selectedOrders.length} orders`),
    kpi("Refunds / cancellations", moneyFromPence(model.refundPence), "Blue refund tab orders", "blue"),
    kpi("Net sales inc VAT", moneyFromPence(model.netSalesPence), "Gross minus refunds", "good"),
    kpi("VAT estimate", moneyFromPence(model.vatPence), `${model.filters.vatRate || 0}% inclusive VAT`),
    kpi("Sales ex VAT", moneyFromPence(model.exVatSalesPence), "Net sales less estimated VAT"),
    kpi("Supplier cost", moneyFromPence(model.supplierCostPence), `${model.selectedProcurements.length} supplier rows`, "warn"),
    kpi("Payment fees estimate", moneyFromPence(model.processorFeePence), "Uses the fee inputs above"),
    kpi("Trading profit estimate", moneyFromPence(model.profitPence), `${model.margin.toFixed(1)}% margin`, model.profitPence >= 0 ? "good" : "hot")
  ].join("");
}

function groupByMonth(model) {
  const rows = new Map();
  for (const order of model.selectedOrders) {
    const key = monthKey(orderDate(order));
    if (!rows.has(key)) {
      rows.set(key, {
        period: key,
        gross_pence: 0,
        refunds_pence: 0,
        net_sales_pence: 0,
        vat_pence: 0,
        ex_vat_sales_pence: 0,
        supplier_cost_pence: 0,
        processor_fee_pence: 0,
        profit_pence: 0,
        orders: 0
      });
    }

    const row = rows.get(key);
    const gross = Number(order.total_pence || 0);
    const refund = refundAmountPence(order);
    const net = Math.max(0, gross - refund);
    const hasSnapshots = hasProfitSnapshots(order);
    const vat = hasSnapshots ? profitSnapshotSum(order, "vat_due_pence") : vatFromGross(net, model.filters.vatRate);
    const supplierCost = supplierCostForOrder(order.id);
    const processorFee = hasSnapshots ? profitSnapshotSum(order, "payment_fee_pence") : processorFeeForOrder(order, model.filters);
    const netProfit = hasSnapshots
      ? profitSnapshotSum(order, "net_profit_pence")
      : Math.max(0, net - vat) - supplierCost - processorFee;

    row.gross_pence += gross;
    row.refunds_pence += refund;
    row.net_sales_pence += net;
    row.vat_pence += vat;
    row.ex_vat_sales_pence += Math.max(0, net - vat);
    row.supplier_cost_pence += supplierCost;
    row.processor_fee_pence += processorFee;
    row.profit_pence += netProfit;
    row.orders += 1;
  }

  return Array.from(rows.values()).sort((a, b) => a.period.localeCompare(b.period));
}

function renderMonthlyChart(model) {
  const rows = groupByMonth(model);
  const maxValue = Math.max(
    1,
    ...rows.flatMap((row) => [row.gross_pence, row.refunds_pence, row.supplier_cost_pence, Math.abs(row.profit_pence)])
  );

  exportCache.vat = rows.map((row) => ({
    period: row.period,
    orders: row.orders,
    gross_gbp: numberFromPence(row.gross_pence),
    refunds_gbp: numberFromPence(row.refunds_pence),
    net_sales_gbp: numberFromPence(row.net_sales_pence),
    vat_estimate_gbp: numberFromPence(row.vat_pence),
    sales_ex_vat_gbp: numberFromPence(row.ex_vat_sales_pence),
    supplier_cost_gbp: numberFromPence(row.supplier_cost_pence),
    processor_fee_gbp: numberFromPence(row.processor_fee_pence),
    profit_estimate_gbp: numberFromPence(row.profit_pence)
  }));

  document.querySelector("#monthlyChart").innerHTML = rows.map((row) => `
    <div class="chart-row">
      <strong>${escapeHtml(row.period)}</strong>
      <div class="chart-bars">
        <span class="bar gross" style="--bar-width:${Math.max(3, (row.gross_pence / maxValue) * 100)}%"></span>
        <span class="bar refund" style="--bar-width:${Math.max(3, (row.refunds_pence / maxValue) * 100)}%"></span>
        <span class="bar cost" style="--bar-width:${Math.max(3, (row.supplier_cost_pence / maxValue) * 100)}%"></span>
        <span class="bar profit ${row.profit_pence < 0 ? "negative" : ""}" style="--bar-width:${Math.max(3, (Math.abs(row.profit_pence) / maxValue) * 100)}%"></span>
      </div>
      <div class="chart-money">
        <span>Sales ${moneyFromPence(row.gross_pence)}</span>
        <span>Refunds ${moneyFromPence(row.refunds_pence)}</span>
        <span>Cost ${moneyFromPence(row.supplier_cost_pence)}</span>
        <span>Profit ${moneyFromPence(row.profit_pence)}</span>
      </div>
    </div>
  `).join("") || "<p>No orders in this period.</p>";

  renderTable("#vatLedger", exportCache.vat, [
    "period",
    "orders",
    "gross_gbp",
    "refunds_gbp",
    "net_sales_gbp",
    "vat_estimate_gbp",
    "sales_ex_vat_gbp",
    "profit_estimate_gbp"
  ]);
}

function renderStateBars(model) {
  const stateCounts = model.selectedOrders.reduce((map, order) => {
    const state = operationalState(order);
    map.set(state, (map.get(state) || 0) + 1);
    return map;
  }, new Map());
  const states = ["Active (not ordered)", "Pending delivery", "Complete", "Refunds"];
  const maxCount = Math.max(1, ...states.map((state) => stateCounts.get(state) || 0));

  document.querySelector("#stateBars").innerHTML = states.map((state) => {
    const count = stateCounts.get(state) || 0;
    return `
      <div class="state-row">
        <span>${escapeHtml(state)}</span>
        <strong>${count}</strong>
        <div><i style="--bar-width:${(count / maxCount) * 100}%"></i></div>
      </div>
    `;
  }).join("");
}

function renderOrderLedger(model) {
  const rows = model.selectedOrders.map((order) => {
    const gross = Number(order.total_pence || 0);
    const refund = refundAmountPence(order);
    const net = Math.max(0, gross - refund);
    const hasSnapshots = hasProfitSnapshots(order);
    const vat = hasSnapshots ? profitSnapshotSum(order, "vat_due_pence") : vatFromGross(net, model.filters.vatRate);
    const snapshotProfit = hasSnapshots ? profitSnapshotSum(order, "net_profit_pence") : null;
    return {
      order: orderLabel(order),
      date: orderDate(order).toLocaleString(),
      customer_email: order.email || "",
      customer_name: order.customer_name || "",
      items: orderItemsText(order),
      state: operationalState(order),
      profit_source: hasSnapshots ? "checkout_snapshot" : "estimate",
      stripe_session_id: order.stripe_session_id || "",
      stripe_payment_intent_id: order.stripe_payment_intent_id || "",
      gross_gbp: numberFromPence(gross),
      refund_gbp: numberFromPence(refund),
      vat_estimate_gbp: numberFromPence(vat),
      net_ex_vat_gbp: numberFromPence(Math.max(0, net - vat)),
      supplier_cost_gbp: numberFromPence(supplierCostForOrder(order.id)),
      net_profit_gbp: snapshotProfit === null
        ? numberFromPence(Math.max(0, net - vat) - supplierCostForOrder(order.id) - processorFeeForOrder(order, model.filters))
        : numberFromPence(snapshotProfit),
      address: orderAddress(order)
    };
  });
  exportCache.orders = rows;
  renderTable("#orderLedger", rows, ["order", "date", "customer_email", "state", "profit_source", "gross_gbp", "refund_gbp", "vat_estimate_gbp", "supplier_cost_gbp", "net_profit_gbp", "stripe_payment_intent_id"]);
}

function renderSupplierLedger(model) {
  const orderById = new Map(model.selectedOrders.map((order) => [order.id, order]));
  const rows = model.selectedProcurements.map((entry) => {
    const order = orderById.get(entry.order_id) || {};
    return {
      order: orderLabel(order),
      supplier: entry.supplier || "",
      supplier_order_ref: entry.supplier_order_ref || "",
      listing_url: entry.listing_url || "",
      product: entry.product_name || entry.product_id || "",
      quantity: entry.quantity || 0,
      product_cost_gbp: numberFromPence(Number(entry.unit_cost_pence || 0) * Number(entry.quantity || 0)),
      delivery_cost_gbp: numberFromPence(entry.shipping_pence || 0),
      total_cost_gbp: numberFromPence(entry.total_cost_pence || 0),
      status: entry.status || "",
      saved_at: entry.created_at ? new Date(entry.created_at).toLocaleString() : ""
    };
  });
  exportCache.suppliers = rows;
  renderTable("#supplierLedger", rows, ["order", "supplier", "supplier_order_ref", "listing_url", "product", "quantity", "total_cost_gbp", "status"]);
}

function renderRefundLedger(model) {
  const rows = model.selectedOrders
    .filter((order) => isCancelledOrder(order) || refundAmountPence(order) > 0)
    .map((order) => {
      const cancellation = order.cancellation || {};
      const refund = order.refund || {};
      return {
        order: orderLabel(order),
        date: orderDate(order).toLocaleString(),
        customer_email: order.email || "",
        amount_gbp: numberFromPence(refundAmountPence(order)),
        refund_status: refund.status || "",
        stripe_refund_id: refund.stripe_refund_id || "",
        email_status: cancellation.email_status || "",
        reason: cancellation.reason || "",
        email_body: cancellation.email_body || ""
      };
    });
  exportCache.refunds = rows;
  renderTable("#refundLedger", rows, ["order", "date", "customer_email", "amount_gbp", "refund_status", "stripe_refund_id", "email_status", "reason"]);
}

function renderTable(selector, rows, columns) {
  const table = document.querySelector(selector);
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td>No rows for this period.</td></tr></tbody>`;
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>${columns.map((column) => `<th>${escapeHtml(column.replaceAll("_", " "))}</th>`).join("")}</tr>
    </thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          ${columns.map((column) => {
            const value = row[column] || "";
            if (column === "listing_url" && value) {
              return `<td><a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">Open</a></td>`;
            }
            return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
          }).join("")}
        </tr>
      `).join("")}
    </tbody>
  `;
}

function renderChecklist(model) {
  const missingStripe = model.selectedOrders.filter((order) => !order.stripe_payment_intent_id && Number(order.total_pence || 0) > 0).length;
  const missingSupplierRefs = model.selectedOrders.filter((order) =>
    operationalState(order) === "Pending delivery" &&
    !orderProcurements(order.id).some((entry) => String(entry.supplier_order_ref || "").trim())
  ).length;
  const openIssues = model.selectedIssues.filter((issue) => !["closed", "resolved"].includes(issue.status)).length;
  const refundsReady = exportCache.refunds.filter((row) => row.refund_status === "stripe_refund_ready").length;

  document.querySelector("#auditChecklist").innerHTML = `
    <div class="audit-evidence good"><strong>${model.selectedOrders.length}</strong><span>Order records in period</span></div>
    <div class="audit-evidence ${missingStripe ? "warn" : "good"}"><strong>${missingStripe}</strong><span>Orders missing Stripe payment intent</span></div>
    <div class="audit-evidence ${missingSupplierRefs ? "warn" : "good"}"><strong>${missingSupplierRefs}</strong><span>Pending orders missing supplier order ID</span></div>
    <div class="audit-evidence ${refundsReady ? "warn" : "good"}"><strong>${refundsReady}</strong><span>Refunds queued for Stripe processing</span></div>
    <div class="audit-evidence ${openIssues ? "warn" : "good"}"><strong>${openIssues}</strong><span>Open customer issue records</span></div>
    <div class="audit-note">
      Keep Stripe payouts, supplier invoices, postage labels, refund confirmations, and customer issue notes with these exports for a clean audit trail.
    </div>
  `;
}

function renderAudit() {
  document.querySelector("#generatedAt").textContent = new Date().toLocaleString();
  const model = calculateAudit();
  renderKpis(model);
  renderMonthlyChart(model);
  renderStateBars(model);
  renderOrderLedger(model);
  renderSupplierLedger(model);
  renderRefundLedger(model);
  renderChecklist(model);
}

async function loadAuditData() {
  setStatus("Loading profit and audit data...");
  orders = await rpc("admin_list_store_orders");
  orders = Array.isArray(orders) ? orders : [];

  try {
    procurements = await rpc("admin_list_store_procurements");
  } catch (error) {
    procurements = [];
    console.warn("Could not load supplier purchases", error);
  }

  try {
    issues = await rpc("admin_list_store_order_issues");
  } catch (error) {
    issues = [];
    console.warn("Could not load order issues", error);
  }

  orders.sort((a, b) => orderDate(b) - orderDate(a));
  renderAudit();
  setStatus("Ready.");
}

function downloadCsv(type) {
  const rows = exportCache[type] || [];
  if (!rows.length) {
    setStatus("No rows to export for this view.", true);
    return;
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tcglocker-${type}-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`${type} CSV exported.`);
}

async function initAuditPanel() {
  if (!(await ensureAdminSession())) return;
  setPresetDates();
  await loadAuditData();
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus("Signing in...");

  try {
    const formData = new FormData(form);
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: String(formData.get("email") || "").trim(),
      password: String(formData.get("password") || "")
    });
    if (error) throw error;
    await initAuditPanel();
  } catch (error) {
    setStatus(error.message || "Could not sign in.", true);
  }
});

signOutButton?.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  window.location.reload();
});

refreshButton?.addEventListener("click", loadAuditData);

document.querySelector("#periodPreset")?.addEventListener("change", () => {
  setPresetDates();
  renderAudit();
});

["#dateFrom", "#dateTo", "#vatRate", "#processorPercent", "#processorFixed"].forEach((selector) => {
  document.querySelector(selector)?.addEventListener("input", () => {
    document.querySelector("#periodPreset").value = selector.startsWith("#date") ? "custom" : document.querySelector("#periodPreset").value;
    renderAudit();
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-export]");
  if (!button) return;
  downloadCsv(button.dataset.export);
});

initAuditPanel().catch((error) => {
  setStatus(error.message || "Could not load audit panel.", true);
});
