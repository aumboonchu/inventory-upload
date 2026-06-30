const apiBaseUrl = window.APP_CONFIG?.apiBaseUrl || "http://localhost:8787";
const page = document.body.dataset.page;
const role = document.body.dataset.vendor;
const vendorLabel = { synnex: "Synnex", vst: "VST", ais: "AIS", admin: "Admin" };
const app = document.querySelector("#app");

let token = localStorage.getItem(`inventory_token_${role}`) || "";
let parsedRows = [];
let lastAdminData = null;

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
        <div class="panel-header">
          <div>
            <h1>${escapeHtml(vendorLabel[role])}</h1>
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
  const printableBonus = (text.match(/[A-Za-z0-9ก-๙]/g) || []).length;
  return delimiterBonus + printableBonus - replacementPenalty - nullPenalty;
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9ก-๙]/g, "");
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
      partNo: row[partIndex] || "",
      description: row[descriptionIndex] || "",
      qty: row[qtyIndex] || "",
      price: row[priceIndex] || ""
    }))
    .filter((row) => row.partNo.trim());
}

function rowsPreview(rows) {
  if (!rows.length) return `<div class="status">ยังไม่มีข้อมูล preview</div>`;
  return html`
    <div class="table-wrap">
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
    ${rows.length > 80 ? `<div class="hint">แสดง preview 80 รายการแรกจากทั้งหมด ${rows.length} รายการ</div>` : ""}
  `;
}

function uploadView(status = "") {
  app.innerHTML = shell(html`
    <div class="layout">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h1>${escapeHtml(vendorLabel[role])} Upload</h1>
            <p>รองรับ CSV หรือ copy ตารางจาก Excel แล้ว paste ลงช่องข้อมูล</p>
          </div>
          <button class="button secondary" id="logoutBtn" type="button">Logout</button>
        </div>
        <div class="panel-body">
          <div class="dropzone">
            <strong>Upload CSV</strong>
            <span class="hint">คอลัมน์ที่แนะนำ: Part No., Description, Qty, Price (ex VAT)</span>
            <div class="template-box">
              <div>
                <strong>Template</strong>
                <span class="hint">ใช้ไฟล์นี้เป็นรูปแบบมาตรฐานก่อน upload</span>
              </div>
              <a class="button secondary" href="template-${role}.csv" download>Download template</a>
            </div>
            <input class="input" id="csvFile" type="file" accept=".csv,text/csv">
            <textarea id="pasteBox" placeholder="หรือ paste ข้อมูลจาก Excel/CSV ที่นี่"></textarea>
            <div class="actions">
              <button class="button secondary" id="parsePasteBtn" type="button">Preview pasted data</button>
              <button class="button primary" id="uploadBtn" type="button" ${parsedRows.length ? "" : "disabled"}>Upload to ${escapeHtml(vendorLabel[role])}</button>
            </div>
          </div>
          ${status}
          <div class="toolbar" style="margin: 20px 0 12px;">
            <h2 style="margin:0;font-size:18px;">Preview</h2>
            <span class="hint">${parsedRows.length} rows ready</span>
          </div>
          ${rowsPreview(parsedRows)}
        </div>
      </section>
      <aside class="side-stack">
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
        <section class="panel mini">
          <h3>Data rule</h3>
          <p>การ upload ครั้งใหม่ของ vendor เดิมจะแทนที่ข้อมูลชุดก่อนหน้า เพื่อให้หน้า admin เห็นข้อมูลล่าสุดของ Synnex, VST และ AIS</p>
        </section>
      </aside>
    </div>
  `, role);

  bindCommon();
  document.querySelector("#csvFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const text = await readUploadText(file);
    parsedRows = mapRows(parseDelimited(text));
    uploadView(`<div class="status success">อ่านไฟล์ ${escapeHtml(file.name)} ได้ ${parsedRows.length} rows</div>`);
  });

  document.querySelector("#parsePasteBtn").addEventListener("click", () => {
    const text = document.querySelector("#pasteBox").value;
    parsedRows = mapRows(parseDelimited(text));
    uploadView(`<div class="status success">อ่านข้อมูล pasted ได้ ${parsedRows.length} rows</div>`);
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

function adminRows(parts, query = "") {
  const q = query.trim().toUpperCase();
  return parts
    .filter((part) => !q || part.partNo.includes(q) || (part.description || "").toUpperCase().includes(q))
    .map((part) => html`
      <tr>
        <td><strong>${escapeHtml(part.partNo)}</strong></td>
        <td>${escapeHtml(part.description || "")}</td>
        <td>${vendorCell(part.synnex)}</td>
        <td>${vendorCell(part.vst)}</td>
        <td>${vendorCell(part.ais)}</td>
      </tr>
    `).join("");
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

  app.innerHTML = shell(html`
    <section class="panel">
      <div class="panel-header">
        <div>
          <h1>Combined parts</h1>
          <p>รวม Part No. เดียวกัน และแสดงแยกคอลัมน์ Synnex / VST / AIS</p>
        </div>
        <div class="actions">
          <button class="button secondary" id="refreshBtn" type="button">Refresh</button>
          <button class="button secondary" id="exportBtn" type="button">Export CSV</button>
          <button class="button secondary" id="logoutBtn" type="button">Logout</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="stats">
          <div class="stat"><b>${data.parts.length}</b><span>Total parts</span></div>
          <div class="stat"><b>${data.uploads.find((item) => item.vendor === "synnex")?.count || 0}</b><span>Synnex rows</span></div>
          <div class="stat"><b>${data.uploads.find((item) => item.vendor === "vst")?.count || 0}</b><span>VST rows</span></div>
          <div class="stat"><b>${data.uploads.find((item) => item.vendor === "ais")?.count || 0}</b><span>AIS rows</span></div>
        </div>
        <div class="toolbar" style="margin-bottom:14px;">
          <input class="input" id="searchBox" placeholder="Search Part No. / Description" style="max-width:360px;">
          <span class="hint">Updated: ${escapeHtml(data.updatedAt || "-")}</span>
        </div>
        ${status}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Part No.</th>
                <th>Description</th>
                <th>Synnex</th>
                <th>VST</th>
                <th>AIS</th>
              </tr>
            </thead>
            <tbody id="adminBody">${adminRows(data.parts)}</tbody>
          </table>
        </div>
      </div>
    </section>
    <div class="layout" style="grid-template-columns: 1fr 320px; margin-top:18px;">
      <section class="panel mini">
        <h3>Latest uploads</h3>
        ${data.uploads.length ? data.uploads.map((upload) => html`
          <p><strong>${escapeHtml(vendorLabel[upload.vendor])}</strong> ${escapeHtml(upload.count)} rows<br><span class="hint">${escapeHtml(upload.uploadedAt)} · ${escapeHtml(upload.filename)}</span></p>
        `).join("") : `<p>ยังไม่มีข้อมูล upload</p>`}
      </section>
      <aside class="side-stack">
        <section class="panel mini">
          <h3>Reset user password</h3>
          <p>ตั้งรหัสผ่านของ Synnex, VST หรือ AIS กลับเป็น 123</p>
          <div class="actions vertical">
            <button class="button secondary full" data-reset-role="synnex" type="button">Reset Synnex to 123</button>
            <button class="button secondary full" data-reset-role="vst" type="button">Reset VST to 123</button>
            <button class="button secondary full" data-reset-role="ais" type="button">Reset AIS to 123</button>
          </div>
        </section>
        <section class="panel mini">
          <h3>Clear uploaded inventory</h3>
          <p>ล้างข้อมูล inventory ที่ upload แล้วเฉพาะเจ้า โดยไม่เปลี่ยน password</p>
          <div class="actions vertical">
            <button class="button warning full" data-clear-role="synnex" type="button">Clear Synnex inventory</button>
            <button class="button warning full" data-clear-role="vst" type="button">Clear VST inventory</button>
            <button class="button warning full" data-clear-role="ais" type="button">Clear AIS inventory</button>
          </div>
        </section>
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
    </div>
  `, "admin");

  bindCommon();
  bindAdminPasswordReset();
  bindAdminInventoryClear();
  document.querySelector("#refreshBtn").addEventListener("click", () => adminView());
  document.querySelector("#searchBox").addEventListener("input", (event) => {
    document.querySelector("#adminBody").innerHTML = adminRows(lastAdminData.parts, event.target.value);
  });
  document.querySelector("#exportBtn").addEventListener("click", exportAdminCsv);
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
