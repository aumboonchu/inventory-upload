(() => {
  "use strict";
  const endpoint = "/api/admin/sales";
  const workerUrl = "assets/sales-worker.js?v=20261120-sales100k-1";
  const maxFileBytes = 64 * 1024 * 1024, maxFileRows = 100000;
  const previewTimeout = 5 * 60 * 1000;
  const tokenKey = "inventory_token_admin";
  const privateRequest = { cache: "no-store", credentials: "omit", redirect: "error" };
  const countFormat = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 8 });
  const bahtFormat = new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const axisFormat = new Intl.NumberFormat("th-TH", { notation: "compact", maximumFractionDigits: 2 });
  const monthFormat = new Intl.DateTimeFormat("th-TH-u-ca-gregory", { month: "long", year: "numeric", timeZone: "UTC" });
  const dateFormat = new Intl.DateTimeFormat("th-TH-u-ca-gregory", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const collation = new Intl.Collator("th", { numeric: true });
  const pageSize = 8;
  const el = id => document.getElementById(id);
  const money = satang => bahtFormat.format(satang / 100);
  const count = number => countFormat.format(number);
  const dateText = iso => dateFormat.format(new Date(iso + "T00:00:00Z"));
  const monthText = month => monthFormat.format(new Date(month + "-01T00:00:00Z"));
  const monthOk = month => typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const lastDay = month => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
  const isoDay = (month, day) => month + "-" + String(day).padStart(2, "0");
  const dateOk = d => typeof d === "string" && /^\d{4}-\d\d-\d\d$/.test(d) && monthOk(d.slice(0, 7)) &&
    +d.slice(8) >= 1 && +d.slice(8) <= lastDay(d.slice(0, 7));
  const branchKey = r => r.branchId || r.branch || "ไม่ระบุสาขา";
  const categoryKey = r => r.category || "ไม่ระบุหมวดหมู่";
  const blankFilters = m => ({ from: isoDay(m, 1), to: isoDay(m, lastDay(m)), branch: "", category: "" });
  const option = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  const icon = name => `<span aria-hidden="true" class="sales-icon sales-icon-${name}"></span>`;
  let current = null;

  const uploadMonthOk = m => monthOk(m) && /^(?:19|20|21)/.test(m);
  const uploadTextOk = (v, max) => typeof v === "string" && v.length <= max && v.trim() !== "" && !/[\x00-\x1f\x7f]/.test(v);

  function cleanRow(r, forUpload, index) {
    const valid = r && dateOk(r.date) && Number.isSafeInteger(r.satang) && Number.isSafeInteger(r.units);
    if (forUpload && (!valid || !uploadMonthOk(r.date.slice(0,7)) ||
        !uploadTextOk(r.branchId,60) || !uploadTextOk(r.branch,180) || !uploadTextOk(r.product,120) ||
        !uploadTextOk(r.name,400) || !uploadTextOk(r.category,150) || Math.abs(r.units) > 1e7 ||
        Math.abs(r.satang) > 1e12 || typeof r.key !== "string" || !/^[a-f\d]{64}$/.test(r.key))) {
      throw new Error("ข้อมูลยอดขายไม่ถูกต้องที่รายการ " + count(index + 1));
    }
    if (!valid || !["string", "number"].includes(typeof r.product) || !String(r.product).trim()) {
      throw new Error("พบรายการที่มีวันที่ รหัสสินค้า จำนวนชิ้น หรือยอดขายไม่ถูกต้อง");
    }
    const row = { date: r.date, branchId: String(r.branchId ?? ""), branch: String(r.branch ?? ""),
      product: String(r.product), name: String(r.name ?? ""), category: String(r.category ?? ""),
      units: r.units, satang: r.satang };
    if (forUpload) row.key = r.key;
    return row;
  }

  function stopWorker(draft) {
    if (!draft) return;
    if (draft.worker) {
      draft.worker.onmessage = draft.worker.onerror = draft.worker.onmessageerror = null;
      draft.worker.terminate();
      draft.worker = null;
    }
  }

  function dropDraft(s) {
    if (!s.draft) return;
    clearTimeout(s.draft.timer);
    stopWorker(s.draft);
    s.draft.request?.abort();
    s.draft.rows = null;
    s.draft = null;
  }

  function forget() {
    const s = current;
    current = null;
    if (!s) return;
    s.get?.abort();
    dropDraft(s);
    s.data = s.model = s.filters = null;
    s.months = [];
    s.token = "";
  }

  function syncSession() {
    forget();
    token = localStorage.getItem(tokenKey) || "";
    if (token) return window.salesView();
    loginView();
  }

  function active(s) {
    if (s !== current) return false;
    if (s.token === token && s.version === adminLoadVersion && token === localStorage.getItem(tokenKey)) return true;
    syncSession();
    return false;
  }

  function denied(s, error) {
    if (error.status !== 401 && error.status !== 403) return false;
    if (active(s)) {
      forget();
      adminLoadVersion++;
      localStorage.removeItem(tokenKey);
      token = "";
      loginView("เซสชันหมดอายุหรือไม่มีสิทธิ์ดูยอดขาย กรุณาเข้าสู่ระบบอีกครั้ง");
    }
    return true;
  }

  // A history snapshot must not contain the last admin's rows, filename or open file dialog.
  window.addEventListener("pagehide", () => {
    forget();
    el("app")?.replaceChildren();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) syncSession(); });
  window.addEventListener("storage", event => {
    if ((event.key === tokenKey || event.key === null) && localStorage.getItem(tokenKey) !== (token || null)) syncSession();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && current) active(current);
  });

  function dialogMarkup() {
    return `<dialog id="salesUploadDialog" class="admin-dialog sales-dialog" aria-labelledby="salesUploadTitle">
      <h2 id="salesUploadTitle">นำเข้ายอดขายจาก Excel</h2>
      <p class="dialog-note">เพิ่มเฉพาะบรรทัดใหม่ ข้ามรายการซ้ำทั้งในไฟล์นี้และไฟล์ก่อนหน้า โดยไม่แทนที่ยอดขายเดิมของวันนั้น</p>
      <div class="sales-file-box">
        <b class="sales-file-mark" aria-hidden="true">XLSX</b>
        <div><strong id="salesFileName">ยังไม่ได้เลือกไฟล์</strong><small>.xlsx 1 ไฟล์ ไม่เกิน 64 MiB และ 100,000 แถวข้อมูล</small></div>
        <button id="salesChoose" class="button secondary" type="button">เลือกไฟล์</button>
        <input id="salesFile" type="file" accept=".xlsx" aria-label="ไฟล์ยอดขาย Excel" hidden>
      </div>
      <div id="salesUploadFeedback" role="status" aria-live="polite"></div>
      <div id="salesPreview"></div>
      <div class="dialog-actions"><button id="salesCancel" type="button" class="button secondary">ยกเลิก</button>
        <button id="salesConfirm" type="button" class="button primary" disabled>${icon("upload")}ยืนยันนำเข้า</button></div>
    </dialog>`;
  }

  function mount(s) {
    app.onclick = null;
    app.innerHTML = shell(`<div id="salesPage" class="sales-page">
      <header class="workspace-heading sales-heading"><div><h1>ภาพรวมยอดขาย</h1><p id="salesLatest" hidden></p></div>
        <div class="heading-actions"><button id="salesReload" type="button" class="button secondary sales-icon-button" aria-label="โหลดข้อมูลยอดขายใหม่" title="โหลดข้อมูลยอดขายใหม่">${icon("reload")}</button>
          <button id="salesUpload" type="button" class="button primary" disabled>${icon("upload")}นำเข้า Excel</button></div></header>
      <div id="salesNotice" role="status" class="status success" hidden></div>
      <div id="salesFilters" class="sales-filters" role="group" aria-label="ตัวกรองยอดขาย" hidden></div>
      <div id="salesResults" aria-busy="true"></div>${dialogMarkup()}</div>`, "sales");
    bindCommon();
    el("logoutBtn")?.addEventListener("click", forget, { capture: true });
    el("salesPage").addEventListener("click", event => onClick(s, event));
    el("salesPage").addEventListener("change", event => onChange(s, event));
    el("salesPage").addEventListener("keydown", event => onDayKey(s, event));
    const dialog = el("salesUploadDialog");
    dialog.addEventListener("cancel", event => { if (s.draft?.sending) event.preventDefault(); });
    dialog.addEventListener("close", () => { if (!dialog.open && current === s) clearDialog(s); });
  }

  window.salesView = function salesView() {
    forget();
    if (!token || token !== localStorage.getItem(tokenKey)) return syncSession();
    const s = { token, version: ++adminLoadVersion, get: null, months: [], month: "", data: null,
      model: null, filters: null, day: "", sort: "satang", productPage: 0, allCategories: false, draft: null };
    current = s;
    mount(s);
    return load(s, "");
  };

  function filtersMarkup(s) {
    const box = el("salesFilters");
    box.hidden = !s.months.length;
    box.innerHTML = !s.months.length ? "" : `<label>เดือน<select id="salesMonth">${s.months.map(m => option(m, monthText(m))).join("")}</select></label>`;
    if (!s.months.length) return;
    el("salesMonth").value = s.month;
    if (!s.filters) return;
    const branches = new Map(), categories = new Set();
    for (const row of s.data.rows) {
      const key = branchKey(row);
      if (!branches.has(key)) branches.set(key, row.branch && row.branch !== key ? row.branch + " · " + key : key);
      categories.add(categoryKey(row));
    }
    const start = isoDay(s.month, 1), end = isoDay(s.month, lastDay(s.month));
    box.insertAdjacentHTML("beforeend", `<label>ตั้งแต่วันที่<input id="salesFrom" type="date" min="${start}" max="${end}" value="${start}"></label>
      <label>ถึงวันที่<input id="salesTo" type="date" min="${start}" max="${end}" value="${end}"></label>
      <label>สาขา<select id="salesBranch">${option("", "ทุกสาขา")}${Array.from(branches).sort((a,b) => collation.compare(a[1],b[1])).map(([k,v]) => option(k,v)).join("")}</select></label>
      <label>หมวดหมู่<select id="salesCategory">${option("", "ทุกหมวดหมู่")}${Array.from(categories).sort(collation.compare).map(c => option(c,c)).join("")}</select></label>
      <button id="salesReset" type="button" class="button secondary sales-reset" disabled>ล้างตัวกรอง</button>`);
  }

  async function load(s, month) {
    if (!active(s)) return;
    const restoreMonthFocus = document.activeElement?.id === "salesMonth";
    s.get?.abort();
    const req = s.get = new AbortController();
    s.data = s.filters = s.model = null;
    s.month = month;
    s.day = "";
    s.productPage = 0;
    s.allCategories = false;
    el("salesUpload").disabled = el("salesReload").disabled = true;
    el("salesLatest").hidden = true;
    el("salesLatest").textContent = "";
    el("salesResults").setAttribute("aria-busy", "true");
    el("salesResults").innerHTML = '<p role="status" class="sales-state sales-loading">กำลังโหลดข้อมูลยอดขาย…</p>';
    filtersMarkup(s);
    if (restoreMonthFocus) el("salesMonth")?.focus();
    try {
      const rows=[];
      const result=await readSalesPages(endpoint,month ? {month} : {},() => active(s) && req===s.get,req.signal,page => {
        if (!Array.isArray(page.rows)) throw new Error("Invalid sales page");
        for (const raw of page.rows) {
          const row=cleanRow(raw,false);
          if (!row.date.startsWith(page.month + "-")) throw new Error("Invalid sales date");
          rows.push(row);
        }
      });
      if (!active(s) || req !== s.get) return;
      if (result?.ok !== true || !Array.isArray(result.rows) || !Array.isArray(result.months) ||
          !(monthOk(result.month) || (result.month === "" && result.rows.length === 0))) throw new Error();
      const months = result.months.filter(monthOk);
      if (result.month) months.push(result.month);
      s.months = Array.from(new Set(months)).sort().reverse();
      s.month = result.month;
      s.data = { rows };
      s.filters = s.month ? blankFilters(s.month) : null;
      filtersMarkup(s);
      if (restoreMonthFocus) el("salesMonth")?.focus();
      const latest = result.latest;
      if (latest?.uploadedAt || latest?.filename) {
        el("salesLatest").textContent = ["นำเข้าล่าสุด", latest.uploadedAt && formatDateTime(latest.uploadedAt), latest.filename].filter(Boolean).join(" · ");
        el("salesLatest").hidden = false;
      }
      el("salesUpload").disabled = false;
      draw(s);
    } catch (error) {
      if (denied(s, error) || !active(s) || req !== s.get) return;
      s.data = s.model = s.filters = null;
      s.months = [];
      filtersMarkup(s);
      el("salesResults").innerHTML = `<div class="sales-state" role="alert"><h2>โหลดข้อมูลยอดขายไม่สำเร็จ</h2>
        <p>ตรวจสอบการเชื่อมต่อ แล้วลองโหลดอีกครั้ง</p><button id="salesRetry" class="button secondary" type="button">${icon("reload")}ลองอีกครั้ง</button></div>`;
    } finally {
      if (current === s && req === s.get) {
        s.get = null;
        el("salesReload").disabled = false;
        el("salesResults").setAttribute("aria-busy", "false");
      }
    }
  }

  function add(map, key, row) {
    const item = map.get(key) || { key, name: row.name, units: 0, satang: 0 };
    item.units += row.units;
    item.satang += row.satang;
    map.set(key, item);
  }

  function summarize(rows, f) {
    const m = { satang: 0, units: 0, matches: 0, branches: new Set(), products: new Map(), categories: new Map(), days: new Map() };
    for (const r of rows) {
      const branch = branchKey(r), category = categoryKey(r);
      if (r.date < f.from || r.date > f.to || (f.branch && branch !== f.branch) || (f.category && category !== f.category)) continue;
      m.matches++;
      m.satang += r.satang;
      m.units += r.units;
      m.branches.add(branch);
      add(m.days, r.date, r);
      add(m.products, r.product, r);
      add(m.categories, category, r);
    }
    return m;
  }

  function syncFilters(s) {
    const f = s.filters, initial = blankFilters(s.month);
    el("salesFrom").value = f.from;
    el("salesTo").value = f.to;
    el("salesBranch").value = f.branch;
    el("salesCategory").value = f.category;
    el("salesReset").disabled = !Object.keys(initial).some(k => initial[k] !== f[k]);
  }

  function draw(s) {
    if (s.filters) syncFilters(s);
    if (!s.data.rows.length || !s.filters) {
      el("salesResults").innerHTML = `<div class="sales-state" role="status"><h2>ยังไม่มีข้อมูลยอดขาย${s.month ? "ในเดือนนี้" : ""}</h2>
        <p>นำเข้าไฟล์ Excel เพื่อดูยอดขายรายวันและสินค้าขายดี</p>
        <button type="button" class="button secondary" data-action="upload">${icon("upload")}นำเข้า Excel</button></div>`;
      return;
    }
    const m = s.model = summarize(s.data.rows, s.filters);
    const metric = (key, label, value) => `<div><dt>${label}</dt><dd data-metric="${key}">${value}</dd></div>`;
    const summary = `<dl id="salesMetrics" class="sales-metrics" aria-label="สรุปยอดขายตามตัวกรอง">
      ${metric("satang", "ยอดขายรวม (บาท)", m.matches ? money(m.satang) : "—")}
      ${metric("units", "จำนวนขาย (ชิ้น)", m.matches ? count(m.units) : "—")}
      ${metric("products", "สินค้า (SKU)", count(m.products.size))}
      ${metric("branches", "สาขาที่มีรายการ", count(m.branches.size))}</dl>`;
    if (!m.matches) {
      el("salesResults").innerHTML = summary + `<div class="sales-state" role="status"><h2>ไม่พบรายการตามตัวกรอง</h2>
        <p>ลองเปลี่ยนช่วงวันที่ สาขา หรือหมวดหมู่</p><button type="button" class="button secondary" data-action="reset">ล้างตัวกรอง</button></div>`;
      return;
    }
    el("salesResults").innerHTML = summary + daily(s) + `<div class="sales-breakdowns">
      <section id="salesCategories" aria-labelledby="salesCategoriesTitle"></section>
      <section id="salesProducts" aria-labelledby="salesProductsTitle"></section></div>`;
    selectDay(s, s.day);
    renderCategories(s);
    renderProducts(s);
  }

  function daily(s) {
    const { from, to } = s.filters, days = [], values = s.model.days;
    for (let i = +from.slice(8); i <= +to.slice(8); i++) days.push(isoDay(s.month, i));
    if (!days.includes(s.day)) s.day = days.filter(d => values.has(d)).pop() || days[0];
    const amounts = Array.from(values.values(), r => r.satang);
    const high = Math.max(0, ...amounts), low = Math.min(0, ...amounts), span = high - low || 1;
    const zero = high === low ? 94 : 4 + 90 * high / span;
    const tick = (v, at) => `<span class="sales-tick" style="top:${at}%">${axisFormat.format(v / 100)}</span>`;
    const mark = (date, i) => {
      const item = values.get(date), n = item?.satang ?? 0;
      const state = !item ? "missing" : n < 0 ? "negative" : n === 0 ? "zero" : "positive";
      const height = Math.abs(n) / span * 90, top = n > 0 ? zero - height : zero;
      const label = dateText(date) + ": " + (item ? money(n) + " บาท, " + count(item.units) + " ชิ้น" : "ไม่มีข้อมูล");
      const showTick = days.length <= 9 || i === 0 || i === days.length - 1 || (i >= 3 && i < days.length - 3 && +date.slice(8) % 5 === 0);
      return `<button type="button" class="sales-day" data-day="${date}" data-state="${state}"
        aria-label="${label}" aria-pressed="false" tabindex="-1" title="${label}">
        <span class="sales-bar" style="top:${top}%;height:${height}%" aria-hidden="true"></span>
        ${showTick ? `<span class="sales-day-tick" aria-hidden="true">${+date.slice(8)}</span>` : ""}</button>`;
    };
    return `<section class="sales-daily" aria-labelledby="salesDailyTitle">
      <div class="sales-section-title"><h2 id="salesDailyTitle">ยอดขายรายวัน</h2><span>${monthText(s.month)} · บาท</span></div>
      <div class="sales-chart" role="group" aria-label="กราฟยอดขายรายวัน หน่วยบาท">
        <div class="sales-axis" aria-hidden="true">${tick(0,zero)}${high > 0 && zero > 18 ? tick(high,4) : ""}${low < 0 && zero < 80 ? tick(low,94) : ""}</div>
        <div class="sales-plot" style="--sales-days:${days.length};--sales-zero:${zero}%">${days.map(mark).join("")}</div></div>
      <div class="sales-legend" aria-label="สัญลักษณ์กราฟ"><span class="positive">ยอดขาย</span>${low < 0 ? '<span class="negative">ยอดติดลบ</span>' : ""}
        <span class="zero">ยอดเป็นศูนย์</span><span class="missing">ไม่มีข้อมูล</span></div>
      <div class="sales-inspect"><label for="salesDay">วันที่</label><select id="salesDay">${days.map(d => option(d,dateText(d))).join("")}</select>
        <output id="salesDayDetail" for="salesDay" aria-live="polite"></output>
        <button type="button" class="sales-text-button" data-action="filter-day" ${from === to ? "hidden" : ""}>กรองเฉพาะวันที่เลือก</button></div>
    </section>`;
  }

  function selectDay(s, date, focus = false) {
    const day = el("salesDay");
    if (!day || !dateOk(date) || date < s.filters.from || date > s.filters.to) return;
    day.value = s.day = date;
    const item = s.model.days.get(date);
    el("salesDayDetail").textContent = item ? money(item.satang) + " บาท · " + count(item.units) + " ชิ้น" : "ไม่มีข้อมูล";
    for (const button of el("salesResults").querySelectorAll("[data-day]")) {
      const on = button.dataset.day === date;
      button.setAttribute("aria-pressed", String(on));
      button.tabIndex = on ? 0 : -1;
      if (on && focus) button.focus();
    }
  }

  function onDayKey(s, event) {
    if (!event.target.matches("[data-day]") || !active(s)) return;
    const buttons = Array.from(el("salesResults").querySelectorAll("[data-day]")), i = buttons.indexOf(event.target);
    const index = { ArrowRight: Math.min(i + 1, buttons.length - 1), ArrowLeft: Math.max(i - 1, 0), Home: 0, End: buttons.length - 1 }[event.key];
    if (index === undefined) return;
    event.preventDefault();
    selectDay(s, buttons[index].dataset.day, true);
  }

  function renderCategories(s) {
    const list = Array.from(s.model.categories.values()).sort((a,b) => b.satang - a.satang || collation.compare(a.key,b.key));
    const high = Math.max(0, list[0].satang), low = Math.min(0, list[list.length - 1].satang);
    const span = high - low || 1, zero = -low / span * 100;
    const line = r => `<li><button type="button" class="sales-category" data-category="${escapeHtml(r.key)}" title="${escapeHtml("กรองหมวดหมู่ " + r.key)}">
      <span class="sales-category-name">${escapeHtml(r.key)}</span><strong>${money(r.satang)}</strong>
      <span class="sales-track" aria-hidden="true" style="--origin:${zero}%"><i class="${r.satang < 0 ? "negative" : ""}"
        style="left:${(Math.min(0,r.satang) - low) / span * 100}%;width:${Math.abs(r.satang) / span * 100}%"></i></span></button></li>`;
    el("salesCategories").innerHTML = `<div class="sales-section-title"><h2 id="salesCategoriesTitle">ยอดขายตามหมวดหมู่</h2><span>บาท</span></div>
      <ul class="sales-category-list">${(s.allCategories ? list : list.slice(0,6)).map(line).join("")}</ul>
      ${list.length > 6 ? `<button type="button" id="salesMoreCategories" class="sales-text-button" aria-expanded="${s.allCategories}">${s.allCategories ? "แสดงน้อยลง" : "ดูทั้งหมด " + count(list.length) + " หมวดหมู่"}</button>` : ""}`;
  }

  function renderProducts(s) {
    const list = Array.from(s.model.products.values()).sort((a,b) => b[s.sort] - a[s.sort] || collation.compare(a.key,b.key));
    const pages = Math.ceil(list.length / pageSize);
    s.productPage = Math.max(0, Math.min(s.productPage, pages - 1));
    const start = s.productPage * pageSize;
    const sortButton = (key,label) => `<button type="button" data-sort="${key}" aria-pressed="${s.sort === key}">${label}</button>`;
    el("salesProducts").innerHTML = `<div class="sales-section-title"><h2 id="salesProductsTitle">สินค้าขายดี</h2>
      <div class="sales-sort" role="group" aria-label="จัดอันดับสินค้าตาม">${sortButton("satang","ยอดขาย")}${sortButton("units","จำนวนชิ้น")}</div></div>
      <table class="sales-product-table"><caption class="visually-hidden">สินค้าขายดี เรียงตาม${s.sort === "units" ? "จำนวนชิ้น" : "ยอดขาย"}จากมากไปน้อย</caption>
        <thead><tr><th scope="col">สินค้า / SKU</th><th scope="col">ชิ้น</th><th scope="col">ยอดขาย (บาท)</th></tr></thead><tbody>
        ${list.slice(start,start + pageSize).map((r,i) => `<tr><td><div class="sales-product"><span aria-hidden="true">${start + i + 1}</span>
          <div><strong>${escapeHtml(r.name || r.key)}</strong>${r.name && r.name !== r.key ? `<small>${escapeHtml(r.key)}</small>` : ""}</div></div></td>
          <td>${count(r.units)}</td><td>${money(r.satang)}</td></tr>`).join("")}</tbody></table>
      ${pages > 1 ? `<div class="sales-pagination"><span>${count(start + 1)}–${count(Math.min(start + pageSize,list.length))} จาก ${count(list.length)} SKU</span>
        <button class="button secondary" type="button" data-step="-1" aria-label="สินค้าหน้าก่อนหน้า" title="หน้าก่อนหน้า" ${start === 0 ? "disabled" : ""}>‹</button>
        <button class="button secondary" type="button" data-step="1" aria-label="สินค้าหน้าถัดไป" title="หน้าถัดไป" ${s.productPage + 1 === pages ? "disabled" : ""}>›</button></div>` : ""}`;
  }

  function feedback(message = "", bad = false) {
    const node = el("salesUploadFeedback");
    node.hidden = !message;
    node.className = bad ? "status error" : "sales-feedback";
    node.setAttribute("role", bad ? "alert" : "status");
    node.textContent = message;
  }

  function clearDialog(s) {
    dropDraft(s);
    el("salesFile").value = "";
    el("salesFileName").textContent = "ยังไม่ได้เลือกไฟล์";
    el("salesPreview").replaceChildren();
    feedback();
    el("salesCancel").disabled = el("salesChoose").disabled = false;
    el("salesCancel").textContent = "ยกเลิก";
    el("salesConfirm").disabled = true;
    el("salesConfirm").innerHTML = icon("upload") + "ยืนยันนำเข้า";
  }

  function openUpload(s) {
    if (!s.data || el("salesUploadDialog").open) return;
    clearDialog(s);
    el("salesUploadDialog").showModal();
    el("salesChoose").focus();
  }

  function previewMoney(satang) {
    const abs = satang < 0n ? -satang : satang;
    return (satang < 0n ? "-" : "") + count(abs / 100n) + "." + String(abs % 100n).padStart(2, "0");
  }

  async function preview(rows, isCurrent) {
    const keys = new Set(), months = new Set();
    let first = "", last = "", total = 0n, units = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i && i % 2500 === 0) {
        feedback("กำลังตรวจสอบ " + count(i) + " / " + count(rows.length) + " แถว…");
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!isCurrent()) return;
      }
      const row = rows[i] = cleanRow(rows[i], true, i);
      months.add(row.date.slice(0,7));
      if (months.size > 12) throw new Error("ไฟล์ต้องมีข้อมูลไม่เกิน 12 เดือน");
      if (!first || row.date < first) first = row.date;
      if (row.date > last) last = row.date;
      if (!keys.has(row.key)) {
        keys.add(row.key);
        total += BigInt(row.satang);
        units += row.units;
      }
    }
    const range = dateText(first) + (first !== last ? " – " + dateText(last) : "");
    return `<h3>ตรวจสอบก่อนนำเข้า</h3><dl class="sales-preview-list">
      <div><dt>ช่วงวันที่ในไฟล์</dt><dd>${range}</dd></div>
      <div><dt>จำนวนแถวทั้งหมด</dt><dd data-preview="rows">${count(rows.length)}</dd></div>
      <div><dt>แถวซ้ำภายในไฟล์</dt><dd data-preview="duplicates">${count(rows.length - keys.size)}</dd></div>
      <div><dt>จำนวนชิ้นไม่ซ้ำในไฟล์</dt><dd>${count(units)}</dd></div>
      <div><dt>ยอดรวมไม่ซ้ำในไฟล์ (บาท)</dt><dd>${previewMoney(total)}</dd></div></dl>
      <p class="sales-preview-note">ยอดนี้ยังไม่หักรายการที่เคยนำเข้า ระบบจะตรวจซ้ำอีกครั้งเมื่อยืนยัน</p>`;
  }

  async function readFile(s, files) {
    if (!files?.length || !s.data || s.draft?.sending || !el("salesUploadDialog").open) return;
    const { length, 0: file } = files;
    clearDialog(s);
    if (length !== 1) return feedback("กรุณาเลือกเพียง 1 ไฟล์", true);
    el("salesFileName").textContent = file.name;
    if (!/\.xlsx$/i.test(file.name)) return feedback("กรุณาเลือกไฟล์ Excel นามสกุล .xlsx", true);
    if (!uploadTextOk(file.name,180) || !/^[^\\/:*?"<>|]+\.xlsx$/i.test(file.name)) return feedback("ชื่อไฟล์ .xlsx ไม่ถูกต้องหรือยาวเกิน 180 ตัวอักษร", true);
    if (!file.size || file.size > maxFileBytes) return feedback("ไฟล์ต้องไม่ว่าง และมีขนาดไม่เกิน 64 MiB", true);
    const draft = s.draft = { filename: file.name, rows: null, worker: null, sending: false,
      offset:0, added:0, skipped:0, month:"", addedMonth:"", uncertain:false, pause:false };
    const isCurrent = () => active(s) && s.draft === draft && el("salesUploadDialog").open;
    const fail = message => {
      if (!isCurrent()) return;
      dropDraft(s);
      el("salesConfirm").disabled = true;
      feedback(message, true);
    };
    feedback("กำลังอ่านไฟล์บนอุปกรณ์นี้…");
    draft.timer = setTimeout(() => fail("อ่านหรือตรวจสอบไฟล์นานเกินไป กรุณาเลือกไฟล์ใหม่ ยังไม่ได้บันทึกยอดขาย"), previewTimeout);
    try {
      const buffer = await file.arrayBuffer();
      if (!isCurrent()) return;
      const worker = draft.worker = new Worker(workerUrl);
      worker.onerror = event => { event.preventDefault(); fail("เปิดไฟล์ไม่สำเร็จ ลองเลือกไฟล์ .xlsx อีกครั้ง"); };
      worker.onmessageerror = () => fail("อ่านผลจากไฟล์ไม่สำเร็จ กรุณาเลือกไฟล์ใหม่");
      worker.onmessage = async ({ data }) => {
        if (!isCurrent()) return;
        stopWorker(draft);
        if (data?.ok !== true) return fail(typeof data?.error === "string" ? data.error : "อ่านไฟล์ Excel ไม่สำเร็จ");
        if (!Array.isArray(data.rows) || !data.rows.length) return fail("ไม่พบแถวข้อมูลยอดขายในไฟล์");
        if (data.rows.length > maxFileRows) return fail("ไฟล์มีข้อมูลเกิน 100,000 แถว");
        try {
          const markup = await preview(data.rows, isCurrent);
          if (!isCurrent()) return;
          clearTimeout(draft.timer);
          draft.rows = data.rows;
          el("salesPreview").innerHTML = markup;
          el("salesConfirm").disabled = false;
          feedback("อ่านไฟล์แล้ว ยังไม่ได้บันทึกยอดขาย");
        } catch (error) { fail(error.message); }
      };
      worker.postMessage(buffer, [buffer]);
    } catch { fail("ไม่สามารถอ่านไฟล์บนอุปกรณ์นี้ได้ กรุณาเปิดหน้านี้ใหม่แล้วลองอีกครั้ง"); }
  }

  async function confirmUpload(s) {
    const draft = s.draft;
    if (!draft?.rows?.length || draft.sending || !el("salesUploadDialog").open) return;
    draft.sending = true;
    draft.pause = false;
    const valid = () => active(s) && s.draft === draft;
    const total = draft.rows.length;
    const progress = () => `${count(draft.offset)} / ${count(total)} แถว · เพิ่ม ${count(draft.added)} แถว · ข้ามรายการซ้ำ ${count(draft.skipped)} แถว`;
    const resume = () => {
      draft.sending = false;
      draft.request = null;
      el("salesConfirm").disabled = el("salesChoose").disabled = el("salesCancel").disabled = false;
      el("salesCancel").textContent = "ปิด";
      el("salesConfirm").textContent = "นำเข้าต่อ";
    };
    el("salesConfirm").disabled = el("salesChoose").disabled = true;
    el("salesCancel").textContent = "หยุดหลังจบชุดนี้";
    el("salesConfirm").textContent = "กำลังบันทึก…";
    try {
      while (draft.offset < total) {
        if (!valid()) return;
        feedback("บันทึกแล้ว " + progress());
        // At most 500 validated rows; even fully JSON-escaped fields fit the 4 MiB API bound.
        const batch = draft.rows.slice(draft.offset, draft.offset + 500);
        const request = draft.request = new AbortController();
        const timer = setTimeout(() => request.abort(), 60000);
        let result;
        try {
          result = await api(endpoint, { ...privateRequest, signal: request.signal, method: "POST",
            body: JSON.stringify({ filename: draft.filename, rows: batch }) });
        } catch (error) {
          if (request.signal.aborted) throw new Error("รอผลนานเกินไป");
          throw error;
        } finally { clearTimeout(timer); }
        if (!valid()) return;
        if (result?.ok !== true || ![result.added,result.skipped,result.received].every(n => Number.isSafeInteger(n) && n >= 0) ||
            result.received !== batch.length || result.added + result.skipped !== result.received ||
            !batch.some(r => r.date.slice(0,7) === result.month)) throw new Error("ไม่ได้รับผลยืนยันที่ครบถ้วน");
        draft.offset += result.received;
        draft.added += result.added;
        draft.skipped += result.skipped;
        if (result.month > draft.month) draft.month = result.month;
        if (result.added && result.month > draft.addedMonth) draft.addedMonth = result.month;
        if (draft.pause && draft.offset < total) {
          resume();
          feedback("พักการนำเข้า · บันทึกแล้ว " + progress());
          return;
        }
      }
      const notice = el("salesNotice");
      notice.textContent = `เพิ่ม ${count(draft.added)} แถว · ข้ามรายการซ้ำ ${count(draft.skipped)} แถว จากทั้งหมด ${count(total)} แถว` +
        (draft.uncertain ? " · รายการซ้ำอาจรวมชุดที่บันทึกสำเร็จก่อนการลองใหม่" : "");
      notice.hidden = false;
      const month = draft.addedMonth || draft.month;
      draft.request = null;
      clearDialog(s);
      el("salesUploadDialog").close();
      await load(s, month);
      if (current === s && s.data && document.activeElement === document.body) el("salesUpload").focus();
    } catch (error) {
      if (denied(s, error) || !active(s) || s.draft !== draft) return;
      resume();
      if (!error.status || error.status >= 500) draft.uncertain = true;
      feedback(`ยืนยันแล้ว ${progress()} · ${error.message} · ลองต่อที่แถว ${count(draft.offset+1)} ได้ ชุดล่าสุดอาจบันทึกแล้ว ระบบจะข้ามรายการซ้ำ`, true);
    }
  }

  function applyFilters(s, patch) {
    Object.assign(s.filters, patch);
    s.productPage = 0;
    s.allCategories = false;
    draw(s);
  }

  function onChange(s, event) {
    if (!active(s)) return;
    const { id, value, files } = event.target;
    if (id === "salesMonth" && s.months.includes(value)) return load(s, value);
    if (id === "salesFile") return readFile(s, files);
    if (!s.filters) return;
    if (id === "salesDay") return selectDay(s, value);
    if (id === "salesBranch") return applyFilters(s, { branch: value });
    if (id === "salesCategory") return applyFilters(s, { category: value });
    if (id === "salesFrom" || id === "salesTo") {
      const key = id === "salesFrom" ? "from" : "to";
      const v = value || blankFilters(s.month)[key];
      if (!dateOk(v) || v.slice(0,7) !== s.month) { event.target.reportValidity(); syncFilters(s); return; }
      const patch = { [key]: v };
      if (key === "from" && v > s.filters.to) patch.to = v;
      if (key === "to" && v < s.filters.from) patch.from = v;
      applyFilters(s, patch);
    }
  }

  function onClick(s, event) {
    const button = event.target.closest("button");
    if (!button || button.disabled || !active(s)) return;
    const { id, dataset: d } = button;
    if (id === "salesRetry" || id === "salesReload") { if (!s.draft?.sending) load(s, s.month); return; }
    if (id === "salesUpload" || d.action === "upload") return openUpload(s);
    if (id === "salesChoose") return el("salesFile").click();
    if (id === "salesCancel") {
      const d = s.draft;
      if (d?.sending) { d.pause = true; button.disabled = true; button.textContent = "กำลังหยุด…"; return; }
      const partial = d?.offset || d?.uncertain;
      if (partial) {
        el("salesNotice").textContent = `หยุดการนำเข้า · ยืนยันผลแล้ว ${count(d.offset)} / ${count(d.rows.length)} แถว เลือกไฟล์เดิมเพื่อนำเข้าต่อได้`;
        el("salesNotice").hidden = false;
      }
      clearDialog(s); el("salesUploadDialog").close();
      if (partial) void load(s,d.addedMonth || s.month);
      return;
    }
    if (id === "salesConfirm") return confirmUpload(s);
    if (!s.filters) return;
    if (id === "salesReset" || d.action === "reset") {
      applyFilters(s, blankFilters(s.month));
      if (d.action === "reset") el("salesFrom").focus();
    } else if (d.day) {
      selectDay(s, d.day);
    } else if (d.action === "filter-day") {
      applyFilters(s, { from: s.day, to: s.day });
      el("salesFrom").focus();
    } else if (d.category !== undefined) {
      applyFilters(s, { category: d.category });
      el("salesCategory").focus();
    } else if (id === "salesMoreCategories") {
      s.allCategories = !s.allCategories;
      renderCategories(s);
      el("salesMoreCategories").focus();
    } else if (d.sort === "units" || d.sort === "satang") {
      s.sort = d.sort;
      s.productPage = 0;
      renderProducts(s);
      el("salesProducts").querySelector(`[data-sort="${s.sort}"]`).focus();
    } else if (d.step) {
      s.productPage += Number(d.step);
      renderProducts(s);
      const nav = el("salesProducts");
      (nav.querySelector(`[data-step="${d.step}"]:enabled`) || nav.querySelector("[data-step]:enabled"))?.focus();
    }
  }
})();
