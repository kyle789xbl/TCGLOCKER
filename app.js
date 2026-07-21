const SUPABASE_URL = "https://vfyipmvaejrnhrqckgvn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fKWNwL1s1WWp1TnufoCCng_F9Bz9pot";
const SESSION_KEY = "card-vault-session-id";
const PENDING_PROFILE_KEY = "card-vault-pending-profile";
const PRODUCT_PAGE_SIZE = 96;
const MAX_ITEM_QUANTITY = 2;
const CHECKOUT_FEE_GBP = 3.49;
const TEST_CHECKOUT_MODE = true;
const HIDDEN_STOREFRONT_TYPES = new Set(["accessory", "merch"]);

const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let products = [];

const state = {
  filter: "all",
  search: "",
  sort: "featured",
  inStockOnly: false,
  cart: new Map(),
  cartExpiries: new Map(),
  cartStatuses: new Map(),
  cartCheckoutIds: new Map(),
  cartLineAnimations: new Set(),
  discountRate: 0,
  watchlist: new Set(),
  loading: true,
  productPage: 1,
  syncing: new Set(),
  user: null,
  profile: null,
  authMode: "join",
  pendingVerificationEmail: "",
  expiryPromptOpen: false,
  expiryWarningDismissedUntil: 0,
  expiryReloading: false,
  authBusy: false
};

const grid = document.querySelector("#productGrid");
const template = document.querySelector("#productTemplate");
const cartPanel = document.querySelector("#cartPanel");
const cartItems = document.querySelector("#cartItems");
const cartCount = document.querySelector("#cartCount");
const cartButton = document.querySelector("#cartButton");
const closeCart = document.querySelector("#closeCart");
const scrim = document.querySelector("#scrim");
const accountPanel = document.querySelector("#accountPanel");
const accountButton = document.querySelector("#accountButton");
const accountLabel = document.querySelector("#accountLabel");
const closeAccount = document.querySelector("#closeAccount");
const accountSubtitle = document.querySelector("#accountSubtitle");
const authTabs = document.querySelector(".auth-tabs");
const joinForm = document.querySelector("#joinForm");
const signinForm = document.querySelector("#signinForm");
const verifyWait = document.querySelector("#verifyWait");
const verifyEmail = document.querySelector("#verifyEmail");
const resendVerification = document.querySelector("#resendVerification");
const showSigninButton = document.querySelector("#showSigninButton");
const profileForm = document.querySelector("#profileForm");
const authStatus = document.querySelector("#authStatus");
const signOutButton = document.querySelector("#signOutButton");
const resultCount = document.querySelector("#resultCount");
const toast = document.querySelector("#toast");
const checkoutForm = document.querySelector("#checkout");
const orderNote = document.querySelector("#orderNote");
const deliveryName = document.querySelector("#deliveryName");
const deliveryAddress = document.querySelector("#deliveryAddress");
const changeDelivery = document.querySelector("#changeDelivery");
const sessionId = getSessionId();
let toastTimer;
let basketTimer;

function getSessionId() {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;

  const next = window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  window.localStorage.setItem(SESSION_KEY, next);
  return next;
}

function money(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
}

function millisecondsUntil(value) {
  if (!value) return 0;
  return new Date(value).getTime() - Date.now();
}

function timerText(value) {
  const totalSeconds = Math.max(0, Math.ceil(millisecondsUntil(value) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function typeLabel(type) {
  const labels = {
    booster: "Booster",
    bundle: "Bundle",
    box: "Box",
    etb: "ETB",
    case: "Case",
    tin: "Tin",
    single: "Single",
    deck: "Deck",
    accessory: "Accessory",
    merch: "Merch",
    code_card: "Code card",
    other: "Other"
  };
  return labels[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

function stockClass(product) {
  if (product.stock === 0) return "out";
  if (product.stock <= 3) return "low";
  return "";
}

function stockText(product) {
  if (product.stock === 0) return "Sold out";
  if (product.stock <= 3) return `${product.stockLabel} left`;
  return `${product.stockLabel} in stock`;
}

function productPower(product) {
  if (product.price > 1000 || product.stock <= 3) return 96;
  if (product.price > 100) return 82;
  if (product.stock >= 500) return 70;
  if (product.type === "bundle" || product.type === "case") return 62;
  return 48;
}

function isRegionalImport(product) {
  const text = `${product.name || ""} ${product.set || ""}`.toLowerCase();
  return /^\s*\((japanese|korean|simplified chinese|traditional chinese|chinese)\)/.test(text);
}

function featuredTypeRank(product) {
  const ranks = {
    etb: 0,
    tin: 1,
    bundle: 2,
    deck: 3,
    booster: 4,
    box: 5,
    case: 6,
    code_card: 8,
    other: 9,
    single: 99
  };
  return ranks[product.type] ?? 20;
}

function normaliseStockLabel(row) {
  const available = Number(row.available_stock ?? row.stock_total ?? 0);
  const total = Number(row.stock_total ?? available);
  if (available !== total) return String(available);
  return row.stock_label || String(available);
}

function productFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    type: row.product_type,
    stock: Number(row.available_stock ?? row.stock_total ?? 0),
    stockTotal: Number(row.stock_total ?? 0),
    reservedStock: Number(row.reserved_stock ?? 0),
    stockLabel: normaliseStockLabel(row),
    price: Number(row.price_pence ?? 0) / 100,
    image: row.image_url
  };
}

function mergeProduct(row) {
  if (!row?.id) return;
  const next = productFromRow(row);
  const index = products.findIndex((product) => product.id === next.id);
  if (index === -1) products.push(next);
  else products[index] = { ...products[index], ...next };
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

function showStoreErrorPopup(message = "Error loading store data") {
  let popup = document.querySelector("#storeErrorPopup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "storeErrorPopup";
    popup.className = "error-popup";
    popup.setAttribute("role", "alertdialog");
    popup.setAttribute("aria-modal", "true");
    popup.innerHTML = `
      <div class="error-popup-card">
        <strong>Error loading store data</strong>
        <p>The live store connection failed. Try refreshing or check the Supabase project.</p>
        <button type="button">Retry</button>
      </div>
    `;
    popup.querySelector("button").addEventListener("click", () => {
      popup.classList.remove("show");
      loadProducts();
    });
    document.body.append(popup);
  }

  popup.querySelector("strong").textContent = message;
  popup.classList.add("show");
}

function setAuthStatus(message = "", isError = false) {
  authStatus.textContent = message;
  authStatus.classList.toggle("error", isError);
}

function pendingProfile() {
  const raw = window.localStorage.getItem(PENDING_PROFILE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_error) {
    window.localStorage.removeItem(PENDING_PROFILE_KEY);
    return null;
  }
}

function setFormDisabled(form, disabled) {
  form.querySelectorAll("input, button").forEach((field) => {
    field.disabled = disabled || (field.name === "email" && form === profileForm);
  });
}

function profilePayloadFromForm(form) {
  const formData = new FormData(form);
  return {
    full_name: String(formData.get("full_name") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    address_line1: String(formData.get("address_line1") || "").trim(),
    address_line2: String(formData.get("address_line2") || "").trim(),
    city: String(formData.get("city") || "").trim(),
    county: String(formData.get("county") || "").trim(),
    postcode: String(formData.get("postcode") || "").trim().toUpperCase(),
    country: String(formData.get("country") || "United Kingdom").trim(),
    marketing_opt_in: formData.get("marketing_opt_in") === "on"
  };
}

function fillProfileForm(profile = {}) {
  if (!profileForm) return;
  const metadata = state.user?.user_metadata || {};
  profileForm.elements.full_name.value = profile.full_name || metadata.full_name || "";
  profileForm.elements.email.value = state.user?.email || profile.email || "";
  profileForm.elements.phone.value = profile.phone || metadata.phone || "";
  profileForm.elements.address_line1.value = profile.address_line1 || "";
  profileForm.elements.address_line2.value = profile.address_line2 || "";
  profileForm.elements.city.value = profile.city || "";
  profileForm.elements.county.value = profile.county || "";
  profileForm.elements.postcode.value = profile.postcode || "";
  profileForm.elements.country.value = profile.country || "United Kingdom";
  profileForm.elements.marketing_opt_in.checked = Boolean(profile.marketing_opt_in);
}

function fillJoinFormFromPending() {
  const pending = pendingProfile();
  if (!pending?.profile || !joinForm) return;

  const { profile } = pending;
  joinForm.elements.email.value = pending.email || "";
  joinForm.elements.full_name.value = profile.full_name || "";
  joinForm.elements.phone.value = profile.phone || "";
  joinForm.elements.address_line1.value = profile.address_line1 || "";
  joinForm.elements.address_line2.value = profile.address_line2 || "";
  joinForm.elements.city.value = profile.city || "";
  joinForm.elements.county.value = profile.county || "";
  joinForm.elements.postcode.value = profile.postcode || "";
  joinForm.elements.country.value = profile.country || "United Kingdom";
  joinForm.elements.marketing_opt_in.checked = Boolean(profile.marketing_opt_in);
}

function cleanProfileValue(value) {
  return String(value || "").trim();
}

function deliveryAddressParts(profile = state.profile) {
  if (!profile) return [];

  const addressParts = [
    profile.address_line1,
    profile.address_line2,
    profile.city,
    profile.county,
    profile.postcode
  ].map(cleanProfileValue).filter(Boolean);

  if (addressParts.length) {
    addressParts.push(cleanProfileValue(profile.country) || "United Kingdom");
  }

  return addressParts;
}

function hasDeliveryProfile(profile = state.profile) {
  return Boolean(
    state.user
      && cleanProfileValue(profile?.address_line1)
      && cleanProfileValue(profile?.city)
      && cleanProfileValue(profile?.postcode)
  );
}

function updateDeliverySummary(profile = state.profile) {
  if (!deliveryName || !deliveryAddress) return;

  const parts = deliveryAddressParts(profile);
  if (state.user && parts.length) {
    deliveryName.textContent = cleanProfileValue(profile?.full_name)
      || cleanProfileValue(state.user?.user_metadata?.full_name)
      || state.user.email
      || "Delivery customer";
    deliveryAddress.textContent = parts.join(", ");
    return;
  }

  deliveryName.textContent = state.user?.email || "Sign in for delivery";
  deliveryAddress.textContent = state.user
    ? "No delivery address saved."
    : "Join or sign in to add your delivery address.";
}

function prefillCheckoutFromProfile() {
  updateDeliverySummary();
}

function previewDeliverySummaryFromProfileForm() {
  if (!state.user || !profileForm || profileForm.classList.contains("hidden")) return;
  updateDeliverySummary(profilePayloadFromForm(profileForm));
}

function updateAuthUi() {
  const signedIn = Boolean(state.user);
  const displayName = state.profile?.full_name || state.user?.user_metadata?.full_name || state.user?.email || "Account";
  const firstName = displayName.split(" ")[0];
  const pending = pendingProfile();
  const pendingEmail = state.pendingVerificationEmail || pending?.email || "";
  const waitingForVerification = !signedIn && state.authMode === "verify" && Boolean(pendingEmail);

  accountLabel.textContent = signedIn ? firstName : "Join / Sign in";
  accountSubtitle.textContent = signedIn ? state.user.email : waitingForVerification ? "Check your inbox" : "Join or sign in";
  authTabs.classList.toggle("hidden", signedIn || waitingForVerification);
  joinForm.classList.toggle("hidden", signedIn || waitingForVerification || state.authMode !== "join");
  signinForm.classList.toggle("hidden", signedIn || waitingForVerification || state.authMode !== "signin");
  verifyWait.classList.toggle("hidden", !waitingForVerification);
  profileForm.classList.toggle("hidden", !signedIn);
  verifyEmail.textContent = pendingEmail ? `Verification sent to ${pendingEmail}.` : "Check your inbox to confirm your account.";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === state.authMode);
  });

  updateDeliverySummary();
  if (window.lucide) window.lucide.createIcons();
}

function setAuthMode(mode) {
  state.authMode = mode;
  setAuthStatus("");
  updateAuthUi();
}

function showVerificationWait(email) {
  state.pendingVerificationEmail = email || pendingProfile()?.email || "";
  state.authMode = "verify";
  setAuthStatus("");
  openAccount();
  updateAuthUi();
}

async function saveCustomerProfile(payload) {
  if (!state.user) throw new Error("Sign in before saving details.");

  const { data, error } = await supabaseClient
    .from("store_customers")
    .upsert({
      user_id: state.user.id,
      email: state.user.email,
      ...payload
    }, { onConflict: "user_id" })
    .select()
    .single();

  if (error) throw error;
  state.profile = data;
  fillProfileForm(data);
  updateDeliverySummary();
  updateAuthUi();
  return data;
}

async function loadCustomerProfile() {
  if (!state.user) {
    state.profile = null;
    fillProfileForm();
    updateAuthUi();
    return;
  }

  const { data, error } = await supabaseClient
    .from("store_customers")
    .select("*")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (error) throw error;
  state.profile = data;
  fillProfileForm(data || {});
  updateAuthUi();
}

async function applyPendingProfile() {
  const pending = pendingProfile();
  if (!pending || !state.user) return;

  if (pending.email?.toLowerCase() !== state.user.email?.toLowerCase()) return;

  await saveCustomerProfile(pending.profile);
  window.localStorage.removeItem(PENDING_PROFILE_KEY);
  state.pendingVerificationEmail = "";
}

async function claimSessionBasket() {
  if (!state.user) return;
  const { error } = await supabaseClient.rpc("claim_store_session_basket", {
    p_session_id: sessionId
  });
  if (error) throw error;
}

async function initAuth() {
  if (!supabaseClient) return;

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user || null;
    if (!state.user) {
      state.profile = null;
      clearCartState();
      const pending = pendingProfile();
      if (pending?.email) {
        state.pendingVerificationEmail = pending.email;
        state.authMode = "verify";
      }
      fillProfileForm();
      renderCart();
      updateAuthUi();
      loadProducts();
      return;
    }

    try {
      await claimSessionBasket();
      await loadCustomerProfile();
      await applyPendingProfile();
      await loadProducts();
    } catch (error) {
      setAuthStatus(error.message || "Could not load account.", true);
    }
  });

  const { data, error } = await supabaseClient.auth.getUser();
  if (error) {
    updateAuthUi();
    return;
  }

  state.user = data?.user || null;
  if (state.user) {
    try {
      await claimSessionBasket();
      await loadCustomerProfile();
      await applyPendingProfile();
      await loadProducts();
    } catch (profileError) {
      setAuthStatus(profileError.message || "Could not load account.", true);
    }
  } else {
    const pending = pendingProfile();
    if (pending?.email) {
      state.pendingVerificationEmail = pending.email;
      state.authMode = "verify";
    }
    updateAuthUi();
  }
}

function bumpCartButton() {
  cartButton.classList.remove("bump");
  void cartButton.offsetWidth;
  cartButton.classList.add("bump");
}

function attachCardMotion(card) {
  card.addEventListener("pointermove", (event) => {
    const rect = card.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const rotateX = (50 - y) * 0.08;
    const rotateY = (x - 50) * 0.08;
    card.style.setProperty("--mx", `${x}%`);
    card.style.setProperty("--my", `${y}%`);
    card.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
  });
  card.addEventListener("pointerleave", () => {
    card.style.transform = "";
  });
}

async function loadProducts() {
  if (!supabaseClient) {
    state.loading = false;
    products = [];
    renderProducts();
    updateMetrics();
    showStoreErrorPopup();
    return;
  }

  state.loading = true;
  resetProductWindow();
  renderProducts();

  let { data, error } = await supabaseClient.rpc("list_store_products_json");
  if (error) {
    ({ data, error } = await supabaseClient.rpc("list_store_products"));
  }
  state.loading = false;

  if (error) {
    products = [];
    renderProducts();
    updateMetrics();
    showStoreErrorPopup();
    return;
  }

  products = (Array.isArray(data) ? data : []).map(productFromRow);
  resetProductWindow();
  try {
    await loadBasket();
  } catch (basketError) {
    showToast(basketError.message || "Could not load basket holds");
  }
  updateMetrics();
  renderProducts();
  renderCart();
}

async function reserveProduct(id, quantity) {
  const { data, error } = await supabaseClient.rpc("reserve_store_item", {
    p_product_id: id,
    p_quantity: quantity,
    p_session_id: sessionId
  });

  if (error) throw error;
  mergeProduct(Array.isArray(data) ? data[0] : data);
}

async function setReservedQuantity(id, quantity) {
  const { data, error } = await supabaseClient.rpc("set_store_item_quantity", {
    p_product_id: id,
    p_quantity: quantity,
    p_session_id: sessionId
  });

  if (error) throw error;
  mergeProduct(Array.isArray(data) ? data[0] : data);
}

function syncCartFromRows(rows = []) {
  state.cart.clear();
  state.cartExpiries.clear();
  state.cartStatuses.clear();
  state.cartCheckoutIds.clear();

  rows.forEach((row) => {
    const id = row.product_id;
    const quantity = Number(row.quantity || 0);
    const previousQty = state.cart.get(id) || 0;
    const previousExpiry = state.cartExpiries.get(id);
    const nextExpiry = row.expires_at;

    state.cart.set(id, previousQty + quantity);
    state.cartStatuses.set(id, row.status || "active");
    state.cartCheckoutIds.set(id, row.stripe_session_id || "");

    if (!previousExpiry || millisecondsUntil(nextExpiry) < millisecondsUntil(previousExpiry)) {
      state.cartExpiries.set(id, nextExpiry);
    }
  });
}

function clearCartState() {
  state.cart.clear();
  state.cartExpiries.clear();
  state.cartStatuses.clear();
  state.cartCheckoutIds.clear();
}

async function loadBasket({ refreshProducts = false } = {}) {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient.rpc("list_store_basket", {
    p_session_id: sessionId
  });

  if (error) throw error;
  syncCartFromRows(data || []);
  if (refreshProducts) await loadProducts();
  renderCart();
}

async function refreshBasketHolds() {
  if (!supabaseClient || !cartLines().length) return;

  const { data, error } = await supabaseClient.rpc("refresh_store_basket", {
    p_session_id: sessionId
  });

  if (error) throw error;
  syncCartFromRows(data || []);
  await loadProducts();
  renderCart();
}

function reloadExpiredBasket() {
  if (state.expiryReloading) return;
  state.expiryReloading = true;
  loadBasket({ refreshProducts: true })
    .catch(() => {})
    .finally(() => {
      state.expiryReloading = false;
    });
}

function hideExpiryPrompt() {
  const popup = document.querySelector("#basketExpiryPopup");
  if (popup) {
    popup.classList.remove("show");
    popup.dataset.expiresAt = "";
    popup.dataset.status = "";
    const refreshButton = popup.querySelector('[data-expiry-action="refresh"]');
    if (refreshButton) refreshButton.disabled = false;
  }
  state.expiryPromptOpen = false;
}

function showExpiryPrompt(line) {
  if (state.expiryPromptOpen || Date.now() < state.expiryWarningDismissedUntil) return;

  let popup = document.querySelector("#basketExpiryPopup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "basketExpiryPopup";
    popup.className = "expiry-popup";
    popup.setAttribute("role", "alertdialog");
    popup.setAttribute("aria-modal", "true");
    popup.innerHTML = `
      <div class="expiry-card">
        <div class="expiry-mark"><i data-lucide="timer-reset"></i></div>
        <div>
          <strong></strong>
          <p></p>
          <div class="expiry-countdown">
            <span>Time left</span>
            <strong data-expiry-countdown>--:--</strong>
          </div>
        </div>
        <div class="expiry-actions">
          <button class="checkout-button" type="button" data-expiry-action="refresh">
            <i data-lucide="refresh-cw"></i>
            Keep items
          </button>
          <button class="ghost-button" type="button" data-expiry-action="dismiss">Not now</button>
        </div>
      </div>
    `;
    popup.querySelector('[data-expiry-action="refresh"]').addEventListener("click", async () => {
      try {
        await refreshBasketHolds();
        hideExpiryPrompt();
        showToast("Basket holds refreshed for 10 minutes");
      } catch (error) {
        showToast(error.message || "Could not refresh basket");
      }
    });
    popup.querySelector('[data-expiry-action="dismiss"]').addEventListener("click", () => {
      state.expiryWarningDismissedUntil = Date.now() + 60_000;
      hideExpiryPrompt();
    });
    document.body.append(popup);
  }

  const checkoutMode = line.status === "checkout";
  popup.querySelector("strong").textContent = checkoutMode ? "Payment hold expiring" : "Basket item expiring";
  popup.querySelector("p").textContent = checkoutMode
    ? "Your payment hold is nearly out of time. Keep these goods in your basket for another 10 minutes?"
    : `${line.product.name} is nearly out of your basket. Refresh all basket items for another 10 minutes?`;
  popup.dataset.expiresAt = line.expiresAt || "";
  popup.dataset.status = line.status || "active";
  popup.classList.add("show");
  state.expiryPromptOpen = true;
  updateExpiryPromptTimer();
  if (window.lucide) window.lucide.createIcons();
}

function updateExpiryPromptTimer() {
  const popup = document.querySelector("#basketExpiryPopup.show");
  if (!popup) return;

  const expiresAt = popup.dataset.expiresAt;
  const countdown = popup.querySelector("[data-expiry-countdown]");
  const refreshButton = popup.querySelector('[data-expiry-action="refresh"]');
  const remaining = millisecondsUntil(expiresAt);

  if (countdown) countdown.textContent = expiresAt ? timerText(expiresAt) : "--:--";
  if (refreshButton) refreshButton.disabled = remaining <= 0;

  if (expiresAt && remaining <= 0) {
    hideExpiryPrompt();
    reloadExpiredBasket();
  }
}

function checkBasketExpiry() {
  const lines = cartLines();
  if (!lines.length) {
    hideExpiryPrompt();
    return;
  }

  const soonest = lines
    .filter((line) => line.expiresAt)
    .sort((a, b) => millisecondsUntil(a.expiresAt) - millisecondsUntil(b.expiresAt))[0];

  if (!soonest) return;

  const remaining = millisecondsUntil(soonest.expiresAt);
  if (remaining <= 0) {
    hideExpiryPrompt();
    reloadExpiredBasket();
    return;
  }

  if (remaining <= 120_000) showExpiryPrompt(soonest);
}

function updateCartTimers() {
  cartItems.querySelectorAll(".cart-line").forEach((line) => {
    const productId = line.dataset.productId;
    const expiresAt = state.cartExpiries.get(productId);
    const status = state.cartStatuses.get(productId) || "active";
    const timer = line.querySelector(".hold-timer strong");

    if (timer) timer.textContent = expiresAt ? timerText(expiresAt) : "--:--";
    line.classList.toggle("expiring", Boolean(expiresAt) && millisecondsUntil(expiresAt) <= 120_000);
    line.classList.toggle("checkout-hold", status === "checkout");
  });

  const checkoutLines = cartLines().filter((line) => line.status === "checkout");
  if (checkoutLines.length) {
    const soonestCheckout = checkoutLines.sort((a, b) => millisecondsUntil(a.expiresAt) - millisecondsUntil(b.expiresAt))[0];
    orderNote.textContent = `Payment hold expires in ${timerText(soonestCheckout?.expiresAt)}.`;
  }
}

function startBasketTimer() {
  window.clearInterval(basketTimer);
  basketTimer = window.setInterval(() => {
    updateCartTimers();
    updateExpiryPromptTimer();
    checkBasketExpiry();
  }, 1000);
}

function filteredProducts() {
  const query = state.search.trim().toLowerCase();
  let output = products.filter((product) => {
    if (HIDDEN_STOREFRONT_TYPES.has(product.type)) return false;
    const matchesFilter = state.filter === "all" || product.type === state.filter || (state.filter === "box" && product.type === "case");
    const matchesSearch = !query || [product.name, product.set, product.type].join(" ").toLowerCase().includes(query);
    const hidesSearchSingle = query && state.filter !== "single" && product.type === "single";
    const matchesStock = !state.inStockOnly || product.stock > 0;
    return matchesFilter && matchesSearch && matchesStock && !hidesSearchSingle;
  });

  output = [...output].sort((a, b) => {
    if (a.stock === 0 && b.stock > 0) return 1;
    if (a.stock > 0 && b.stock === 0) return -1;
    const regionalRank = Number(isRegionalImport(a)) - Number(isRegionalImport(b));
    if (regionalRank !== 0) return regionalRank;
    if (state.filter === "all" && state.sort === "featured") {
      const typeRank = featuredTypeRank(a) - featuredTypeRank(b);
      if (typeRank !== 0) return typeRank;
    }
    if (state.sort === "price-low") return a.price - b.price;
    if (state.sort === "price-high") return b.price - a.price;
    if (state.sort === "stock") return b.stock - a.stock;
    if (state.sort === "name") return a.name.localeCompare(b.name);
    return products.indexOf(a) - products.indexOf(b);
  });

  return output;
}

function storefrontProductCount() {
  return products.filter((product) => !HIDDEN_STOREFRONT_TYPES.has(product.type)).length;
}

function resetProductWindow() {
  state.productPage = 1;
}

function setProductPage(page, totalPages) {
  state.productPage = Math.min(Math.max(1, page), Math.max(1, totalPages));
  renderProducts();
  document.querySelector("#catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderProducts() {
  const visible = filteredProducts();
  const totalPages = Math.max(1, Math.ceil(visible.length / PRODUCT_PAGE_SIZE));
  if (state.productPage > totalPages) state.productPage = totalPages;
  const pageStart = (state.productPage - 1) * PRODUCT_PAGE_SIZE;
  const pageEnd = pageStart + PRODUCT_PAGE_SIZE;
  const pageProducts = visible.slice(pageStart, pageEnd);
  grid.replaceChildren();

  if (state.loading) {
    const loading = document.createElement("p");
    loading.className = "empty-state";
    loading.textContent = "Loading live store data...";
    grid.append(loading);
    resultCount.textContent = "Loading products";
    return;
  }

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = products.length ? "No products match those filters." : "Store data unavailable.";
    grid.append(empty);
  }

  pageProducts.forEach((product, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    const img = card.querySelector("img");
    const badge = card.querySelector(".stock-badge");
    const wish = card.querySelector(".wish-button");
    const button = card.querySelector(".add-button");
    const buyArea = card.querySelector(".product-buy");
    const rarity = card.querySelector(".rarity-meter span");
    const syncing = state.syncing.has(product.id);
    const cartQty = state.cart.get(product.id) || 0;
    const cartStatus = state.cartStatuses.get(product.id) || "active";
    const checkoutMode = cartStatus === "checkout";

    card.style.animationDelay = `${Math.min(index * 28, 420)}ms`;
    card.style.setProperty("--rarity", `${productPower(product)}%`);
    attachCardMotion(card);

    img.src = product.image;
    img.alt = product.name;
    img.decoding = "async";
    img.fetchPriority = index < 4 ? "high" : "low";
    img.onerror = () => {
      img.src = "assets/store-hero.png";
      img.style.objectFit = "cover";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.mixBlendMode = "normal";
    };

    badge.textContent = stockText(product);
    const badgeClass = stockClass(product);
    if (badgeClass) badge.classList.add(badgeClass);
    card.querySelector(".product-set").textContent = product.set;
    card.querySelector("h3").textContent = product.name;
    card.querySelector(".product-type").textContent = typeLabel(product.type);
    card.querySelector(".product-stock").textContent = product.reservedStock ? `${product.reservedStock} held` : product.stockLabel;
    rarity.style.width = `${productPower(product)}%`;
    card.querySelector(".price").textContent = money(product.price);

    if (cartQty > 0) {
      button.remove();
      const stepper = document.createElement("div");
      stepper.className = `card-qty-stepper${checkoutMode ? " checkout-mode" : ""}`;
      stepper.innerHTML = `
        <button type="button" data-card-action="down" aria-label="Decrease quantity">-</button>
        <span>${syncing ? "..." : cartQty}</span>
        <button type="button" data-card-action="up" aria-label="Increase quantity">+</button>
      `;
      stepper.querySelector('[data-card-action="down"]').disabled = syncing || checkoutMode;
      stepper.querySelector('[data-card-action="up"]').disabled = syncing || checkoutMode || product.stock === 0 || cartQty >= MAX_ITEM_QUANTITY;
      stepper.querySelector('[data-card-action="down"]').addEventListener("click", () => changeQty(product.id, -1));
      stepper.querySelector('[data-card-action="up"]').addEventListener("click", () => changeQty(product.id, 1));
      buyArea.append(stepper);
    } else {
      button.disabled = syncing || product.stock === 0 || cartQty >= MAX_ITEM_QUANTITY;
      button.lastChild.textContent = syncing ? " Syncing" : product.stock === 0 ? " Sold out" : " Add";
      button.addEventListener("click", () => addToCart(product.id));
    }

    wish.classList.toggle("active", state.watchlist.has(product.id));
    wish.addEventListener("click", () => {
      if (state.watchlist.has(product.id)) state.watchlist.delete(product.id);
      else state.watchlist.add(product.id);
      renderProducts();
    });
    grid.append(card);
  });

  if (visible.length > PRODUCT_PAGE_SIZE) {
    const pager = document.createElement("nav");
    pager.className = "pagination";
    pager.setAttribute("aria-label", "Product pages");
    pager.innerHTML = `
      <button type="button" data-page="prev" ${state.productPage === 1 ? "disabled" : ""}>Previous</button>
      <span>Page ${state.productPage} of ${totalPages}</span>
      <button type="button" data-page="next" ${state.productPage === totalPages ? "disabled" : ""}>Next</button>
    `;
    pager.querySelector('[data-page="prev"]').addEventListener("click", () => setProductPage(state.productPage - 1, totalPages));
    pager.querySelector('[data-page="next"]').addEventListener("click", () => setProductPage(state.productPage + 1, totalPages));
    grid.append(pager);
  }

  const storefrontTotal = storefrontProductCount();
  resultCount.textContent = visible.length > PRODUCT_PAGE_SIZE
    ? `Showing ${pageStart + 1}-${Math.min(pageEnd, visible.length)} of ${visible.length} matches (${storefrontTotal} total)`
    : `Showing ${visible.length} of ${storefrontTotal} products`;
  if (window.lucide) window.lucide.createIcons();
}

async function addToCart(id) {
  const product = products.find((entry) => entry.id === id);
  if (!product || product.stock === 0 || state.syncing.has(id)) return;
  if ((state.cart.get(id) || 0) >= MAX_ITEM_QUANTITY) {
    showToast(`Max ${MAX_ITEM_QUANTITY} per item`);
    return;
  }

  const isNewLine = !state.cart.has(id);
  state.syncing.add(id);
  renderProducts();

  try {
    await reserveProduct(id, 1);
    if (isNewLine) state.cartLineAnimations.add(id);
    await loadBasket();
    renderCart();
    updateMetrics();
    bumpCartButton();
    showToast(`${product.set} added to basket`);
    openCart();
  } catch (error) {
    showToast(error.message || "Could not add stock");
  } finally {
    state.syncing.delete(id);
    renderCart();
    renderProducts();
  }
}

async function changeQty(id, delta) {
  const product = products.find((entry) => entry.id === id);
  const current = state.cart.get(id) || 0;
  const next = Math.max(0, current + delta);
  if (!product || next === current || state.syncing.has(id)) return;
  if (next > current && product.stock === 0) return;
  if (next > MAX_ITEM_QUANTITY) {
    showToast(`Max ${MAX_ITEM_QUANTITY} per item`);
    return;
  }

  state.syncing.add(id);
  renderCart();

  try {
    await setReservedQuantity(id, next);
    await loadBasket();
    updateMetrics();
  } catch (error) {
    showToast(error.message || "Could not update basket");
  } finally {
    state.syncing.delete(id);
    renderCart();
    renderProducts();
  }
}

function cartLines() {
  return [...state.cart.entries()].map(([id, qty]) => ({
    product: products.find((entry) => entry.id === id),
    qty,
    expiresAt: state.cartExpiries.get(id),
    status: state.cartStatuses.get(id) || "active",
    checkoutId: state.cartCheckoutIds.get(id) || ""
  })).filter((line) => line.product);
}

function renderCart() {
  const lines = cartLines();
  const itemCount = lines.reduce((sum, line) => sum + line.qty, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.product.price * line.qty, 0);
  const discount = subtotal * state.discountRate;
  const shipping = subtotal === 0 ? 0 : CHECKOUT_FEE_GBP;
  const total = Math.max(0, subtotal - discount + shipping);
  const hasCheckoutHold = lines.some((line) => line.status === "checkout");
  const needsDeliveryAddress = !hasDeliveryProfile();

  cartCount.textContent = itemCount;
  document.querySelector("#basketSubtitle").textContent = itemCount
    ? `${itemCount} item${itemCount === 1 ? "" : "s"} ${hasCheckoutHold ? "being paid for" : "ready to buy"}`
    : "No items yet";
  cartItems.replaceChildren();

  lines.forEach(({ product, qty, expiresAt, status }) => {
    const syncing = state.syncing.has(product.id);
    const checkoutMode = status === "checkout";
    const urgent = expiresAt && millisecondsUntil(expiresAt) <= 120_000;
    const line = document.createElement("article");
    line.className = `cart-line${state.cartLineAnimations.has(product.id) ? " animate-in" : ""}${urgent ? " expiring" : ""}${checkoutMode ? " checkout-hold" : ""}`;
    line.dataset.productId = product.id;
    line.dataset.qty = String(qty);
    line.dataset.status = status;
    line.dataset.expiresAt = expiresAt || "";
    line.innerHTML = `
      <img src="${product.image}" alt="${product.name}">
      <div>
        <h3>${product.name}</h3>
        <p>${money(product.price)} each</p>
        <div class="hold-timer">
          <i data-lucide="${checkoutMode ? "credit-card" : "timer"}"></i>
          <span>${checkoutMode ? "Payment processing" : "Basket expires"}</span>
          <strong>${expiresAt ? timerText(expiresAt) : "--:--"}</strong>
        </div>
        <div class="line-actions">
          <div class="qty-stepper" aria-label="Quantity controls">
            <button type="button" data-action="down" aria-label="Decrease quantity">-</button>
            <span>${syncing ? "..." : qty}</span>
            <button type="button" data-action="up" aria-label="Increase quantity">+</button>
          </div>
          <button class="remove-line" type="button">Remove</button>
        </div>
      </div>
    `;
    line.querySelector("img").onerror = (event) => {
      event.currentTarget.src = "assets/store-hero.png";
    };
    line.querySelector('[data-action="down"]').disabled = syncing || checkoutMode;
    line.querySelector('[data-action="up"]').disabled = syncing || checkoutMode || product.stock === 0 || qty >= MAX_ITEM_QUANTITY;
    line.querySelector(".remove-line").disabled = syncing || checkoutMode;
    cartItems.append(line);
  });

  state.cartLineAnimations.clear();

  if (!lines.length) {
    const empty = document.createElement("p");
    empty.className = "empty-cart";
    empty.textContent = "Your basket is empty.";
    cartItems.append(empty);
  }

  document.querySelector("#subtotal").textContent = money(subtotal);
  document.querySelector("#discount").textContent = `-${money(discount)}`;
  document.querySelector("#shipping").textContent = money(shipping);
  document.querySelector("#total").textContent = money(total);
  const checkoutButton = checkoutForm.querySelector(".checkout-button");
  checkoutButton.disabled = !lines.length || hasCheckoutHold || needsDeliveryAddress || [...state.syncing.values()].length > 0;
  checkoutButton.lastChild.textContent = hasCheckoutHold
    ? " Processing payment"
    : needsDeliveryAddress
      ? " Add delivery address"
      : " Buy now";
  if (hasCheckoutHold) {
    const soonestCheckout = lines
      .filter((line) => line.status === "checkout")
      .sort((a, b) => millisecondsUntil(a.expiresAt) - millisecondsUntil(b.expiresAt))[0];
    orderNote.textContent = `Payment hold expires in ${timerText(soonestCheckout?.expiresAt)}.`;
  } else if (needsDeliveryAddress && lines.length) {
    orderNote.textContent = "Add a delivery address before checkout.";
  } else if (orderNote.textContent === "Add a delivery address before checkout.") {
    orderNote.textContent = "";
  }
  if (window.lucide) window.lucide.createIcons();
}

function openCart() {
  closeAccountPanel();
  document.body.classList.add("cart-open");
  cartPanel.setAttribute("aria-hidden", "false");
  prefillCheckoutFromProfile();
}

function closeCartPanel() {
  document.body.classList.remove("cart-open");
  cartPanel.setAttribute("aria-hidden", "true");
}

function openAccount() {
  closeCartPanel();
  document.body.classList.add("account-open");
  accountPanel.setAttribute("aria-hidden", "false");
}

async function openDeliveryEditor() {
  setAuthStatus("");

  if (!state.user) {
    state.authMode = "join";
    fillJoinFormFromPending();
    updateAuthUi();
    openAccount();
    return;
  }

  fillProfileForm(state.profile || {});
  openAccount();
  setAuthStatus("Loading delivery address...");

  try {
    await loadCustomerProfile();
    await applyPendingProfile();
    fillProfileForm(state.profile || {});
    setAuthStatus(hasDeliveryProfile() ? "Delivery address loaded." : "Add your delivery address.");
  } catch (error) {
    fillProfileForm(state.profile || {});
    setAuthStatus(error.message || "Could not load delivery address.", true);
  }
}

function closeAccountPanel() {
  document.body.classList.remove("account-open");
  accountPanel.setAttribute("aria-hidden", "true");
}

function closePanels() {
  closeCartPanel();
  closeAccountPanel();
}

function updateMetrics() {
  const storefrontProducts = products.filter((product) => !HIDDEN_STOREFRONT_TYPES.has(product.type));
  const available = storefrontProducts.filter((product) => product.stock > 0);
  setText("#stockLines", storefrontProducts.length);
  setText("#availableLines", available.length);
  setText("#bulkCount", storefrontProducts.filter((product) => product.stock >= 300).length);
  setText("#fromPrice", storefrontProducts.length ? money(Math.min(...storefrontProducts.map((product) => product.price))) : money(0));
  setText("#lowStockCount", storefrontProducts.filter((product) => product.stock > 0 && product.stock <= 3).length);
}

document.querySelector("#searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  resetProductWindow();
  renderProducts();
});

document.querySelectorAll(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((entry) => entry.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    resetProductWindow();
    renderProducts();
  });
});

document.querySelector("#sortSelect").addEventListener("change", (event) => {
  state.sort = event.target.value;
  resetProductWindow();
  renderProducts();
});

document.querySelector("#inStockOnly").addEventListener("change", (event) => {
  state.inStockOnly = event.target.checked;
  resetProductWindow();
  renderProducts();
});

document.querySelector("#clearFilters").addEventListener("click", () => {
  state.search = "";
  state.filter = "all";
  state.sort = "featured";
  state.inStockOnly = false;
  resetProductWindow();
  document.querySelector("#searchInput").value = "";
  document.querySelector("#sortSelect").value = "featured";
  document.querySelector("#inStockOnly").checked = false;
  document.querySelectorAll(".segmented button").forEach((entry) => entry.classList.toggle("active", entry.dataset.filter === "all"));
  renderProducts();
});

document.querySelector("#applyCoupon").addEventListener("click", () => {
  const code = document.querySelector("#couponInput").value.trim().toUpperCase();
  state.discountRate = code === "VAULT5" ? 0.05 : 0;
  orderNote.textContent = state.discountRate ? "VAULT5 applied." : "Code not recognised.";
  renderCart();
});

document.querySelectorAll("[data-auth-mode]").forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
});

showSigninButton.addEventListener("click", () => setAuthMode("signin"));

resendVerification.addEventListener("click", async () => {
  if (!supabaseClient || state.authBusy) return;

  const pendingEmail = state.pendingVerificationEmail || pendingProfile()?.email || "";
  if (!pendingEmail) {
    setAuthStatus("Enter your email again to resend verification.", true);
    setAuthMode("join");
    return;
  }

  state.authBusy = true;
  resendVerification.disabled = true;
  setAuthStatus("Sending verification email...");

  try {
    const { error } = await supabaseClient.auth.resend({
      type: "signup",
      email: pendingEmail,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`
      }
    });

    if (error) throw error;
    setAuthStatus("Verification email sent.");
  } catch (error) {
    const message = error.message || "Could not resend verification email.";
    setAuthStatus(message.includes("security purposes") ? message : "Could not resend verification email.", true);
  } finally {
    state.authBusy = false;
    resendVerification.disabled = false;
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient || state.authBusy) return;

  const formData = new FormData(joinForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const profile = profilePayloadFromForm(joinForm);

  state.authBusy = true;
  setFormDisabled(joinForm, true);
  setAuthStatus("Creating account...");

  try {
    window.localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify({ email, profile }));
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
        data: {
          full_name: profile.full_name,
          phone: profile.phone
        }
      }
    });

    if (error) throw error;

    if (data?.session) {
      state.user = data.user;
      await claimSessionBasket();
      await saveCustomerProfile(profile);
      window.localStorage.removeItem(PENDING_PROFILE_KEY);
      joinForm.reset();
      setAuthStatus("Account ready.");
    } else {
      showVerificationWait(email);
    }
  } catch (error) {
    setAuthStatus(error.message || "Could not create account.", true);
  } finally {
    state.authBusy = false;
    setFormDisabled(joinForm, false);
    updateAuthUi();
  }
});

signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient || state.authBusy) return;

  const formData = new FormData(signinForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  state.authBusy = true;
  setFormDisabled(signinForm, true);
  setAuthStatus("Signing in...");

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    state.user = data.user;
    await claimSessionBasket();
    await loadCustomerProfile();
    await applyPendingProfile();
    await loadProducts();
    signinForm.reset();
    setAuthStatus("Signed in.");
  } catch (error) {
    if ((error.message || "").toLowerCase().includes("email not confirmed")) {
      showVerificationWait(email);
      setAuthStatus("Verify your email before signing in.", true);
    } else {
      setAuthStatus(error.message || "Could not sign in.", true);
    }
  } finally {
    state.authBusy = false;
    setFormDisabled(signinForm, false);
    updateAuthUi();
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient || !state.user || state.authBusy) return;

  const profilePayload = profilePayloadFromForm(profileForm);
  state.authBusy = true;
  setFormDisabled(profileForm, true);
  setAuthStatus("Saving details...");

  try {
    await saveCustomerProfile(profilePayload);
    renderCart();
    setAuthStatus("Details saved.");
  } catch (error) {
    setAuthStatus(error.message || "Could not save details.", true);
  } finally {
    state.authBusy = false;
    setFormDisabled(profileForm, false);
  }
});

profileForm.addEventListener("input", previewDeliverySummaryFromProfileForm);
profileForm.addEventListener("change", previewDeliverySummaryFromProfileForm);

signOutButton.addEventListener("click", async () => {
  if (!supabaseClient || state.authBusy) return;

  state.authBusy = true;
  setAuthStatus("Signing out...");

  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    state.user = null;
    state.profile = null;
    clearCartState();
    renderCart();
    await loadProducts();
    setAuthStatus("");
    updateAuthUi();
  } catch (error) {
    setAuthStatus(error.message || "Could not sign out.", true);
  } finally {
    state.authBusy = false;
  }
});

changeDelivery?.addEventListener("click", openDeliveryEditor);

let lastCartControlAt = 0;

function handleCartControl(event) {
  const button = event.target.closest("button");
  const line = button?.closest(".cart-line");
  if (!button || !line || button.disabled) return;

  const now = Date.now();
  if (event.type === "click" && now - lastCartControlAt < 500) return;
  lastCartControlAt = now;

  event.preventDefault();
  event.stopPropagation();

  const id = line.dataset.productId;
  const qty = Number(line.dataset.qty || 0);
  if (button.matches('[data-action="down"]')) changeQty(id, -1);
  if (button.matches('[data-action="up"]')) changeQty(id, 1);
  if (button.matches(".remove-line")) changeQty(id, -qty);
}

document.addEventListener("pointerdown", handleCartControl, true);
document.addEventListener("click", handleCartControl, true);

checkoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cartLines().length) return;
  if (!hasDeliveryProfile()) {
    orderNote.textContent = "Add a delivery address before checkout.";
    openAccount();
    return;
  }

  const checkoutButton = checkoutForm.querySelector(".checkout-button");
  checkoutButton.disabled = true;
  orderNote.textContent = TEST_CHECKOUT_MODE ? "Creating test order..." : "Opening secure checkout...";

  if (TEST_CHECKOUT_MODE) {
    const { data, error } = await supabaseClient.rpc("complete_test_store_checkout", {
      p_session_id: sessionId
    });

    if (error) {
      orderNote.textContent = error.message || "Test checkout failed.";
      renderCart();
      return;
    }

    const order = Array.isArray(data) ? data[0] : data;
    clearCartState();
    await loadProducts();
    renderCart();
    orderNote.textContent = order?.order_number
      ? `Test order #${order.order_number} created.`
      : "Test order created.";
    showToast(order?.order_number ? `Order #${order.order_number} created` : "Order created");
    return;
  }

  const { data, error } = await supabaseClient.functions.invoke("create-stripe-checkout", {
    body: {
      sessionId,
      successUrl: `${window.location.origin}${window.location.pathname}?checkout=success`,
      cancelUrl: `${window.location.origin}${window.location.pathname}?checkout=cancelled`
    }
  });

  if (error) {
    orderNote.textContent = error.message || "Checkout failed.";
    renderCart();
    return;
  }

  if (data?.error) {
    orderNote.textContent = data.error;
    renderCart();
    return;
  }

  if (data?.url) {
    window.location.assign(data.url);
    return;
  }

  orderNote.textContent = "Checkout did not return a payment URL.";
  renderCart();
});

accountButton.addEventListener("click", openAccount);
cartButton.addEventListener("click", openCart);
document.querySelector("#footerCartButton")?.addEventListener("click", openCart);
closeCart.addEventListener("click", closeCartPanel);
closeAccount.addEventListener("click", closeAccountPanel);
scrim.addEventListener("click", closePanels);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePanels();
});

updateMetrics();
renderProducts();
renderCart();
updateAuthUi();
initAuth();
startBasketTimer();
loadProducts();
if (window.lucide) window.lucide.createIcons();
