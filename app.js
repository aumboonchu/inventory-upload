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
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} (${pad(date.getHours())}:${pad(date.getMinutes())})`;
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
    <section class="page-hero">
      <div>
        <p class="eyebrow">Supplier workspace</p>
        <h1>${escapeHtml(vendorLabel[role])} Upload</h1>
        <p>วางข้อมูลจาก Excel หรืออัปโหลด CSV แล้วตรวจ preview ก่อนส่งเข้า Admin</p>
      </div>
      <button class="button secondary" id="logoutBtn" type="button">Logout</button>
    </section>

    <div class="layout upload-layout">
      <section class="panel upload-panel">
        <div class="panel-header compact">
          <div>
            <h2>Upload source</h2>
            <p>Columns: Part No., Description, Qty, Price (ex VAT)</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="dropzone redesign-dropzone">
            <div class="upload-source-row">
              <div>
                <strong>CSV file</strong>
                <span class="hint">เลือกไฟล์ CSV หรือใช้ template ล่าสุดก่อน upload</span>
              </div>
              <a class="button secondary" href="template-${role}.csv" download>Download template</a>
            </div>
            <input class="input file-input" id="csvFile" type="file" accept=".csv,text/csv">
            <textarea id="pasteBox" placeholder="Paste data from Excel / CSV here"></textarea>
            <div class="actions upload-actions">
              <button class="button secondary" id="parsePasteBtn" type="button">Preview pasted data</button>
              <button class="button primary" id="uploadBtn" type="button" ${parsedRows.length ? "" : "disabled"}>Upload to ${escapeHtml(vendorLabel[role])}</button>
            </div>
          </div>
          ${status}
        </div>
      </section>

      <aside class="side-stack guide-stack">
        <section class="panel mini guide-panel">
          <h3>Before upload</h3>
          <div class="step-list">
            <div><span>1</span><p>ใช้ template ล่าสุด</p></div>
            <div><span>2</span><p>ตรวจ preview ให้ Part No. และ Price ตรง</p></div>
            <div><span>3</span><p>Upload ใหม่จะแทนข้อมูลเดิมของ supplier นี้</p></div>
          </div>
        </section>
        <section class="panel mini">
          <h3>Change password</h3>
          <p>เปลี่ยนรหัสผ่านเฉพาะหน้า ${escapeHtml(vendorLabel[role])}</p>
          <form id="passwordForm">
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
        </section>
      </aside>
    </div>

    <section class="panel preview-panel">
      <div class="panel-header compact inline-header">
        <div>
          <h2>Preview</h2>
          <p>ตรวจข้อมูลก่อน upload เข้า Admin</p>
        </div>
        <span class="hint">${parsedRows.length} rows ready</span>
      </div>
      <div class="panel-body">${rowsPreview(parsedRows)}</div>
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
function vendorCell(data) {
  if (!data) return `<span class="empty">-</span>`;
  return html`
    <div class="vendor-cell">
      <strong>${escapeHtml(data.qty || "-")}</strong>
      <span class="muted">Price (ex VAT): ${escapeHtml(data.price || "-")}</span>
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
          <th>Part No.</th>
          <th>Description</th>
          ${activeSuppliers.map((supplier) => `<th>${escapeHtml(vendorLabel[supplier])}</th>`).join("")}
        </tr>
      </thead>
      <tbody id="adminBody">${adminRows(parts, query, activeSuppliers)}</tbody>
    </table>
  `;
}

function adminRows(parts, query = "", suppliers = getActiveAdminSuppliers()) {
  const q = query.trim().toUpperCase();
  return parts
    .filter((part) => !q || part.partNo.includes(q) || (part.description || "").toUpperCase().includes(q))
    .map((part) => html`
      <tr>
        <td>
          <button class="part-link" data-part-no="${escapeHtml(part.partNo)}" type="button">
            ${escapeHtml(part.partNo)}
          </button>
        </td>
        <td>${escapeHtml(part.description || "")}</td>
        ${suppliers.map((supplier) => `<td>${vendorCell(part[supplier])}</td>`).join("")}
      </tr>
    `).join("");
}

function latestUploadsView(uploads) {
  return html`
    <section class="latest-strip">
      <div class="section-title">
        <h2>Latest uploads</h2>
        <span class="hint">รูปแบบวันเวลา dd-mm-yyyy (time)</span>
      </div>
      <div class="latest-grid">
        ${uploads.length ? uploads.map((upload) => html`
          <article class="latest-card">
            <span class="vendor-badge">${escapeHtml(vendorLabel[upload.vendor])}</span>
            <strong>${escapeHtml(upload.count)} rows</strong>
            <span>${escapeHtml(formatDateTime(upload.uploadedAt))}</span>
            <small>${escapeHtml(upload.filename || "browser upload")}</small>
          </article>
        `).join("") : `<div class="latest-card empty-state">ยังไม่มีข้อมูล upload</div>`}
      </div>
    </section>
  `;
}
async function loadAdmin() {
  lastAdminData = await api("/api/admin/parts");
  return lastAdminData;
}

async function adminView(status = "") {
  let data = lastAdminData;
  try {
    data = await loadAdmin();
  } catch (error) {
    if (error.message === "Unauthorized") return loginView();
    status = `<div class="status error">${escapeHtml(error.message)}</div>`;
    data = { parts: [], uploads: [] };
  }

  const countFor = (vendor) => data.uploads.find((item) => item.vendor === vendor)?.count || 0;

  app.innerHTML = shell(html`
    <section class="page-hero admin-hero">
      <div>
        <h1>Combined Inventory</h1>
        <p>อัพเดตล่าสุดจากทุก supplier ให้เห็นสถานะ จำนวนสินค้า และพร้อมตัดสินใจ</p>
      </div>
      <div class="actions hero-actions">
        <button class="button secondary" id="exportBtn" type="button">Export CSV</button>
        <button class="button primary" id="refreshBtn" type="button">Refresh</button>
      </div>
    </section>

    <section class="admin-overview">
      <div class="overview-latest">
        ${latestUploadsView(data.uploads)}
      </div>
      <div class="stats admin-stats">
        <div class="stat"><span>Total parts</span><b>${data.parts.length}</b></div>
        <div class="stat"><span>Synnex rows</span><b>${countFor("synnex")}</b></div>
        <div class="stat"><span>VST rows</span><b>${countFor("vst")}</b></div>
        <div class="stat"><span>AIS rows</span><b>${countFor("ais")}</b></div>
      </div>
    </section>

    <section class="panel admin-panel">
      <div class="panel-body">
        <div class="toolbar admin-toolbar">
          <input class="input search-input" id="searchBox" placeholder="Search Part No. / Description">
          ${supplierFilterControls()}
          <div class="table-actions">
            <span class="hint">Updated: ${escapeHtml(formatDateTime(data.updatedAt))}</span>
            <details class="tool-menu">
              <summary class="button secondary">Reset</summary>
              <div class="tool-menu-list">
                <button class="menu-action" data-reset-role="synnex" type="button">Reset Synnex</button>
                <button class="menu-action" data-reset-role="vst" type="button">Reset VST</button>
                <button class="menu-action" data-reset-role="ais" type="button">Reset AIS</button>
              </div>
            </details>
            <details class="tool-menu">
              <summary class="button primary">Clear</summary>
              <div class="tool-menu-list">
                <button class="menu-action danger" data-clear-role="synnex" type="button">Clear Synnex</button>
                <button class="menu-action danger" data-clear-role="vst" type="button">Clear VST</button>
                <button class="menu-action danger" data-clear-role="ais" type="button">Clear AIS</button>
              </div>
            </details>
            <button class="button secondary" id="logoutBtn" type="button">Logout</button>
          </div>
        </div>
        ${status}
        <div class="table-wrap admin-table" id="adminTableWrap">${renderAdminTable(data.parts)}</div>
      </div>
    </section>

    <section class="admin-tools">
      <div class="section-title tools-title">
        <h2>Password</h2>
        <span class="hint">เปลี่ยนรหัสผ่านเฉพาะหน้า Admin</span>
      </div>
      <aside class="side-stack">
        <section class="panel mini">
          <h3>Change password</h3>
          <p>เปลี่ยนรหัสผ่านเฉพาะหน้า Admin</p>
          <form id="passwordForm">
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
        </section>
      </aside>
    </section>
  `, "admin");

  bindCommon();
  bindAdminPasswordReset();
  bindAdminInventoryClear();
  document.querySelector("#refreshBtn").addEventListener("click", () => adminView());
  bindAdminSupplierFilters();
  document.querySelector("#searchBox").addEventListener("input", () => renderAdminTableIntoView());
  document.querySelector("#exportBtn").addEventListener("click", exportAdminCsv);
  bindPartDetailLinks();
  bindPartDetailModalEvents();
}

function renderAdminTableIntoView() {
  const query = document.querySelector("#searchBox")?.value || "";
  const tableWrap = document.querySelector("#adminTableWrap");
  if (!tableWrap || !lastAdminData) return;
  tableWrap.innerHTML = renderAdminTable(lastAdminData.parts, query);
  bindPartDetailLinks();
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
function bindAdminPasswordReset() {
  document.querySelectorAll("[data-reset-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetRole = button.dataset.resetRole;
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
      if (!confirm(`Clear uploaded inventory ของ ${label}?`)) return;
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





