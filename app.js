/* Lone Star Tan — Month-End Inventory Adjustment Form
 * Front-end logic. State is in-memory only (no localStorage), per spec §6.6. */
(function () {
  "use strict";

  // ---- Config ----------------------------------------------------------
  var CATALOG = (window.PRODUCT_CATALOG || []).slice();
  var STORES = (window.STORE_LIST || []).slice();
  var DUE_DAY = 25;

  // Reason codes. `routine: true` reasons fall through to audit in/out by sign;
  // Damage and Transferred are special-cased per spec §5.2.
  var NOTATIONS = [
    { value: "Damage", routine: false },
    { value: "Stolen", routine: true },
    { value: "Expired", routine: true },
    { value: "Missold", routine: true },
    { value: "Lost", routine: true },
    { value: "Transferred", routine: false },
    { value: "Other", routine: true },
  ];

  // Notation -> SunLync transaction type (PROPOSED; verify against POS, spec §8).
  function transactionType(notation, adjustment) {
    if (notation === "Damage") return "damage";
    if (notation === "Transferred") return "transfer";
    if (adjustment > 0) return "audit in";
    if (adjustment < 0) return "audit out";
    return "";
  }

  // ---- State -----------------------------------------------------------
  var lines = []; // { id, product, isWriteIn, adjustment(str), notation, transferFrom, transferTo, note }
  var seq = 1;

  // ---- DOM refs --------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var linesEl = $("lines");
  var emptyState = $("emptyState");
  var counterEl = $("lineCounter");
  var search = $("productSearch");
  var comboList = $("comboList");
  var toastEl = $("toast");

  var activeIndex = -1;     // highlighted item in combo dropdown
  var currentMatches = [];

  // ---- Init ------------------------------------------------------------
  function init() {
    // Date defaults to today (local).
    var today = new Date();
    $("date").value = toISODate(today);
    updateLateHint();

    // Stores -> datalist (optional).
    if (STORES.length) {
      var dl = $("storeList");
      STORES.forEach(function (s) {
        var o = document.createElement("option");
        o.value = s;
        dl.appendChild(o);
      });
    }

    $("catalogMeta").textContent = CATALOG.length + " catalog SKUs loaded";

    wireEvents();
    render();
  }

  function wireEvents() {
    search.addEventListener("input", onSearchInput);
    search.addEventListener("keydown", onSearchKeydown);
    search.addEventListener("focus", onSearchInput);
    document.addEventListener("click", function (e) {
      if (!$("combo").contains(e.target)) closeCombo();
    });

    $("writeInBtn").addEventListener("click", addWriteIn);
    $("date").addEventListener("change", updateLateHint);

    $("previewBtn").addEventListener("click", function () { openSummary(false); });
    $("submitBtn").addEventListener("click", function () { openSummary(true); });
    $("downloadJsonBtn").addEventListener("click", function () { if (guard()) downloadJSON(); });
    $("downloadCsvBtn").addEventListener("click", function () { if (guard()) downloadCSV(); });

    $("modalClose").addEventListener("click", closeModal);
    $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
    $("copyBtn").addEventListener("click", copySummary);
    $("mailtoBtn").addEventListener("click", openMailto);
    $("modalJsonBtn").addEventListener("click", downloadJSON);
    $("modalCsvBtn").addEventListener("click", downloadCSV);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeModal(); closeCombo(); }
    });
  }

  // ---- Combobox (searchable product picker) ---------------------------
  function onSearchInput() {
    var q = search.value.trim().toLowerCase();
    var added = new Set(lines.filter(function (l) { return !l.isWriteIn; })
                             .map(function (l) { return l.product; }));
    var matches = [];
    for (var i = 0; i < CATALOG.length && matches.length < 60; i++) {
      var name = CATALOG[i];
      if (!q || name.toLowerCase().indexOf(q) !== -1) {
        matches.push(name);
      }
    }
    currentMatches = matches;
    activeIndex = matches.length ? 0 : -1;
    renderCombo(matches, q, added);
  }

  function renderCombo(matches, q, added) {
    comboList.innerHTML = "";
    if (!matches.length) {
      var li = document.createElement("li");
      li.className = "no-match";
      li.textContent = "No catalog match. Use “+ Write-in product” for items not listed.";
      comboList.appendChild(li);
      openCombo();
      return;
    }
    matches.forEach(function (name, idx) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      var isAdded = added.has(name);
      if (isAdded) li.className = "is-added";
      if (idx === activeIndex) li.className += " active";
      var label = document.createElement("span");
      label.innerHTML = highlight(name, q);
      li.appendChild(label);
      if (isAdded) {
        var tag = document.createElement("span");
        tag.className = "added-tag";
        tag.textContent = "added";
        li.appendChild(tag);
      }
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        pickProduct(name);
      });
      comboList.appendChild(li);
    });
    openCombo();
  }

  function onSearchKeydown(e) {
    if (comboList.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
      refreshActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      refreshActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && currentMatches[activeIndex]) pickProduct(currentMatches[activeIndex]);
    }
  }

  function refreshActive() {
    var items = comboList.querySelectorAll("li");
    items.forEach(function (li, i) {
      li.classList.toggle("active", i === activeIndex);
      if (i === activeIndex) li.scrollIntoView({ block: "nearest" });
    });
  }

  function openCombo() {
    comboList.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }
  function closeCombo() {
    comboList.hidden = true;
    search.setAttribute("aria-expanded", "false");
  }

  function pickProduct(name) {
    var existing = lines.find(function (l) { return !l.isWriteIn && l.product === name; });
    if (existing) {
      // Prevent duplicate rows — focus the existing one instead (spec §6.1).
      closeCombo();
      search.value = "";
      flashRow(existing.id);
      toast("“" + name + "” is already added");
      return;
    }
    lines.push(newLine({ product: name }));
    search.value = "";
    closeCombo();
    render();
    focusAdjustment(lines[lines.length - 1].id);
  }

  function addWriteIn() {
    lines.push(newLine({ product: "", isWriteIn: true }));
    render();
    // Focus the write-in name field of the new row.
    var last = lines[lines.length - 1];
    var el = document.querySelector('[data-writein="' + last.id + '"]');
    if (el) el.focus();
  }

  function newLine(over) {
    return Object.assign({
      id: seq++,
      product: "",
      isWriteIn: false,
      adjustment: "",
      notation: "",
      transferFrom: "",
      transferTo: "",
      note: "",
    }, over || {});
  }

  // ---- Render line rows ------------------------------------------------
  function render() {
    linesEl.innerHTML = "";
    lines.forEach(function (l) { linesEl.appendChild(renderLine(l)); });
    emptyState.hidden = lines.length > 0;
    counterEl.textContent = lines.length + (lines.length === 1 ? " item" : " items");
  }

  function renderLine(l) {
    var row = document.createElement("div");
    row.className = "line";
    row.dataset.row = l.id;

    // --- top: name + remove ---
    var top = document.createElement("div");
    top.className = "line-top";
    var nameWrap = document.createElement("div");
    nameWrap.className = "line-name";

    if (l.isWriteIn) {
      var wi = document.createElement("div");
      wi.className = "field writein-name";
      var wlabel = document.createElement("span");
      wlabel.className = "label-text";
      wlabel.textContent = "Write-in product name *";
      var winput = document.createElement("input");
      winput.type = "text";
      winput.placeholder = "Product not in catalog";
      winput.value = l.product;
      winput.dataset.writein = l.id;
      winput.addEventListener("input", function () { l.product = winput.value; });
      var badge = document.createElement("span");
      badge.className = "writein-badge";
      badge.textContent = "write-in";
      wlabel.appendChild(badge);
      wi.appendChild(wlabel);
      wi.appendChild(winput);
      nameWrap.appendChild(wi);
    } else {
      var pname = document.createElement("div");
      pname.className = "pname";
      pname.textContent = l.product;
      nameWrap.appendChild(pname);
    }
    top.appendChild(nameWrap);

    var rm = document.createElement("button");
    rm.className = "remove-btn";
    rm.type = "button";
    rm.title = "Remove this row";
    rm.innerHTML = "&times;";
    rm.addEventListener("click", function () { removeLine(l.id); });
    top.appendChild(rm);
    row.appendChild(top);

    // --- grid: adjustment, notation, (transfer) ---
    var grid = document.createElement("div");
    grid.className = "line-grid";
    if (l.notation === "Transferred") grid.className += " with-transfer";

    // Adjustment
    grid.appendChild(fieldWrap("Adjustment *", (function () {
      var w = document.createElement("div");
      w.className = "adj-wrap";
      var inp = document.createElement("input");
      inp.type = "number";
      inp.step = "1";
      inp.className = "adj-input";
      inp.placeholder = "±0";
      inp.value = l.adjustment;
      inp.dataset.adj = l.id;
      var sign = document.createElement("span");
      sign.className = "adj-sign";
      function paintSign() {
        var n = parseInt(inp.value, 10);
        sign.textContent = "";
        sign.className = "adj-sign";
        if (!isNaN(n) && n > 0) { sign.textContent = "in"; sign.className += " pos"; }
        else if (!isNaN(n) && n < 0) { sign.textContent = "out"; sign.className += " neg"; }
      }
      inp.addEventListener("input", function () { l.adjustment = inp.value; paintSign(); });
      paintSign();
      w.appendChild(inp);
      w.appendChild(sign);
      return w;
    })()));

    // Notation
    grid.appendChild(fieldWrap("Notation (reason) *", (function () {
      var sel = document.createElement("select");
      sel.dataset.notation = l.id;
      var ph = document.createElement("option");
      ph.value = ""; ph.textContent = "Select reason…";
      sel.appendChild(ph);
      NOTATIONS.forEach(function (n) {
        var o = document.createElement("option");
        o.value = n.value; o.textContent = n.value;
        if (l.notation === n.value) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        l.notation = sel.value;
        render(); // re-render to toggle transfer fields
      });
      return sel;
    })()));

    // Conditional transfer fields
    if (l.notation === "Transferred") {
      grid.appendChild(fieldWrap("Transfer FROM *", textField(l, "transferFrom", "From store/market")));
      grid.appendChild(fieldWrap("Transfer TO *", textField(l, "transferTo", "To store/market")));
    }

    row.appendChild(grid);

    // --- optional note ---
    var noteWrap = document.createElement("div");
    noteWrap.className = "note-row field";
    var nlabel = document.createElement("span");
    nlabel.className = "label-text";
    nlabel.textContent = "Note (optional)";
    var ta = document.createElement("textarea");
    ta.rows = 1;
    ta.placeholder = "Anything the reason dropdown doesn't cover";
    ta.value = l.note;
    ta.addEventListener("input", function () { l.note = ta.value; });
    noteWrap.appendChild(nlabel);
    noteWrap.appendChild(ta);
    row.appendChild(noteWrap);

    return row;
  }

  function fieldWrap(labelText, control) {
    var f = document.createElement("label");
    f.className = "field";
    var s = document.createElement("span");
    s.className = "label-text";
    s.textContent = labelText;
    f.appendChild(s);
    f.appendChild(control);
    return f;
  }

  function textField(l, key, placeholder) {
    var inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = placeholder;
    inp.value = l[key];
    inp.dataset.field = key;
    inp.dataset.row = l.id;
    inp.addEventListener("input", function () { l[key] = inp.value; });
    return inp;
  }

  function removeLine(id) {
    lines = lines.filter(function (l) { return l.id !== id; });
    render();
  }

  function focusAdjustment(id) {
    var el = document.querySelector('[data-adj="' + id + '"]');
    if (el) el.focus();
  }

  function flashRow(id) {
    var row = document.querySelector('[data-row="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.style.transition = "background .2s";
    var old = row.style.background;
    row.style.background = "#fff7d6";
    setTimeout(function () { row.style.background = old; }, 700);
  }

  // ---- Validation ------------------------------------------------------
  function validate() {
    var problems = [];
    clearFieldErrors();

    var employee = $("employee").value.trim();
    var store = $("store").value.trim();
    var date = $("date").value;

    if (!employee) { fieldError("employee", "Required"); problems.push("Employee name is required."); }
    if (!store) { fieldError("store", "Required"); problems.push("Store market / number is required."); }
    if (!date) { fieldError("date", "Required"); problems.push("Date is required."); }

    if (!lines.length) problems.push("Add at least one adjustment.");

    lines.forEach(function (l, i) {
      var rowEl = document.querySelector('[data-row="' + l.id + '"]');
      var label = l.isWriteIn ? (l.product || "Write-in #" + (i + 1)) : l.product;
      var bad = false;

      if (l.isWriteIn && !l.product.trim()) {
        problems.push("Row " + (i + 1) + ": write-in needs a product name.");
        bad = true;
      }
      var n = parseInt(l.adjustment, 10);
      if (l.adjustment === "" || isNaN(n) || n === 0) {
        problems.push("“" + label + "”: needs a non-zero adjustment.");
        bad = true;
      }
      if (!l.notation) {
        problems.push("“" + label + "”: needs a notation (reason).");
        bad = true;
      }
      if (l.notation === "Transferred") {
        if (!l.transferFrom.trim()) { problems.push("“" + label + "”: transfer FROM required."); bad = true; }
        if (!l.transferTo.trim()) { problems.push("“" + label + "”: transfer TO required."); bad = true; }
      }
      if (rowEl) rowEl.classList.toggle("row-invalid", bad);
    });

    // Duplicate write-in names colliding with catalog or each other
    var names = {};
    lines.forEach(function (l) {
      var key = (l.product || "").trim().toLowerCase();
      if (!key) return;
      names[key] = (names[key] || 0) + 1;
    });
    Object.keys(names).forEach(function (k) {
      if (names[k] > 1) problems.push("Duplicate product rows for “" + k + "” — combine into one.");
    });

    return problems;
  }

  function fieldError(id, msg) {
    $(id).classList.add("invalid");
    var span = document.querySelector('[data-err="' + id + '"]');
    if (span) span.textContent = msg;
  }
  function clearFieldErrors() {
    ["employee", "store", "date"].forEach(function (id) {
      $(id).classList.remove("invalid");
      var span = document.querySelector('[data-err="' + id + '"]');
      if (span) span.textContent = "";
    });
    document.querySelectorAll(".line.row-invalid").forEach(function (r) {
      r.classList.remove("row-invalid");
    });
  }

  function guard() {
    var problems = validate();
    if (problems.length) {
      openSummary(true);
      return false;
    }
    return true;
  }

  // ---- Build submission payload ---------------------------------------
  function buildPayload() {
    var payloadLines = lines.map(function (l) {
      var adj = parseInt(l.adjustment, 10);
      var line = {
        product: (l.product || "").trim(),
        adjustment: isNaN(adj) ? null : adj,
        notation: l.notation || null,
        transactionType: transactionType(l.notation, adj),
      };
      if (l.notation === "Transferred") {
        line.transferFrom = l.transferFrom.trim();
        line.transferTo = l.transferTo.trim();
      }
      if (l.note.trim()) line.note = l.note.trim();
      if (l.isWriteIn) line.isWriteIn = true;
      return line;
    });
    return {
      employee: $("employee").value.trim(),
      storeMarketNumber: $("store").value.trim(),
      date: $("date").value,
      submittedAt: new Date().toISOString(),
      isLate: isLate($("date").value),
      lineCount: payloadLines.length,
      lines: payloadLines,
    };
  }

  // ---- Summary modal ---------------------------------------------------
  function openSummary(isSubmit) {
    var problems = validate();
    var body = $("modalBody");
    body.innerHTML = "";

    if (problems.length) {
      var banner = document.createElement("div");
      banner.className = "problem-banner";
      banner.innerHTML = "<strong>Please fix " + problems.length +
        (problems.length === 1 ? " issue" : " issues") + " before submitting:</strong>";
      var ul = document.createElement("ul");
      problems.forEach(function (p) {
        var li = document.createElement("li"); li.textContent = p; ul.appendChild(li);
      });
      banner.appendChild(ul);
      body.appendChild(banner);
      // Disable submit-only actions when invalid.
      setModalActionsEnabled(false);
    } else {
      setModalActionsEnabled(true);
    }

    var payload = buildPayload();

    // Meta block
    var meta = document.createElement("div");
    meta.className = "summary-meta";
    meta.appendChild(metaCard("Employee", payload.employee || "—"));
    meta.appendChild(metaCard("Store Market / #", payload.storeMarketNumber || "—"));
    meta.appendChild(metaCard("Date", payload.date + (payload.isLate ? "  ⚠ late" : "")));
    body.appendChild(meta);

    if (payload.lines.length) {
      var table = document.createElement("table");
      table.className = "summary";
      table.innerHTML =
        "<thead><tr><th>Product</th><th>Adj</th><th>Reason</th><th>Tx type</th><th>Detail</th></tr></thead>";
      var tbody = document.createElement("tbody");
      payload.lines.forEach(function (l) {
        var tr = document.createElement("tr");
        var detail = [];
        if (l.transferFrom || l.transferTo) detail.push("From " + (l.transferFrom || "?") + " → " + (l.transferTo || "?"));
        if (l.note) detail.push(l.note);
        var adjClass = (l.adjustment > 0) ? "pos" : "neg";
        var adjText = (l.adjustment > 0 ? "+" : "") + l.adjustment;
        tr.innerHTML =
          "<td>" + esc(l.product || "—") + (l.isWriteIn ? ' <span class="writein-badge">write-in</span>' : "") + "</td>" +
          '<td class="qty"><span class="chip ' + adjClass + '">' + adjText + "</span></td>" +
          "<td>" + esc(l.notation || "—") + "</td>" +
          '<td class="tx">' + esc(l.transactionType || "—") + "</td>" +
          "<td>" + esc(detail.join(" · ")) + "</td>";
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      body.appendChild(table);
    }

    $("modal").hidden = false;
    lastPayload = payload;
  }

  function metaCard(k, v) {
    var d = document.createElement("div");
    d.className = "m";
    d.innerHTML = '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div>";
    return d;
  }

  function setModalActionsEnabled(ok) {
    ["copyBtn", "mailtoBtn", "modalJsonBtn", "modalCsvBtn"].forEach(function (id) {
      $(id).disabled = !ok;
      $(id).style.opacity = ok ? "" : ".5";
      $(id).style.pointerEvents = ok ? "" : "none";
    });
  }

  function closeModal() { $("modal").hidden = true; }

  var lastPayload = null;

  // ---- Exports ---------------------------------------------------------
  function fileBase() {
    var p = lastPayload || buildPayload();
    var store = (p.storeMarketNumber || "store").replace(/[^\w.-]+/g, "_");
    return "LST_adjustments_" + store + "_" + (p.date || "");
  }

  function downloadJSON() {
    var p = lastPayload || buildPayload();
    var blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    triggerDownload(blob, fileBase() + ".json");
    toast("JSON downloaded");
  }

  function downloadCSV() {
    var p = lastPayload || buildPayload();
    var headers = ["employee", "storeMarketNumber", "date", "product", "adjustment",
                   "notation", "transactionType", "transferFrom", "transferTo", "note", "isWriteIn"];
    var rows = [headers.join(",")];
    p.lines.forEach(function (l) {
      rows.push([
        p.employee, p.storeMarketNumber, p.date, l.product, l.adjustment,
        l.notation || "", l.transactionType || "", l.transferFrom || "", l.transferTo || "",
        l.note || "", l.isWriteIn ? "yes" : "",
      ].map(csvCell).join(","));
    });
    var blob = new Blob([rows.join("\r\n")], { type: "text/csv" });
    triggerDownload(blob, fileBase() + ".csv");
    toast("CSV downloaded");
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- Text summary + mailto ------------------------------------------
  function summaryText(p) {
    var lines = [];
    lines.push("LONE STAR TAN — Month-End Inventory Adjustments");
    lines.push("Employee:   " + p.employee);
    lines.push("Store:      " + p.storeMarketNumber);
    lines.push("Date:       " + p.date + (p.isLate ? "  (LATE — after the 25th)" : ""));
    lines.push("Items:      " + p.lines.length);
    lines.push("");
    lines.push("Product                            | Adj | Reason     | Tx type   | Detail");
    lines.push("-----------------------------------+-----+------------+-----------+--------------------");
    p.lines.forEach(function (l) {
      var detail = [];
      if (l.transferFrom || l.transferTo) detail.push("from " + (l.transferFrom || "?") + " to " + (l.transferTo || "?"));
      if (l.note) detail.push(l.note);
      var adj = (l.adjustment > 0 ? "+" : "") + l.adjustment;
      lines.push(
        pad(l.product, 35) + "| " + pad(adj, 4) + "| " + pad(l.notation || "", 11) +
        "| " + pad(l.transactionType || "", 10) + "| " + detail.join("; ")
      );
    });
    return lines.join("\n");
  }

  function copySummary() {
    var p = lastPayload || buildPayload();
    var text = summaryText(p);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Summary copied"); },
        function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Summary copied"); }
    catch (e) { toast("Copy failed — select manually"); }
    document.body.removeChild(ta);
  }

  function openMailto() {
    var p = lastPayload || buildPayload();
    var subject = "Inventory Adjustments — " + p.storeMarketNumber + " — " + p.date;
    var body = summaryText(p) +
      "\n\n(Attach the downloaded JSON/CSV for bulk processing.)";
    var href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    window.location.href = href;
  }

  // ---- Helpers ---------------------------------------------------------
  function toISODate(d) {
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }
  function isLate(dateStr) {
    if (!dateStr) return false;
    var parts = dateStr.split("-");
    if (parts.length !== 3) return false;
    return parseInt(parts[2], 10) > DUE_DAY;
  }
  function updateLateHint() {
    var v = $("date").value;
    var hint = $("lateHint");
    var pill = $("duePill");
    if (isLate(v)) {
      hint.hidden = false;
      hint.className = "hint warn";
      hint.textContent = "After the 25th — flagged as a late submission.";
      pill.classList.add("late");
      pill.textContent = "Late (after the 25th)";
    } else {
      hint.hidden = true;
      pill.classList.remove("late");
      pill.textContent = "Due by the 25th";
    }
  }
  function highlight(text, q) {
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q);
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) +
      "</mark>" + esc(text.slice(i + q.length));
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function pad(s, n) {
    s = String(s == null ? "" : s);
    if (s.length >= n) return s.slice(0, n - 1) + " ";
    return s + " ".repeat(n - s.length);
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  // ---- Go --------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
