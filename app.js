const apiBaseUrl = window.APP_CONFIG?.apiBaseUrl || "http://localhost:8787";
const page = document.body.dataset.page;
const role = document.body.dataset.vendor;
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

function adminIcon(name) {
  return `<img class="admin-icon" src="assets/admin-${name}.svg" width="18" height="18" alt="">`;
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
  return html`
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">JIB</div>
          <div>
            <p class="brand-title">Inventory Upload</p>
            <p class="brand-subtitle">${escapeHtml(vendorLabel[role])}</p>
          </div>
        </div>
        <nav class="nav">
          <a class="${active === "synnex" ? "active" : ""}" href="upload-synnex.html">Synnex</a>
          <a class="${active === "vst" ? "active" : ""}" href="upload-vst.html">VST</a>
          <a class="${active === "ais" ? "active" : ""}" href="upload-ais.html">AIS</a>
          <a class="${active === "admin" ? "active" : ""}" href="admin.html">Admin</a>
          <button class="button secondary nav-logout ${active === "admin" ? "icon-button" : ""}" id="logoutBtn" type="button" title="Logout" aria-label="Logout">${active === "admin" ? adminIcon("logout") : "Logout"}</button>
        </nav>
      </header>
      <main class="page">${content}</main>
    </div>
  `;
}

function loginView(message = "") {
  app.innerHTML = html`
    <div class="login-wrap">
      <section class="panel login-panel">
        <div class="login-brand">
          <div class="brand-mark">JIB</div>
        </div>
        <div class="panel-header compact">
          <div>
            <h1>${escapeHtml(vendorLabel[role])} Login</h1>
            <p>กรอกรหัสผ่านเพื่อเข้าใช้งาน</p>
          </div>
        </div>
        <form class="panel-body" id="loginForm">
          <div class="field">
            <label for="password">Password</label>
            <input class="input" id="password" name="password" type="password" autocomplete="current-password" required autofocus>
          </div>
          <button class="button primary full" type="submit">Login</button>
          ${message ? `<div class="status error">${escapeHtml(message)}</div>` : ""}
        </form>
      </section>
    </div>
  `;

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const password = new FormData(event.currentTarget).get("password");
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ role, password })
      });
      token = data.token;
      localStorage.setItem(`inventory_token_${role}`, token);
      render();
    } catch (error) {
      loginView(error.message);
    }
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
  const priceIndex = hasHeader ? findIndex(["price", "cost", "amount", "ราคา"], 3) : 3;

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
              <td>${escapeHtml(row.price)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${rows.length > 80 ? `<div class="hint table-note">แสดง preview 80 รายการแรกจากทั้งหมด ${rows.length} รายการ</div>` : ""}
  `;
}

function uploadView(status = "") {
  app.innerHTML = shell(html`
    <section class="upload-hero">
      <p class="eyebrow">SUPPLIER WORKSPACE / ${escapeHtml(vendorLabel[role]).toUpperCase()}</p>
      <h1>Upload inventory</h1>
      <p>นำเข้าไฟล์ supplier แล้วตรวจข้อมูลให้พร้อมก่อนส่งเข้า Admin</p>
    </section>

    <ol class="upload-steps" aria-label="Upload progress">
      <li class="active"><span>1</span><div><strong>Upload source</strong><small>เลือกไฟล์หรือวางข้อมูล</small></div></li>
      <li><span>2</span><div><strong>Review preview</strong><small>ตรวจ Part No., Qty และราคา</small></div></li>
      <li><span>3</span><div><strong>Send to Admin</strong><small>ยืนยันและแทนข้อมูลเดิม</small></div></li>
    </ol>

    <div class="upload-redesign-layout">
      <section class="upload-source-card">
        <div class="upload-card-heading">
          <h2>Add source data</h2>
          <p>อัปโหลด CSV หรือวางตารางจาก Excel ได้ทันที</p>
        </div>

        <div class="template-strip">
          <div>
            <strong>Use the current template</strong>
            <span>Part No., Description, Qty, Price (ex VAT)</span>
          </div>
          <a class="button secondary" href="template-${role}.csv" download>Download template</a>
        </div>

        <div class="file-dropzone">
          <img class="upload-icon" src="assets/upload.svg" alt="" aria-hidden="true">
          <div>
            <strong>Drop CSV here or choose a file</strong>
            <span>ไฟล์ใหม่จะแทนข้อมูลเดิมของ ${escapeHtml(vendorLabel[role])} หลังจากยืนยัน upload</span>
          </div>
          <input id="csvFile" type="file" accept=".csv,text/csv">
          <label class="button primary" for="csvFile">Choose CSV</label>
        </div>

        <label class="paste-field" for="pasteBox">
          <span>หรือวางข้อมูลจาก Excel / CSV</span>
          <textarea id="pasteBox" placeholder="วางข้อมูลที่นี่"></textarea>
        </label>
      </section>

      <aside class="upload-side-stack">
        <section class="data-check-card">
          <h2>Data check</h2>
          <p>ตรวจให้ครบก่อนสร้าง preview</p>
          <div class="data-fields">
            <span>Part No.</span><span>Description</span><span>Qty</span><span>Price (ex VAT)</span>
          </div>
          <div class="master-part-note">
            <strong>Apple master part</strong>
            <span>ถ้าพบ Part No. ในรายการกลาง ระบบจะใช้ชื่อสินค้านั้นก่อน</span>
          </div>
        </section>

        <details class="account-settings-card">
          <summary>
            <div>
              <h2>Account settings</h2>
              <p>เปลี่ยนรหัสผ่านสำหรับ ${escapeHtml(vendorLabel[role])} โดยไม่รบกวนขั้นตอน upload</p>
            </div>
            <span class="button secondary">Change password</span>
          </summary>
          <form id="passwordForm" class="account-password-form">
            <div class="field">
              <label>Current password</label>
              <input class="input" name="currentPassword" type="password" required>
            </div>
            <div class="field">
              <label>New password</label>
              <input class="input" name="newPassword" type="password" minlength="3" required>
            </div>
            <button class="button warning full" type="submit">Change password</button>
          </form>
        </details>
      </aside>
    </div>

    ${status}

    <section class="preview-card">
      <div class="preview-card-header">
        <div>
          <h2>Review preview</h2>
          <p>ตรวจข้อมูลก่อนส่งเข้า Admin</p>
        </div>
        <div class="preview-actions">
          <span class="hint">${parsedRows.length} rows ready</span>
          <button class="button secondary" id="parsePasteBtn" type="button">Preview data</button>
          <button class="button primary" id="uploadBtn" type="button" ${parsedRows.length ? "" : "disabled"}>Upload to ${escapeHtml(vendorLabel[role])}</button>
        </div>
      </div>
      <div class="preview-card-body">${rowsPreview(parsedRows)}</div>
    </section>
  `, role);

  bindCommon();
  document.querySelector("#csvFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const text = await readUploadText(file);
    await loadMasterParts();
    const result = applyMasterParts(mapRows(parseDelimited(text)));
    parsedRows = result.rows;
    uploadView(`<div class="status success">อ่านไฟล์ ${escapeHtml(file.name)} ได้ ${parsedRows.length} rows ใช้ชื่อจาก partApple ${result.matched} rows</div>`);
  });

  document.querySelector("#parsePasteBtn").addEventListener("click", async () => {
    const text = document.querySelector("#pasteBox").value;
    await loadMasterParts();
    const result = applyMasterParts(mapRows(parseDelimited(text)));
    parsedRows = result.rows;
    uploadView(`<div class="status success">อ่านข้อมูล pasted ได้ ${parsedRows.length} rows ใช้ชื่อจาก partApple ${result.matched} rows</div>`);
  });

  document.querySelector("#uploadBtn").addEventListener("click", async () => {
    try {
      const data = await api("/api/upload", {
        method: "POST",
        body: JSON.stringify({ vendor: role, filename: "browser upload", rows: parsedRows })
      });
      uploadView(`<div class="status success">Upload สำเร็จ ${data.count} rows ตอนนี้ admin มี part รวม ${data.combinedCount} รายการ</div>`);
    } catch (error) {
      uploadView(`<div class="status error">${escapeHtml(error.message)}</div>`);
    }
  });
}
function vendorCell(data, part, supplier) {
  if (!data) return `<span class="empty">-</span>`;
  const ordered = Boolean(part.orders?.[supplier]);
  return html`
    <div class="vendor-cell">
      <div class="vendor-values"><strong>${escapeHtml(data.qty ?? "-")}</strong><span>${data.price !== "" && data.price != null ? `฿${escapeHtml(data.price)}` : "-"}</span></div>
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

function partDetailSupplierCard(label, data) {
  return html`
    <article class="part-supplier-card">
      <h4>${escapeHtml(label)}</h4>
      <div class="part-supplier-values">
        <div>
          <span>Qty</span>
          <strong class="${data ? "" : "empty"}">${escapeHtml(data?.qty || "-")}</strong>
        </div>
        <div>
          <span>Price (ex VAT)</span>
          <strong class="${data ? "" : "empty"}">${escapeHtml(data?.price || "-")}</strong>
        </div>
      </div>
    </article>
  `;
}

function partDetailModal(part) {
  const activeSuppliers = getActiveAdminSuppliers();
  return html`
    <div class="modal-backdrop" data-modal-close>
      <section class="part-modal" role="dialog" aria-modal="true" aria-labelledby="partModalTitle">
        <button class="modal-close" data-modal-close type="button" aria-label="Close part detail">×</button>
        <div class="part-modal-head">
          <h2 id="partModalTitle">${escapeHtml(part.partNo)}</h2>
          <p>${escapeHtml(part.description || "-")}</p>
        </div>

        <div class="part-detail-grid">
          <div>
            <span>Part No.</span>
            <strong>${escapeHtml(part.partNo)}</strong>
          </div>
          <div>
            <span>Description</span>
            <strong>${escapeHtml(part.description || "-")}</strong>
          </div>
        </div>

        <div class="part-supplier-section">
          <h3>Supplier inventory</h3>
          <div class="part-supplier-grid supplier-count-${activeSuppliers.length}">
            ${activeSuppliers.map((supplier) => partDetailSupplierCard(vendorLabel[supplier], part[supplier])).join("")}
          </div>
        </div>

        <p class="part-modal-note">ข้อมูลแสดงจาก record ที่ upload ล่าสุดของแต่ละ supplier</p>
      </section>
    </div>
  `;
}

function showPartDetail(partNo) {
  const part = lastAdminData?.parts?.find((item) => item.partNo === partNo);
  if (!part) return;
  document.querySelector(".modal-backdrop")?.remove();
  document.body.insertAdjacentHTML("beforeend", partDetailModal(part));
  document.body.classList.add("modal-open");
  document.querySelector(".modal-close")?.focus();
}

function closePartDetail() {
  document.querySelector(".modal-backdrop")?.remove();
  document.body.classList.remove("modal-open");
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
  const activeSuppliers = getActiveAdminSuppliers();
  return html`
    <table class="supplier-visible-${activeSuppliers.length}">
      <thead>
        <tr>
          <th class="order-column" scope="col">สถานะสั่งซื้อ</th>
          <th class="part-column" scope="col">Part No.</th>
          <th class="description-column" scope="col">Description</th>
          ${activeSuppliers.map((supplier) => `<th class="supplier-column" scope="col">${escapeHtml(vendorLabel[supplier])}<small>Qty / Price (ex VAT)</small></th>`).join("")}
        </tr>
      </thead>
      <tbody id="adminBody">${adminRows(parts, query, activeSuppliers)}</tbody>
    </table>
  `;
}

function filteredAdminParts(parts, query = "") {
  const q = query.trim().toUpperCase();
  return parts
    .filter((part) => !q || part.partNo.includes(q) || (part.description || "").toUpperCase().includes(q))
    .filter((part) => adminOrderFilter === "all" || orderStateFor(part).key === adminOrderFilter);
}

function adminRows(parts, query = "", suppliers = getActiveAdminSuppliers()) {
  const rows = filteredAdminParts(parts, query);
  if (!rows.length) return `<tr><td class="inventory-empty" colspan="${3 + suppliers.length}">ไม่พบรายการสินค้า</td></tr>`;
  return rows
    .map((part) => html`
      <tr class="inventory-row state-${orderStateFor(part).key}">
        <td class="order-cell">
          ${orderStateCell(part)}
        </td>
        <td>
          <button class="part-link" data-part-no="${escapeHtml(part.partNo)}" type="button">
            ${escapeHtml(part.partNo)}
          </button>
        </td>
        <td>${escapeHtml(part.description || "")}</td>
        ${suppliers.map((supplier) => `<td>${vendorCell(part[supplier], part, supplier)}</td>`).join("")}
      </tr>
    `).join("");
}

function latestUploadsView(uploads) {
  return html`
    <section class="latest-strip">
      <div class="section-title">
        <h2>Latest uploads</h2>
        <span class="hint">เวลาประเทศไทย</span>
      </div>
      <div class="latest-grid">
        ${supplierKeys.map((supplier) => {
          const upload = uploads.find((item) => item.vendor === supplier);
          return html`
          <article class="latest-card latest-${supplier}">
            <div class="latest-info"><h3>${escapeHtml(vendorLabel[supplier])}</h3>
            <span>${upload ? escapeHtml(formatDateTime(upload.uploadedAt)) : "ยังไม่มีข้อมูล"}</span>
            <small>${upload ? escapeHtml(upload.filename || "browser upload") : "รอการอัปโหลด"}</small></div>
            <div class="latest-count"><strong>${escapeHtml(upload?.count ?? 0)}</strong><span>rows</span></div>
          </article>
        `; }).join("")}
      </div>
    </section>
  `;
}
async function loadAdmin() {
  lastAdminData = await api("/api/admin/parts");
  return lastAdminData;
}

async function adminView(status = "") {
  let data;
  try {
    data = await loadAdmin();
  } catch (error) {
    if (error.message === "Unauthorized") return loginView();
    status = `<div class="status error">${escapeHtml(error.message)}</div>`;
    data = lastAdminData || { parts: [], uploads: [] };
  }

  app.innerHTML = shell(html`
    <section class="page-hero admin-hero">
      <div><h1>Combined Inventory</h1><p>${data.parts.length} parts / Synnex · VST · AIS</p></div>
      <div class="actions hero-actions">
        <button class="button secondary icon-button" id="refreshBtn" type="button" title="Refresh" aria-label="Refresh">${adminIcon("refresh")}</button>
        <button class="button primary" id="exportBtn" type="button">${adminIcon("download")}Export CSV</button>
      </div>
    </section>
    <section class="admin-overview">${latestUploadsView(data.uploads)}</section>
    <section class="admin-workspace">
      <div class="admin-toolbar">
        <label class="admin-search">${adminIcon("search")}<input id="searchBox" type="search" aria-label="ค้นหา Part No. / ชื่อสินค้า" placeholder="ค้นหา Part No. / ชื่อสินค้า" value="${escapeHtml(adminSearchQuery)}"></label>
        <div class="admin-filter-actions">
          <span class="supplier-caption">Supplier</span>${supplierFilterControls()}
          <details class="tool-menu admin-management" id="adminManagement">
            <summary class="button secondary">${adminIcon("settings")}จัดการ${adminIcon("down")}</summary>
            <div class="tool-menu-list">
              <span class="menu-heading">สถานะสั่งซื้อ</span>
              <button class="menu-action reset-orders" id="resetOrderStatusBtn" type="button">Reset สั่งแล้วทั้งหมด</button>
              <hr><span class="menu-heading">รหัสผ่าน</span>
              <button class="menu-action" id="adminPasswordBtn" type="button">เปลี่ยนรหัสผ่าน Admin</button>
              ${supplierKeys.map((supplier) => `<button class="menu-action" data-reset-role="${supplier}" type="button">Reset รหัสผ่าน ${vendorLabel[supplier]}</button>`).join("")}
              <hr><span class="menu-heading">ล้าง Inventory</span>
              ${supplierKeys.map((supplier) => `<button class="menu-action danger" data-clear-role="${supplier}" type="button">ล้างข้อมูล ${vendorLabel[supplier]}</button>`).join("")}
            </div>
          </details>
        </div>
      </div>
      <div class="admin-order-bar">${orderFilterControl()}<span id="visiblePartsCount" class="hint">${filteredAdminParts(data.parts, adminSearchQuery).length} parts</span></div>
      ${status}
      <div class="table-wrap admin-table" id="adminTableWrap" tabindex="0" role="region" aria-label="ตาราง inventory">${renderAdminTable(data.parts, adminSearchQuery)}</div>
      <div class="admin-footer"><span>${adminIcon("clock")}Updated: ${escapeHtml(formatDateTime(data.updatedAt))}</span><span>Price (ex VAT)</span></div>
    </section>
    <dialog class="admin-dialog" id="adminPasswordDialog" aria-labelledby="adminPasswordTitle">
      <h2 id="adminPasswordTitle">เปลี่ยนรหัสผ่าน Admin</h2>
      <form id="passwordForm">
        <div class="field"><label for="adminCurrentPassword">Current password</label><input class="input" id="adminCurrentPassword" name="currentPassword" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="adminNewPassword">New password</label><input class="input" id="adminNewPassword" name="newPassword" type="password" autocomplete="new-password" minlength="3" required></div>
        <div class="dialog-actions"><button class="button secondary" type="button" data-dialog-cancel>ยกเลิก</button><button class="button primary" type="submit">เปลี่ยนรหัสผ่าน</button></div>
      </form>
    </dialog>
  `, "admin");

  bindCommon();
  bindAdminPasswordReset();
  bindAdminInventoryClear();
  bindAdminOrderStatusReset();
  document.querySelector("#refreshBtn").addEventListener("click", () => adminView());
  bindAdminSupplierFilters();
  bindAdminOrderFilter();
  document.querySelector("#searchBox").addEventListener("input", (event) => {
    adminSearchQuery = event.currentTarget.value;
    renderAdminTableIntoView();
  });
  document.querySelector("#exportBtn").addEventListener("click", exportAdminCsv);
  const passwordDialog = document.querySelector("#adminPasswordDialog");
  document.querySelector("#adminPasswordBtn").addEventListener("click", () => {
    closeAdminManagement();
    passwordDialog.showModal();
  });
  passwordDialog.querySelector("[data-dialog-cancel]").addEventListener("click", () => passwordDialog.close());
  const menu = document.querySelector("#adminManagement");
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); }
  });
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
  document.querySelector("#visiblePartsCount").textContent = `${filteredAdminParts(lastAdminData.parts, query).length} parts`;
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
      checkbox.closest(".supplier-filter-option")?.classList.toggle("active", checkbox.checked);
      closePartDetail();
      renderAdminTableIntoView();
    });
  });
}

function bindAdminOrderFilter() {
  document.querySelectorAll("[data-order-filter]").forEach((button) => button.addEventListener("click", () => {
    adminOrderFilter = button.dataset.orderFilter;
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
  if (!token) return loginView();
  if (page === "admin") return adminView();
  return uploadView();
}

render();





