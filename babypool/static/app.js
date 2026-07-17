/*
 * baby-pool front-end.
 *
 * Everything is computed client-side from the /api/entries snapshot:
 *   - the Data tab lists every guess,
 *   - the Insights tab computes each guess's *winning window* (the closest-guess
 *     partition of the timeline) and lets a guest search their own name.
 *
 * SECURITY: entry names come from a Google Sheet and can contain `&`, `<`,
 * quotes, etc. They are ONLY ever injected into the DOM via textContent /
 * createElement / dataset / .value — NEVER innerHTML with an interpolated name.
 * Keep it that way; the security review checks for it.
 *
 * No external network calls, no libraries — the confetti and animations are
 * hand-rolled so the page stays self-contained under a strict `default-src
 * 'self'` CSP.
 */
"use strict";

(function () {
  const REDUCED_MOTION =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- helpers ------------------------------------------------------------

  /** Parse a naive ISO datetime ("2026-08-20T06:00:00") as LOCAL wall-clock ms.
   * A date-time ISO string with no timezone offset is parsed as local time by
   * every modern engine, which is exactly the "wall clock at the hospital"
   * semantics we want. */
  function toMs(iso) {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  const FMT = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  /** Format an absolute ms instant as e.g. "Aug 19, 1:57 PM". */
  function fmtInstant(ms) {
    // Intl gives "Aug 19, 1:57 PM" as "Aug 19 at 1:57 PM" in some locales via
    // formatToParts; the plain format() is "Aug 19, 1:57 PM" for en-US which is
    // our audience. Good enough and locale-aware for everyone else.
    return FMT.format(new Date(ms));
  }

  /** Human duration from a ms span, e.g. "2d 4h" / "6h 12m" / "48m". */
  function fmtDuration(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    const parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m && !d) parts.push(m + "m"); // drop minutes once we're in days territory
    return parts.length ? parts.join(" ") : "0m";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // textContent = XSS-safe
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- winner-interval math ----------------------------------------------
  //
  // "Closest guess wins" is a 1-D nearest-neighbour partition: guess i owns
  // everything nearer to it than to any other guess, i.e. the interval bounded
  // by the midpoints to its neighbours. Guesses at the identical instant are
  // co-winners sharing one window (a "node").

  /** Build winner nodes from raw entries.
   * Returns { nodes, domainStart, domainEnd } where each node is
   * { ms, entries:[...], left, right, openLeft, openRight, visualLen }. */
  function computeNodes(entries) {
    const withMs = entries
      .map((e, i) => ({ entry: e, ms: toMs(e.datetime), origIndex: i }))
      .filter((x) => Number.isFinite(x.ms))
      .sort((a, b) => a.ms - b.ms);

    // Group identical instants into co-winner nodes.
    const nodes = [];
    for (const x of withMs) {
      const last = nodes[nodes.length - 1];
      if (last && last.ms === x.ms) {
        last.entries.push(x);
      } else {
        nodes.push({ ms: x.ms, entries: [x] });
      }
    }
    if (nodes.length === 0) return { nodes: [], domainStart: 0, domainEnd: 0 };

    // Midpoint bounds. First node is open on the left, last open on the right.
    for (let i = 0; i < nodes.length; i++) {
      const cur = nodes[i];
      cur.openLeft = i === 0;
      cur.openRight = i === nodes.length - 1;
      cur.left = i === 0 ? -Infinity : (nodes[i - 1].ms + cur.ms) / 2;
      cur.right =
        i === nodes.length - 1 ? Infinity : (cur.ms + nodes[i + 1].ms) / 2;
    }

    // A finite visual domain so open-ended windows and the timeline have a
    // sensible extent: mirror the first/last half-gap outward. With one node we
    // pick an arbitrary ±1 day so it renders as a single full band.
    let lead, trail;
    if (nodes.length === 1) {
      lead = trail = 24 * 3600 * 1000;
    } else {
      lead = (nodes[1].ms - nodes[0].ms) / 2;
      trail = (nodes[nodes.length - 1].ms - nodes[nodes.length - 2].ms) / 2;
    }
    const domainStart = nodes[0].ms - lead;
    const domainEnd = nodes[nodes.length - 1].ms + trail;

    // Visual (finite) length of each band, clamping the open ends to the domain.
    for (const n of nodes) {
      const l = n.openLeft ? domainStart : n.left;
      const r = n.openRight ? domainEnd : n.right;
      n.visualLen = Math.max(0, r - l);
    }
    return { nodes, domainStart, domainEnd };
  }

  /** English description of a node's winning window. */
  function windowText(node) {
    if (node.openLeft && node.openRight) {
      return "any time — the only guess in the pool!";
    }
    if (node.openLeft) {
      return "any time before " + fmtInstant(node.right);
    }
    if (node.openRight) {
      return "any time after " + fmtInstant(node.left);
    }
    return "between " + fmtInstant(node.left) + " and " + fmtInstant(node.right);
  }

  /** Compact range label for a timeline band. */
  function rangeLabel(node) {
    if (node.openLeft && node.openRight) return "any time";
    if (node.openLeft) return "before " + fmtInstant(node.right);
    if (node.openRight) return "after " + fmtInstant(node.left);
    return fmtInstant(node.left) + " → " + fmtInstant(node.right);
  }

  /** Unique winner display names for a node (dedup co-winners w/ same name). */
  function nodeNames(node) {
    const seen = [];
    for (const x of node.entries) {
      if (!seen.includes(x.entry.name)) seen.push(x.entry.name);
    }
    return seen;
  }

  // ---- calendar (day-by-day gantt) helpers --------------------------------
  //
  // The calendar reuses the SAME winner nodes/windows as the timeline — no new
  // winner math. Each node owns [left, right); we clip the open ends to the
  // first/last covered calendar day, then split each window into per-day slices
  // so a window crossing midnight becomes two continuous bar segments.

  /** Stable pastel hue [0,360) from a name, so a person's every window shares
   * one colour. Simple deterministic string hash; unsigned to avoid negatives. */
  function hueForName(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  /** A node's colour hue = its first winner's hue. For a co-winner (tie) node
   * we key off the first name; ties are rare and both names still show. */
  function hueForNode(node) {
    const names = nodeNames(node);
    return hueForName(names[0] || "");
  }

  /** Build the list of calendar day rows covering the winner nodes: one entry
   * per LOCAL calendar day from the day of the earliest guess to the day of the
   * latest. Returns { days:[{start,end,date}], firstDayStart, lastDayEnd } with
   * start/end as local-midnight ms bounds (end = next day's midnight, so a day
   * is its real length even across a DST change). */
  function buildCalendarDays(nodes) {
    if (!nodes.length) return { days: [], firstDayStart: 0, lastDayEnd: 0 };
    const first = new Date(nodes[0].ms);
    const last = new Date(nodes[nodes.length - 1].ms);
    let cur = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    const lastMidnight = new Date(
      last.getFullYear(), last.getMonth(), last.getDate()
    ).getTime();
    const days = [];
    // Guard against a pathological span blowing up the DOM (shouldn't happen
    // with real guesses, but keep it bounded).
    while (cur.getTime() <= lastMidnight && days.length < 400) {
      const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      days.push({ start: cur.getTime(), end: next.getTime(), date: new Date(cur) });
      cur = next;
    }
    return {
      days,
      firstDayStart: days[0].start,
      lastDayEnd: days[days.length - 1].end,
    };
  }

  /**
   * Split a half-open window [wStart, wEnd) into per-day slices over `days`
   * (each day = { start, end } in ms). Pure. Returns [{ dayIndex, start, end }]
   * clipped to each overlapped day.
   *
   * Self-check (reason through — no JS test framework in this repo):
   *   days = [{start:D0,end:D1},{start:D1,end:D2}]  (D0=Aug19 00:00,
   *          D1=Aug20 00:00, D2=Aug21 00:00)
   *   window [Aug19 17:31, Aug20 08:15) →
   *     day 0: [Aug19 17:31, Aug20 00:00)   (fills to midnight)
   *     day 1: [Aug20 00:00, Aug20 08:15)   (continues from midnight)
   *   Because the source node windows already tile [firstDayStart, lastDayEnd)
   *   with no gaps/overlaps, the union of all slices across all nodes tiles the
   *   same range exactly — the gantt is continuous down the rows.
   */
  function sliceWindowAcrossDays(wStart, wEnd, days) {
    const slices = [];
    for (let i = 0; i < days.length; i++) {
      const s = Math.max(wStart, days[i].start);
      const e = Math.min(wEnd, days[i].end);
      if (e > s) slices.push({ dayIndex: i, start: s, end: e });
    }
    return slices;
  }

  // ---- rendering ----------------------------------------------------------

  const state = { snapshot: null, nodes: [] };

  /** Populate the page title + subtitle from the snapshot's baby object.
   * The static HTML ships only a GENERIC fallback ("The Baby Pool") — the
   * real family label/parents live only in the runtime snapshot and are set
   * here via textContent (never innerHTML). Guards for missing/empty. */
  function renderBaby(snapshot) {
    const baby = (snapshot && snapshot.baby) || {};
    const label = (typeof baby.label === "string" && baby.label.trim())
      ? baby.label.trim()
      : "The Baby Pool";
    const parents = Array.isArray(baby.parents)
      ? baby.parents.filter((p) => typeof p === "string" && p.trim())
      : [];

    const titleEl = document.getElementById("pool-title");
    if (titleEl) {
      // Preserve the decorative wave span; only replace the leading text node.
      const wave = titleEl.querySelector(".wave");
      titleEl.textContent = label + " ";
      if (wave) titleEl.appendChild(wave);
    }
    document.title = label;

    const parentsEl = document.getElementById("pool-parents");
    if (parentsEl) {
      if (parents.length) {
        parentsEl.textContent = parents.join(" & ");
        parentsEl.hidden = false;
      } else {
        parentsEl.textContent = "";
        parentsEl.hidden = true;
      }
    }
  }

  function renderUpdated(snapshot) {
    const node = document.getElementById("updated");
    if (!node) return;
    if (snapshot.updated_at) {
      const d = new Date(snapshot.updated_at);
      const when = Number.isFinite(d.getTime())
        ? d.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : snapshot.updated_at;
      node.textContent = "Entries as of " + when;
    } else {
      node.textContent = "";
    }
  }

  function renderData(snapshot) {
    const list = document.getElementById("data-list");
    const empty = document.getElementById("data-empty");
    clear(list);
    const entries = snapshot.entries || [];
    empty.hidden = entries.length > 0;
    for (const e of entries) {
      const card = el("div", "entry-card");
      card.appendChild(el("span", "entry-name", e.name));
      const meta = el("div", "entry-meta");
      meta.appendChild(el("span", "entry-date", e.date_label || ""));
      meta.appendChild(el("span", "entry-time", e.time_label || ""));
      card.appendChild(meta);
      list.appendChild(card);
    }
  }

  function renderTimeline(nodes) {
    const wrap = document.getElementById("timeline");
    const empty = document.getElementById("insights-empty");
    clear(wrap);
    empty.hidden = nodes.length > 0;

    // Total finite extent for proportional sizing.
    const total = nodes.reduce((s, n) => s + n.visualLen, 0) || 1;
    const TARGET = 820; // px of vertical "clock" to spread bands across

    nodes.forEach((node, idx) => {
      const seg = el("div", "seg");
      seg.dataset.idx = String(idx);
      // Proportional height, but every band stays tappable/legible.
      const h = Math.min(
        240,
        Math.max(52, Math.round((node.visualLen / total) * TARGET))
      );
      seg.style.minHeight = h + "px";
      seg.style.setProperty("--hue", String((idx * 47) % 360));

      const names = nodeNames(node);
      const nameRow = el("div", "seg-names");
      names.forEach((n, i) => {
        // Co-winners are joined with " + " (not " & ") so a name that itself
        // contains "&" — e.g. "Abbey & Warren" — stays unambiguous, reading
        // "John Heller + Abbey & Warren".
        if (i) nameRow.appendChild(el("span", "seg-amp", " + "));
        nameRow.appendChild(el("span", "seg-name", n));
      });
      seg.appendChild(nameRow);
      seg.appendChild(el("div", "seg-range", rangeLabel(node)));

      // Tap/click and keyboard reveal the plain-English window.
      seg.setAttribute("tabindex", "0");
      seg.setAttribute("role", "button");
      seg.setAttribute("aria-label", names.join(" and ") + ": " + windowText(node));
      const reveal = () => {
        wrap.querySelectorAll(".seg.open").forEach((s) => {
          if (s !== seg) s.classList.remove("open");
        });
        seg.classList.toggle("open");
      };
      seg.addEventListener("click", reveal);
      seg.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          reveal();
        }
      });

      const detail = el("div", "seg-detail", windowText(node));
      seg.appendChild(detail);
      wrap.appendChild(seg);
    });
  }

  const CAL_DAY_FMT = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  /**
   * A single custom, theme-styled tooltip for calendar bars. Works on hover
   * (desktop), tap/click (mobile + desktop), and keyboard focus — replacing both
   * the browser-native `title` popup and the old `#cal-detail` panel with one
   * coherent styled reveal. Content (winner name + exact window) is built with
   * textContent only, so an untrusted Sheet name can never inject markup.
   *
   * Positioned `fixed` in viewport coords from the hovered bar's rect: prefer
   * above the bar, flip below if it'd clip the top, clamp horizontally so it
   * never overflows the screen edges. Tap pins it (tap again / tap another bar /
   * tap or scroll elsewhere dismisses); hover/focus show transiently.
   */
  const CalTip = (function () {
    let root = null, whoEl = null, winEl = null, pinned = null, built = false;

    function build() {
      if (built) return;
      built = true;
      root = el("div", "cal-tooltip");
      root.setAttribute("role", "tooltip");
      whoEl = el("span", "cal-tt-who");
      winEl = el("span", "cal-tt-win");
      root.appendChild(whoEl);
      root.appendChild(winEl);
      document.body.appendChild(root);
      // Any tap/scroll/resize outside a bar dismisses. Bars stopPropagation on
      // their own click so a bar tap doesn't fall through to this.
      document.addEventListener("click", hide);
      window.addEventListener("scroll", hide, { passive: true });
      window.addEventListener("resize", hide);
    }

    function fill(node, hue) {
      whoEl.textContent = nodeNames(node).join(" + ");
      whoEl.style.color = "hsl(" + hue + " 55% 38%)"; // the winner's bar colour
      winEl.textContent = windowText(node);
    }

    function position(bar) {
      const r = bar.getBoundingClientRect();
      const t = root.getBoundingClientRect(); // real size (visible once .show set)
      let left = r.left + r.width / 2 - t.width / 2;
      const maxLeft = window.innerWidth - t.width - 8;
      if (left > maxLeft) left = maxLeft;
      if (left < 8) left = 8;
      let top = r.top - t.height - 10; // prefer above the bar
      root.classList.remove("cal-tooltip-below");
      if (top < 8) { // would clip the top of the viewport → place below
        top = r.bottom + 10;
        root.classList.add("cal-tooltip-below");
      }
      root.style.left = left + "px";
      root.style.top = top + "px";
      // Caret points at the bar's centre, clamped to stay within the bubble.
      const caretX = r.left + r.width / 2 - left;
      root.style.setProperty(
        "--caret-x", Math.max(12, Math.min(t.width - 12, caretX)) + "px"
      );
    }

    function show(bar) {
      build();
      fill(bar._calNode, bar._calHue);
      root.classList.add("show"); // visible → measurable
      position(bar);
    }

    // mouseenter / focus: transient preview, but never override a pinned bar.
    function hover(bar) { if (pinned !== bar) { if (!pinned) show(bar); } }
    function unhover() { if (!pinned && root) root.classList.remove("show"); }

    // click / Enter / Space: toggle a pinned reveal that survives mouseleave.
    function toggle(bar) {
      build();
      if (pinned === bar) { hide(); }
      else { pinned = bar; show(bar); }
    }

    function hide() {
      pinned = null;
      if (root) root.classList.remove("show");
    }

    return { hover, unhover, toggle, hide };
  })();

  /** Render the day-by-day gantt from the SAME winner nodes as the timeline. */
  function renderCalendar(nodes) {
    const wrap = document.getElementById("calendar");
    const empty = document.getElementById("calendar-empty");
    if (!wrap) return;
    CalTip.hide(); // drop any reveal pinned to bars we're about to replace
    clear(wrap);
    if (empty) empty.hidden = nodes.length > 0;
    if (!nodes.length) return;

    const { days, firstDayStart, lastDayEnd } = buildCalendarDays(nodes);

    // Estimated track pixel width (the track spans the page content width, which
    // is the same whether or not the Insights tab is currently shown — so we
    // can't measure a display:none panel; we derive it from the viewport). Used
    // only to decide when a bar is too tiny to fit even a truncated name.
    const trackPx = Math.max(220, Math.min(608, (window.innerWidth || 400) - 32));

    // Axis header: a few ticks (0, 6, 12, 18, 24) for reading the 24h track.
    const axis = el("div", "cal-axis");
    [0, 6, 12, 18, 24].forEach((h) => {
      const tick = el("span", "cal-tick", String(h));
      if (h === 24) tick.classList.add("cal-tick-end");
      else tick.style.left = (h / 24) * 100 + "%";
      axis.appendChild(tick);
    });
    wrap.appendChild(axis);

    // Bucket each node's per-day slices into their day row.
    const barsByDay = days.map(() => []);
    nodes.forEach((node, idx) => {
      const wStart = node.openLeft ? firstDayStart : node.left;
      const wEnd = node.openRight ? lastDayEnd : node.right;
      const hue = hueForNode(node);
      const names = nodeNames(node);
      const nameStr = names.join(" + ");
      const aria = nameStr + ": " + windowText(node);
      sliceWindowAcrossDays(wStart, wEnd, days).forEach((sl) => {
        barsByDay[sl.dayIndex].push({ node, idx, slice: sl, hue, nameStr, aria });
      });
    });

    days.forEach((day, di) => {
      const row = el("div", "cal-row");
      row.appendChild(el("div", "cal-day-label", CAL_DAY_FMT.format(day.date)));
      const track = el("div", "cal-track");
      const span = day.end - day.start || 1;

      barsByDay[di].forEach((b) => {
        const leftFrac = (b.slice.start - day.start) / span;
        const widthFrac = (b.slice.end - b.slice.start) / span;

        const bar = el("div", "cal-bar");
        bar.dataset.idx = String(b.idx);
        bar.style.left = leftFrac * 100 + "%";
        bar.style.width = widthFrac * 100 + "%";
        // Colours computed in JS → set via .style (allowed under the CSP; no
        // inline <style>). Pastel fill, darker matching edge.
        bar.style.backgroundColor = "hsl(" + b.hue + " 70% 84%)";
        bar.style.borderColor = "hsl(" + b.hue + " 55% 55%)";

        // Open-end caps: only the very first day's left edge / last day's right
        // edge get the "extends earlier/later" marker.
        if (b.node.openLeft && b.slice.start === firstDayStart) {
          bar.classList.add("cal-open-left");
        }
        if (b.node.openRight && b.slice.end === lastDayEnd) {
          bar.classList.add("cal-open-right");
        }

        // ALWAYS render the name; the label span truncates with an ellipsis
        // (CSS: overflow/ellipsis/nowrap) so a mid-width bar shows as much as
        // fits ("Jeannine Dis…") instead of going blank. Only omit the inline
        // text for genuinely tiny slivers where not even ~2 chars + ellipsis
        // fit (~26px of inner width, allowing ~12px for the bar's h-padding);
        // those stay reachable via the tooltip. Names via textContent = XSS-safe.
        const innerPx = widthFrac * trackPx - 12;
        if (innerPx < 26) bar.classList.add("cal-narrow");
        bar.appendChild(el("span", "cal-bar-label", b.nameStr));

        // Styled tooltip (hover + tap + focus) replaces the native `title`.
        // aria-label keeps the name + window available to screen readers; the
        // native title is deliberately NOT set (no double tooltip).
        bar.setAttribute("aria-label", b.aria);
        bar.setAttribute("role", "button");
        bar.setAttribute("tabindex", "0");
        bar._calNode = b.node; // stash for the tooltip (expando, not DOM markup)
        bar._calHue = b.hue;
        bar.addEventListener("mouseenter", () => CalTip.hover(bar));
        bar.addEventListener("mouseleave", () => CalTip.unhover());
        bar.addEventListener("focus", () => CalTip.hover(bar));
        bar.addEventListener("blur", () => CalTip.unhover());
        bar.addEventListener("click", (ev) => {
          ev.stopPropagation(); // don't let the document dismiss-handler fire
          CalTip.toggle(bar);
        });
        bar.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            CalTip.toggle(bar);
          }
        });
        track.appendChild(bar);
      });

      row.appendChild(track);
      wrap.appendChild(row);
    });
  }

  function renderLeaderboard(nodes) {
    const box = document.getElementById("leaderboard");
    const list = document.getElementById("leaderboard-list");
    clear(list);
    // Sum owned time per person across their guesses, keeping the nodes so we
    // can also show each person's winning window(s). EXCLUDE the open-ended
    // bookends (the earliest guess's "any time before …" and the latest's
    // "any time after …"): those windows are unbounded, so their length isn't a
    // meaningful "coverage" and would unfairly rank whoever guessed first/last.
    const byName = new Map();
    for (const node of nodes) {
      if (node.openLeft || node.openRight) continue; // skip bookends
      for (const name of nodeNames(node)) {
        let rec = byName.get(name);
        if (!rec) { rec = { ms: 0, nodes: [] }; byName.set(name, rec); }
        rec.ms += node.visualLen;
        rec.nodes.push(node);
      }
    }
    const ranked = [...byName.entries()]
      .sort((a, b) => b[1].ms - a[1].ms).slice(0, 5);
    box.hidden = ranked.length < 2; // no point showing a board of one
    for (const [name, rec] of ranked) {
      const li = el("li", "lb-row");
      const head = el("div", "lb-head");
      head.appendChild(el("span", "lb-name", name));
      head.appendChild(el("span", "lb-time", fmtDuration(rec.ms)));
      li.appendChild(head);
      // One "between X and Y" line per (finite) window this person owns; most
      // have one, multi-guess folks get all of theirs.
      const wins = el("div", "lb-windows");
      rec.nodes
        .slice()
        .sort((a, b) => a.left - b.left)
        .forEach((node) => wins.appendChild(
          el("span", "lb-win", windowText(node))));
      li.appendChild(wins);
      list.appendChild(li);
    }
  }

  function renderSuggestions(snapshot) {
    const dl = document.getElementById("name-suggest");
    clear(dl);
    const seen = new Set();
    for (const e of snapshot.entries || []) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const opt = document.createElement("option");
      opt.value = e.name; // property assignment, not innerHTML — safe
      dl.appendChild(opt);
    }
  }

  // ---- name search --------------------------------------------------------

  function highlightSegments(indices) {
    const set = new Set(indices);
    // `indices` is empty for both "no query" and "no match" → clear/undim in
    // both; non-empty means there are hits → dim the non-matching bars.
    const active = indices.length > 0;
    document.querySelectorAll("#timeline .seg").forEach((seg) => {
      seg.classList.toggle("hit", set.has(Number(seg.dataset.idx)));
    });
    // Same searched-name state drives the calendar: bold the person's bars,
    // fade the rest. Reuses the existing search input/state — no 2nd box.
    document.querySelectorAll("#calendar .cal-bar").forEach((bar) => {
      const hit = set.has(Number(bar.dataset.idx));
      bar.classList.toggle("cal-hit", hit);
      bar.classList.toggle("cal-dim", active && !hit);
    });
  }

  function runSearch(rawQuery) {
    const out = document.getElementById("search-result");
    clear(out);
    const q = rawQuery.trim().toLowerCase();
    if (!q) {
      highlightSegments([]);
      return;
    }
    // Which nodes contain a matching name, and the matched display names.
    const matchIndices = [];
    const matchedNames = new Set();
    state.nodes.forEach((node, idx) => {
      let hit = false;
      for (const x of node.entries) {
        if (x.entry.name.toLowerCase().includes(q)) {
          hit = true;
          matchedNames.add(x.entry.name);
        }
      }
      if (hit) matchIndices.push(idx);
    });

    if (matchIndices.length === 0) {
      const msg = el("div", "no-match");
      // Build with textContent pieces so the untrusted query can't inject.
      msg.appendChild(el("span", null, "No entry found for "));
      msg.appendChild(el("strong", null, "“" + rawQuery.trim() + "”"));
      msg.appendChild(el("span", null, ". Double-check the spelling? 🍼"));
      out.appendChild(msg);
      highlightSegments([]);
      return;
    }

    out.appendChild(el("div", "match-lead", "🎉 Found it! You win if the baby arrives…"));
    // One line per matching guess, grouped under each distinct name.
    for (const name of matchedNames) {
      const block = el("div", "match-name");
      block.appendChild(el("span", "match-who", name));
      const ul = el("ul", "match-windows");
      state.nodes.forEach((node) => {
        const owns = node.entries.some((x) => x.entry.name === name);
        if (owns) ul.appendChild(el("li", null, windowText(node)));
      });
      block.appendChild(ul);
      out.appendChild(block);
    }

    highlightSegments(matchIndices);

    // Scroll the first hit into view + confetti celebration.
    const first = document.querySelector('#timeline .seg[data-idx="' + matchIndices[0] + '"]');
    if (first && first.scrollIntoView) {
      first.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "center" });
    }
    Confetti.burst();
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---- tabs ---------------------------------------------------------------

  function initTabs() {
    const tabs = [
      { tab: document.getElementById("tab-data"), panel: document.getElementById("panel-data") },
      { tab: document.getElementById("tab-insights"), panel: document.getElementById("panel-insights") },
    ];

    function select(i) {
      tabs.forEach((t, j) => {
        const on = i === j;
        t.tab.setAttribute("aria-selected", on ? "true" : "false");
        t.tab.tabIndex = on ? 0 : -1;
        t.panel.hidden = !on;
      });
      tabs[i].tab.focus();
    }

    tabs.forEach((t, i) => {
      t.tab.addEventListener("click", () => select(i));
      t.tab.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
          ev.preventDefault();
          select((i + 1) % tabs.length);
        } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          select((i - 1 + tabs.length) % tabs.length);
        } else if (ev.key === "Home") {
          ev.preventDefault();
          select(0);
        } else if (ev.key === "End") {
          ev.preventDefault();
          select(tabs.length - 1);
        }
      });
    });
  }

  // ---- confetti (hand-rolled, canvas) ------------------------------------

  const Confetti = (function () {
    const canvas = document.getElementById("confetti");
    if (!canvas) return { burst() {} };
    const ctx = canvas.getContext("2d");
    const COLORS = ["#7cc4ff", "#a9e5ff", "#c9b3ff", "#bff0d4", "#ffd6ec", "#fff3b0"];
    let particles = [];
    let running = false;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    window.addEventListener("resize", resize);
    resize();

    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.12; // gravity
        p.rot += p.vr;
        p.life -= 1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      particles = particles.filter((p) => p.life > 0 && p.y < canvas.height + 40);
      if (particles.length) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    function burst() {
      if (REDUCED_MOTION) return; // non-essential motion
      const cx = canvas.width / 2;
      const cy = canvas.height * 0.28;
      for (let i = 0; i < 90; i++) {
        const angle = (Math.PI * 2 * i) / 90 + Math.random() * 0.3;
        const speed = 3 + Math.random() * 6;
        particles.push({
          x: cx + (Math.random() - 0.5) * 60,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 3,
          vr: (Math.random() - 0.5) * 0.3,
          rot: Math.random() * Math.PI,
          size: 6 + Math.random() * 8,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          life: 60 + Math.random() * 40,
        });
      }
      if (!running) {
        running = true;
        requestAnimationFrame(tick);
      }
    }

    return { burst };
  })();

  // ---- ambient decor (balloons / clouds / stars) --------------------------

  function initAmbient() {
    if (REDUCED_MOTION) return; // honour the user's motion preference
    const balloons = document.getElementById("balloons");
    const clouds = document.getElementById("clouds");
    const stars = document.getElementById("stars");
    const B = ["🎈", "🍼", "👣", "⭐", "☁️"];

    function make(container, className, count, builder) {
      if (!container) return;
      for (let i = 0; i < count; i++) container.appendChild(builder(i));
    }

    make(balloons, "balloon", 6, (i) => {
      const b = el("span", "balloon", ["🎈", "🍼", "🧸", "🎈", "👶", "🎈"][i % 6]);
      b.style.left = 6 + i * 15 + Math.random() * 6 + "%";
      b.style.animationDuration = 14 + Math.random() * 10 + "s";
      b.style.animationDelay = -Math.random() * 12 + "s";
      b.style.fontSize = 1.6 + Math.random() * 1.2 + "rem";
      return b;
    });
    make(clouds, "cloud", 4, (i) => {
      const c = el("span", "cloud", "☁️");
      c.style.top = 4 + i * 16 + "%";
      c.style.animationDuration = 40 + Math.random() * 30 + "s";
      c.style.animationDelay = -Math.random() * 30 + "s";
      c.style.fontSize = 2 + Math.random() * 2 + "rem";
      return c;
    });
    make(stars, "star", 18, () => {
      const s = el("span", "star", "✦");
      s.style.left = Math.random() * 100 + "%";
      s.style.top = Math.random() * 60 + "%";
      s.style.animationDuration = 2 + Math.random() * 3 + "s";
      s.style.animationDelay = -Math.random() * 4 + "s";
      s.style.fontSize = 0.5 + Math.random() * 0.9 + "rem";
      return s;
    });
  }

  // ---- boot ---------------------------------------------------------------

  function boot(snapshot) {
    state.snapshot = snapshot;
    const { nodes } = computeNodes(snapshot.entries || []);
    state.nodes = nodes;

    renderBaby(snapshot);
    renderUpdated(snapshot);
    renderData(snapshot);
    renderTimeline(nodes);
    renderCalendar(nodes);
    renderLeaderboard(nodes);
    renderSuggestions(snapshot);

    const search = document.getElementById("name-search");
    if (search) {
      search.addEventListener("input", debounce((ev) => runSearch(ev.target.value), 180));
    }
  }

  function init() {
    initTabs();
    initAmbient();
    fetch("/api/entries", { credentials: "same-origin" })
      .then((r) => r.json())
      .then(boot)
      .catch((err) => {
        // Network/parse failure → render an empty pool rather than a blank page.
        console.error("Failed to load entries:", err);
        boot({ updated_at: "", entries: [] });
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
