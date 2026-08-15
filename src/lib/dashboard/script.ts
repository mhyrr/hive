/**
 * Inline JS for the dashboard. Vanilla only — no imports, no runtime deps.
 *
 * Responsibilities (v2):
 *   1. Archive-day click swaps the active briefing `<article>`.
 *   2. Inbox/ticket-group toggles (state persisted to localStorage).
 *   3. Project filter pills (localStorage + URL hash).
 *   4. Per-project <details> collapse persistence.
 *   5. Needs-Action toggle.
 *   6. Keyboard navigation (j/k/x/d/p/`/`).
 *   7. Action buttons with two-step confirm, optimistic DOM update,
 *      POST + fragment re-render, snackbar feedback.
 */

export const DASHBOARD_JS = `
(function () {
  var LS_KEY = "hive-dash.v2";
  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ---------- Snackbar ----------
  function toast(msg, kind) {
    var el = document.getElementById("snackbar");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("err");
    if (kind === "err") el.classList.add("err");
    el.classList.add("visible");
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.classList.remove("visible"); }, 3000);
  }

  // ---------- Archive click swap (in-page) ----------
  function activateBriefing(date) {
    document.querySelectorAll("[data-briefing-date]").forEach(function (a) {
      if (a.getAttribute("data-briefing-date") === date) a.classList.add("active");
      else a.classList.remove("active");
    });
    document.querySelectorAll("[data-archive-card]").forEach(function (a) {
      if (a.getAttribute("data-archive-card") === date) a.classList.add("active");
      else a.classList.remove("active");
    });
  }

  // Anchor archive cards go to /archive/:date in a new tab, so we don't
  // intercept clicks — but if a frozen snapshot is opened, cards have
  // href="#" and we fall back to in-page briefing swap.
  document.querySelectorAll("a.archive-card[href='#']").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var date = a.getAttribute("data-archive-card");
      if (date) activateBriefing(date);
    });
  });

  // ---------- Inbox body toggles ----------
  function wireToggle(el) {
    var targetId = el.getAttribute("data-toggle");
    var target = document.getElementById(targetId);
    if (!target) return;
    var key = "collapse:" + targetId;
    if (state[key]) {
      target.style.display = "none";
      el.textContent = el.getAttribute("data-show") || "Show";
    }
    el.addEventListener("click", function () {
      var hidden = target.style.display === "none";
      if (hidden) {
        target.style.display = "";
        el.textContent = el.getAttribute("data-hide") || "Hide";
        delete state[key];
      } else {
        target.style.display = "none";
        el.textContent = el.getAttribute("data-show") || "Show";
        state[key] = true;
      }
      saveState();
    });
  }
  document.querySelectorAll(".toggle[data-toggle]").forEach(wireToggle);

  // ---------- Project filter (pills + URL hash + localStorage) ----------
  function readHashFilter() {
    var m = (window.location.hash || "").match(/#project=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function activeFilter() {
    return readHashFilter() || state.filter || "ALL";
  }
  var baseTitle = document.title;
  function applyFilter(id) {
    var all = id === "ALL";
    document.querySelectorAll("[data-project]").forEach(function (el) {
      // Colonies are the filter control, not filtered content: hiding the
      // yard would remove the only way back out of the filter.
      if (el.classList.contains("colony")) {
        if (!all && el.getAttribute("data-project") === id) el.classList.add("colony--selected");
        else el.classList.remove("colony--selected");
        return;
      }
      if (all || el.getAttribute("data-project") === id) {
        el.classList.remove("gone");
      } else {
        el.classList.add("gone");
      }
    });
    var yard = document.getElementById("section-yard");
    if (yard) yard.classList.toggle("filtering", !all);
    document.querySelectorAll("[data-project-filter]").forEach(function (p) {
      if (p.getAttribute("data-project-filter") === id) p.classList.add("pill--active");
      else p.classList.remove("pill--active");
    });
    var banner = document.getElementById("filter-banner");
    if (banner) {
      if (all) {
        banner.classList.remove("visible");
        banner.textContent = "";
      } else {
        banner.classList.add("visible");
        banner.innerHTML = "FILTERING \u2192 <strong>" + id + "</strong> \u00B7 <button type='button' class='filter-clear' data-project-filter='ALL'>clear</button>";
        var clearBtn = banner.querySelector(".filter-clear");
        if (clearBtn) clearBtn.addEventListener("click", function () { setFilter("ALL"); });
      }
    }
    document.title = all ? baseTitle : baseTitle.replace(/^HIVE/, "HIVE \u00B7 " + id);
  }
  function setFilter(id) {
    state.filter = id;
    saveState();
    if (id === "ALL") {
      if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
    } else {
      history.replaceState(null, "", "#project=" + encodeURIComponent(id));
    }
    applyFilter(id);
  }

  document.querySelectorAll("[data-project-filter]").forEach(function (p) {
    p.addEventListener("click", function () {
      var id = p.getAttribute("data-project-filter");
      if (id) setFilter(id);
    });
  });
  // The yard is the project filter. Clicking a colony narrows the page to it;
  // clicking the selected one again clears, so the control is its own escape.
  document.querySelectorAll(".colony[data-project]").forEach(function (c) {
    c.addEventListener("click", function () {
      var id = c.getAttribute("data-project");
      if (!id) return;
      setFilter(activeFilter() === id ? "ALL" : id);
    });
  });
  // The shortcut button in each project <summary>
  document.querySelectorAll("[data-project-filter-shortcut]").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = b.getAttribute("data-project-filter-shortcut");
      if (id) setFilter(id);
    });
  });
  applyFilter(activeFilter());

  // Hashchange: refilter when the user edits the URL hash directly.
  window.addEventListener("hashchange", function () {
    applyFilter(activeFilter());
  });

  // ---------- Needs-Action toggle ----------
  var needsBtn = document.querySelector("[data-needs-action-toggle]");
  if (needsBtn) {
    if (state.needsActionOnly) {
      document.body.classList.add("filtered-by-actions");
      needsBtn.setAttribute("aria-pressed", "true");
    }
    needsBtn.addEventListener("click", function () {
      var on = !document.body.classList.contains("filtered-by-actions");
      document.body.classList.toggle("filtered-by-actions", on);
      needsBtn.setAttribute("aria-pressed", on ? "true" : "false");
      state.needsActionOnly = on;
      saveState();
    });
  }

  // ---------- Action buttons ----------
  var actionRoutes = {
    "ticket-start":        { path: "ticket/start",        section: "tickets", build: function (btn) { return { id: btn.getAttribute("data-id"), project: btn.getAttribute("data-project") }; } },
    "ticket-close":        { path: "ticket/close",        section: "tickets", build: idProj, optimistic: fadeRow },
    "ticket-reopen":       { path: "ticket/reopen",       section: "tickets", build: idProj },
    "ticket-note":         { path: "ticket/note",         section: "tickets", build: idProjPrompt("note to add") },
    "ticket-dispatch-run": { path: "ticket/dispatch-run", section: "runs",    build: idProj },
    "ticket-tag-dispatch": { path: "ticket/tag-dispatch", section: "tickets", build: idProj },
    "dispatch-kill":       { path: "dispatch/kill",       section: "runs",    build: runIdFromBtn, optimistic: fadeRow },
    "dispatch-override":   { path: "dispatch/override-status", section: "runs",
                             build: function (btn) {
                               var status = window.prompt("Override to (complete / partial / failed):", "complete");
                               if (!status) return null;
                               return { runId: btn.getAttribute("data-run-id"), status: status.trim() };
                             } },
    "inbox-promote":       { path: "ticket/create", section: "inboxes",
                             build: function (btn) {
                               var body = btn.closest(".inbox-entry").querySelector("[data-inbox-body]");
                               var first = body ? (body.innerText.trim().split("\\n")[0] || "from inbox") : "from inbox";
                               return { project: btn.getAttribute("data-project"), title: first.slice(0, 80) };
                             } },
    "inbox-dispatch":      { path: "dispatch", section: "runs",
                             build: function (btn) {
                               var body = btn.closest(".inbox-entry").querySelector("[data-inbox-body]");
                               return { project: btn.getAttribute("data-project"), goal: (body ? body.innerText.trim() : "") };
                             } },
    "inbox-ack":           { path: "inbox/ack", section: "inboxes",
                             build: function (btn) {
                               var body = btn.closest(".inbox-entry").querySelector("[data-inbox-body]");
                               return { project: btn.getAttribute("data-project"), entry: (body ? body.innerText.trim() : "") };
                             },
                             optimistic: fadeRow },
  };

  function idProj(btn) {
    return { id: btn.getAttribute("data-id"), project: btn.getAttribute("data-project") };
  }
  function idProjPrompt(label) {
    return function (btn) {
      var note = window.prompt(label + ":");
      if (!note) return null;
      return { id: btn.getAttribute("data-id"), project: btn.getAttribute("data-project"), note: note };
    };
  }
  function runIdFromBtn(btn) {
    return { runId: btn.getAttribute("data-run-id") };
  }
  function fadeRow(btn) {
    var row = btn.closest(".ticket-row, .dispatch-row, .inbox-entry");
    if (row) row.classList.add("pending");
    return function revert() { if (row) row.classList.remove("pending"); };
  }

  function wireAction(btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var actionName = btn.getAttribute("data-action");
      var route = actionRoutes[actionName];
      if (!route) return;

      // Two-step confirm for destructive.
      if (btn.getAttribute("data-confirm") === "true" && btn.getAttribute("aria-pressed") !== "true") {
        btn.setAttribute("aria-pressed", "true");
        var originalText = btn.textContent;
        btn.textContent = "[ click again ]";
        setTimeout(function () {
          if (btn.getAttribute("aria-pressed") === "true") {
            btn.removeAttribute("aria-pressed");
            btn.textContent = originalText;
          }
        }, 3000);
        return;
      }
      btn.removeAttribute("aria-pressed");

      var payload;
      try { payload = route.build(btn); } catch (err) { toast(String(err), "err"); return; }
      if (payload == null) return; // user cancelled a prompt

      var revert = route.optimistic ? route.optimistic(btn) : null;

      fetch("/action/" + route.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false, error: "non-JSON response" }; })
          .then(function (body) { return { status: res.status, body: body }; });
      }).then(function (out) {
        if (!out.body.ok) {
          toast(out.body.error || ("error " + out.status), "err");
          if (revert) revert();
          return;
        }
        toast(out.body.message || "done");
        if (route.section) {
          return fetch("/fragment/" + route.section).then(function (r) { return r.text(); })
            .then(function (html) {
              var sec = document.getElementById("section-" + route.section);
              if (sec) {
                sec.outerHTML = html;
                // Re-wire action buttons + toggles in the new HTML.
                rewireDynamic(document.getElementById("section-" + route.section));
                applyFilter(activeFilter());
              }
            });
        }
      }).catch(function (err) {
        toast(String(err), "err");
        if (revert) revert();
      });
    });
  }

  function rewireDynamic(root) {
    if (!root) return;
    root.querySelectorAll(".toggle[data-toggle]").forEach(wireToggle);
    root.querySelectorAll(".action[data-action]").forEach(wireAction);
  }

  document.querySelectorAll(".action[data-action]").forEach(wireAction);

  // ---------- Tickets-page card expand/collapse ----------
  function ticketCardKey(card) {
    var id = card.getAttribute("data-ticket-id") || "";
    var proj = card.getAttribute("data-project") || "";
    return "card-expanded:" + proj + "/" + id;
  }

  function setCardExpanded(card, expanded) {
    var body = card.querySelector(".card-body");
    if (!body) return; // no body content to toggle
    if (expanded) {
      card.classList.add("expanded");
      body.removeAttribute("hidden");
      card.setAttribute("aria-expanded", "true");
      state[ticketCardKey(card)] = 1;
    } else {
      card.classList.remove("expanded");
      body.setAttribute("hidden", "");
      card.setAttribute("aria-expanded", "false");
      delete state[ticketCardKey(card)];
    }
    saveState();
  }

  function wireTicketCard(card) {
    if (!card.querySelector(".card-body")) return; // nothing to expand
    // Restore prior state
    if (state[ticketCardKey(card)]) setCardExpanded(card, true);

    card.addEventListener("click", function (e) {
      // Don't toggle when clicking inside the body itself (so links/text
      // selection in the body work normally).
      var t = e.target;
      while (t && t !== card) {
        if (t.classList && t.classList.contains("card-body")) return;
        t = t.parentNode;
      }
      setCardExpanded(card, !card.classList.contains("expanded"));
    });

    card.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setCardExpanded(card, !card.classList.contains("expanded"));
      }
    });
  }

  document.querySelectorAll(".ticket-card[role='button']").forEach(wireTicketCard);

  // ---------- Epic-board head expand/collapse ----------
  function epicBoardKey(board) {
    var id = board.getAttribute("data-epic-id") || "";
    var proj = board.getAttribute("data-project") || "";
    return "epic-expanded:" + proj + "/" + id;
  }

  function setBoardExpanded(board, expanded) {
    var body = board.querySelector(":scope > .epic-body");
    var head = board.querySelector(":scope > .board-head");
    if (!body || !head) return;
    if (expanded) {
      board.classList.add("expanded");
      body.removeAttribute("hidden");
      head.setAttribute("aria-expanded", "true");
      state[epicBoardKey(board)] = 1;
    } else {
      board.classList.remove("expanded");
      body.setAttribute("hidden", "");
      head.setAttribute("aria-expanded", "false");
      delete state[epicBoardKey(board)];
    }
    saveState();
  }

  function wireEpicBoard(board) {
    var head = board.querySelector(":scope > .board-head[role='button']");
    if (!head) return;
    if (state[epicBoardKey(board)]) setBoardExpanded(board, true);

    head.addEventListener("click", function () {
      setBoardExpanded(board, !board.classList.contains("expanded"));
    });
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setBoardExpanded(board, !board.classList.contains("expanded"));
      }
    });
  }

  document.querySelectorAll(".epic-board").forEach(wireEpicBoard);

  // ---------- Arc card expand/collapse ----------
  function arcCardKey(card) {
    // Support both id-based (goal arcs) and data-arc-id (campaign arcs)
    var id = card.getAttribute("data-arc-id") || card.id || "";
    return "arc-expanded:" + id;
  }

  function setArcExpanded(card, expanded) {
    var body = card.querySelector(":scope > .arc-body");
    var header = card.querySelector(":scope > .arc-header");
    var glyph = card.querySelector(":scope > .arc-header .arc-expand");
    if (!body || !header) return;
    if (expanded) {
      card.classList.add("expanded");
      header.setAttribute("aria-expanded", "true");
      if (glyph) glyph.textContent = "−"; // minus sign
      state[arcCardKey(card)] = 1;
    } else {
      card.classList.remove("expanded");
      header.setAttribute("aria-expanded", "false");
      if (glyph) glyph.textContent = "+";
      delete state[arcCardKey(card)];
    }
    saveState();
  }

  function wireArcCard(card) {
    var header = card.querySelector(":scope > .arc-header");
    if (!header) return;

    // Restore persisted state
    if (state[arcCardKey(card)]) setArcExpanded(card, true);

    header.addEventListener("click", function (e) {
      // Don't toggle when clicking links inside the header
      if (e.target.closest && e.target.closest("a")) return;
      setArcExpanded(card, !card.classList.contains("expanded"));
    });
    header.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setArcExpanded(card, !card.classList.contains("expanded"));
      }
    });
  }

  document.querySelectorAll(".arc-card").forEach(wireArcCard);

  // ---------- Why-failed expand/collapse ----------
  function wireWhyFailed(el) {
    el.addEventListener("click", function (e) {
      el.classList.toggle("expanded");
      var toggle = el.querySelector(".why-failed-toggle");
      if (toggle) toggle.textContent = el.classList.contains("expanded") ? "click to collapse" : "click to expand";
    });
  }
  document.querySelectorAll("[data-why-failed]").forEach(wireWhyFailed);

  function wireWhyFailedInline(el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      el.classList.toggle("expanded");
    });
  }
  document.querySelectorAll("[data-why-failed-inline]").forEach(wireWhyFailedInline);

  // ---------- Keyboard ----------
  var focusables = function () { return Array.prototype.slice.call(document.querySelectorAll(".ticket-row, .dispatch-row, .inbox-entry:not(.empty)")); };
  var focusIdx = -1;

  function moveFocus(delta) {
    var list = focusables().filter(function (el) { return !el.classList.contains("gone"); });
    if (list.length === 0) return;
    focusIdx = Math.max(0, Math.min(list.length - 1, focusIdx + delta));
    list.forEach(function (el, i) { el.classList.toggle("focused", i === focusIdx); });
    list[focusIdx].scrollIntoView({ block: "nearest" });
  }

  function focusedAction(name) {
    var list = focusables();
    if (focusIdx < 0 || focusIdx >= list.length) return;
    var btn = list[focusIdx].querySelector("[data-action='" + name + "']");
    if (btn) btn.click();
  }

  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "j": moveFocus(+1); break;
      case "k": moveFocus(-1); break;
      case "x": focusedAction("ticket-close"); break;
      case "d":
        focusedAction("ticket-dispatch-run") ||
        focusedAction("inbox-dispatch");
        break;
      case "p":
        focusedAction("inbox-promote") ||
        focusedAction("memory-promote");
        break;
      case "/": {
        var pill = document.querySelector("[data-project-filter='ALL']");
        if (pill) { pill.focus(); e.preventDefault(); }
        break;
      }
      default: return;
    }
  });
})();
`;
