/*
 * Setu import duties – cart widget.
 *
 * Reads the cart from /cart.js, sends it with the chosen destination to the
 * app (signed app proxy /apps/setu-duties), and shows the breakdown.
 * Display only: it never adds anything to the cart or checkout total.
 *
 * Amounts are rendered with the shop's money format inside <span class="money">
 * so currency converters such as Bucks convert them like other cart prices.
 */
(function () {
  "use strict";
  if (window.__setuDuties) return;
  window.__setuDuties = true;

  var PROXY = "/apps/setu-duties";
  var ATTR = "_setu_destination";
  var OTHER = "OTHER"; // "Other country": no estimate, but checkout is allowed
  var STORE_KEY = "setu_duties_destination";
  var CART_RE = /\/cart\/(add|change|update|clear)(\.js|\.json)?(\?|$)/;
  var DEBOUNCE_MS = 300;

  var origFetch = window.fetch.bind(window);
  var state = {
    config: null,        // { destinations, settings }
    cart: null,
    destination: null,
    result: null,
    error: null,
    loading: false,
    moneyFormat: "{{amount}}",
    initDone: false,
  };
  var L = {};
  var C = "setu-duties__"; // CSS class prefix
  var timer = null;
  var controller = null;
  var requestSeq = 0;

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Shopify money format placeholders: [decimals, thousands, decimal mark]
  var FORMATS = {
    amount: [2, ",", "."], amount_no_decimals: [0, ",", "."],
    amount_with_comma_separator: [2, ".", ","], amount_no_decimals_with_comma_separator: [0, ".", ","],
    amount_with_apostrophe_separator: [2, "'", "."], amount_with_space_separator: [2, " ", ","],
    amount_no_decimals_with_space_separator: [0, " ", ","], amount_with_period_and_space_separator: [2, " ", "."],
  };
  function formatMoney(cents) {
    var format = String(state.moneyFormat || "{{amount}}").replace(/<[^>]*>/g, "");
    return format.replace(/\{\{\s*(\w+)\s*\}\}/, function (_, key) {
      var f = FORMATS[key] || FORMATS.amount;
      var parts = (cents / 100).toFixed(f[0]).split(".");
      return parts[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + f[1]) + (parts[1] ? f[2] + parts[1] : "");
    });
  }

  /** "830.00" (major units from the app) -> <span class="money">₹830.00</span> */
  function money(amount) {
    var cents = Math.round(parseFloat(amount) * 100);
    return el("span", { class: "money", text: formatMoney(cents) });
  }

  function storageGet() { try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function storageSet(v) { try { window.localStorage.setItem(STORE_KEY, v); } catch (e) { /* private mode */ } }

  function roots() { return Array.prototype.slice.call(document.querySelectorAll("[data-setu-duties]")); }

  function rateLabel(row) {
    if (row.chargeType === "percentage") return row.ratePercent === "varies" ? "rate varies by item" : row.ratePercent + "%";
    if (row.scope === "per_cart") return "fixed, per shipment";
    if (row.scope === "per_unit") return "fixed, per item";
    if (row.scope === "per_line") return "fixed, per line";
    return "fixed";
  }

  // ---------------------------------------------------------------- render
  function render() {
    roots().forEach(renderRoot);
    notifyConverters();
  }

  function renderRoot(root) {
    root.setAttribute("data-setu-ready", "true");
    var heading = root.getAttribute("data-heading") || L.heading;
    var openDetail = root.getAttribute("data-open-detail") === "true";
    var r = state.result;
    var dests = (state.config && state.config.destinations) || [];

    // hide entirely when nothing is configured or the cart is empty
    if (state.config && dests.length === 0) { root.hidden = true; return; }
    if (state.cart && state.cart.item_count === 0) { root.hidden = true; return; }
    root.hidden = false;

    var keep = root.querySelectorAll("script");
    root.innerHTML = "";
    Array.prototype.forEach.call(keep, function (k) { root.appendChild(k); });
    root.classList.toggle("is-loading", !!state.loading);
    root.setAttribute("aria-busy", state.loading ? "true" : "false");

    var selectId = "setu-dest-" + Math.random().toString(36).slice(2, 8);
    var select = el("select", { id: selectId, class: C + "select" }, [
      el("option", { value: "", text: L.select }),
    ]);
    dests.forEach(function (d) {
      var opt = el("option", { value: d.code, text: d.name });
      if (d.code === state.destination) opt.selected = true;
      select.appendChild(opt);
    });
    if (dests.length && root.getAttribute("data-allow-other") === "true") {
      select.appendChild(el("option", { value: OTHER, text: L.other, selected: state.destination === OTHER ? "selected" : null }));
    }
    select.addEventListener("change", function () { setDestination(select.value || null); });

    var body = el("div", { class: C + "body", "aria-live": "polite" });
    root.appendChild(el("div", { class: C + "head" }, [el("h3", { class: C + "title", text: heading })]));
    root.appendChild(el("div", { class: C + "field" }, [
      el("label", { for: selectId, class: C + "label", text: L.destination }),
      select,
    ]));
    root.appendChild(body);

    if (state.error) {
      body.appendChild(el("p", { class: C + "note", text: L.unavailable }));
      return;
    }
    if (!state.destination) {
      body.appendChild(el("p", { class: C + "note", text: L.choose }));
      return;
    }
    if (state.destination === OTHER) {
      body.appendChild(el("p", { class: C + "note", text: L.otherNote }));
      return;
    }
    if (!r) {
      body.appendChild(el("p", { class: C + "note", text: L.calculating }));
      return;
    }

    var table = el("dl", { class: C + "rows" });
    function row(label, valueNode, cls, meta) {
      table.appendChild(el("div", { class: C + "row" + (cls ? " " + cls : "") }, [
        el("dt", null, [label, meta ? el("span", { class: C + "meta", text: meta }) : null]),
        el("dd", null, [valueNode]),
      ]));
    }
    row(L.subtotal, money(r.subtotal));
    r.summary.forEach(function (s) { row(s.name, money(s.amount), s.chargeType === "fixed" ? "is-fixed" : "", rateLabel(s)); });
    if (r.summary.length === 0) {
      table.appendChild(el("div", { class: C + "row is-empty" }, [el("dt", { text: L.none })]));
    }
    var partial = r.status === "partial";
    row(partial ? L.totalPartial : L.total, money(r.totalCharges), "is-total");
    if (!partial && r.showLandedCost !== false) row(L.landed, money(r.landedCost), "is-landed");
    body.appendChild(table);

    if (partial && r.issues.length) {
      var list = el("ul", { class: C + "issues" });
      var unavailable = [];
      r.issues.forEach(function (i) {
        if (i.type === "missing_hsn" || i.type === "no_profile" || i.type === "no_active_components") unavailable = unavailable.concat(i.productTitles);
        else list.appendChild(el("li", { text: i.message }));
      });
      if (unavailable.length) {
        list.insertBefore(el("li", { text: L.notCovered + (r.destinationName || r.destination) + ": " + unique(unavailable).join(", ") }), list.firstChild);
      }
      body.appendChild(el("div", { class: C + "partial" }, [
        el("p", { class: C + "partial-title", text: L.partial }), list,
      ]));
    }
    if (r.currencyNote) body.appendChild(el("p", { class: C + "note", text: r.currencyNote.message }));

    if (r.groups.length > 1 || (r.groups.length === 1 && r.groups[0].lines.length > 1)) {
      var details = el("details", { class: C + "detail" });
      if (openDetail) details.open = true;
      details.appendChild(el("summary", { text: L.detail }));
      r.groups.forEach(function (g) {
        var box = el("div", { class: C + "group" });
        box.appendChild(el("p", { class: C + "group-title" }, [
          "HSN " + g.hsn + (g.hsnDescription ? " · " + g.hsnDescription : "") + " · value ", money(g.value),
        ]));
        var gl = el("dl", { class: C + "rows is-compact" });
        g.components.forEach(function (c) {
          var label = c.name + (c.chargeType === "percentage" ? " (" + c.ratePercent + "%)" : c.multiplier > 1 ? " (" + c.multiplier + " ×)" : "");
          gl.appendChild(el("div", { class: C + "row" }, [el("dt", { text: label }), el("dd", null, [money(c.amount)])]));
        });
        box.appendChild(gl);
        box.appendChild(el("p", { class: C + "group-items", text: g.lines.map(function (l) {
          return l.productTitle + (l.variantTitle ? " – " + l.variantTitle : "") + " × " + l.quantity;
        }).join(", ") }));
        details.appendChild(box);
      });
      body.appendChild(details);
    }

    var disclaimer = r.disclaimer || (state.config && state.config.settings && state.config.settings.disclaimer);
    if (disclaimer) body.appendChild(el("p", { class: C + "disclaimer", text: disclaimer }));
  }

  function unique(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  /** Tells converters (e.g. Bucks) and the checkout lock that the widget changed. */
  function notifyConverters() {
    var c = state.config;
    try {
      document.dispatchEvent(new CustomEvent("setu-duties:rendered", { bubbles: true, detail: {
        destination: state.destination, ready: state.initDone,
        // never keep checkout locked when the estimate cannot be shown
        unlock: !!state.error || !!(c && !c.destinations.length),
      } }));
    } catch (e) { /* old browser */ }
  }

  // ---------------------------------------------------------------- data
  function getJSON(url) {
    return origFetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error(url + " " + res.status);
      return res.json();
    });
  }

  function loadConfig() {
    if (state.config) return Promise.resolve(state.config);
    return getJSON(PROXY + "/destinations").then(function (c) { state.config = c; return c; });
  }

  function chooseInitialDestination() {
    var codes = state.config.destinations.map(function (d) { return d.code; });
    codes.push(OTHER); // only ever stored when the option was offered
    var s = state.config.settings || {};
    var root = roots()[0];
    var candidates = [
      state.cart && state.cart.attributes ? state.cart.attributes[ATTR] : null,
      storageGet(),
      s.prefillFromCustomer && root ? root.getAttribute("data-customer-country") : null,
      // storefront market country can come from IP geolocation: only when enabled in admin
      s.prefillFromMarketCountry && root ? root.getAttribute("data-market-country") : null,
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && codes.indexOf(candidates[i]) !== -1) return candidates[i];
    }
    return null;
  }

  function setDestination(code) {
    state.destination = code;
    state.result = null;
    if (code) storageSet(code);
    render();
    // remember on the cart (hidden attribute, also visible on the order); own request is not intercepted
    origFetch("/cart/update.js", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ attributes: (function () { var a = {}; a[ATTR] = code || ""; return a; })() }),
    }).catch(function () {});
    refresh(true);
  }

  function cartDiscount(cart) {
    return (cart.cart_level_discount_applications || []).reduce(function (sum, d) {
      return sum + (d.total_allocated_amount || 0);
    }, 0);
  }

  function calculate() {
    if (!state.destination || state.destination === OTHER || !state.cart || state.cart.item_count === 0) { state.result = null; state.loading = false; render(); return Promise.resolve(); }
    if (controller) controller.abort();
    controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var seq = ++requestSeq;
    var payload = {
      destination: state.destination,
      currency: state.cart.currency,
      cart_discount: cartDiscount(state.cart),
      lines: state.cart.items.map(function (i) {
        return {
          key: i.key, variant_id: i.variant_id, product_id: i.product_id,
          product_title: i.product_title, variant_title: i.variant_title,
          quantity: i.quantity, final_line_price: i.final_line_price, original_line_price: i.original_line_price,
        };
      }),
    };
    return origFetch(PROXY + "/calculate", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      if (!res.ok) throw new Error("calculate " + res.status);
      return res.json();
    }).then(function (result) {
      if (seq !== requestSeq) return;
      state.result = result; state.error = null; state.loading = false; render();
    }).catch(function (e) {
      if (e && e.name === "AbortError") return;
      if (seq !== requestSeq) return;
      state.error = e; state.loading = false; render();
    });
  }

  function refresh(immediate) {
    clearTimeout(timer);
    state.loading = true;
    roots().forEach(function (r) { r.classList.add("is-loading"); });
    timer = setTimeout(function () {
      Promise.all([loadConfig(), getJSON("/cart.js")]).then(function (res) {
        state.cart = res[1];
        if (!state.initDone) {
          state.initDone = true;
          state.destination = chooseInitialDestination();
        }
        return calculate();
      }).catch(function (e) {
        state.error = e; state.loading = false; render();
      });
    }, immediate ? 0 : DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- watch the cart
  window.fetch = function (input, init) {
    var p = origFetch(input, init);
    try {
      var url = typeof input === "string" ? input : input && input.url;
      if (url && CART_RE.test(url)) p.then(function () { refresh(false); }, function () {});
    } catch (e) { /* ignore */ }
    return p;
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__setuUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__setuUrl && CART_RE.test(String(this.__setuUrl))) {
      this.addEventListener("load", function () { refresh(false); });
    }
    return origSend.apply(this, arguments);
  };

  // themes that announce cart changes with a custom event
  ["cart:updated", "cart:refresh"].forEach(function (name) {
    document.addEventListener(name, function () { refresh(false); });
  });
  window.addEventListener("pageshow", function (e) { if (e.persisted) refresh(true); });

  // themes re-render cart sections after changes: pick up fresh, empty roots
  function readLabels() {
    var n = document.querySelector("[data-setu-duties] script[data-setu-labels], template[data-setu-duties-drawer]");
    var sc = n && (n.tagName === "TEMPLATE" ? n.content.querySelector("script[data-setu-labels]") : n);
    try { L = JSON.parse(sc.textContent); } catch (e) { L = {}; }
  }
  function readMoneyFormat() {
    var node = document.querySelector("[data-setu-duties] script[data-setu-money-format], template[data-setu-duties-drawer]");
    var script = node && (node.tagName === "TEMPLATE" ? node.content.querySelector("script[data-setu-money-format]") : node);
    if (script) { try { state.moneyFormat = JSON.parse(script.textContent); } catch (e) { /* keep default */ } }
  }
  var observer = new MutationObserver(function () {
    var fresh = roots().filter(function (r) { return !r.hasAttribute("data-setu-ready"); });
    if (fresh.length) { fresh.forEach(renderRoot); notifyConverters(); }
  });

  function start() {
    readMoneyFormat();
    readLabels();
    observer.observe(document.body, { childList: true, subtree: true });
    if (roots().length || document.querySelector("template[data-setu-duties-drawer]")) {
      render();
      refresh(true);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // small hook for themes or support: window.SetuDuties.refresh()
  window.SetuDuties = { refresh: function () { refresh(true); }, state: state };
})();
