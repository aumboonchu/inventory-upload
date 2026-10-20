const apiBaseUrl = window.APP_CONFIG?.apiBaseUrl || "http://localhost:8787";
const page = document.body.dataset.page || "home";
const role = document.body.dataset.vendor || "admin";
const vendorLabel = { synnex: "Synnex", vst: "VST", ais: "AIS", admin: "Admin" };
const supplierKeys = ["synnex", "vst", "ais"];
const app = document.querySelector("#app");

let token = localStorage.getItem(`inventory_token_${role}`) || "";
let parsedRows = [];
let lastAdminData = null;
let masterParts = null;
let masterPartsPromise = null;
let partModalEventsBound = false;
let adminSupplierFilters = { synnex: true, vst: true, ais: true };
let adminOrderFilter = "all";
let adminSearchQuery = "";
let adminPageIndex = 0;
const adminPageSize = 7;
let lastPartTrigger = null;
let uploadMode = "file";
let uploadSource = { filename: "", raw: "", matched: 0, errors: [], reading: false, submitting: false, complete: false };
let uploadReadVersion = 0;

function adminIcon(name) {
  const assets = { settings: "e7977", "settings-muted": "0d2f1", "settings-small": "f22e1", "settings-login": "94fcc", "settings-note": "8479a", download: "34023", "download-muted": "2550a", refresh: "8aabe", search: "c79ca", clock: "fa1f6", "clock-upload": "098ef" };
  return `<span class="workspace-icon icon-${escapeHtml(name)}" aria-hidden="true"><img src="assets/fresh-${assets[name] || assets.settings}.svg" alt=""></span>`;
}

function statusMessage(message, type = "success") {
  return `<div class="status ${type}" role="${type === "error" ? "alert" : "status"}">${escapeHtml(message)}</div>`;
}

function formatMoney(value) {
  if (value === "" || value == null) return "—";
  const n = Number(String(value).replace(/[,\s฿]/g, ""));
  return Number.isFinite(n) ? `฿${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)}` : escapeHtml(value);
}

function html(strings, ...values) {
  return strings.reduce((out, string, index) => out + string + (values[index] ?? ""), "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.day}-${parts.month}-${parts.year} (${parts.hour}:${parts.minute})`;
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function shell(content, active = role) {
  const isAdmin = role === "admin";
  const links = isAdmin ? ["admin", ...supplierKeys] : [role];
  const label = isAdmin ? "Combined inventory" : vendorLabel[role] + " upload";
  return html`
    <div class="workspace-shell">
      <aside class="workspace-sidebar" aria-label="พื้นที่ทำงาน">
        <a class="workspace-brand" href="index.html"><span class="workspace-mark">JIB</span><span><strong>Inventory</strong><small>JIB WORKSPACE</small></span></a>
        <span class="nav-caption">WORKSPACE</span>
        <nav class="workspace-nav">${links.map((key) => `<a href="${key === "admin" ? "admin.html" : "upload-" + key + ".html"}" class="${active === key ? "active" : ""}" ${active === key ? 'aria-current="page"' : ""}>${adminIcon(key === "admin" ? "settings" : active === key ? "download" : "download-muted")}<span>${key === "admin" ? "Inventory" : vendorLabel[key]}</span></a>`).join("")}</nav>
        <button class="workspace-account" id="logoutBtn" type="button" title="ออกจากระบบ"><span class="account-avatar">${isAdmin ? "A" : vendorLabel[role].slice(0, 1)}</span><span><strong>${escapeHtml(vendorLabel[role])}</strong><small>ออกจากระบบ</small></span></button>
      </aside>
      <div class="workspace-main">
        <header class="workspace-topbar"><span>WORKSPACE</span><span class="breadcrumb-divider">/</span><strong>${escapeHtml(label)}</strong><span class="topbar-spacer"></span><span class="badge">เข้าสู่ระบบแล้ว</span><time>${new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Bangkok" }).format(new Date())}</time></header>
        <main id="mainContent">${content}</main>
      </div>
    </div>
  `;
}

function loginView(message = "") {
  app.onclick = null;
  closePartDetail();
  app.innerHTML = html`
    <div class="workspace-login">
      <header class="public-header"><a href="index.html" class="public-brand"><span class="workspace-mark">JIB</span><strong>Inventory workspace</strong></a><span>JIB / Supplier portal</span></header>
      <main class="login-center"><section class="login-form-wrap">
        <span class="login-workspace-icon">${adminIcon("settings-login")}</span>
        <div><h1>เข้าใช้งาน Inventory</h1><p class="login-intro">เลือกพื้นที่ทำงาน แล้วกรอกรหัสผ่านของคุณ</p></div>
        <nav class="workspace-picker" aria-label="เลือกพื้นที่ทำงาน">${["admin", ...supplierKeys].map((key) => `<a href="${key === "admin" ? "admin.html" : "upload-" + key + ".html"}" ${role === key ? 'aria-current="page" class="active"' : ""}>${vendorLabel[key]}</a>`).join("")}</nav>
        <form id="loginForm">
          <div class="field"><label for="password">รหัสผ่าน ${escapeHtml(vendorLabel[role])}</label><div class="password-input"><input id="password" name="password" type="password" autocomplete="current-password" required><button id="passwordVisibility" type="button" aria-pressed="false" aria-controls="password">แสดง</button></div></div>
          <button class="button primary full" type="submit">เข้าใช้งาน <span aria-hidden="true">→</span></button>
          ${message ? statusMessage(message, "error") : ""}
        </form>
        <p class="login-private-note">${adminIcon("settings-note")}พื้นที่สำหรับ Admin และ Supplier ที่ได้รับสิทธิ์</p>
      </section></main>
      <footer class="public-footer">JIB · Inventory workspace</footer>
    </div>`;
  document.querySelector("#passwordVisibility").addEventListener("click", (event) => {
    const input = document.querySelector("#password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    event.currentTarget.textContent = show ? "ซ่อน" : "แสดง";
    event.currentTarget.setAttribute("aria-pressed", String(show));
  });
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const password = new FormData(event.currentTarget).get("password");
      const data = await api("/api/login", { method: "POST", body: JSON.stringify({ role, password }) });
      token = data.token;
      localStorage.setItem(`inventory_token_${role}`, token);
      if (page === "home") window.location.href = "admin.html";
      else render();
    } catch (error) { loginView(error.message); }
  });
}
function parseDelimited(text) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;
  const delimiter = text.includes("\t") ? "\t" : ",";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

async function readUploadText(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const candidates = [
    decodeWith("utf-8", buffer, bytes),
    decodeWith("utf-16le", buffer, bytes),
    decodeWith("windows-874", buffer, bytes),
    decodeWith("windows-1252", buffer, bytes)
  ].filter(Boolean);
  candidates.sort((a, b) => scoreDecodedText(b.text) - scoreDecodedText(a.text));
  return candidates[0]?.text || "";
}

function decodeWith(encoding, buffer, bytes) {
  try {
    const text = new TextDecoder(encoding).decode(buffer).replace(/^\uFEFF/, "");
    return { encoding, text };
  } catch {
    return null;
  }
}

function scoreDecodedText(text) {
  const replacementPenalty = (text.match(/\uFFFD/g) || []).length * 100;
  const nullPenalty = (text.match(/\u0000/g) || []).length * 50;
  const delimiterBonus = (text.match(/[,\t\r\n]/g) || []).length;
  const printableBonus = (text.match(/[A-Za-z0-9\u0E00-\u0E7F]/g) || []).length;
  return delimiterBonus + printableBonus - replacementPenalty - nullPenalty;
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, "");
}

function normalizePartNo(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

async function loadMasterParts() {
  if (masterParts) return masterParts;
  if (!masterPartsPromise) {
    masterPartsPromise = fetch("partApple.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { parts: {} }))
      .then((data) => {
        masterParts = data.parts || {};
        return masterParts;
      })
      .catch(() => {
        masterParts = {};
        return masterParts;
      });
  }
  return masterPartsPromise;
}

function applyMasterParts(rows) {
  let matched = 0;
  const mappedRows = rows.map((row) => {
    const master = masterParts?.[normalizePartNo(row.partNo)];
    const masterDescription = master?.productName || master?.model || "";
    if (!masterDescription) return row;
    matched++;
    return { ...row, description: masterDescription, masterMatched: true };
  });
  return { rows: mappedRows, matched };
}

function mapRows(rawRows) {
  if (!rawRows.length) return [];
  const header = rawRows[0].map(normalizeHeader);
  const hasHeader = header.some((name) => ["part", "partno", "partnumber", "sku", "item", "pn"].includes(name));
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows;

  const findIndex = (candidates, fallback) => {
    const index = header.findIndex((name) => candidates.includes(name));
    return index >= 0 ? index : fallback;
  };

  const partIndex = hasHeader ? findIndex(["part", "partno", "partnumber", "sku", "item", "pn"], 0) : 0;
  const descriptionIndex = hasHeader ? findIndex(["description", "desc", "name", "productname", "รายละเอียด"], 1) : 1;
  const qtyIndex = hasHeader ? findIndex(["qty", "quantity", "stock", "balance", "จำนวน"], 2) : 2;
  const priceIndex = hasHeader ? findIndex(["price", "priceexvat", "cost", "costexvat", "amount", "ราคา"], 3) : 3;

  return dataRows
    .map((row) => ({
      partNo: normalizePartNo(row[partIndex] || ""),
      description: row[descriptionIndex] || "",
      qty: row[qtyIndex] || "",
      price: row[priceIndex] || ""
    }))
    .filter((row) => row.partNo.trim());
}

function rowsPreview(rows) {
  if (!rows.length) return `<div class="empty-preview">ยังไม่มีข้อมูล preview</div>`;
  return html`
    <div class="table-wrap preview-table">
      <table>
        <thead>
          <tr>
            <th>Part No.</th>
            <th>Description</th>
            <th>Qty</th>
            <th>Price (ex VAT)</th>
          </tr>
        </thead>
        <tbody>
          ${rows.slice(0, 80).map((row) => html`
            <tr>
              <td><strong>${escapeHtml(row.partNo)}</strong></td>
              <td>${escapeHtml(row.description)}</td>
              <td>${escapeHtml(row.qty)}</td>
              <td>${formatMoney(row.price)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${rows.length > 80 ? `<div class="hint table-note">แสดง preview 80 รายการแรกจากทั้งหมด ${rows.length} รายการ</div>` : ""}
  `;
}

function uploadView(status = "") {
  const ready = parsedRows.length > 0 && !uploadSource.errors.length && !uploadSource.reading;
  const label = vendorLabel[role];
  const busy = uploadSource.reading || uploadSource.submitting;
  const checks = [
    [parsedRows.length > 0, "Part No. ครบทุกแถว"],
    [ready, "Qty และราคาอยู่ในรูปแบบที่ถูกต้อง"],
    [ready, uploadSource.matched ? `ใช้ชื่อจาก Apple master part ${uploadSource.matched} rows` : "ชื่อสินค้าใช้จาก Supplier"],
    [ready, `พร้อมแทนข้อมูลล่าสุดของ ${label}`]
  ];
  app.innerHTML = shell(html`
    <section class="workspace-heading">
      <div><h1>${escapeHtml(label)} upload</h1><p>นำเข้าข้อมูล ตรวจสอบ แล้วส่งเข้า Inventory</p></div>
      <a class="button secondary" href="template-${role}.csv" download>${adminIcon("download")}ดาวน์โหลด Template</a>
    </section>
    <ol class="workflow-steps" aria-label="Upload progress">
      ${["เลือกข้อมูล", "ตรวจสอบ Preview", "ส่งเข้า Admin"].map((step, i) => `<li class="${(uploadSource.complete ? i === 2 : parsedRows.length ? i === 1 : i === 0) ? "active" : ""}"><span>0${i + 1}</span>${step}</li>`).join("")}
    </ol>
    <div class="upload-source-layout">
      <section class="source-content"><div class="source-heading"><h2>Source data</h2><span class="hint">CSV / Excel</span></div>
        <div class="source-tabs" role="group" aria-label="วิธีนำเข้าข้อมูล">
          <button type="button" data-source-mode="file" aria-pressed="${uploadMode === "file"}" class="${uploadMode === "file" ? "active" : ""}" ${busy ? "disabled" : ""}>อัปโหลดไฟล์</button>
          <button type="button" data-source-mode="paste" aria-pressed="${uploadMode === "paste"}" class="${uploadMode === "paste" ? "active" : ""}" ${busy ? "disabled" : ""}>วางข้อมูลจาก Excel</button>
        </div>
        <div class="file-dropzone ${uploadSource.reading ? "reading" : ""}" id="csvDropzone" ${uploadMode === "file" ? "" : "hidden"}>
          <div class="selected-file"><span class="file-format">CSV</span><div class="file-info"><strong>${uploadSource.reading ? "กำลังอ่านไฟล์…" : escapeHtml(uploadSource.filename || "เลือกไฟล์ CSV")}</strong><span>${parsedRows.length ? `${parsedRows.length} rows · ${ready ? "พร้อมตรวจสอบข้อมูล" : "พบข้อมูลที่ต้องแก้ไข"}` : "ลากไฟล์มาวาง หรือเลือกไฟล์"}</span></div>
            <label class="button secondary ${busy ? "disabled" : ""}" for="csvFile">${adminIcon("refresh")}${uploadSource.filename ? "เปลี่ยนไฟล์" : "เลือกไฟล์"}</label>
          </div>
          <input id="csvFile" type="file" accept=".csv,text/csv" ${busy ? "disabled" : ""} aria-label="เลือกไฟล์ CSV">
          <div class="read-progress ${parsedRows.length ? "complete" : ""}" aria-hidden="true"></div>
          <p class="file-read-status">${uploadSource.reading ? "กำลังตรวจข้อมูล" : ready ? "✓ อ่านไฟล์สำเร็จ" : "Part No., Description, Qty, Price (ex VAT)"}</p>
        </div>
        <div class="paste-input-wrap" ${uploadMode === "paste" ? "" : "hidden"}><label class="visually-hidden" for="pasteBox">ข้อมูลจาก Excel / CSV</label><textarea id="pasteBox" placeholder="วางข้อมูลจาก Excel / CSV" ${busy ? "disabled" : ""}>${escapeHtml(uploadSource.raw)}</textarea><button class="button secondary" id="parsePasteBtn" type="button" ${busy ? "disabled" : ""}>ตรวจสอบข้อมูล</button></div>
        <p class="source-columns">Part No. · Description · Qty · Price (ex VAT)</p>
      </section>
      <aside class="upload-validation"><section class="validation-summary">
        <div class="source-heading"><h2>ตรวจข้อมูล</h2><span class="badge">${ready ? "ผ่าน 4/4" : "รอตรวจสอบ"}</span></div>
        <ul>${checks.map(([ok, text]) => `<li class="${ok ? "valid" : ""}"><span aria-hidden="true">${ok ? "✓" : "○"}</span>${escapeHtml(text)}</li>`).join("")}</ul>
      </section><button class="password-action" id="supplierPasswordBtn" type="button">${adminIcon("settings-small")}เปลี่ยนรหัสผ่าน ${escapeHtml(label)}<span aria-hidden="true">→</span></button></aside>
    </div>
    <section class="upload-review">
      ${status}
      ${uploadSource.errors.length ? statusMessage(uploadSource.errors.join(" · "), "error") : ""}
      <div class="review-heading"><h2>Preview</h2><span class="badge">${parsedRows.length} rows ${ready ? "พร้อมส่ง" : ""}</span><button class="button primary" id="uploadBtn" type="button" ${!ready || busy ? "disabled" : ""}>${adminIcon("download")}${uploadSource.submitting ? "กำลังส่งข้อมูล…" : "ส่งข้อมูลเข้า Admin"}</button></div>
      ${rowsPreview(parsedRows)}
      <p class="replacement-note">${adminIcon("clock-upload")}ข้อมูลใหม่นี้จะแทนที่ Inventory เดิมของ ${escapeHtml(label)} หลังยืนยัน</p>
    </section>
    ${passwordDialogMarkup("supplierPasswordDialog", label)}
  `, role);
  bindCommon();
  bindPasswordDialog("#supplierPasswordBtn", "#supplierPasswordDialog");
  document.querySelectorAll("[data-source-mode]").forEach((button) => button.addEventListener("click", () => {
    uploadMode = button.dataset.sourceMode;
    uploadReadVersion++;
    parsedRows = [];
    uploadSource = { ...uploadSource, filename: "", raw: "", matched: 0, errors: [], complete: false };
    uploadView();
  }));
  document.querySelector("#csvFile").addEventListener("change", (event) => { if (event.target.files[0]) parseUploadSource(event.target.files[0]); });
  const drop = document.querySelector("#csvDropzone");
  drop.addEventListener("dragover", (event) => { event.preventDefault(); if (!busy) drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => { event.preventDefault(); drop.classList.remove("dragging"); if (!busy && event.dataTransfer.files[0]) parseUploadSource(event.dataTransfer.files[0]); });
  document.querySelector("#pasteBox").addEventListener("input", (event) => {
    uploadSource.raw = event.currentTarget.value;
    parsedRows = [];
    uploadSource.errors = [];
    uploadSource.complete = false;
    document.querySelector("#uploadBtn").disabled = true;
    document.querySelector(".review-heading .badge").textContent = "กรุณาตรวจสอบข้อมูลใหม่";
    document.querySelector(".preview-table")?.remove();
    document.querySelector(".validation-summary .badge").textContent = "รอตรวจสอบ";
    document.querySelectorAll(".validation-summary li").forEach((li) => { li.classList.remove("valid"); li.firstElementChild.textContent = "○"; });
  });
  document.querySelector("#parsePasteBtn").addEventListener("click", () => parseUploadSource());
  document.querySelector("#uploadBtn").addEventListener("click", async () => {
    if (!ready || busy) return;
    const rows = parsedRows.map(({ partNo, description, qty, price }) => ({ partNo, description, qty, price }));
    if (!await confirmAdminAction({ title: `ส่งข้อมูล ${label} เข้า Admin?`, message: `ใช้ข้อมูล ${rows.length} rows แทน Inventory ล่าสุดของ ${label}`, confirmLabel: "ยืนยัน Upload" })) return;
    uploadSource.submitting = true;
    uploadView();
    try {
      const data = await api("/api/upload", { method: "POST", body: JSON.stringify({ vendor: role, filename: uploadSource.filename || "pasted data", rows }) });
      uploadSource.submitting = false;
      uploadSource.complete = true;
      uploadView(statusMessage(`อัปโหลดสำเร็จ ${data.count} rows ของ ${label}`));
    } catch (error) {
      uploadSource.submitting = false;
      if (error.message === "Unauthorized") { token = ""; localStorage.removeItem(`inventory_token_${role}`); return loginView("หมดเวลาการเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง"); }
      uploadView(statusMessage(error.message, "error"));
    }
  });
}

function passwordDialogMarkup(id, label) {
  return `<dialog class="admin-dialog" id="${id}" aria-labelledby="${id}Title"><h2 id="${id}Title">เปลี่ยนรหัสผ่าน ${escapeHtml(label)}</h2><form id="passwordForm"><div class="field"><label for="currentPassword">Current password</label><input class="input" id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="newPassword">New password</label><input class="input" id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="3" required></div><div class="dialog-actions"><button class="button secondary" type="button" data-dialog-cancel>ยกเลิก</button><button class="button primary" type="submit">เปลี่ยนรหัสผ่าน</button></div></form></dialog>`;
}

function bindPasswordDialog(trigger, target) {
  const dialog = document.querySelector(target);
  document.querySelector(trigger).addEventListener("click", () => { closeAdminManagement(); dialog.showModal(); });
  dialog.querySelector("[data-dialog-cancel]").addEventListener("click", () => dialog.close());
}

async function parseUploadSource(file) {
  const version = ++uploadReadVersion;
  if (file && !/\.csv$/i.test(file.name)) {
    parsedRows = [];
    uploadSource = { ...uploadSource, filename: file.name, errors: ["กรุณาเลือกไฟล์ CSV"], matched: 0, complete: false };
    return uploadView();
  }
  parsedRows = [];
  uploadSource = { ...uploadSource, reading: true, complete: false, errors: [], filename: file?.name || "", matched: 0 };
  uploadView();
  try {
    const raw = file ? await readUploadText(file) : uploadSource.raw;
    await loadMasterParts();
    if (version !== uploadReadVersion) return;
    const result = applyMasterParts(mapRows(parseDelimited(raw)));
    parsedRows = result.rows;
    uploadSource.matched = result.matched;
    if (!parsedRows.length) uploadSource.errors.push("ไม่พบข้อมูล Part No.");
    const invalid = parsedRows.findIndex((row) => ["qty", "price"].some((key) => {
      const value = String(row[key] ?? "").trim();
      return value && (!Number.isFinite(Number(value.replace(/[,\s฿]/g, ""))) || Number(value.replace(/[,\s฿]/g, "")) < 0);
    }));
    if (invalid >= 0) uploadSource.errors.push(`Qty หรือ Price ไม่ถูกต้องที่รายการ ${invalid + 1}`);
  } catch (error) { uploadSource.errors = [error.message]; }
  uploadSource.reading = false;
  uploadView();
}
function vendorCell(data, part, supplier) {
  if (!data) return `<span class="empty">-</span>`;
  const ordered = Boolean(part.orders?.[supplier]);
  return html`
    <div class="vendor-cell">
      <div class="vendor-values"><strong>${escapeHtml(data.qty ?? "—")}</strong><span>${formatMoney(data.price)}</span></div>
      <label class="vendor-order-control">
        <input
          class="supplier-order-toggle"
          data-ordered-part-no="${escapeHtml(part.partNo)}"
          data-ordered-supplier="${escapeHtml(supplier)}"
          type="checkbox"
          ${ordered ? "checked" : ""}
          aria-label="Mark ${escapeHtml(part.partNo)} as ordered from ${escapeHtml(vendorLabel[supplier])}"
        >
        <span>${ordered ? "สั่งแล้ว" : "ยังไม่สั่ง"}</span>
      </label>
    </div>
  `;
}

function partDetailSupplierCard(supplier, part) {
  const data = part[supplier];
  const ordered = Boolean(part.orders?.[supplier]);
  return `<article class="part-supplier-card ${ordered ? "ordered" : ""} ${data ? "" : "unavailable"}"><div class="part-supplier-heading"><h3>${vendorLabel[supplier]}</h3>${data ? `<span class="badge ${ordered ? "" : "badge-muted"}">${ordered ? "✓ สั่งแล้ว" : "ยังไม่สั่ง"}</span>` : '<span class="hint">ยังไม่มีข้อมูล</span>'}</div>
    ${data ? `<div class="part-supplier-values"><strong>${escapeHtml(data.qty ?? "—")}</strong><span>หน่วย</span><strong class="detail-price">${formatMoney(data.price)}</strong></div><p>Price (ex VAT)</p>` : ""}
    </article>`;
}

function partDetailModal(part) {
  const state = orderStateFor(part);
  return `<dialog class="part-modal" aria-labelledby="partModalTitle">
    <div class="part-modal-toolbar"><span class="badge">PART DETAIL</span><button class="button secondary icon-button" data-modal-close type="button" aria-label="Close part detail">×</button></div>
    <h2 id="partModalTitle">${escapeHtml(part.description || part.partNo)}</h2>
    <div class="part-identifier"><span>PART NO.</span><strong>${escapeHtml(part.partNo)}</strong></div>
    <div class="part-order-summary"><span class="badge ${state.key === "partial" ? "badge-amber" : state.key === "pending" ? "badge-muted" : ""}">${state.label}</span><span class="hint">${escapeHtml(state.detail)}</span></div>
    <div class="part-supplier-grid">${getActiveAdminSuppliers().map((supplier) => partDetailSupplierCard(supplier, part)).join("")}</div>
    <p class="part-modal-note">อัปเดต ${escapeHtml(formatDateTime(lastAdminData?.updatedAt))}</p>
    </dialog>`;
}

function showPartDetail(partNo) {
  const part = lastAdminData?.parts?.find((item) => item.partNo === partNo);
  if (!part) return;
  closePartDetail();
  lastPartTrigger = document.activeElement;
  document.body.insertAdjacentHTML("beforeend", partDetailModal(part));
  const dialog = document.querySelector(".part-modal");
  dialog.querySelector("[data-modal-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { dialog.remove(); lastPartTrigger?.focus(); }, { once: true });
  dialog.addEventListener("click", (event) => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
  dialog.showModal();
}

function closePartDetail() {
  const dialog = document.querySelector(".part-modal");
  if (dialog?.open) dialog.close();
  else dialog?.remove();
}

function bindPartDetailLinks() {
  document.querySelectorAll("[data-part-no]").forEach((button) => {
    button.addEventListener("click", () => showPartDetail(button.dataset.partNo));
  });
}

function bindPartDetailModalEvents() {
  if (partModalEventsBound) return;
  partModalEventsBound = true;
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.matches("[data-modal-close]")) closePartDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePartDetail();
  });
}

function getActiveAdminSuppliers() {
  const active = supplierKeys.filter((supplier) => adminSupplierFilters[supplier]);
  return active.length ? active : [...supplierKeys];
}

function orderStateFor(part) {
  const availableSuppliers = supplierKeys.filter((supplier) => part[supplier]);
  const orderedSuppliers = availableSuppliers.filter((supplier) => part.orders?.[supplier]);
  const pendingSuppliers = availableSuppliers.filter((supplier) => !part.orders?.[supplier]);

  if (!availableSuppliers.length) return { key: "none", label: "ไม่มีสินค้า", detail: "-" };
  if (!orderedSuppliers.length) return { key: "pending", label: "ยังไม่สั่ง", detail: `0/${availableSuppliers.length} supplier` };
  if (!pendingSuppliers.length) return { key: "complete", label: "สั่งครบแล้ว", detail: `${orderedSuppliers.length}/${availableSuppliers.length} supplier` };

  return {
    key: "partial",
    label: "สั่งบาง Supplier",
    detail: `${orderedSuppliers.length}/${availableSuppliers.length} supplier`
  };
}

function orderStateCell(part) {
  const state = orderStateFor(part);
  return html`
    <div class="order-state order-state-${state.key}">
      <strong>${escapeHtml(state.label)}</strong>
      <span>${escapeHtml(state.detail)}</span>
    </div>
  `;
}

function orderFilterControl() {
  return `<div class="order-tabs" role="group" aria-label="สถานะสั่งซื้อ">${[
    ["all", "ทั้งหมด"], ["pending", "ยังไม่สั่ง"], ["partial", "สั่งบาง Supplier"], ["complete", "สั่งครบแล้ว"]
  ].map(([value, label]) => `<button type="button" data-order-filter="${value}" aria-pressed="${adminOrderFilter === value}" class="order-tab ${adminOrderFilter === value ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

function supplierFilterControls() {
  return html`
    <fieldset class="supplier-filter" aria-label="Filter supplier columns">
      <legend>Supplier</legend>
      ${supplierKeys.map((supplier) => html`
        <label class="supplier-filter-option ${adminSupplierFilters[supplier] ? "active" : ""}">
          <input type="checkbox" value="${supplier}" ${adminSupplierFilters[supplier] ? "checked" : ""}>
          <span>${escapeHtml(vendorLabel[supplier])}</span>
        </label>
      `).join("")}
    </fieldset>
  `;
}

function renderAdminTable(parts, query = "") {
  const suppliers = getActiveAdminSuppliers();
  return `<table class="supplier-visible-${suppliers.length}"><thead><tr>
    <th class="part-column" scope="col">Part No. / สถานะ</th><th class="description-column" scope="col">Description</th>
    ${suppliers.map((supplier) => `<th class="supplier-column" scope="col">${vendorLabel[supplier]}<small>Qty · Price ex VAT</small></th>`).join("")}
    </tr></thead><tbody id="adminBody">${adminRows(parts, query, suppliers)}</tbody></table>`;
}

function filteredAdminParts(parts, query = "") {
  const q = query.trim().toUpperCase();
  const suppliers = getActiveAdminSuppliers();
  return parts.filter((part) => suppliers.some((supplier) => part[supplier]))
    .filter((part) => !q || part.partNo.toUpperCase().includes(q) || (part.description || "").toUpperCase().includes(q))
    .filter((part) => adminOrderFilter === "all" || orderStateFor(part).key === adminOrderFilter);
}

function adminRows(parts, query = "", suppliers = getActiveAdminSuppliers()) {
  const rows = filteredAdminParts(parts, query);
  const maxPage = Math.max(0, Math.ceil(rows.length / adminPageSize) - 1);
  adminPageIndex = Math.min(adminPageIndex, maxPage);
  if (!rows.length) return `<tr><td class="inventory-empty" colspan="${2 + suppliers.length}">ไม่พบรายการสินค้า</td></tr>`;
  return rows.slice(adminPageIndex * adminPageSize, (adminPageIndex + 1) * adminPageSize).map((part) => {
    const available = suppliers.filter((supplier) => part[supplier]).length;
    return `<tr class="inventory-row state-${orderStateFor(part).key}" style="--supplier-count:${Math.max(available, 1)}">
      <td class="part-cell"><button class="part-link" data-part-no="${escapeHtml(part.partNo)}" type="button">${escapeHtml(part.partNo)}</button>${orderStateCell(part)}</td>
      <td class="description-cell">${escapeHtml(part.description || "—")}</td>
      ${suppliers.map((supplier) => `<td class="supplier-cell ${part[supplier] ? "" : "no-inventory"}" data-supplier="${vendorLabel[supplier]}">${vendorCell(part[supplier], part, supplier)}</td>`).join("")}
    </tr>`;
  }).join("");
}

function paginationMarkup(parts) {
  const count = filteredAdminParts(parts, adminSearchQuery).length;
  return `<div class="pagination"><span id="paginationLabel">${count ? `แสดง ${adminPageIndex * adminPageSize + 1}–${Math.min((adminPageIndex + 1) * adminPageSize, count)} จาก ${count} parts` : "0 parts"}</span><button class="button secondary icon-button" id="previousPageBtn" type="button" title="หน้าก่อนหน้า" aria-label="หน้าก่อนหน้า" ${adminPageIndex === 0 ? "disabled" : ""}>←</button><button class="button secondary icon-button" id="nextPageBtn" type="button" title="หน้าถัดไป" aria-label="หน้าถัดไป" ${(adminPageIndex + 1) * adminPageSize >= count ? "disabled" : ""}>→</button></div>`;
}

function updateAdminCounts() {
  if (!lastAdminData) return;
  const count = filteredAdminParts(lastAdminData.parts, adminSearchQuery).length;
  document.querySelector("#visiblePartsCount").textContent = `${count} parts`;
  document.querySelector("#paginationLabel").textContent = count ? `แสดง ${adminPageIndex * adminPageSize + 1}–${Math.min((adminPageIndex + 1) * adminPageSize, count)} จาก ${count} parts` : "0 parts";
  document.querySelector("#previousPageBtn").disabled = adminPageIndex === 0;
  document.querySelector("#nextPageBtn").disabled = (adminPageIndex + 1) * adminPageSize >= count;
  const counts = { all: lastAdminData.parts.length, pending: 0, partial: 0, complete: 0 };
  lastAdminData.parts.forEach((part) => { const key = orderStateFor(part).key; if (key in counts) counts[key]++; });
  Object.entries(counts).forEach(([key, value]) => { const el = document.querySelector(`[data-order-count="${key}"]`); if (el) el.textContent = value; });
}

function latestUploadsView(uploads) {
  return `<section class="latest-strip"><div class="section-title"><h2>Latest uploads</h2><span class="hint">เวลาประเทศไทย</span></div><div class="latest-grid">
    ${supplierKeys.map((supplier) => {
      const upload = uploads.find((item) => item.vendor === supplier);
      return `<article class="latest-card latest-${supplier}"><span class="supplier-mark">${supplier === "synnex" ? "S" : vendorLabel[supplier]}</span><div class="latest-info"><h3>${vendorLabel[supplier]}</h3><span>${upload ? escapeHtml(formatDateTime(upload.uploadedAt)) : "รอการอัปโหลด"}</span></div><div class="latest-count"><strong>${escapeHtml(upload?.count ?? 0)}</strong><span>rows</span></div></article>`;
    }).join("")}</div></section>`;
}
async function loadAdmin() {
  lastAdminData = await api("/api/admin/parts");
  return lastAdminData;
}

async function adminView(status = "") {
  let data;
  try { data = await loadAdmin(); }
  catch (error) {
    if (error.message === "Unauthorized") { token = ""; localStorage.removeItem("inventory_token_admin"); return loginView("หมดเวลาการเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง"); }
    status = statusMessage(error.message, "error");
    data = lastAdminData || { parts: [], uploads: [] };
  }
  app.innerHTML = shell(html`
    <section class="workspace-heading"><div><h1>Combined inventory</h1><p>สต็อกล่าสุดจากทุก Supplier ในมุมมองเดียว</p></div><div class="heading-actions"><button class="button secondary icon-button" id="refreshBtn" type="button" title="Refresh" aria-label="Refresh">${adminIcon("refresh")}</button><button class="button primary" id="exportBtn" type="button">${adminIcon("download")}Export CSV</button></div></section>
    <section class="order-summary" aria-label="สรุปสถานะสั่งซื้อ">${[["all", "Part ทั้งหมด"], ["pending", "ยังไม่สั่ง"], ["partial", "สั่งบาง Supplier"], ["complete", "สั่งครบแล้ว"]].map(([key, label]) => `<div class="summary-${key}"><strong data-order-count="${key}">${key === "all" ? data.parts.length : data.parts.filter((p) => orderStateFor(p).key === key).length}</strong><span>${label}</span></div>`).join("")}</section>
    ${latestUploadsView(data.uploads)}
    <section class="admin-workspace">
      <div class="admin-toolbar"><label class="admin-search">${adminIcon("search")}<input id="searchBox" type="search" aria-label="ค้นหา Part No. / ชื่อสินค้า" placeholder="ค้นหา Part No. หรือชื่อสินค้า" value="${escapeHtml(adminSearchQuery)}"></label>
        <div class="admin-filter-actions">${supplierFilterControls()}<details class="tool-menu admin-management" id="adminManagement"><summary class="button secondary">${adminIcon("settings")}จัดการ</summary>
          <div class="tool-menu-list"><span class="menu-heading">สถานะสั่งซื้อ</span><button class="menu-action reset-orders" id="resetOrderStatusBtn" type="button">Reset สั่งแล้วทั้งหมด</button><hr><span class="menu-heading">รหัสผ่าน</span><button class="menu-action" id="adminPasswordBtn" type="button">เปลี่ยนรหัสผ่าน Admin</button>
          ${supplierKeys.map((supplier) => `<button class="menu-action" data-reset-role="${supplier}" type="button">Reset รหัสผ่าน ${vendorLabel[supplier]}</button>`).join("")}
          <hr><span class="menu-heading">ล้าง Inventory</span>${supplierKeys.map((supplier) => `<button class="menu-action danger" data-clear-role="${supplier}" type="button">ล้างข้อมูล ${vendorLabel[supplier]}</button>`).join("")}</div>
        </details></div>
      </div>
      <div class="admin-order-bar">${orderFilterControl()}<span id="visiblePartsCount" class="hint">${filteredAdminParts(data.parts, adminSearchQuery).length} parts</span></div>
      ${status}
      <div class="table-wrap admin-table" id="adminTableWrap" tabindex="0" role="region" aria-label="ตาราง inventory">${renderAdminTable(data.parts, adminSearchQuery)}</div>
      <div class="admin-footer"><span>${adminIcon("clock")}อัปเดตล่าสุด ${escapeHtml(formatDateTime(data.updatedAt))}</span>${paginationMarkup(data.parts)}</div>
    </section>
    ${passwordDialogMarkup("adminPasswordDialog", "Admin")}
  `, "admin");
  bindCommon();
  bindAdminPasswordReset();
  bindAdminInventoryClear();
  bindAdminOrderStatusReset();
  document.querySelector("#refreshBtn").addEventListener("click", async (event) => { event.currentTarget.disabled = true; await adminView(); });
  bindAdminSupplierFilters();
  bindAdminOrderFilter();
  document.querySelector("#searchBox").addEventListener("input", (event) => { adminSearchQuery = event.currentTarget.value; adminPageIndex = 0; renderAdminTableIntoView(); });
  document.querySelector("#exportBtn").addEventListener("click", exportAdminCsv);
  bindPasswordDialog("#adminPasswordBtn", "#adminPasswordDialog");
  for (const [selector, delta] of [["#previousPageBtn", -1], ["#nextPageBtn", 1]]) document.querySelector(selector).addEventListener("click", () => { adminPageIndex += delta; renderAdminTableIntoView(); document.querySelector("#adminTableWrap").scrollTop = 0; });
  const menu = document.querySelector("#adminManagement");
  menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); } });
  app.onclick = (event) => { if (!menu.contains(event.target)) menu.open = false; };
  bindPartDetailLinks();
  bindPartOrderToggles();
  bindPartDetailModalEvents();
}

function closeAdminManagement() {
  const menu = document.querySelector("#adminManagement");
  if (menu) menu.open = false;
}

function confirmAdminAction({ title, message, note = "", confirmLabel = "ยืนยัน", danger = false }) {
  closeAdminManagement();
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "admin-dialog";
    dialog.setAttribute("aria-labelledby", "adminConfirmTitle");
    dialog.innerHTML = `<h2 id="adminConfirmTitle">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      ${note ? `<p class="dialog-note">${escapeHtml(note)}</p>` : ""}
      <form method="dialog" class="dialog-actions">
        <button class="button secondary" value="cancel" autofocus>ยกเลิก</button>
        <button class="button ${danger ? "danger-button" : "primary"}" value="confirm">${escapeHtml(confirmLabel)}</button>
      </form>`;
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    dialog.showModal();
  });
}

function renderAdminTableIntoView() {
  const query = document.querySelector("#searchBox")?.value || "";
  const tableWrap = document.querySelector("#adminTableWrap");
  if (!tableWrap || !lastAdminData) return;
  tableWrap.innerHTML = renderAdminTable(lastAdminData.parts, query);
  updateAdminCounts();
  bindPartDetailLinks();
  bindPartOrderToggles();
}

function bindPartOrderToggles() {
  document.querySelectorAll("[data-ordered-part-no]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const partNo = checkbox.dataset.orderedPartNo;
      const supplier = checkbox.dataset.orderedSupplier;
      const part = lastAdminData?.parts?.find((item) => item.partNo === partNo);
      const wasOrdered = Boolean(part?.orders?.[supplier]);
      const ordered = checkbox.checked;
      checkbox.disabled = true;

      try {
        const data = await api("/api/admin/part-order-status", {
          method: "POST",
          body: JSON.stringify({ partNo, supplier, ordered })
        });
        if (part) part.orders = { ...part.orders, [supplier]: data.ordered };
        renderAdminTableIntoView();
        showAdminExportStatus(data.ordered
          ? `ทำเครื่องหมาย ${partNo} ว่าสั่งจาก ${vendorLabel[supplier]} แล้ว`
          : `ยกเลิกสถานะสั่งแล้วของ ${partNo} จาก ${vendorLabel[supplier]}`);
      } catch (error) {
        checkbox.checked = wasOrdered;
        showAdminExportStatus(error.message, "error");
      } finally {
        checkbox.disabled = false;
      }
    });
  });
}

function bindAdminSupplierFilters() {
  document.querySelectorAll(".supplier-filter input").forEach((input) => {
    input.addEventListener("change", (event) => {
      const checkbox = event.currentTarget;
      const supplier = checkbox.value;
      const checkedCount = supplierKeys.filter((key) => adminSupplierFilters[key]).length;
      if (!checkbox.checked && checkedCount === 1) {
        checkbox.checked = true;
        return;
      }
      adminSupplierFilters[supplier] = checkbox.checked;
      adminPageIndex = 0;
      checkbox.closest(".supplier-filter-option")?.classList.toggle("active", checkbox.checked);
      closePartDetail();
      renderAdminTableIntoView();
    });
  });
}

function bindAdminOrderFilter() {
  document.querySelectorAll("[data-order-filter]").forEach((button) => button.addEventListener("click", () => {
    adminOrderFilter = button.dataset.orderFilter;
    adminPageIndex = 0;
    document.querySelectorAll("[data-order-filter]").forEach((tab) => {
      const active = tab.dataset.orderFilter === adminOrderFilter;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    closePartDetail();
    renderAdminTableIntoView();
  }));
}
function bindAdminPasswordReset() {
  document.querySelectorAll("[data-reset-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetRole = button.dataset.resetRole;
      if (!await confirmAdminAction({ title: `Reset รหัสผ่าน ${vendorLabel[targetRole]}?`, message: `รหัสผ่านของ ${vendorLabel[targetRole]} จะกลับเป็น 123`, confirmLabel: "Reset รหัสผ่าน" })) return;
      button.disabled = true;
      try {
        await api("/api/admin/reset-password", {
          method: "POST",
          body: JSON.stringify({ targetRole })
        });
        adminView(`<div class="status success">Reset password ของ ${escapeHtml(vendorLabel[targetRole])} เป็น 123 แล้ว</div>`);
      } catch (error) {
        adminView(`<div class="status error">${escapeHtml(error.message)}</div>`);
      }
    });
  });
}

function bindAdminInventoryClear() {
  document.querySelectorAll("[data-clear-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetRole = button.dataset.clearRole;
      const label = vendorLabel[targetRole];
      if (!await confirmAdminAction({ title: `ล้างข้อมูล ${label}?`, message: `ลบ inventory ที่อัปโหลดของ ${label} ทั้งหมด`, confirmLabel: "ล้างข้อมูล", danger: true })) return;
      button.disabled = true;
      try {
        await api("/api/admin/clear-upload", {
          method: "POST",
          body: JSON.stringify({ targetRole })
        });
        adminView(`<div class="status success">ล้าง inventory ของ ${escapeHtml(label)} แล้ว</div>`);
      } catch (error) {
        adminView(`<div class="status error">${escapeHtml(error.message)}</div>`);
      }
    });
  });
}

function bindAdminOrderStatusReset() {
  document.querySelector("#resetOrderStatusBtn")?.addEventListener("click", async () => {
    if (!await confirmAdminAction({
      title: "Reset สถานะสั่งซื้อทั้งหมด?",
      message: "เปลี่ยนทุก Part ของ Synnex, VST และ AIS กลับเป็น “ยังไม่สั่ง” รวมถึงรายการที่ซ่อนด้วยตัวกรอง",
      note: "จำนวนสินค้า ราคา และข้อมูลอัปโหลดยังคงเดิม",
      confirmLabel: "Reset ทั้งหมด"
    })) return;
    document.querySelector("#resetOrderStatusBtn").disabled = true;

    try {
      await api("/api/admin/reset-order-status", { method: "POST" });
      adminOrderFilter = "all";
      adminPageIndex = 0;
      adminView('<div class="status success">Reset สถานะสั่งแล้วทั้งหมดเป็นยังไม่สั่งแล้ว</div>');
    } catch (error) {
      adminView(`<div class="status error">${escapeHtml(error.message)}</div>`);
    }
  });
}

function exportAdminCsv() {
  if (!lastAdminData || !lastAdminData.parts?.length) {
    showAdminExportStatus("ยังไม่มีข้อมูลสำหรับ export", "error");
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const serverExportUrl = `${apiBaseUrl}/api/admin/export.csv?token=${encodeURIComponent(token)}`;
  triggerDownload(serverExportUrl, `combined-parts-${date}.csv`);
  showAdminExportStatus(`กำลัง export CSV ${lastAdminData.parts.length} รายการ`, "success");
}

function exportAdminCsvFromBrowserData() {
  const rows = [["Part No.", "Description", "Synnex Qty", "Synnex Price (ex VAT)", "VST Qty", "VST Price (ex VAT)", "AIS Qty", "AIS Price (ex VAT)"]];
  for (const part of lastAdminData.parts) {
    rows.push([
      part.partNo,
      part.description || "",
      part.synnex?.qty || "",
      part.synnex?.price || "",
      part.vst?.qty || "",
      part.vst?.price || "",
      part.ais?.qty || "",
      part.ais?.price || ""
    ]);
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  triggerDownload(url, `combined-parts-${date}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function triggerDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
  }, 1000);
}

function showAdminExportStatus(message, type = "success") {
  const existing = document.querySelector("#adminExportStatus");
  if (existing) existing.remove();
  const status = document.createElement("div");
  status.id = "adminExportStatus";
  status.className = `status ${type}`;
  status.textContent = message;
  const table = document.querySelector(".table-wrap");
  table?.parentElement?.insertBefore(status, table);
}

function bindCommon() {
  document.querySelector("#logoutBtn")?.addEventListener("click", () => {
    token = "";
    localStorage.removeItem(`inventory_token_${role}`);
    parsedRows = [];
    uploadReadVersion++;
    uploadSource = { filename: "", raw: "", matched: 0, errors: [], reading: false, submitting: false, complete: false };
    loginView();
  });

  document.querySelector("#passwordForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: form.get("currentPassword"),
          newPassword: form.get("newPassword")
        })
      });
      const message = `<div class="status success">เปลี่ยนรหัสผ่านสำเร็จ</div>`;
      if (page === "admin") adminView(message);
      else uploadView(message);
    } catch (error) {
      const message = `<div class="status error">${escapeHtml(error.message)}</div>`;
      if (page === "admin") adminView(message);
      else uploadView(message);
    }
  });
}

function render() {
  if (!token || page === "home") return loginView();
  if (page === "admin") return adminView();
  return uploadView();
}

render();





