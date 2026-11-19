function stockOverview(rows, upload) {
  const net = rows.reduce((total, row) => total + BigInt(row.quantity), 0n);
  const matched = rows.filter(row => row.suppliers.length > 0).length;
  const positive = rows.filter(row => row.quantity > 0).length;
  const zero = rows.filter(row => row.quantity === 0).length;
  const states = [["positive", "มีสต็อก", positive], ["zero", "ยอดศูนย์", zero], ["negative", "ยอดติดลบ", rows.length - positive - zero]];
  const metrics = [["units", "สต็อกสุทธิ (ชิ้น)", net], ["parts", "Part ในไฟล์", rows.length],
    ["matched", "มีใน Allocation", matched], ["unmatched", "ไม่มีใน Allocation", rows.length - matched]];
  return `<dl class="stock-kpis" aria-label="สรุปทั้งไฟล์">${metrics.map(([key, label, value]) =>
    `<div><dt>${label}</dt><dd data-stock-metric="${key}">${stockNumber.format(value)}</dd></div>`).join("")}</dl>
    <section class="stock-insights" aria-label="ข้อมูลไฟล์ล่าสุด">
      <div class="stock-source"><h2>ไฟล์สต็อกล่าสุด</h2><strong>${escapeHtml(upload.filename)}</strong>
        <span>อัปโหลด ${escapeHtml(formatDateTime(upload.uploadedAt))} · เวลาไทย</span></div>
      <div class="stock-distribution"><h2>สถานะสต็อก <small>จำนวน Part</small></h2>
        <div class="stock-strip" aria-hidden="true">${states.filter(([, , n]) => n > 0).map(([key, , n]) =>
          `<i class="stock-${key}" style="flex-grow:${n}"></i>`).join("")}</div>
        <ul>${states.map(([key, label, n]) => `<li><i class="stock-${key}" aria-hidden="true"></i>${label} <strong>${stockNumber.format(n)}</strong></li>`).join("")}</ul>
      </div>
    </section>`;
}

function stockListControls() {
  const filters = [["all", "ทั้งหมด"], ["matched", "มีใน Allocation"], ["unmatched", "ไม่มีใน Allocation"]];
  return `<section class="stock-list" aria-labelledby="stockListTitle">
    <div class="stock-list-heading"><h2 id="stockListTitle">รายการสต็อก</h2>
      <label class="admin-search">${adminIcon("search")}<input id="inventorySearch" type="search" aria-label="ค้นหา Part No. หรือชื่อสินค้า" placeholder="ค้นหา Part No. หรือชื่อสินค้า"></label></div>
    <div class="stock-list-tools"><div class="order-tabs" role="group" aria-label="การจับคู่ Allocation">
      ${filters.map(([value, label]) => `<button type="button" class="order-tab" data-stock-filter="${value}">${label}</button>`).join("")}
      </div><span id="inventoryCount" role="status"></span></div>
    <table class="stock-table" aria-labelledby="stockListTitle"><thead><tr><th scope="col">สินค้า / Part No.</th><th scope="col">สต็อก (ชิ้น)</th><th scope="col">Allocation</th></tr></thead>
      <tbody id="inventoryRows"></tbody></table></section>`;
}

async function inventoryView(notice = "", filters = { match: "all", query: "" }) {
  if (!token || role !== "admin") return loginView();
  const version = ++adminLoadVersion;
  const current = () => Boolean(token) && version === adminLoadVersion;
  app.innerHTML = shell(`<section class="workspace-heading"><div><h1>Inventory</h1><p>สต็อกคงเหลือ JIB</p></div>
    <div class="heading-actions"><button type="button" id="stockRefresh" class="button secondary icon-button" aria-label="รีเฟรชสต็อก" title="รีเฟรชสต็อก" disabled>${adminIcon("refresh")}</button>
      ${jibStockUploadButton(true)}</div></section>
    ${notice ? `<div class="stock-notice">${notice}</div>` : ""}
    <div id="inventoryContent" aria-busy="true"><div class="stock-placeholder" role="status">กำลังโหลดสต็อก…</div></div>
    ${jibStockUploadDialog()}`, "inventory");
  bindCommon();
  bindJibStockUpload(inventoryView);
  const refresh = document.querySelector("#stockRefresh");
  const upload = document.querySelector("#jibStockUploadBtn");
  const content = document.querySelector("#inventoryContent");
  upload.disabled = true;
  refresh.addEventListener("click", () => inventoryView("", filters));
  let result;
  try {
    result = await api("/api/admin/jib-stock", { signal: AbortSignal.timeout(20000) });
    if (!current()) return;
    if (!result.ok || !Array.isArray(result.rows) || (!result.upload && result.rows.length) ||
        result.rows.some(r => typeof r?.partNo !== "string" || !Number.isSafeInteger(r.quantity) || !Array.isArray(r.suppliers))) {
      throw new Error("Invalid inventory");
    }
  } catch (error) {
    if (!current()) return;
    if (error.status === 401 || error.status === 403) {
      token = "";
      localStorage.removeItem("inventory_token_admin");
      return loginView("กรุณาเข้าสู่ระบบ Admin อีกครั้ง");
    }
    content.innerHTML = '<div class="stock-notice">' + statusMessage("โหลดข้อมูลสต็อกไม่ได้ กรุณากดรีเฟรชเพื่อลองอีกครั้ง", "error") + '</div>';
    return;
  } finally {
    if (current()) { refresh.disabled = false; content.setAttribute("aria-busy", "false"); }
  }
  upload.disabled = false;
  if (!result.upload) {
    content.innerHTML = '<section class="stock-placeholder"><h2>ยังไม่มีไฟล์สต็อก</h2><p>ยอดคงเหลือจะแสดงเมื่ออัปโหลดไฟล์ Excel ครั้งแรก</p></section>';
    return;
  }
  const rows = result.rows.sort((a,b) => b.quantity - a.quantity || a.partNo.localeCompare(b.partNo));
  content.innerHTML = stockOverview(rows, result.upload) + stockListControls();
  const search = content.querySelector("#inventorySearch");
  const buttons = [...content.querySelectorAll("[data-stock-filter]")];
  const tbody = content.querySelector("#inventoryRows");
  const count = content.querySelector("#inventoryCount");
  search.value = filters.query;
  function drawRows() {
    const query = filters.query.trim().toLowerCase();
    let visible = 0;
    const markup = [];
    for (const row of rows) {
      const matched = row.suppliers.length > 0;
      if (filters.match !== "all" && matched !== (filters.match === "matched")) continue;
      const master = masterParts?.[row.partNo];
      const name = master?.productName || master?.model || row.description || "";
      if (query && !row.partNo.toLowerCase().includes(query) && !name.toLowerCase().includes(query)) continue;
      visible++;
      const suppliers = supplierKeys.filter(key => row.suppliers.includes(key)).map(key => vendorLabel[key]);
      markup.push(`<tr><th scope="row"><strong>${escapeHtml(row.partNo)}</strong>${name ? `<span>${escapeHtml(name)}</span>` : ""}</th>
        <td class="stock-quantity${row.quantity <= 0 ? " stock-nonpositive" : ""}">${stockNumber.format(row.quantity)}</td>
        <td>${matched ? `<span class="stock-matched">${suppliers.join(" · ")}</span>` : '<span class="stock-unmatched">ไม่มีใน Allocation</span>'}</td></tr>`);
    }
    tbody.innerHTML = markup.join("") || '<tr><td colspan="3" class="stock-no-rows">ไม่พบ Part ที่ตรงกับตัวกรอง</td></tr>';
    count.textContent = `${stockNumber.format(visible)} จาก ${stockNumber.format(rows.length)} Part`;
    for (const button of buttons) {
      const selected = button.dataset.stockFilter === filters.match;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }
  search.addEventListener("input", () => { filters.query = search.value; drawRows(); });
  for (const button of buttons) button.addEventListener("click", () => { filters.match = button.dataset.stockFilter; drawRows(); });
  drawRows();
  if (!masterParts) void loadMasterParts().then(() => { if (current()) drawRows(); });
}
