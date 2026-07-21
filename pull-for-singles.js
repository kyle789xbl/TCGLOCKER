const SUPABASE_URL = "https://vfyipmvaejrnhrqckgvn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fKWNwL1s1WWp1TnufoCCng_F9Bz9pot";
const FALLBACK_CARD_IMAGE = "assets/pull/PokemonCard.png";
const FALLBACK_PACK_IMAGE = "assets/pull/tcg-locker-pack-art.png";
const PULL_SIZE = 1;
const HISTORY_PAGE_SIZE = 100;
const PULL_TIERS = [
  {
    id: "spark",
    number: 1,
    name: "Spark Vault",
    priceLabel: "£5",
    creditCost: 5,
    pullSize: 1,
    minCardPence: 100,
    maxCardPence: 390,
    minLabel: "£1",
    maxLabel: "£3.90",
    packArt: "assets/pull/tcg-locker-pack-art.png",
    tone: "green",
    rarityLabel: "Green rarity",
    strap: "Entry rarity pulls"
  },
  {
    id: "holo",
    number: 2,
    name: "Holo Vault",
    priceLabel: "£10",
    creditCost: 10,
    pullSize: 1,
    minCardPence: 250,
    maxCardPence: 780,
    minLabel: "£2.50",
    maxLabel: "£7.80",
    packArt: "assets/pull/tcg-locker-pack-art.png",
    tone: "blue",
    rarityLabel: "Blue rarity",
    strap: "Better rarity range"
  },
  {
    id: "prism",
    number: 3,
    name: "Prism Vault",
    priceLabel: "£25",
    creditCost: 25,
    pullSize: 1,
    minCardPence: 750,
    maxCardPence: 1950,
    minLabel: "£7.50",
    maxLabel: "£19.50",
    packArt: "assets/pull/tcg-locker-pack-art.png",
    tone: "purple",
    rarityLabel: "Purple rarity",
    strap: "Premium rarity pool"
  },
  {
    id: "black-label",
    number: 4,
    name: "Black Label Vault",
    priceLabel: "£100",
    creditCost: 100,
    pullSize: 1,
    minCardPence: 4000,
    maxCardPence: 7800,
    minLabel: "£40",
    maxLabel: "£78",
    packArt: "assets/pull/tcg-locker-pack-art.png",
    tone: "gold",
    rarityLabel: "Gold rarity",
    strap: "Highest-value rarity"
  }
];

const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const state = {
  packs: [],
  selectedPackKey: "",
  selectedTierId: "spark",
  user: null,
  isAdmin: false,
  credits: null,
  tierSummary: {},
  history: [],
  historyHasMore: false,
  latestCards: [],
  revealReady: false,
  currentEventId: "",
  currentDecision: "",
  decisionBusy: false,
  busy: false,
  search: "",
  historyTab: "all",
  historyPage: 1,
  expandedHistoryId: ""
};

const root = document.documentElement;
const stage = document.querySelector("#stage");
const shell = document.querySelector("#packShell");
const rewardCardImage = document.querySelector("#rewardCardImage");
const packArtImages = [...document.querySelectorAll("[data-pack-art]")];
const packGrid = document.querySelector("#packGrid");
const packCount = document.querySelector("#packCount");
const packSearch = document.querySelector("#packSearch");
const selectedPackName = document.querySelector("#selectedPackName");
const selectedPackMeta = document.querySelector("#selectedPackMeta");
const creditBalance = document.querySelector("#creditBalance");
const accountStatus = document.querySelector("#accountStatus");
const accountStatusLabel = document.querySelector("#accountStatusLabel");
const accountStatusMeta = document.querySelector("#accountStatusMeta");
const grantCredits = document.querySelector("#grantCredits");
const signOutButton = document.querySelector("#signOutButton");
const signinForm = document.querySelector("#signinForm");
const authPanel = document.querySelector("#authPanel");
const openSelectedPack = document.querySelector("#openSelectedPack");
const refreshPacks = document.querySelector("#refreshPacks");
const pulledGrid = document.querySelector("#pulledGrid");
const pullResultStatus = document.querySelector("#pullResultStatus");
const pullDecision = document.querySelector("#pullDecision");
const historyTabs = document.querySelector("#historyTabs");
const historyToolbar = document.querySelector("#historyToolbar");
const historyPageLabel = document.querySelector("#historyPageLabel");
const historyList = document.querySelector("#historyList");
const toast = document.querySelector("#toast");

const selectSfx = new Audio("assets/pull/SelectSFX.mp3?v=1");
const tearSfx = new Audio("assets/pull/TearSoundEffect.mp3?v=1");
const chargeSfx = new Audio("assets/pull/ChargePeelSFX.mp3?v=1");
const openSfx = new Audio("assets/pull/OpenEffect.mp3?v=1");
chargeSfx.loop = true;

let dragging = false;
let progress = 0;
let forcedOpen = false;
let raf = 0;
let toastTimer = 0;
let revealResetTimer = 0;

function moneyFromPence(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(value) || 0) / 100);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function imageUrl(value) {
  return value || FALLBACK_CARD_IMAGE;
}

function packArtUrl(pack = selectedPack()) {
  return selectedTier()?.packArt || FALLBACK_PACK_IMAGE;
}

function setPackArt(url = FALLBACK_PACK_IMAGE) {
  const nextUrl = url || FALLBACK_PACK_IMAGE;
  packArtImages.forEach((image) => {
    if (image.src.endsWith(nextUrl)) return;
    image.src = nextUrl;
    image.onerror = () => {
      image.onerror = null;
      image.src = FALLBACK_PACK_IMAGE;
    };
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function rpc(name, args = {}) {
  const { data, error } = await supabaseClient.rpc(name, args);
  if (error) throw error;
  return data;
}

function playSound(sound, volume = 1) {
  sound.pause();
  sound.currentTime = 0;
  sound.volume = volume;
  sound.play().catch(() => {});
}

function startCharge() {
  chargeSfx.volume = 0.55;
  chargeSfx.play().catch(() => {});
}

function stopCharge() {
  chargeSfx.pause();
  chargeSfx.currentTime = 0;
}

function setProgress(next) {
  progress = Math.max(0, Math.min(1, next));
  root.style.setProperty("--p", progress.toFixed(3));
  shell.classList.toggle("is-open", progress > 0.01);
}

function resetPackAnimation() {
  forcedOpen = false;
  dragging = false;
  stopCharge();
  cancelAnimationFrame(raf);
  clearTimeout(revealResetTimer);
  shell.classList.remove("is-open", "is-complete", "flash");
  stage.classList.remove("reward-focus");
  setProgress(0);
}

function resealPackForNextPull() {
  state.revealReady = false;
  state.currentEventId = "";
  state.currentDecision = "";
  state.decisionBusy = false;
  rewardCardImage.src = FALLBACK_CARD_IMAGE;
  rewardCardImage.alt = "Pulled card preview";
  setPackArt(packArtUrl());
  resetPackAnimation();
  pullResultStatus.textContent = "Pack sealed. Open the selected pack for the next pull.";
  renderAll();
}

function schedulePackReseal() {
  clearTimeout(revealResetTimer);
  revealResetTimer = setTimeout(resealPackForNextPull, 5200);
}

function forceOpen() {
  if (forcedOpen) return;
  forcedOpen = true;
  dragging = false;
  stopCharge();
  playSound(tearSfx, 0.9);
  playSound(openSfx, 0.95);

  const start = progress;
  const startTime = performance.now();
  const duration = 760;
  cancelAnimationFrame(raf);

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    setProgress(start + (1 - start) * eased);
    if (t < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
    shell.classList.add("flash");
    setTimeout(() => {
      shell.classList.add("is-complete");
      stage.classList.add("reward-focus");
      state.revealReady = false;
      pullResultStatus.textContent = "Pull finished. Choose keep or discard.";
      renderAll();
    }, 260);
    setTimeout(() => shell.classList.remove("flash"), 900);
  }

  raf = requestAnimationFrame(step);
}

function progressFromPointer(event) {
  if (forcedOpen || !state.revealReady) return;
  const rect = shell.getBoundingClientRect();
  const next = (event.clientX - rect.left) / rect.width;
  setProgress(next);
  if (progress >= 0.2) forceOpen();
}

function parseCards(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function selectedTier() {
  return PULL_TIERS.find((tier) => tier.id === state.selectedTierId) || PULL_TIERS[0];
}

function packMaxPrice(pack) {
  const previewMax = Math.max(0, ...parseCards(pack.preview_cards).map((card) => Number(card.price_pence || 0)));
  return Math.max(Number(pack.max_price_pence || 0), previewMax);
}

function packMinPrice(pack) {
  const previewPrices = parseCards(pack.preview_cards)
    .map((card) => Number(card.price_pence || 0))
    .filter((price) => price > 0);
  const previewMin = previewPrices.length ? Math.min(...previewPrices) : Number.POSITIVE_INFINITY;
  const packMin = Number(pack?.min_price_pence || 0);
  return Math.min(packMin > 0 ? packMin : Number.POSITIVE_INFINITY, previewMin);
}

function tierAllowsPack(tier, pack) {
  if (!pack || Number(pack.available_stock || 0) <= 0) return false;
  const maxPrice = packMaxPrice(pack);
  const minPrice = packMinPrice(pack);
  if (maxPrice < tier.minCardPence) return false;
  if (!Number.isFinite(tier.maxCardPence)) return true;
  return minPrice <= tier.maxCardPence;
}

function tierEligiblePacks(tier = selectedTier()) {
  return state.packs
    .filter((pack) => tierAllowsPack(tier, pack))
    .sort((a, b) => {
      const priceDelta = packMaxPrice(b) - packMaxPrice(a);
      if (priceDelta) return priceDelta;
      return Number(b.available_stock || 0) - Number(a.available_stock || 0);
    });
}

function selectedPack() {
  const tier = selectedTier();
  const current = state.packs.find((pack) => pack.pack_key === state.selectedPackKey);
  if (tierAllowsPack(tier, current)) return current;
  return tierEligiblePacks(tier)[0] || state.packs.find((pack) => Number(pack.available_stock || 0) > 0) || state.packs[0] || null;
}

function choosePackForTier(tier = selectedTier()) {
  const candidates = tierEligiblePacks(tier).slice(0, 10);
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function tierSummary(tier) {
  return state.tierSummary[tier?.id] || null;
}

function topCardsForTier(tier = selectedTier(), limit = 4) {
  const summaryCards = parseCards(tierSummary(tier)?.preview_cards);
  if (summaryCards.length) return summaryCards.slice(0, limit);

  const seen = new Set();
  const cards = [];
  tierEligiblePacks(tier).forEach((pack) => {
    parseCards(pack.preview_cards).forEach((card) => {
      const price = Number(card.price_pence || 0);
      if (price < tier.minCardPence) return;
      if (Number.isFinite(tier.maxCardPence) && price > tier.maxCardPence) return;
      const key = `${card.name || ""}|${card.set_name || ""}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);
      cards.push({
        ...card,
        source_pack: pack.pack_name,
        price_pence: price
      });
    });
  });
  return cards.sort((a, b) => Number(b.price_pence || 0) - Number(a.price_pence || 0)).slice(0, limit);
}

function tierLiveCount(tier) {
  const summary = tierSummary(tier);
  if (summary) return Number(summary.safe_card_count || 0);
  return tierEligiblePacks(tier).reduce((total, pack) => total + Number(pack.available_stock || 0), 0);
}

function renderPackSelection() {
  const pack = selectedPack();
  const tier = selectedTier();
  if (!pack) {
    selectedPackName.textContent = "No tier stock yet";
    selectedPackMeta.textContent = "Add live single-card stock first";
    stage.dataset.hint = "add live single-card stock first";
    openSelectedPack.innerHTML = `<i data-lucide="package-open"></i> No tier stock`;
    openSelectedPack.disabled = true;
    return;
  }

  state.selectedPackKey = pack.pack_key;
  setPackArt(packArtUrl(pack));
  selectedPackName.textContent = tier.name;
  if (state.revealReady) {
    selectedPackMeta.textContent = `${tier.priceLabel} tier | ${tier.creditCost} credits used`;
    stage.dataset.hint = `${tier.priceLabel} tier | drag to open`;
    openSelectedPack.innerHTML = `<i data-lucide="package-open"></i> OPEN PACK (${tier.creditCost} CREDITS)`;
    openSelectedPack.classList.add("reveal-ready");
  } else if (state.currentDecision === "pending") {
    selectedPackMeta.textContent = "Choose keep or discard";
    stage.dataset.hint = "choose keep or discard";
    openSelectedPack.innerHTML = `<i data-lucide="package-open"></i> Choose keep or discard`;
    openSelectedPack.classList.remove("reveal-ready");
  } else if (state.busy) {
    selectedPackMeta.textContent = `Checking stock | ${tier.creditCost} credits`;
    stage.dataset.hint = "checking live stock";
    openSelectedPack.innerHTML = `<i data-lucide="loader-circle"></i> Loading pull...`;
    openSelectedPack.classList.remove("reveal-ready");
  } else {
    selectedPackMeta.textContent = `${tier.priceLabel} | ${tier.creditCost} credits | ${tier.minLabel}-${tier.maxLabel}`;
    stage.dataset.hint = `load pull then drag to open | ${tier.creditCost} credits`;
    openSelectedPack.innerHTML = `<i data-lucide="package-open"></i> OPEN PACK (${tier.creditCost} CREDITS)`;
    openSelectedPack.classList.remove("reveal-ready");
  }
  openSelectedPack.disabled = state.busy || state.currentDecision === "pending";
}

function renderCredits() {
  authPanel.classList.toggle("hidden", Boolean(state.user));
  signOutButton.classList.toggle("hidden", !state.user);
  grantCredits.classList.toggle("hidden", !state.isAdmin);

  if (!state.user) {
    creditBalance.textContent = "Sign in";
    accountStatus.href = "#authPanel";
    accountStatus.classList.remove("signed-in");
    accountStatus.setAttribute("aria-label", "Go to pull sign in");
    accountStatusLabel.textContent = "Join / Sign in";
    accountStatusMeta.textContent = "Pull account";
    return;
  }

  const balance = Number(state.credits?.credits_balance || 0);
  creditBalance.textContent = `${balance} credit${balance === 1 ? "" : "s"}`;
  const email = state.user.email || "Signed in";
  accountStatus.href = "#";
  accountStatus.classList.add("signed-in");
  accountStatus.setAttribute("aria-label", `Signed in as ${email}`);
  accountStatusLabel.textContent = "Signed in";
  accountStatusMeta.textContent = `${email} | ${balance} credit${balance === 1 ? "" : "s"}`;
}

function renderPacks() {
  const livePackCount = state.packs.filter((pack) => Number(pack.available_stock || 0) > 0).length;
  packCount.textContent = livePackCount
    ? `${livePackCount} live single-card pools feeding four fixed pull tiers`
    : "No single-card stock is available yet";

  if (!livePackCount) {
    packGrid.innerHTML = `<div class="empty-state">No live single-card stock found for pull tiers.</div>`;
    return;
  }

  packGrid.innerHTML = PULL_TIERS.map((tier) => {
    const cards = topCardsForTier(tier, 4);
    const liveSingles = tierLiveCount(tier);
    const previews = cards.length
      ? cards.map((card) => `
          <article class="tier-chase-card">
            <img src="${escapeHtml(imageUrl(card.image_url))}" alt="" loading="lazy" onerror="this.src='${FALLBACK_CARD_IMAGE}'" />
            <div>
              <strong>${moneyFromPence(card.price_pence)}</strong>
              <span>${escapeHtml(card.name || "Single card")}</span>
            </div>
          </article>
        `).join("")
      : `<img src="${FALLBACK_CARD_IMAGE}" alt="" loading="lazy" />`;
    const selected = tier.id === state.selectedTierId;

    return `
      <article class="tier-card tone-${escapeHtml(tier.tone)} ${selected ? "selected" : ""}">
        <div class="tier-copy">
          <span class="tier-kicker">${escapeHtml(tier.rarityLabel || `Tier ${tier.number}`)}</span>
          <h3>${escapeHtml(tier.name)}</h3>
          <p>${escapeHtml(tier.strap)}</p>
          <div class="tier-stats">
            <span>${escapeHtml(tier.priceLabel)}</span>
            <span>${tier.creditCost} credits</span>
            <span>Min ${escapeHtml(tier.minLabel)}</span>
            <span>Max ${escapeHtml(tier.maxLabel)}</span>
            <span>${liveSingles} guarded</span>
          </div>
        </div>
        <img class="tier-pack-art" src="${escapeHtml(tier.packArt)}" alt="" loading="lazy" />
        <div class="tier-chase-list">
          <span>Chase cards</span>
          ${previews}
        </div>
        <div class="tier-foot">
          <button type="button" data-tier-id="${escapeHtml(tier.id)}">${selected ? "Selected tier" : "Select tier"}</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderPulledCards() {
  if (!state.latestCards.length) {
    pulledGrid.innerHTML = `<div class="empty-state">Your pulled card will appear here after Supabase confirms stock is available.</div>`;
    return;
  }

  pulledGrid.innerHTML = state.latestCards.map((card, index) => `
    <article class="pulled-card" style="animation-delay: ${index * 70}ms">
      <img src="${escapeHtml(imageUrl(card.image_url))}" alt="${escapeHtml(card.name)}" loading="lazy" onerror="this.src='${FALLBACK_CARD_IMAGE}'" />
      <div>
        <h3>${escapeHtml(card.name)}</h3>
        <p>${escapeHtml(card.set_name || "Single card")}</p>
        <strong>${moneyFromPence(card.price_pence)}</strong>
      </div>
    </article>
  `).join("");
}

function decisionLabel(decision) {
  if (decision === "kept") return "Kept";
  if (decision === "discarded") return "Discarded";
  return "Pending";
}

function renderDecision() {
  const isVisible = Boolean(state.currentEventId && state.currentDecision === "pending" && shell.classList.contains("is-complete"));
  pullDecision.classList.toggle("hidden", !isVisible);
  pullDecision.querySelectorAll("button").forEach((button) => {
    button.disabled = state.decisionBusy;
  });
}

function historyCardRows() {
  return state.history.flatMap((entry) => {
    const decision = entry.decision || "pending";
    return parseCards(entry.cards).map((card) => ({
      event_id: entry.id,
      pack_key: entry.pack_key,
      pack_name: entry.pack_name,
      credits_spent: Number(entry.credits_spent || 0),
      decision,
      decision_at: entry.decision_at,
      created_at: entry.created_at,
      card
    }));
  });
}

function filteredHistoryRows() {
  const rows = historyCardRows();
  if (state.historyTab === "live" || state.historyTab === "all") return rows;
  return rows.filter((row) => row.decision === state.historyTab);
}

function renderHistory() {
  if (historyTabs) {
    historyTabs.querySelectorAll("[data-history-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.historyTab === state.historyTab);
    });
  }

  if (!state.user) {
    historyList.innerHTML = `<div class="empty-state">Sign in to see pull history.</div>`;
    return;
  }

  const rows = filteredHistoryRows();
  const pageStart = (state.historyPage - 1) * HISTORY_PAGE_SIZE;
  const visibleRows = rows.slice(0, HISTORY_PAGE_SIZE);

  if (historyToolbar && historyPageLabel) {
    const end = pageStart + visibleRows.length;
    historyPageLabel.textContent = visibleRows.length
      ? `Page ${state.historyPage} | ${pageStart + 1}-${end}${state.historyHasMore ? "+" : ""}`
      : `Page ${state.historyPage}`;
    historyToolbar.querySelector('[data-history-page="prev"]').disabled = state.historyPage <= 1;
    historyToolbar.querySelector('[data-history-page="next"]').disabled = !state.historyHasMore;
  }

  if (!state.history.length || !rows.length) {
    historyList.innerHTML = `<div class="empty-state">No pulls recorded yet.</div>`;
    return;
  }

  if (!visibleRows.length) {
    const label = state.historyTab === "live" ? "live pull log" : `${state.historyTab} pulls`;
    historyList.innerHTML = `<div class="empty-state">No ${escapeHtml(label)} recorded yet.</div>`;
    return;
  }

  historyList.innerHTML = visibleRows.map((row) => {
    const card = row.card || {};
    const date = row.created_at ? new Date(row.created_at).toLocaleString("en-GB") : "";
    const rowId = `${row.event_id || ""}|${card.id || card.name || ""}`;
    const isExpanded = state.expandedHistoryId === rowId;
    return `
      <article class="history-entry ${escapeHtml(row.decision)} ${isExpanded ? "expanded" : ""}" data-history-row="${escapeHtml(rowId)}" role="button" tabindex="0" aria-expanded="${isExpanded ? "true" : "false"}">
        <img class="history-card-image" src="${escapeHtml(imageUrl(card.image_url))}" alt="${escapeHtml(card.name || "Pulled card")}" loading="lazy" onerror="this.src='${FALLBACK_CARD_IMAGE}'" />
        <div>
          <h3>${escapeHtml(card.name || "Single-card pull")}</h3>
          <p>${escapeHtml(card.set_name || row.pack_name || "tcglocker pull")}</p>
          <div class="history-meta">
            <span>${moneyFromPence(card.price_pence)}</span>
            <span>${row.credits_spent} credits</span>
            <span>1 card</span>
            <span class="decision-pill ${escapeHtml(row.decision)}">${decisionLabel(row.decision)}</span>
            <span>${escapeHtml(date)}</span>
          </div>
          <div class="history-submeta">
            <span>${escapeHtml(row.pack_name || row.pack_key || "Pull pool")}</span>
            <span>${escapeHtml(row.event_id || "")}</span>
          </div>
        </div>
        <button class="history-expand-button" type="button" aria-label="${isExpanded ? "Collapse card details" : "Expand card details"}">
          <i data-lucide="${isExpanded ? "chevron-up" : "chevron-down"}"></i>
        </button>
        <div class="history-expanded-card">
          <img src="${escapeHtml(imageUrl(card.image_url))}" alt="${escapeHtml(card.name || "Pulled card")}" loading="lazy" onerror="this.src='${FALLBACK_CARD_IMAGE}'" />
          <div>
            <h4>${escapeHtml(card.name || "Single-card pull")}</h4>
            <dl>
              <div><dt>Card value</dt><dd>${moneyFromPence(card.price_pence)}</dd></div>
              <div><dt>Set</dt><dd>${escapeHtml(card.set_name || "Unknown")}</dd></div>
              <div><dt>Pull pool</dt><dd>${escapeHtml(row.pack_name || row.pack_key || "Pull pool")}</dd></div>
              <div><dt>Status</dt><dd>${decisionLabel(row.decision)}</dd></div>
              <div><dt>Credits used</dt><dd>${row.credits_spent}</dd></div>
              <div><dt>Pulled</dt><dd>${escapeHtml(date)}</dd></div>
            </dl>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderAll() {
  renderPackSelection();
  renderCredits();
  renderPacks();
  renderPulledCards();
  renderDecision();
  renderHistory();
  if (window.lucide) window.lucide.createIcons();
}

async function loadPacks() {
  const data = await rpc("list_pull_single_packs");
  state.packs = Array.isArray(data) ? data : [];
  if (!state.selectedPackKey || !tierAllowsPack(selectedTier(), state.packs.find((pack) => pack.pack_key === state.selectedPackKey))) {
    state.selectedPackKey = selectedPack()?.pack_key || "";
  }
}

async function loadTierSummary() {
  const data = await rpc("list_pull_tier_summary").catch(() => []);
  state.tierSummary = {};
  (Array.isArray(data) ? data : []).forEach((row) => {
    if (row?.tier_id) state.tierSummary[row.tier_id] = row;
  });
}

async function loadHistoryPage() {
  const offset = (state.historyPage - 1) * HISTORY_PAGE_SIZE;
  try {
    const history = await rpc("list_my_pull_history", {
      p_limit: HISTORY_PAGE_SIZE + 1,
      p_offset: offset
    });
    const rows = Array.isArray(history) ? history : [];
    state.historyHasMore = rows.length > HISTORY_PAGE_SIZE;
    state.history = rows.slice(0, HISTORY_PAGE_SIZE);
  } catch (_error) {
    const history = await rpc("list_my_pull_history", { p_limit: HISTORY_PAGE_SIZE }).catch(() => []);
    const rows = Array.isArray(history) ? history : [];
    state.historyHasMore = false;
    state.history = rows.slice(0, HISTORY_PAGE_SIZE);
  }
}

async function loadAccountData() {
  if (!state.user) {
    state.credits = null;
    state.history = [];
    state.historyHasMore = false;
    state.isAdmin = false;
    return;
  }

  const [credits, isAdmin] = await Promise.all([
    rpc("get_pull_credit_balance").catch(() => []),
    rpc("is_store_admin").catch(() => false)
  ]);
  await loadHistoryPage();

  state.credits = Array.isArray(credits) ? credits[0] || null : credits;
  state.isAdmin = Boolean(isAdmin);
}

async function refreshAll(message = "") {
  try {
    state.busy = true;
    renderPackSelection();
    await Promise.all([loadPacks(), loadTierSummary()]);
    await loadAccountData();
    if (message) showToast(message);
  } catch (error) {
    showToast(error.message || "Could not load pull data.");
  } finally {
    state.busy = false;
    renderAll();
  }
}

async function openPack() {
  const tier = selectedTier();
  const pack = choosePackForTier(tier) || selectedPack();
  if (!state.user) {
    showToast("Sign in before opening a pull pack.");
    authPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (!pack) {
    showToast("Choose an available singles pack first.");
    return;
  }
  if (state.currentDecision === "pending") {
    showToast("Choose keep or discard before opening another pack.");
    return;
  }
  if (state.revealReady) {
    showToast(`Drag the pack to open. ${tier.creditCost} credits have been used for this pull.`);
    return;
  }
  if (state.busy) return;

  try {
    state.busy = true;
    state.latestCards = [];
    state.selectedPackKey = pack.pack_key;
    state.revealReady = false;
    state.currentEventId = "";
    state.currentDecision = "";
    state.decisionBusy = false;
    state.historyPage = 1;
    pullResultStatus.textContent = "Checking live single-card availability...";
    rewardCardImage.src = FALLBACK_CARD_IMAGE;
    setPackArt(packArtUrl(pack));
    resetPackAnimation();
    renderAll();

    const result = await rpc("open_single_pull_tier", {
      p_tier_id: tier.id,
      p_pack_key: pack.pack_key
    });
    const event = Array.isArray(result) ? result[0] : result;
    const cards = parseCards(event?.cards);
    state.latestCards = cards;
    state.revealReady = cards.length > 0;
    state.currentEventId = event?.event_id || event?.id || "";
    state.currentDecision = cards.length > 0 ? "pending" : "";
    state.credits = {
      ...(state.credits || {}),
      credits_balance: Number(event?.credits_remaining || 0)
    };

    const showcaseCard = [...cards].sort((a, b) => Number(b.price_pence || 0) - Number(a.price_pence || 0))[0];
    rewardCardImage.src = imageUrl(showcaseCard?.image_url);
    rewardCardImage.alt = showcaseCard?.name ? `Pulled ${showcaseCard.name}` : "Pulled card";
    pullResultStatus.textContent = `${cards.length || 1} card pulled from ${tier.name}.`;
    renderAll();
    showToast("Pull ready. Drag the pack to reveal.");

    await Promise.all([loadAccountData(), loadPacks()]);
  } catch (error) {
    pullResultStatus.textContent = "Pull failed.";
    if (error.code === "PGRST202" || String(error.message || "").includes("open_single_pull_tier")) {
      showToast("Tier value guard is not deployed yet. Apply the latest Supabase migration before pulls.");
    } else {
      showToast(error.message || "Could not open this pull pack.");
    }
  } finally {
    state.busy = false;
    renderAll();
  }
}

async function resolvePullDecision(decision) {
  if (!state.currentEventId || state.currentDecision !== "pending" || state.decisionBusy) return;

  try {
    state.decisionBusy = true;
    renderAll();
    await rpc("resolve_my_pull_event", {
      p_event_id: state.currentEventId,
      p_decision: decision
    });
    state.currentDecision = decision;
    pullResultStatus.textContent = `Pull ${decisionLabel(decision).toLowerCase()}. Pack sealed for the next pull.`;
    showToast(decision === "kept" ? "Pull kept." : "Pull discarded.");
    await loadAccountData();
    renderAll();
    setTimeout(resealPackForNextPull, 650);
  } catch (error) {
    state.decisionBusy = false;
    showToast(error.message || "Could not save that pull decision.");
    renderAll();
  }
}

async function signIn(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not available.");
    return;
  }

  const formData = new FormData(signinForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    signinForm.reset();
    showToast("Signed in.");
  } catch (error) {
    showToast(error.message || "Sign in failed.");
  }
}

async function signOut() {
  await supabaseClient.auth.signOut();
  state.user = null;
  state.credits = null;
  state.history = [];
  state.isAdmin = false;
  renderAll();
  showToast("Signed out.");
}

async function addTestCredits() {
  if (!state.isAdmin || state.busy) return;
  try {
    state.busy = true;
    const data = await rpc("admin_grant_self_pull_credits", { p_amount: 50 });
    state.credits = Array.isArray(data) ? data[0] || null : data;
    showToast("Added 50 test pull credits.");
  } catch (error) {
    showToast(error.message || "Could not add credits.");
  } finally {
    state.busy = false;
    renderAll();
  }
}

function bindAnimation() {
  shell.addEventListener("pointerdown", (event) => {
    if (forcedOpen || !state.revealReady) return;
    dragging = true;
    playSound(selectSfx, 0.85);
    startCharge();
    shell.setPointerCapture(event.pointerId);
    progressFromPointer(event);
  });

  shell.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    progressFromPointer(event);
  });

  shell.addEventListener("pointerup", (event) => {
    dragging = false;
    if (!forcedOpen) stopCharge();
    shell.releasePointerCapture(event.pointerId);
  });

  shell.addEventListener("pointercancel", () => {
    dragging = false;
    if (!forcedOpen) stopCharge();
  });
}

function bindEvents() {
  packGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tier-id]");
    if (!button) return;
    if (state.currentDecision === "pending") {
      showToast("Choose keep or discard before changing tiers.");
      return;
    }
    state.selectedTierId = button.dataset.tierId;
    state.selectedPackKey = selectedPack()?.pack_key || "";
    state.latestCards = [];
    state.revealReady = false;
    state.currentEventId = "";
    state.currentDecision = "";
    state.decisionBusy = false;
    setPackArt(packArtUrl(selectedPack()));
    resetPackAnimation();
    pullResultStatus.textContent = "Open a pack to reveal cards.";
    renderAll();
  });

  if (packSearch) {
    packSearch.addEventListener("input", () => {
      state.search = packSearch.value;
      renderPacks();
    });
  }

  if (historyTabs) {
    historyTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-history-tab]");
      if (!button) return;
      state.historyTab = button.dataset.historyTab || "all";
      state.historyPage = 1;
      state.expandedHistoryId = "";
      renderHistory();
      if (window.lucide) window.lucide.createIcons();
    });
  }

  historyList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-history-row]");
    if (!row) return;
    const rowId = row.dataset.historyRow || "";
    state.expandedHistoryId = state.expandedHistoryId === rowId ? "" : rowId;
    renderHistory();
    if (window.lucide) window.lucide.createIcons();
  });

  historyList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-history-row]");
    if (!row) return;
    event.preventDefault();
    const rowId = row.dataset.historyRow || "";
    state.expandedHistoryId = state.expandedHistoryId === rowId ? "" : rowId;
    renderHistory();
    if (window.lucide) window.lucide.createIcons();
  });

  if (historyToolbar) {
    historyToolbar.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-history-page]");
      if (!button || button.disabled || !state.user) return;
      const direction = button.dataset.historyPage;
      if (direction === "prev" && state.historyPage > 1) {
        state.historyPage -= 1;
      } else if (direction === "next" && state.historyHasMore) {
        state.historyPage += 1;
      } else {
        return;
      }

      state.expandedHistoryId = "";
      historyList.innerHTML = `<div class="empty-state">Loading pull history...</div>`;
      await loadHistoryPage();
      renderHistory();
      if (window.lucide) window.lucide.createIcons();
    });
  }

  refreshPacks.addEventListener("click", () => refreshAll("Pull tiers refreshed."));
  openSelectedPack.addEventListener("click", openPack);
  pullDecision.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pull-decision]");
    if (!button) return;
    resolvePullDecision(button.dataset.pullDecision);
  });
  signinForm.addEventListener("submit", signIn);
  signOutButton.addEventListener("click", signOut);
  grantCredits.addEventListener("click", addTestCredits);
}

async function init() {
  if (!supabaseClient) {
    showToast("Supabase did not load.");
    return;
  }

  bindAnimation();
  bindEvents();
  resetPackAnimation();
  renderAll();
  await loadPackArtManifest();

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user || null;
    await loadAccountData();
    renderAll();
  });

  const { data } = await supabaseClient.auth.getSession();
  state.user = data.session?.user || null;
  await refreshAll();
}

init();
