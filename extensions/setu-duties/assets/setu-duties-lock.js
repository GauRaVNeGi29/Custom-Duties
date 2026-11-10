/*
 * Setu import duties – checkout lock and cart-drawer mounting.
 *
 * Until the customer picks a shipping destination in the duty widget, the
 * cart's checkout buttons stay visible but cannot be used. Picking any
 * country (including "Other country") unlocks them.
 *
 * Also asks the Bucks currency converter to convert the widget's amounts.
 *
 * Works alongside other checkout restrictions (e.g. Webkul minimum order
 * value): it blocks clicks and submits itself and never changes a button's
 * `disabled` state, so it can neither undo nor be undone by another app.
 *
 * Fails open: if the widget cannot load or has nothing configured, or no
 * answer arrives within 10 seconds, checkout is never blocked.
 */
(function () {
  "use strict";
  if (window.__setuLock) return;
  window.__setuLock = true;

  var DEFAULT_SELECTOR = [
    'button[name="checkout"]', 'input[name="checkout"]', "#checkout", ".cart__checkout-button",
    'a[href$="/checkout"]', 'a[href*="/checkout?"]',
  ].join(",");
  // Shop Pay / PayPal / Google Pay buttons shown in the cart
  var EXPRESS = ".additional-checkout-buttons,.cart__dynamic-checkout-buttons,shopify-accelerated-checkout-cart,.dynamic-checkout__content";
  var FAIL_OPEN_MS = 10000;

  var locked = true;
  var decided = false;
  var scheduled = false;

  /** Settings come from the widget block (or the drawer embed's template). */
  function settings() {
    var root = document.querySelector("[data-setu-duties]");
    if (!root) {
      var tpl = document.querySelector("template[data-setu-duties-drawer]");
      root = tpl && tpl.content.querySelector("[data-setu-duties]");
    }
    if (!root) return null;
    var labels = {};
    try { labels = JSON.parse(root.querySelector("script[data-setu-labels]").textContent); } catch (e) { /* defaults */ }
    return {
      enabled: root.getAttribute("data-require-destination") === "true",
      selector: root.getAttribute("data-checkout-selector") || DEFAULT_SELECTOR,
      hint: labels.lockHint || "Select your shipping destination above to continue to checkout.",
    };
  }

  function lockNow() {
    var s = settings();
    return !!s && s.enabled && locked;
  }

  function apply() {
    scheduled = false;
    mountDrawers();
    var s = settings();
    var on = !!s && s.enabled && locked;
    var buttons = s ? safeAll(s.selector) : [];
    var express = safeAll(EXPRESS);

    // The lock never touches the button's own `disabled` state, so other apps
    // that disable checkout (e.g. Webkul minimum order value) keep full control:
    // checkout works only when every one of them allows it.
    buttons.forEach(function (b) {
      if (on) {
        b.classList.add("setu-locked");
        b.setAttribute("data-setu-locked", "");
      } else if (b.hasAttribute("data-setu-locked")) {
        b.classList.remove("setu-locked");
        b.removeAttribute("data-setu-locked");
      }
    });
    express.forEach(function (x) { x.classList.toggle("setu-locked", on); });
    if (on) {
      // one hint, under the first visible checkout button
      var first = buttons.filter(function (b) { return b.offsetParent !== null && !b.closest(EXPRESS); })[0];
      if (first) addHint(first, s.hint);
    }
    if (!on) document.querySelectorAll("[data-setu-hint]").forEach(function (h) { h.remove(); });
  }

  function safeAll(selector) {
    try { return Array.prototype.slice.call(document.querySelectorAll(selector)); } catch (e) { return []; }
  }

  function addHint(button, text) {
    var next = button.nextElementSibling;
    if (next && next.hasAttribute("data-setu-hint")) return;
    document.querySelectorAll("[data-setu-hint]").forEach(function (h) { h.remove(); });
    var p = document.createElement("p");
    p.className = "setu-checkout-hint";
    p.setAttribute("data-setu-hint", "");
    p.setAttribute("role", "status");
    p.textContent = text;
    button.insertAdjacentElement("afterend", p);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(apply);
  }

  function focusSelector() {
    var select = document.querySelector(".setu-duties__select");
    if (!select) return;
    select.scrollIntoView({ behavior: "smooth", block: "center" });
    try { select.focus({ preventScroll: true }); } catch (e) { select.focus(); }
  }

  // Backstop for themes that re-enable buttons or submit by script
  document.addEventListener("click", function (e) {
    if (!lockNow()) return;
    var s = settings();
    var hit = e.target.closest && (e.target.closest(s.selector) || e.target.closest(EXPRESS));
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    focusSelector();
  }, true);
  document.addEventListener("submit", function (e) {
    if (!lockNow()) return;
    var submitter = e.submitter;
    var toCheckout = (submitter && submitter.name === "checkout") || /\/checkout/.test(e.target.getAttribute("action") || "");
    if (!toCheckout) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    focusSelector();
  }, true);

  // Bucks Currency Converter scans prices once on page load; ask it to convert
  // the widget's new amounts after every render (they use the store's money format).
  function reconvertCurrency() {
    try {
      var bucks = window.bucksCC;
      if (bucks && typeof bucks.reConvert === "function") bucks.reConvert();
      else if (bucks && typeof bucks.rerender === "function") bucks.rerender();
    } catch (e) { /* converter not ready */ }
  }

  // The duty widget reports its state after every render
  document.addEventListener("setu-duties:rendered", function (e) {
    reconvertCurrency();
    var d = e.detail || {};
    if (!d.ready && !d.unlock) return;
    decided = true;
    locked = !(d.unlock || d.destination);
    schedule();
  });
  setTimeout(function () {
    if (!decided) { locked = false; schedule(); }
  }, FAIL_OPEN_MS);

  // Cart drawer embed: insert the widget before the configured element
  function mountDrawers() {
    document.querySelectorAll("template[data-setu-duties-drawer]").forEach(function (tpl) {
      var selector = tpl.getAttribute("data-selector");
      if (!selector) return;
      var target;
      try { target = document.querySelector(selector); } catch (e) { return; }
      var prev = target && target.previousElementSibling;
      if (!target || (prev && (prev.hasAttribute("data-setu-duties") || prev.hasAttribute("data-setu-hint")))) return;
      target.parentNode.insertBefore(tpl.content.cloneNode(true), target);
    });
  }

  function start() {
    schedule();
    new MutationObserver(schedule).observe(document.body, {
      childList: true, subtree: true,
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
