/**
 * Inline JS for the dashboard. Vanilla only — no imports, no runtime deps.
 *
 * Responsibilities:
 *   1. Archive-day click swaps the active briefing `<article>`.
 *   2. Inbox "show more"/"show less" toggles (state persisted to localStorage).
 *   3. Ticket-group collapse toggles (state persisted to localStorage).
 */

export const DASHBOARD_JS = `
(function () {
  var LS_KEY = "hive-dashboard-v1";

  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (e) { return {}; }
  }
  function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* noop */ }
  }

  var state = loadState();

  // ---------- Archive ----------
  function activateBriefing(date) {
    var articles = document.querySelectorAll("[data-briefing-date]");
    var found = false;
    for (var i = 0; i < articles.length; i++) {
      if (articles[i].getAttribute("data-briefing-date") === date) {
        articles[i].classList.add("active");
        found = true;
      } else {
        articles[i].classList.remove("active");
      }
    }
    var cards = document.querySelectorAll("[data-archive-card]");
    for (var j = 0; j < cards.length; j++) {
      if (cards[j].getAttribute("data-archive-card") === date) {
        cards[j].classList.add("active");
      } else {
        cards[j].classList.remove("active");
      }
    }
    if (found) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  document.querySelectorAll("[data-archive-card]").forEach(function (el) {
    el.addEventListener("click", function () {
      var date = el.getAttribute("data-archive-card");
      activateBriefing(date);
    });
  });

  // ---------- Toggles (inbox, ticket groups) ----------
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
      saveState(state);
    });
  }

  document.querySelectorAll(".toggle[data-toggle]").forEach(wireToggle);
})();
`;
