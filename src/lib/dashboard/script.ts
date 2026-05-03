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
      if (all || el.getAttribute("data-project") === id) {
        el.classList.remove("gone");
      } else {
        el.classList.add("gone");
      }
    });
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
