import React, { useState, useCallback, useRef, useEffect } from "react";

// ---------- palette for group tags (technical, muted — not neon) ----------
const GROUP_COLORS = [
  "#2E6F8E",
  "#8E5A2E",
  "#4B7F52",
  "#8E2E5A",
  "#5A2E8E",
  "#2E8E7F",
  "#8E7A2E",
  "#2E4B8E",
  "#8E2E2E",
  "#5A8E2E",
  "#2E8E5A",
  "#7A2E8E",
];
const colorForGroup = (g) =>
  GROUP_COLORS[Math.abs(hash(String(g))) % GROUP_COLORS.length];
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

// ---------- default dataset (mirrors the source sheet) ----------
const DEFAULT_ROWS = [
  ["32A", 159],
  ["32B", 212],
  ["32C", 263],
  ["32D", 236],
  ["32DD", 206],
  ["32E", 189],
  ["34A", 483],
  ["34B", 1065],
  ["34C", 889],
  ["34D", 716],
  ["34DD", 568],
  ["34E", 316],
  ["36A", 734],
  ["36B", 1789],
  ["36C", 1867],
  ["36D", 1310],
  ["36DD", 856],
  ["36E", 450],
  ["38A", 646],
  ["38B", 1566],
  ["38C", 1810],
  ["38D", 1346],
  ["38DD", 833],
  ["38E", 478],
  ["40A", 418],
  ["40B", 986],
  ["40C", 1086],
  ["40D", 816],
  ["40DD", 533],
  ["40E", 279],
  ["42A", 266],
  ["42B", 618],
  ["42C", 600],
  ["42D", 378],
  ["42DD", 379],
  ["42E", 154],
];

// Every size starts as its own group, numbered in order: 32A=1, 32B=2, 32C=3 ...
// Select sizes and press "Group Selected" to merge them — the group keeps the
// lowest of the merged numbers, but the combined total displays on the LAST
// (rightmost) size in the group; every other member shows 0.
const makeDefaultSizes = () =>
  DEFAULT_ROWS.map(([name, qty], i) => ({
    id: `s${i}`,
    name,
    qty,
    group: i + 1,
    firstCut: 0,
    sample: 0,
    priority: false,
    selected: false,
  }));

const DEFAULT_CONSTANTS = {
  consumption: 0.041,
  maxLayer: 60,
  maxLength: 5.5,
  maxExcess: 30,
};

// Proportionally tops up `alloc` on each item using `budget` units, weighted by
// `weight`, never exceeding `cap`. Mutates and returns the items array.
function waterFill(items, budget) {
  let remaining = Math.max(0, Math.floor(budget));
  let active = items.filter((it) => it.cap > it.alloc && it.weight > 0);
  let guard = 0;

  while (remaining > 0 && active.length > 0 && guard < 200) {
    guard++;
    const totalWeight = active.reduce((a, it) => a + it.weight, 0);
    if (totalWeight <= 0) break;

    const shares = active.map((it) => {
      const raw = (remaining * it.weight) / totalWeight;
      return { it, floor: Math.floor(raw), rem: raw - Math.floor(raw) };
    });
    const assigned = shares.reduce((a, s) => a + s.floor, 0);
    let leftover = remaining - assigned;
    shares.sort((a, b) => b.rem - a.rem);
    for (let i = 0; i < leftover; i++) if (shares[i]) shares[i].floor += 1;

    let anyCapped = false;
    shares.forEach((s) => {
      const capRoom = s.it.cap - s.it.alloc;
      if (s.floor > capRoom) {
        remaining -= capRoom;
        s.it.alloc = s.it.cap;
        anyCapped = true;
      }
    });

    if (anyCapped) {
      active = active.filter((it) => it.alloc < it.cap);
      continue;
    } else {
      shares.forEach((s) => (s.it.alloc += s.floor));
      remaining = 0;
      break;
    }
  }
  return items;
}

// ---------- solver: guarantee 1st-Cut priority targets first, then maximize the rest ----------
function computeRatios(sizes, constants) {
  const consumption = Number(constants.consumption) || 0.0001;
  const Lay = Number(constants.maxLayer) || 0;
  const maxLength = Number(constants.maxLength) || 0;
  const maxExcess = Number(constants.maxExcess) || 0;

  const groupsMap = {};
  sizes.forEach((s) => {
    const key = s.group;
    if (!groupsMap[key])
      groupsMap[key] = {
        id: key,
        demand: 0,
        firstCutDemand: 0,
        sample: 0,
        priority: false,
        memberIds: [],
      };
    groupsMap[key].demand += Number(s.qty) || 0;
    groupsMap[key].firstCutDemand += Number(s.firstCut) || 0;
    groupsMap[key].sample += Number(s.sample) || 0;
    groupsMap[key].memberIds.push(s.id);
    if (s.priority) groupsMap[key].priority = true;
  });
  const groups = Object.values(groupsMap);

  const S = Lay > 0 ? Math.max(0, Math.floor(maxLength / consumption)) : 0;

  groups.forEach((g) => {
    g.cap = Lay > 0 ? Math.max(0, Math.floor((g.demand + maxExcess) / Lay)) : 0;
    g.alloc = 0;
  });

  // Phase 1: guarantee the 1st-Cut priority target per group, if the marker
  // length budget allows it. Each group's target is the smallest ratio that
  // covers its 1st-Cut quantity, never exceeding what the excess cap allows.
  const firstTargets = groups.map((g) => ({
    g,
    target:
      g.firstCutDemand > 0 && Lay > 0
        ? Math.min(Math.ceil(g.firstCutDemand / Lay), g.cap)
        : 0,
  }));
  const sumFirst = firstTargets.reduce((a, f) => a + f.target, 0);

  if (sumFirst <= S) {
    firstTargets.forEach((f) => (f.g.alloc = f.target));
  } else {
    // Not enough marker length to fully cover every 1st-Cut target — share
    // the available budget proportionally across them instead of dropping
    // any group to zero outright.
    const shrink = firstTargets
      .filter((f) => f.target > 0)
      .map((f) => ({
        g: f.g,
        weight: f.g.firstCutDemand,
        cap: f.target,
        alloc: 0,
      }));
    waterFill(shrink, S);
    shrink.forEach((it) => (it.g.alloc = it.alloc));
  }

  // Phase 2: priority-flagged groups get first claim on whatever marker
  // length remains, up to their own excess cap — this runs before anyone
  // else touches the leftover budget, so priority has a real, visible effect
  // instead of a mild weighting nudge.
  const afterFirstCut = groups.reduce((a, g) => a + g.alloc, 0);
  let leftover = S - afterFirstCut;
  const priorityItems = groups
    .filter((g) => g.priority)
    .map((g) => ({ g, weight: g.demand, cap: g.cap, alloc: g.alloc }));
  waterFill(priorityItems, leftover);
  priorityItems.forEach((it) => (it.g.alloc = it.alloc));

  // Phase 3: whatever length is left after that is spread across ALL groups
  // (priority ones included, in case they haven't hit their cap yet) to
  // maximize total cut, proportional to full order demand.
  const afterPriority = groups.reduce((a, g) => a + g.alloc, 0);
  leftover = S - afterPriority;
  const topUp = groups.map((g) => ({
    g,
    weight: g.demand,
    cap: g.cap,
    alloc: g.alloc,
  }));
  waterFill(topUp, leftover);
  topUp.forEach((it) => (it.g.alloc = it.alloc));

  groups.forEach((g) => {
    g.ratio = g.alloc;
    g.cutt = g.ratio * Lay;
    g.balance = g.demand - g.cutt;
    g.firstCutMet = g.firstCutDemand === 0 || g.cutt >= g.firstCutDemand;
    g.repId = g.memberIds[g.memberIds.length - 1]; // last column added to the group carries the totals
  });

  const byGroup = {};
  groups.forEach((g) => (byGroup[g.id] = g));
  const totalRatio = groups.reduce((a, g) => a + g.ratio, 0);
  const lengthUsed = totalRatio * consumption;
  const totalCutt = groups.reduce((a, g) => a + g.cutt, 0);
  const totalQty = sizes.reduce((a, s) => a + (Number(s.qty) || 0), 0);
  const totalBalance = totalQty - totalCutt;
  const totalFirstCut = sizes.reduce(
    (a, s) => a + (Number(s.firstCut) || 0),
    0,
  );
  const totalSample = sizes.reduce((a, s) => a + (Number(s.sample) || 0), 0);

  return {
    byGroup,
    totalRatio,
    lengthUsed,
    totalCutt,
    totalQty,
    totalBalance,
    totalFirstCut,
    totalSample,
  };
}

// ---------- small UI atoms ----------
function LabelCell({ children, accent = "#24303A" }) {
  return (
    <td
      className="sticky left-0 z-10 bg-[#F5F1E6] border-r-2 border-[#24303A] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[#24303A] whitespace-nowrap"
      style={{ borderLeft: `4px solid ${accent}` }}
    >
      {children}
    </td>
  );
}

function SectionHeader({ label, hint, colSpan, accent }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-white"
        style={{ background: accent }}
      >
        {label}
        {hint && (
          <span className="ml-2 font-normal normal-case tracking-normal opacity-80">
            {hint}
          </span>
        )}
      </td>
    </tr>
  );
}

const SECTION = {
  setup: "#24303A",
  input: "#2E6F8E",
  priority: "#8E2E2E",
  results: "#5A5343",
};

const ROW_ORDER = ["select", "size", "qty", "firstCut", "sample", "priority"];

export default function RatioMaker() {
  const [sizes, setSizes] = useState(makeDefaultSizes());
  const [constants, setConstants] = useState(DEFAULT_CONSTANTS);
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [gradingText, setGradingText] = useState("");
  const [showGradingPaste, setShowGradingPaste] = useState(false);
  const [gradingStatus, setGradingStatus] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const nextId = useRef(sizes.length);
  const cellRefs = useRef({});

  const setCellRef = useCallback(
    (row, col) => (el) => {
      if (el) cellRefs.current[`${row}-${col}`] = el;
      else delete cellRefs.current[`${row}-${col}`];
    },
    [],
  );

  const focusCell = useCallback((row, col) => {
    const el = cellRefs.current[`${row}-${col}`];
    if (!el) return;
    el.focus();
    if (typeof el.select === "function" && el.type !== "checkbox") el.select();
  }, []);

  // click-to-select-all: browsers place the cursor at the click point on
  // mouseup, which undoes select() called on focus — swallow that one mouseup.
  const handleEditableFocus = useCallback((e) => {
    e.target.dataset.justFocused = "true";
    e.target.select();
  }, []);
  const handleEditableMouseUp = useCallback((e) => {
    if (e.target.dataset.justFocused === "true") {
      e.preventDefault();
      delete e.target.dataset.justFocused;
    }
  }, []);
  const handleEditableBlur = useCallback((e) => {
    delete e.target.dataset.justFocused;
  }, []);

  const handleGridKeyDown = useCallback(
    (e, row, col) => {
      const key = e.key;
      const rowIdx = ROW_ORDER.indexOf(row);
      const isTextInput =
        e.target.tagName === "INPUT" && e.target.type !== "checkbox";

      if (key === "ArrowUp") {
        e.preventDefault();
        if (rowIdx > 0) focusCell(ROW_ORDER[rowIdx - 1], col);
      } else if (key === "ArrowDown") {
        e.preventDefault();
        if (rowIdx < ROW_ORDER.length - 1)
          focusCell(ROW_ORDER[rowIdx + 1], col);
      } else if (key === "ArrowLeft") {
        if (isTextInput) {
          const atStart =
            e.target.selectionStart === 0 && e.target.selectionEnd === 0;
          if (!atStart) return; // let cursor move normally within the text
        }
        e.preventDefault();
        focusCell(row, col - 1);
      } else if (key === "ArrowRight") {
        if (isTextInput) {
          const len = e.target.value.length;
          const atEnd =
            e.target.selectionStart === len && e.target.selectionEnd === len;
          if (!atEnd) return; // let cursor move normally within the text
        }
        e.preventDefault();
        focusCell(row, col + 1);
      }
      // Tab/Shift+Tab and Delete/Backspace use native input behavior — untouched.
    },
    [focusCell],
  );

  const [result, setResult] = useState(() => computeRatios(sizes, constants));
  const [dirty, setDirty] = useState(false);

  const recalculate = useCallback(() => {
    setResult(computeRatios(sizes, constants));
    setDirty(false);
  }, [sizes, constants]);

  const updateSize = useCallback((id, patch) => {
    setSizes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    if (
      "qty" in patch ||
      "priority" in patch ||
      "group" in patch ||
      "name" in patch
    )
      setDirty(true);
  }, []);

  const addSize = useCallback(() => {
    const id = `s${nextId.current++}`;
    setSizes((prev) => {
      const nextGroupNum =
        Math.max(0, ...prev.map((s) => Number(s.group) || 0)) + 1;
      return [
        ...prev,
        {
          id,
          name: `New${prev.length + 1}`,
          qty: 0,
          group: nextGroupNum,
          firstCut: 0,
          sample: 0,
          priority: false,
          selected: false,
        },
      ];
    });
    setDirty(true);
  }, []);

  const removeLast = useCallback(() => {
    setSizes((prev) => (prev.length ? prev.slice(0, -1) : prev));
    setDirty(true);
  }, []);

  const removeSelected = useCallback(() => {
    setSizes((prev) => prev.filter((s) => !s.selected));
    setDirty(true);
  }, []);

  const groupSelected = useCallback(() => {
    setSizes((prev) => {
      const sel = prev.filter((s) => s.selected);
      if (sel.length < 2) return prev;
      const sharedGroup = Math.min(...sel.map((s) => Number(s.group)));
      return prev.map((s) =>
        s.selected ? { ...s, group: sharedGroup, selected: false } : s,
      );
    });
    setDirty(true);
  }, []);

  const ungroupSelected = useCallback(() => {
    setSizes((prev) => {
      let nextGroupNum =
        Math.max(0, ...prev.map((s) => Number(s.group) || 0)) + 1;
      return prev.map((s) =>
        s.selected ? { ...s, group: nextGroupNum++, selected: false } : s,
      );
    });
    setDirty(true);
  }, []);

  const clearSelection = useCallback(() => {
    setSizes((prev) => prev.map((s) => ({ ...s, selected: false })));
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSizes((prev) => {
      const allSelected = prev.length > 0 && prev.every((s) => s.selected);
      return prev.map((s) => ({ ...s, selected: !allSelected }));
    });
  }, []);

  // Parses lines like "32A/34A" or "32C/34B" (slash- or comma-separated size
  // names) and merges each line's sizes into one shared group, matched by
  // name rather than by selection.
  const applyGradingPaste = useCallback(() => {
    const lines = gradingText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (lines.length === 0) return;
    let matchedLines = 0;
    let unmatchedNames = [];

    setSizes((prev) => {
      let next = [...prev];
      lines.forEach((line) => {
        const names = line
          .split(/[\/,]/)
          .map((n) => n.trim())
          .filter((n) => n !== "");
        if (names.length < 2) return;
        const idxs = names.map((n) =>
          next.findIndex((s) => s.name.toLowerCase() === n.toLowerCase()),
        );
        const foundIdxs = idxs.filter((i) => i !== -1);
        names.forEach((n, i) => {
          if (idxs[i] === -1) unmatchedNames.push(n);
        });
        if (foundIdxs.length < 2) return;
        matchedLines++;
        const sharedGroup = Math.min(
          ...foundIdxs.map((i) => Number(next[i].group)),
        );
        foundIdxs.forEach((i) => {
          next[i] = { ...next[i], group: sharedGroup };
        });
      });
      return next;
    });

    setDirty(true);
    if (unmatchedNames.length > 0) {
      setGradingStatus(
        `Grouped ${matchedLines} line(s). Not found: ${unmatchedNames.join(", ")}`,
      );
    } else {
      setGradingStatus(`Grouped ${matchedLines} line(s).`);
    }
    setTimeout(() => setGradingStatus(""), 4000);
  }, [gradingText]);

  // Global keyboard shortcuts: Ctrl/Cmd+G = Group Selected, Ctrl/Cmd+B = Ungroup Selected.
  // These override the browser's default bindings (e.g. Chrome's bookmarks bar toggle).
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "g") {
        e.preventDefault();
        groupSelected();
      } else if (key === "b") {
        e.preventDefault();
        ungroupSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [groupSelected, ungroupSelected]);

  const handleNumberPaste = useCallback((e, startId, field) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\t") && !text.includes("\n")) return; // let default paste happen for single value
    e.preventDefault();
    const values = text
      .split(/\r?\n|\t/)
      .map((v) => v.trim())
      .filter((v) => v !== "");
    setSizes((prev) => {
      const startIdx = prev.findIndex((s) => s.id === startId);
      if (startIdx === -1) return prev;
      const next = [...prev];
      values.forEach((v, i) => {
        const idx = startIdx + i;
        if (idx < next.length) {
          const n = parseFloat(v.replace(/,/g, ""));
          next[idx] = {
            ...next[idx],
            [field]: isNaN(n) ? next[idx][field] : n,
          };
        }
      });
      return next;
    });
    setDirty(true);
  }, []);

  const loadPastedBlock = useCallback(() => {
    const lines = pasteText.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 2) return;
    const names = lines[0].split("\t").map((v) => v.trim());
    const qtys = lines[1]
      .split("\t")
      .map((v) => parseFloat(v.replace(/,/g, "")) || 0);
    const firstCuts = lines[2]
      ? lines[2].split("\t").map((v) => parseFloat(v.replace(/,/g, "")) || 0)
      : [];
    const samples = lines[3]
      ? lines[3].split("\t").map((v) => parseFloat(v.replace(/,/g, "")) || 0)
      : [];
    const count = Math.max(names.length, qtys.length);
    const rows = [];
    for (let i = 0; i < count; i++) {
      const gid = `s${nextId.current++}`;
      rows.push({
        id: gid,
        name: names[i] || `Size${i + 1}`,
        qty: qtys[i] || 0,
        group: i + 1,
        firstCut: firstCuts[i] || 0,
        sample: samples[i] || 0,
        priority: false,
        selected: false,
      });
    }
    setSizes(rows);
    setPasteText("");
    setShowPaste(false);
    setDirty(true);
  }, [pasteText]);

  const copyRatioRow = useCallback(async () => {
    const line = sizes
      .map((s) => result.byGroup[s.group]?.ratio ?? 0)
      .join("\t");
    try {
      await navigator.clipboard.writeText(line);
      setCopyStatus("Copied ratio row");
    } catch {
      setCopyStatus("Copy failed — select & copy manually");
    }
    setTimeout(() => setCopyStatus(""), 2000);
  }, [sizes, result]);

  const selectedCount = sizes.filter((s) => s.selected).length;
  const allSelected = sizes.length > 0 && selectedCount === sizes.length;
  const lengthPct =
    constants.maxLength > 0
      ? Math.min(100, (result.lengthUsed / constants.maxLength) * 100)
      : 0;

  return (
    <div className="w-full min-h-full bg-[#F5F1E6] text-[#24303A] font-sans p-5">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-4 border-b-2 border-[#24303A] pb-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            Cutting Ratio Planner
          </h1>
          <p className="text-xs text-[#5A5343] tracking-wide">
            grading groups → marker ratio → layer plan
          </p>
        </div>
        <div className="text-right text-[11px] font-mono text-[#5A5343] leading-tight">
          <div>
            {sizes.length} sizes · {new Set(sizes.map((s) => s.group)).size}{" "}
            groups
          </div>
        </div>
      </div>

      {/* Constants panel */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          ["consumption", "Consumption / unit"],
          ["maxLayer", "Max Layer"],
          ["maxLength", "Max Length"],
          ["maxExcess", "Max Excess / Size"],
        ].map(([key, label]) => (
          <div key={key} className="bg-white border border-[#C9C2AE] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#5A5343] mb-1">
              {label}
            </div>
            <input
              type="number"
              step="any"
              value={constants[key]}
              onChange={(e) => {
                setConstants((c) => ({
                  ...c,
                  [key]: parseFloat(e.target.value) || 0,
                }));
                setDirty(true);
              }}
              className="w-full bg-transparent font-mono text-sm font-semibold outline-none border-b border-transparent focus:border-[#C1440E]"
            />
          </div>
        ))}
      </div>

      {/* Summary strip */}
      <div className="flex flex-wrap gap-4 items-center mb-4 bg-white border border-[#C9C2AE] px-4 py-3">
        <button
          onClick={recalculate}
          aria-label={
            dirty
              ? "Refresh calculations — changes are pending"
              : "Refresh calculations"
          }
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide text-white rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
          style={{ background: dirty ? "#C1440E" : "#4B7F52" }}
        >
          ⟳ Refresh Calculations
        </button>
        <div className="w-px h-8 bg-[#C9C2AE]" />
        <div className="text-xs font-mono">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block">
            Total Qty
          </span>
          <span className="font-semibold">
            {result.totalQty.toLocaleString()}
          </span>
        </div>
        <div className="text-xs font-mono">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block">
            Total Ratio
          </span>
          <span className="font-semibold">{result.totalRatio}</span>
        </div>
        <div className="text-xs font-mono">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block">
            Total Cut
          </span>
          <span className="font-semibold">
            {result.totalCutt.toLocaleString()}
          </span>
        </div>
        <div className="text-xs font-mono">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block">
            Total Balance
          </span>
          <span
            className="font-semibold"
            style={{ color: result.totalBalance < 0 ? "#C1440E" : "#24303A" }}
          >
            {result.totalBalance.toLocaleString()}
          </span>
        </div>
        <div className="text-xs font-mono">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block">
            1st Cut Target
          </span>
          <span className="font-semibold text-[#8E2E2E]">
            {result.totalFirstCut.toLocaleString()}
            {(() => {
              const groupsWithTarget = Object.values(result.byGroup).filter(
                (g) => g.firstCutDemand > 0,
              );
              const shortCount = groupsWithTarget.filter(
                (g) => !g.firstCutMet,
              ).length;
              return shortCount > 0
                ? ` (${shortCount} short)`
                : groupsWithTarget.length > 0
                  ? " (all met)"
                  : "";
            })()}
          </span>
        </div>
        <div className="text-xs font-mono">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block">
            Sample Qty
          </span>
          <span className="font-semibold">
            {result.totalSample.toLocaleString()}
          </span>
        </div>
        <div className="flex-1 min-w-[180px]">
          <span className="text-[#5A5343] uppercase text-[10px] tracking-wider block mb-1">
            Marker Length {result.lengthUsed.toFixed(3)} /{" "}
            {Number(constants.maxLength).toFixed(2)}
          </span>
          <div className="h-2 bg-[#EDE7D6] border border-[#C9C2AE]">
            <div
              className="h-full"
              style={{
                width: `${lengthPct}%`,
                background: lengthPct >= 98 ? "#C1440E" : "#D9A404",
              }}
            />
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <button
          onClick={recalculate}
          aria-label={
            dirty ? "Recalculate — changes are pending" : "Recalculate"
          }
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
          style={{ background: dirty ? "#C1440E" : "#4B7F52" }}
        >
          {dirty ? "⟳ Recalculate (changes pending)" : "⟳ Recalculate"}
        </button>
        <div className="w-px h-5 bg-[#C9C2AE] mx-1" />
        <button
          onClick={addSize}
          aria-label="Add a new size column"
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#24303A] text-white rounded-sm hover:bg-[#3a4954] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          + Add Size
        </button>
        <button
          onClick={removeLast}
          aria-label="Remove the last size column"
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#5A5343] text-white rounded-sm hover:bg-[#463f32] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          Remove Last
        </button>
        <div className="w-px h-5 bg-[#C9C2AE] mx-1" />
        <button
          onClick={toggleSelectAll}
          aria-label={allSelected ? "Deselect all sizes" : "Select all sizes"}
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#3d5a45] text-white rounded-sm hover:bg-[#32492e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          {allSelected ? "Deselect All" : "Select All"}
        </button>
        <button
          onClick={groupSelected}
          disabled={selectedCount < 2}
          aria-label={`Group ${selectedCount} selected sizes, shortcut Control G`}
          title="Ctrl+G"
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#2E6F8E] text-white rounded-sm hover:bg-[#255a73] disabled:opacity-40 disabled:hover:bg-[#2E6F8E] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          Group Selected ({selectedCount}){" "}
          <span className="opacity-80 normal-case">Ctrl+G</span>
        </button>
        <button
          onClick={ungroupSelected}
          disabled={selectedCount < 1}
          aria-label="Ungroup selected sizes, shortcut Control B"
          title="Ctrl+B"
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#8E7A2E] text-white rounded-sm hover:bg-[#75651f] disabled:opacity-40 disabled:hover:bg-[#8E7A2E] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          Ungroup Selected{" "}
          <span className="opacity-80 normal-case">Ctrl+B</span>
        </button>
        <button
          onClick={removeSelected}
          disabled={selectedCount < 1}
          aria-label="Remove selected size columns"
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#C1440E] text-white rounded-sm hover:bg-[#a3390c] disabled:opacity-40 disabled:hover:bg-[#C1440E] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          Remove Selected
        </button>
        {selectedCount > 0 && (
          <button
            onClick={clearSelection}
            aria-label="Clear selection"
            className="px-2 py-1.5 text-xs font-bold text-[#24303A] underline decoration-2 underline-offset-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
          >
            clear selection
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setShowGradingPaste((v) => !v)}
          aria-label={
            showGradingPaste
              ? "Close grading paste panel"
              : "Open grading paste panel"
          }
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#2E6F8E] text-white rounded-sm hover:bg-[#255a73] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          {showGradingPaste ? "Close Grading Paste" : "Paste Grading"}
        </button>
        <button
          onClick={() => setShowPaste((v) => !v)}
          aria-label={
            showPaste ? "Close data paste panel" : "Open data paste panel"
          }
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#24303A] text-white rounded-sm hover:bg-[#3a4954] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          {showPaste ? "Close Paste" : "Paste Data"}
        </button>
        <button
          onClick={copyRatioRow}
          aria-label="Copy the ratio row to clipboard"
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#D9A404] text-[#24303A] rounded-sm hover:bg-[#c79604] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
        >
          Copy Ratio Row
        </button>
        {copyStatus && (
          <span role="status" className="text-[11px] text-[#4B7F52] font-bold">
            {copyStatus}
          </span>
        )}
      </div>

      {showGradingPaste && (
        <div className="mb-4 bg-white border-2 border-[#2E6F8E] p-3">
          <p className="text-[11px] text-[#5A5343] mb-2">
            Paste grading pairs, one group per line, sizes separated by{" "}
            <code>/</code> or <code>,</code> — matched by size name (not by
            column position). Example:
          </p>
          <textarea
            value={gradingText}
            onChange={(e) => setGradingText(e.target.value)}
            rows={5}
            aria-label="Grading pairs to paste"
            className="w-full border-2 border-[#C9C2AE] p-2 font-mono text-xs outline-none focus:border-[#2E6F8E]"
            placeholder={"32A/34A\n32C/34B\n34DD/32E"}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={applyGradingPaste}
              aria-label="Apply grading pairs"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#2E6F8E] text-white rounded-sm hover:bg-[#255a73] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
            >
              Apply Grading
            </button>
            {gradingStatus && (
              <span
                role="status"
                className="text-[11px] font-bold text-[#5A5343]"
              >
                {gradingStatus}
              </span>
            )}
          </div>
        </div>
      )}

      {showPaste && (
        <div className="mb-4 bg-white border-2 border-[#C9C2AE] p-3">
          <p className="text-[11px] text-[#5A5343] mb-2">
            Paste from Excel: line 1 = size names, line 2 = MO quantities, line
            3 = 1st Cut targets (optional), line 4 = Sample qty (optional) — all
            tab-separated. This replaces the current table.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={5}
            aria-label="Size data to paste"
            className="w-full border-2 border-[#C9C2AE] p-2 font-mono text-xs outline-none focus:border-[#C1440E]"
            placeholder={
              "32A\t32B\t32C ...\n159\t212\t263 ...\n128\t165\t213 ...\n0\t0\t0 ..."
            }
          />
          <button
            onClick={loadPastedBlock}
            aria-label="Load pasted data"
            className="mt-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-[#24303A] text-white rounded-sm hover:bg-[#3a4954] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
          >
            Load Pasted Data
          </button>
        </div>
      )}

      {/* Data grid */}
      <div className="overflow-x-auto border-2 border-[#24303A] bg-white">
        <table className="border-collapse text-xs w-full">
          <tbody>
            <SectionHeader
              label="Identification"
              hint="pick, name, and group sizes"
              colSpan={sizes.length + 1}
              accent={SECTION.setup}
            />

            <tr className="border-b border-[#C9C2AE]">
              <LabelCell accent={SECTION.setup}>
                Select (Total Sizes {sizes.length})
              </LabelCell>
              {sizes.map((s, col) => (
                <td
                  key={s.id}
                  className="px-2 py-2 text-center border-r border-[#EDE7D6]"
                >
                  <input
                    ref={setCellRef("select", col)}
                    type="checkbox"
                    checked={s.selected}
                    onChange={(e) =>
                      updateSize(s.id, { selected: e.target.checked })
                    }
                    onKeyDown={(e) => handleGridKeyDown(e, "select", col)}
                    aria-label={`Select ${s.name}`}
                    className="w-4 h-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
                  />
                </td>
              ))}
            </tr>

            <tr className="border-b border-[#C9C2AE]">
              <LabelCell accent={SECTION.setup}>Size Name</LabelCell>
              {sizes.map((s, col) => (
                <td
                  key={s.id}
                  className="px-1 py-2 border-r border-[#EDE7D6]"
                  style={{ borderTop: `3px solid ${colorForGroup(s.group)}` }}
                >
                  <input
                    ref={setCellRef("size", col)}
                    value={s.name}
                    onChange={(e) => updateSize(s.id, { name: e.target.value })}
                    onFocus={handleEditableFocus}
                    onMouseUp={handleEditableMouseUp}
                    onBlur={handleEditableBlur}
                    onKeyDown={(e) => handleGridKeyDown(e, "size", col)}
                    className="w-16 bg-transparent font-semibold text-center outline-none focus:bg-[#EDE7D6]"
                  />
                </td>
              ))}
            </tr>

            <tr className="border-b-2 border-[#24303A]">
              <LabelCell accent={SECTION.setup}>Grading Group</LabelCell>
              {sizes.map((s) => {
                const isRep = result.byGroup[s.group]?.repId === s.id;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-1 text-center border-r border-[#EDE7D6]"
                  >
                    <span
                      className="inline-block px-1.5 py-0.5 text-[9px] font-mono font-bold text-white rounded-sm"
                      style={{
                        background: colorForGroup(s.group),
                        outline: isRep ? "2px solid #24303A" : "none",
                        outlineOffset: "1px",
                      }}
                      title={
                        isRep
                          ? "Carries this group's totals"
                          : "Shares totals with the marked column in this group"
                      }
                    >
                      {s.group}
                      {isRep ? " ★" : ""}
                    </span>
                  </td>
                );
              })}
            </tr>

            <SectionHeader
              label="Editable Inputs"
              hint="typed or pasted per size"
              colSpan={sizes.length + 1}
              accent={SECTION.input}
            />

            <tr className="border-b border-[#C9C2AE] bg-[#FBF9F2]">
              <LabelCell accent={SECTION.input}>
                MO Qty ({result.totalQty.toLocaleString()})
              </LabelCell>
              {sizes.map((s, col) => (
                <td key={s.id} className="px-1 py-2 border-r border-[#EDE7D6]">
                  <input
                    ref={setCellRef("qty", col)}
                    type="text"
                    inputMode="numeric"
                    value={s.qty}
                    onPaste={(e) => handleNumberPaste(e, s.id, "qty")}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.\-]/g, "");
                      updateSize(s.id, { qty: v === "" ? 0 : parseFloat(v) });
                    }}
                    onFocus={handleEditableFocus}
                    onMouseUp={handleEditableMouseUp}
                    onBlur={handleEditableBlur}
                    onKeyDown={(e) => handleGridKeyDown(e, "qty", col)}
                    className="w-16 bg-transparent font-mono text-center outline-none focus:bg-[#EDE7D6]"
                  />
                </td>
              ))}
            </tr>

            <tr className="border-b border-[#C9C2AE]">
              <LabelCell accent={SECTION.input}>
                Has Qty ({sizes.filter((s) => (Number(s.qty) || 0) > 0).length}/
                {sizes.length})
              </LabelCell>
              {sizes.map((s) => {
                const has = (Number(s.qty) || 0) > 0;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 text-center border-r border-[#EDE7D6]"
                  >
                    <span
                      className="inline-block w-4 h-4 rounded-full text-[10px] leading-4 font-bold"
                      style={{
                        background: has ? "#4B7F52" : "#E3DCC9",
                        color: has ? "#fff" : "#A69C7F",
                      }}
                      title={
                        has
                          ? "Has a pasted/entered quantity"
                          : "No quantity yet"
                      }
                    >
                      {has ? "✓" : "–"}
                    </span>
                  </td>
                );
              })}
            </tr>

            <tr
              className="border-b border-[#C9C2AE]"
              style={{ background: "#FBE3DC" }}
            >
              <LabelCell accent={SECTION.priority}>
                1st Cut Qty ({result.totalFirstCut.toLocaleString()})
              </LabelCell>
              {sizes.map((s, col) => {
                const g = result.byGroup[s.group];
                const notMet =
                  g &&
                  g.firstCutDemand > 0 &&
                  !g.firstCutMet &&
                  result.byGroup[s.group]?.repId === s.id;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 border-r border-[#F3C9BC]"
                  >
                    <input
                      ref={setCellRef("firstCut", col)}
                      type="text"
                      inputMode="numeric"
                      value={s.firstCut}
                      onPaste={(e) => handleNumberPaste(e, s.id, "firstCut")}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.\-]/g, "");
                        updateSize(s.id, {
                          firstCut: v === "" ? 0 : parseFloat(v),
                        });
                      }}
                      onFocus={handleEditableFocus}
                      onMouseUp={handleEditableMouseUp}
                      onBlur={handleEditableBlur}
                      onKeyDown={(e) => handleGridKeyDown(e, "firstCut", col)}
                      className="w-16 bg-transparent font-mono font-semibold text-center text-[#8E2E2E] outline-none focus:bg-white"
                      title={
                        notMet
                          ? "Marker length budget wasn't enough to fully cover this group's 1st Cut target"
                          : ""
                      }
                    />
                    {notMet && (
                      <div className="text-[8px] text-[#8E2E2E] text-center">
                        short
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>

            <tr className="border-b border-[#C9C2AE] bg-[#EFF3ED]">
              <LabelCell accent="#4B7F52">
                Sample Qty ({result.totalSample.toLocaleString()})
              </LabelCell>
              {sizes.map((s, col) => (
                <td key={s.id} className="px-1 py-2 border-r border-[#D8E2D8]">
                  <input
                    ref={setCellRef("sample", col)}
                    type="text"
                    inputMode="numeric"
                    value={s.sample}
                    onPaste={(e) => handleNumberPaste(e, s.id, "sample")}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.\-]/g, "");
                      updateSize(s.id, {
                        sample: v === "" ? 0 : parseFloat(v),
                      });
                    }}
                    onFocus={handleEditableFocus}
                    onMouseUp={handleEditableMouseUp}
                    onBlur={handleEditableBlur}
                    onKeyDown={(e) => handleGridKeyDown(e, "sample", col)}
                    className="w-16 bg-transparent font-mono text-center outline-none focus:bg-white"
                  />
                </td>
              ))}
            </tr>

            <tr className="border-b-2 border-[#24303A]">
              <LabelCell accent="#D9A404">Priority Flag</LabelCell>
              {sizes.map((s, col) => (
                <td
                  key={s.id}
                  className="px-1 py-2 text-center border-r border-[#EDE7D6]"
                >
                  <input
                    ref={setCellRef("priority", col)}
                    type="checkbox"
                    checked={s.priority}
                    onChange={(e) =>
                      updateSize(s.id, { priority: e.target.checked })
                    }
                    onKeyDown={(e) => handleGridKeyDown(e, "priority", col)}
                    aria-label={`Mark ${s.name} as priority`}
                    className="w-4 h-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24303A]"
                  />
                </td>
              ))}
            </tr>

            <SectionHeader
              label="Calculated Results"
              hint="read-only — press Recalculate to refresh"
              colSpan={sizes.length + 1}
              accent={SECTION.results}
            />

            <tr
              className="border-b border-[#C9C2AE]"
              style={{ background: "#F3D4C8" }}
            >
              <LabelCell accent={SECTION.priority}>
                1st Cut Total ({result.totalFirstCut.toLocaleString()})
              </LabelCell>
              {sizes.map((s) => {
                const g = result.byGroup[s.group];
                const isRep = g?.repId === s.id;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 text-center font-mono font-semibold text-[#8E2E2E] border-r border-[#F3C9BC]"
                  >
                    {isRep ? g.firstCutDemand : 0}
                  </td>
                );
              })}
            </tr>

            <tr className="border-b border-[#C9C2AE] bg-[#EDE7D6]">
              <LabelCell accent={SECTION.results}>
                Group Demand Total ({result.totalQty.toLocaleString()})
              </LabelCell>
              {sizes.map((s) => {
                const g = result.byGroup[s.group];
                const isRep = g?.repId === s.id;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 text-center font-mono border-r border-[#C9C2AE]"
                  >
                    {isRep ? g.demand : 0}
                  </td>
                );
              })}
            </tr>

            <tr className="border-b border-[#C9C2AE]">
              <LabelCell accent={SECTION.results}>
                Cutting Ratio (total {result.totalRatio})
              </LabelCell>
              {sizes.map((s) => {
                const g = result.byGroup[s.group];
                const isRep = g?.repId === s.id;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 text-center font-mono font-bold text-[#C1440E] border-r border-[#EDE7D6]"
                  >
                    {isRep ? g.ratio : 0}
                  </td>
                );
              })}
            </tr>

            <tr className="border-b border-[#C9C2AE]">
              <LabelCell accent={SECTION.results}>
                Layers ({constants.maxLayer} per group)
              </LabelCell>
              {sizes.map((s) => (
                <td
                  key={s.id}
                  className="px-1 py-2 text-center font-mono text-[#5A5343] border-r border-[#EDE7D6]"
                >
                  {constants.maxLayer}
                </td>
              ))}
            </tr>

            <tr className="border-b border-[#C9C2AE] bg-[#FBF9F2]">
              <LabelCell accent={SECTION.results}>
                Cut Qty (total {result.totalCutt.toLocaleString()})
              </LabelCell>
              {sizes.map((s) => {
                const g = result.byGroup[s.group];
                const isRep = g?.repId === s.id;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 text-center font-mono font-semibold border-r border-[#EDE7D6]"
                  >
                    {isRep ? g.cutt : 0}
                  </td>
                );
              })}
            </tr>

            <tr>
              <LabelCell accent={SECTION.results}>
                Balance (total {result.totalBalance.toLocaleString()})
              </LabelCell>
              {sizes.map((s) => {
                const g = result.byGroup[s.group];
                const isRep = g?.repId === s.id;
                const bal = isRep ? g.balance : 0;
                const isExcess = isRep && bal < 0;
                return (
                  <td
                    key={s.id}
                    className="px-1 py-2 text-center font-mono border-r border-[#EDE7D6]"
                    style={{ color: isExcess ? "#C1440E" : "#4B7F52" }}
                  >
                    {bal}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[12px] text-[#5A5343] mt-3 leading-relaxed max-w-2x2">
        Solve order: first, each group's <strong>1st Cut</strong> target is
        guaranteed if the marker length budget allows it (shared out
        proportionally across groups if it doesn't quite fit). Whatever length
        remains is then used to maximize total pieces cut, proportional to each
        group's full order quantity, capped so no group is overcut beyond the
        Max Excess/Size limit, and bounded by the Max Length available on the
        cutting table. Priority-flagged sizes get more of that leftover but
        still respect the same excess cap. A group whose 1st Cut couldn't be
        fully covered is marked "short" in red. Sample qty is tracked per size
        but isn't cut into the marker automatically — treat it as a separate
        trial run.
      </p>

      <footer className="mt-6 pt-3 border-t border-[#C9C2AE] text-center text-[12px] text-[#5A5343] tracking-wide">
        Made by Muhammad Sojib to ease life a little.
      </footer>
    </div>
  );
}
