const tickEl = document.getElementById("tick");
const elevatorContainer = document.getElementById("elevator-cards");
const floorTableBody = document.querySelector("#floor-table tbody");
const metricsList = document.getElementById("metrics-list");
const statusEl = document.getElementById("controller-status");
const toggleBtn = document.getElementById("toggle-controller");
const lastUpdateEl = document.getElementById("last-update");
const floorLabelsEl = document.getElementById("floor-labels");
const floorGuidesEl = document.getElementById("floor-guides");
const waitingAreaEl = document.getElementById("waiting-area");
const shaftContainer = document.getElementById("shaft-container");
const motionLayer = document.getElementById("motion-layer");
const visualCanvasEl = document.querySelector(".visual-canvas");
const visualStageEl = document.getElementById("visual-stage");
const visualViewportEl = document.getElementById("visual-viewport");
const scenarioSelect = document.getElementById("scenario-select");
const applyScenarioBtn = document.getElementById("apply-scenario");
const scenarioMetaEl = document.getElementById("scenario-meta");
const speedControlsEl = document.getElementById("speed-controls");
const stageScaleInput = document.getElementById("stage-scale");
const stageScaleValueEl = document.getElementById("stage-scale-value");
const viewportResetBtn = document.getElementById("viewport-reset");
const queueSummaryEl = document.getElementById("queue-summary");

let controllerRunning = false;
let pendingAction = false;
let scenarioLoading = false;

const POLL_INTERVAL_BASE = 650;
const MIN_POLL_INTERVAL = 180;
let pollTimer = null;
let currentSpeedFactor = 1;

const sceneState = {
  floorNumbers: [],
  floorMeta: { min: 0, max: 1, span: 1, count: 0, range: 0 },
  cabinHeightPx: null,
  floorCentersPx: new Map(),
  floorLevelsPx: new Map(),
  floorCenterRatios: new Map(),
  floorBoundaryRatios: new Map(),
  shaftHeightPx: 0,
  travelHeightPx: 0,
  floorPixelRange: { start: 0, end: 0 },
  doorHoldMax: 2,
  stageScale: 1,
  stageHeightPx: 0,
  layout: {
    paddingTop: 36,
    paddingBottom: 28,
    buildingPaddingX: 26,
    shaftPaddingLeft: 42,
    shaftPaddingRight: 42,
    queueWidth: 220,
    floorUnit: 48,
    cabinHeight: 46,
  },
};

const elevatorNodes = new Map();
const waitingNodes = new Map();
const passengerRegistry = new Map();
let previousTick = null;
let trafficCatalog = [];
let currentTrafficInfo = null;
let pendingScenarioIndex = null;
let pendingElevatorSizeUpdate = false;

function getPollInterval() {
  return Math.max(MIN_POLL_INTERVAL, POLL_INTERVAL_BASE / Math.max(currentSpeedFactor, 0.25));
}

function updateSpeedButtons() {
  if (!speedControlsEl) {
    return;
  }
  const buttons = speedControlsEl.querySelectorAll("button[data-speed]");
  buttons.forEach((button) => {
    const factor = parseFloat(button.dataset.speed || "1");
    const active = Math.abs(factor - currentSpeedFactor) < 0.05;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function applySpeedStyling() {
  document.documentElement.style.setProperty("--speed-factor", currentSpeedFactor.toString());
  document.documentElement.style.setProperty(
    "--speed-multiplier",
    (1 / Math.max(currentSpeedFactor, 0.25)).toFixed(3)
  );
  updateSpeedButtons();
}

function setStageScale(multiplier, { silent = false } = {}) {
  const normalized = Math.max(0.7, Math.min(multiplier, 1.4));
  if (Math.abs(normalized - sceneState.stageScale) < 0.01) {
    if (!silent) {
      updateStageScaleDisplay(normalized);
    }
    return;
  }
  sceneState.stageScale = normalized;
  updateStageScaleDisplay(normalized);
  if (visualStageEl) {
    visualStageEl.style.setProperty("--stage-scale", normalized.toFixed(3));
  }
  requestElevatorSizeUpdate();
  window.requestAnimationFrame(() => {
    cacheFloorCenters();
    elevatorNodes.forEach((node) => {
      if (node.snapshot) {
        updateElevatorVisual(node, node.snapshot);
      }
    });
  });
}

function updateStageScaleDisplay(scale) {
  if (stageScaleInput) {
    const targetValue = Math.round(scale * 100);
    if (parseInt(stageScaleInput.value, 10) !== targetValue) {
      stageScaleInput.value = String(targetValue);
    }
  }
  if (stageScaleValueEl) {
    stageScaleValueEl.textContent = `${Math.round(scale * 100)}%`;
  }
}

function initializeStageControls() {
  if (visualStageEl) {
    visualStageEl.style.setProperty("--stage-scale", sceneState.stageScale.toFixed(3));
  }
  updateStageScaleDisplay(sceneState.stageScale);
  if (stageScaleInput) {
    stageScaleInput.addEventListener("input", (event) => {
      const value = Number.parseInt(event.target.value, 10);
      if (Number.isFinite(value)) {
        setStageScale(value / 100);
      }
    });
  }
  if (viewportResetBtn) {
    viewportResetBtn.addEventListener("click", () => {
      setStageScale(1);
      if (visualViewportEl) {
        visualViewportEl.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }
}

function setSpeedFactor(factor) {
  const normalized = Math.max(0.25, Math.min(factor, 6));
  if (Math.abs(normalized - currentSpeedFactor) < 0.05) {
    return;
  }
  currentSpeedFactor = normalized;
  applySpeedStyling();
  startPolling(false);
  fetchState();
}

function initializeSpeedControls() {
  if (!speedControlsEl) {
    applySpeedStyling();
    return;
  }
  const buttons = speedControlsEl.querySelectorAll("button[data-speed]");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const factor = parseFloat(button.dataset.speed || "1");
      if (Number.isFinite(factor)) {
        setSpeedFactor(factor);
      }
    });
  });
  applySpeedStyling();
}

function startPolling(immediate = false) {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }
  const interval = getPollInterval();
  pollTimer = window.setInterval(fetchState, interval);
  if (immediate) {
    fetchState();
  }
}

function resetAnimationState() {
  previousTick = null;
  passengerRegistry.clear();
  pendingScenarioIndex = null;
  sceneState.floorNumbers = [];
  sceneState.floorMeta = { min: 0, max: 1, span: 1, count: 0, range: 0 };
  sceneState.cabinHeightPx = null;
  sceneState.floorCentersPx = new Map();
  sceneState.floorLevelsPx = new Map();
  sceneState.floorCenterRatios = new Map();
  sceneState.floorBoundaryRatios = new Map();
  sceneState.shaftHeightPx = 0;
  sceneState.doorHoldMax = 2;
  if (visualCanvasEl) {
    visualCanvasEl.style.height = "";
  }
  if (visualStageEl) {
    visualStageEl.style.minHeight = "";
  }
  if (motionLayer) {
    motionLayer.innerHTML = "";
  }
}

function pruneMotionLayer(limit = 80) {
  if (!motionLayer) {
    return;
  }
  while (motionLayer.children.length > limit) {
    motionLayer.removeChild(motionLayer.firstChild);
  }
}

function requestElevatorSizeUpdate() {
  if (pendingElevatorSizeUpdate) {
    return;
  }
  pendingElevatorSizeUpdate = true;
  window.requestAnimationFrame(() => {
    pendingElevatorSizeUpdate = false;
    updateElevatorSizing();
  });
}

function updateElevatorSizing() {
  configureStageLayout(sceneState.floorNumbers.length || 0);
  resizeStageHeight();

  if (!visualCanvasEl || !shaftContainer) {
    sceneState.cabinHeightPx = null;
    sceneState.floorCentersPx = new Map();
    sceneState.floorLevelsPx = new Map();
    sceneState.shaftHeightPx = 0;
    return;
  }

  const layout = sceneState.layout || {};
  const unit = Number.isFinite(layout.floorUnit) ? layout.floorUnit : 42;
  const computedCabin = Number.isFinite(layout.cabinHeight)
    ? layout.cabinHeight
    : Math.round(Math.max(18, Math.min(unit * 0.62, 52)));
  sceneState.cabinHeightPx = computedCabin;

  elevatorNodes.forEach((node) => applyCabinSizing(node));

  window.requestAnimationFrame(() => {
    cacheFloorCenters();
    elevatorNodes.forEach((node) => {
      if (node.snapshot) {
        updateElevatorVisual(node, node.snapshot);
      }
    });
  });
}

function applyCabinSizing(node) {
  if (!node || !node.cabin) {
    return;
  }
  const height = sceneState.cabinHeightPx;
  const unit = sceneState.layout?.floorUnit;
  if (typeof height === "number") {
    node.cabin.style.minHeight = `${height}px`;
    node.cabin.style.height = `${height}px`;
  } else {
    node.cabin.style.minHeight = "";
    node.cabin.style.height = "";
  }
  if (Number.isFinite(unit)) {
    const width = Math.round(Math.max(44, Math.min(unit * 0.82, 68)));
    node.cabin.style.width = `${width}px`;
  } else {
    node.cabin.style.width = "";
  }
  if (node.interior) {
    if (typeof height === "number") {
      const interiorHeight = Math.max(height - 26, 28);
      node.interior.style.minHeight = `${interiorHeight}px`;
    } else {
      node.interior.style.minHeight = "";
    }
  }
  if (node.passengersEl) {
    if (typeof height === "number") {
      const usable = Math.max(height - 28, 20);
      node.passengersEl.style.maxHeight = `${usable}px`;
    } else {
      node.passengersEl.style.maxHeight = "";
    }
  }
}

function cacheFloorCenters() {
  const floorNumbers = sceneState.floorNumbers;
  if (!Array.isArray(floorNumbers) || !floorNumbers.length) {
    sceneState.shaftHeightPx = 0;
    sceneState.floorCentersPx = new Map();
    sceneState.floorLevelsPx = new Map();
    sceneState.floorPixelRange = { start: 0, end: 0 };
    return;
  }

  const layout = sceneState.layout || {};
  const unit = Number.isFinite(layout.floorUnit) ? layout.floorUnit : 40;
  const centers = new Map();
  const levels = new Map();

  floorNumbers.forEach((floor, index) => {
    const boundary = index * unit;
    const center = boundary + unit / 2;
    levels.set(floor, boundary);
    centers.set(floor, center);

    const entry = waitingNodes.get(floor);
    if (entry?.root) {
      entry.root.style.bottom = `${boundary}px`;
    }
    if (entry?.guide) {
      entry.guide.style.bottom = `${boundary}px`;
    }
    if (entry?.label) {
      entry.label.style.bottom = `${center}px`;
    }
  });

  const travelHeight = Math.max((floorNumbers.length - 1) * unit, 0);
  sceneState.floorPixelRange = { start: 0, end: travelHeight };
  sceneState.travelHeightPx = travelHeight;
  sceneState.shaftHeightPx = travelHeight;
  sceneState.floorLevelsPx = levels;
  sceneState.floorCentersPx = centers;
}

async function fetchTrafficCatalog() {
  try {
    const resp = await fetch(`/dashboard/traffic/list?_=${Date.now()}`, {
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    trafficCatalog = Array.isArray(data.traffic) ? data.traffic : [];
    if (data.info) {
      currentTrafficInfo = data.info;
    }
    renderTrafficOptions(trafficCatalog, currentTrafficInfo);
  } catch (error) {
    console.error("获取测试用例列表失败:", error);
    trafficCatalog = [];
    renderTrafficOptions(trafficCatalog, currentTrafficInfo);
  }
}

function renderTrafficOptions(catalog, info) {
  if (!scenarioSelect) {
    return;
  }

  scenarioSelect.innerHTML = "";
  if (!Array.isArray(catalog) || catalog.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无可用测试";
    scenarioSelect.appendChild(option);
    scenarioSelect.disabled = true;
    renderScenarioMeta(info);
    updateScenarioControls();
    return;
  }

  catalog.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item.index);
    const labelParts = [];
    if (typeof item.index === "number") {
      labelParts.push(`${item.index + 1}.`);
    }
    labelParts.push(item.label || item.filename || `测试 ${item.index + 1}`);
    if (item.scale) {
      labelParts.push(`(${item.scale})`);
    }
    if (item.source === "custom") {
      labelParts.push("[自定义]");
    }
    option.textContent = labelParts.join(" ");
    scenarioSelect.appendChild(option);
  });

  const activeIndex = getActiveScenarioIndex(info);
  let targetValue = null;
  if (pendingScenarioIndex !== null) {
    targetValue = String(pendingScenarioIndex);
  } else if (activeIndex !== null) {
    targetValue = String(activeIndex);
  }
  if (targetValue !== null) {
    const hasOption = Array.from(scenarioSelect.options).some((opt) => opt.value === targetValue);
    scenarioSelect.value = hasOption ? targetValue : scenarioSelect.options[0]?.value ?? "";
  }
  scenarioSelect.disabled = false;
  renderScenarioMeta(info);
  updateScenarioControls();
}

function renderScenarioMeta(info) {
  if (!scenarioMetaEl) {
    return;
  }
  if (!info || !info.current_file) {
    scenarioMetaEl.textContent = "当前测试：--";
    return;
  }
  const meta = info.current_file;
  const label = meta.label || meta.filename || "未命名测试";
  const highlights = [];
  if (meta.elevators) {
    highlights.push(`${meta.elevators} 部电梯`);
  }
  if (meta.floors) {
    highlights.push(`${meta.floors} 层`);
  }
  if (meta.duration) {
    highlights.push(`持续 ${meta.duration} tick`);
  }
  if (meta.expected_passengers) {
    highlights.push(`乘客 ${meta.expected_passengers} 人`);
  }
  if (meta.scale) {
    highlights.push(`规模 ${meta.scale}`);
  }
  if (meta.source) {
    const sourceLabel = meta.source === "custom" ? "自定义案例" : "内置案例";
    highlights.push(sourceLabel);
  }
  const description = meta.description || meta.scenario || "";
  const infoParts = [];
  if (description) {
    infoParts.push(description);
  }
  if (highlights.length) {
    infoParts.push(highlights.join("，"));
  }
  scenarioMetaEl.textContent = `当前测试：${label}${infoParts.length ? `（${infoParts.join("；")}）` : ""}`;
}

function getActiveScenarioIndex(info) {
  if (!info) {
    return null;
  }
  if (info.current_file && typeof info.current_file.index === "number") {
    return info.current_file.index;
  }
  if (typeof info.current_index === "number") {
    return info.current_index;
  }
  return null;
}

function updateScenarioControls() {
  if (!scenarioSelect || !applyScenarioBtn) {
    return;
  }
  const disabled = controllerRunning || scenarioLoading || pendingAction || !trafficCatalog.length;
  scenarioSelect.disabled = controllerRunning || scenarioLoading || pendingAction || !trafficCatalog.length;
  const selectedIndex = parseInt(scenarioSelect.value, 10);
  const activeIndex = getActiveScenarioIndex(currentTrafficInfo);
  const noChange = !Number.isNaN(selectedIndex) && activeIndex === selectedIndex;
  applyScenarioBtn.disabled = disabled || !scenarioSelect.value || noChange;
  if (scenarioLoading) {
    applyScenarioBtn.textContent = "载入中...";
  } else {
    applyScenarioBtn.textContent = "载入测试";
  }
}

async function fetchState() {
  try {
    const resp = await fetch(`/dashboard/state?_=${Date.now()}`, {
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    renderState(data);
  } catch (error) {
    console.error("获取状态失败:", error);
  }
}

function renderState(state) {
  if (!state) {
    return;
  }
  const currentTick = ensureNumber(state.tick, 0);
  if (previousTick !== null && currentTick < previousTick) {
    resetAnimationState();
  }

  const tickDisplay = Number.isFinite(currentTick)
    ? currentTick
    : state.tick ?? "--";
  tickEl.textContent = `Tick: ${tickDisplay}`;
  if (lastUpdateEl) {
    const now = new Date();
    lastUpdateEl.textContent = `上次更新：${now
      .toLocaleTimeString("zh-CN", { hour12: false })
      .padStart(8, "0")}`;
  }

  ensureSceneStructure(state);
  updateElevatorScene(state);
  updatePassengerVisuals(state.passengers || []);
  updateElevatorCards(state.elevators || []);
  updateFloorTable(state.floors || []);
  updateMetrics(state.metrics || {});
  if (state.traffic) {
    currentTrafficInfo = state.traffic;
    const activeIndex = getActiveScenarioIndex(currentTrafficInfo);
    if (pendingScenarioIndex !== null && activeIndex === pendingScenarioIndex) {
      pendingScenarioIndex = null;
    }
    if (
      scenarioSelect &&
      activeIndex !== null &&
      (scenarioLoading || pendingScenarioIndex === null) &&
      (scenarioLoading || document.activeElement !== scenarioSelect)
    ) {
      const targetValue = String(activeIndex);
      if (scenarioSelect.value !== targetValue) {
        scenarioSelect.value = targetValue;
      }
    }
    renderScenarioMeta(currentTrafficInfo);
  }

  controllerRunning = Boolean(state.controller_running);
  updateControls();
  previousTick = currentTick;
}

function ensureSceneStructure(state) {
  const floorNumbers = (state.floors || [])
    .map((f) => f.floor)
    .sort((a, b) => a - b);
  if (!arraysEqual(sceneState.floorNumbers, floorNumbers)) {
    sceneState.floorNumbers = floorNumbers;
    buildFloorScaffolding(floorNumbers);
  }
  syncElevatorShafts(state.elevators || []);
}

function buildFloorScaffolding(floorNumbers) {
  if (!floorLabelsEl || !floorGuidesEl || !waitingAreaEl) {
    return;
  }
  floorLabelsEl.innerHTML = "";
  floorGuidesEl.innerHTML = "";
  waitingAreaEl.innerHTML = "";
  waitingNodes.forEach((entry) => {
    if (entry?.highlightTimer) {
      clearTimeout(entry.highlightTimer);
    }
  });
  waitingNodes.clear();

  if (!floorNumbers.length) {
    sceneState.floorMeta = { min: 0, max: 1, span: 1, count: 0 };
    return;
  }

  const min = floorNumbers[0];
  const max = floorNumbers[floorNumbers.length - 1];
  const range = max - min;
  const span = Math.max(range, 1);
  sceneState.floorMeta = { min, max, span, count: floorNumbers.length, range };
  const centerRatios = new Map();
  const boundaryRatios = new Map();
  const total = floorNumbers.length;
  const clampPercent = (value, low = 0, high = 100) => Math.min(high, Math.max(low, value));
  const clampRatio = (ratio) => Math.min(1, Math.max(0, ratio));
  const intervalCount = total > 1 ? total - 1 : 1;
  const centerStep = total > 0 ? 1 / total : 0;

  floorNumbers.forEach((floor, index) => {
    const boundaryRatio = total <= 1 ? 0.5 : clampRatio(index / intervalCount);
    const centerRatio = total <= 1 ? 0.5 : clampRatio(centerStep * (index + 0.5));
    boundaryRatios.set(floor, boundaryRatio);
    centerRatios.set(floor, centerRatio);
    const levelPercent = clampPercent(boundaryRatio * 100, 0, 100);
    const centerPercent = clampPercent(centerRatio * 100, 0, 100);

    const label = document.createElement("div");
    label.className = "floor-label";
    label.dataset.floor = String(floor);
    label.textContent = formatFloorLabel(floor);
    label.style.bottom = `${centerPercent}%`;
    floorLabelsEl.appendChild(label);

    const guide = document.createElement("div");
    guide.className = "floor-guide";
    guide.dataset.floor = String(floor);
    guide.style.bottom = `${levelPercent}%`;
    floorGuidesEl.appendChild(guide);

    const waitingRoot = document.createElement("div");
    waitingRoot.className = "floor-waiting inactive";
    waitingRoot.dataset.floor = String(floor);
    waitingRoot.style.bottom = `${levelPercent}%`;

    const upQueue = document.createElement("div");
    upQueue.className = "wait-queue up";
    upQueue.dataset.label = "↑";
    waitingRoot.appendChild(upQueue);

    const downQueue = document.createElement("div");
    downQueue.className = "wait-queue down";
    downQueue.dataset.label = "↓";
    waitingRoot.appendChild(downQueue);

    waitingAreaEl.appendChild(waitingRoot);
    waitingNodes.set(floor, {
      root: waitingRoot,
      up: upQueue,
      down: downQueue,
      guide,
      label,
      upCount: 0,
      downCount: 0,
      highlightTimer: null,
    });
  });
  sceneState.floorCenterRatios = centerRatios;
  sceneState.floorBoundaryRatios = boundaryRatios;

  configureStageLayout(total);

  if (total > 0) {
    const roofGuide = document.createElement("div");
    roofGuide.className = "floor-guide floor-guide-roof";
    roofGuide.dataset.floor = `${floorNumbers[total - 1]}-top`;
    roofGuide.style.top = "0";
    floorGuidesEl.appendChild(roofGuide);
  }

  resizeStageHeight(floorNumbers.length);
  requestElevatorSizeUpdate();
  window.requestAnimationFrame(cacheFloorCenters);
}

function configureStageLayout(floorCount) {
  const layout = sceneState.layout;
  const elevatorCount = Math.max(elevatorNodes.size || 0, 1);
  const floors = Math.max(floorCount, 1);
  const viewportHeight = visualViewportEl?.clientHeight ?? window.innerHeight ?? 760;
  const viewportWidth = visualViewportEl?.clientWidth ?? window.innerWidth ?? 1280;
  const availableHeight = Math.max(viewportHeight - 260, 420);
  let floorUnit = Math.round(availableHeight / Math.max(floors + 2, 8));
  floorUnit = Math.max(18, Math.min(64, floorUnit));
  if (floors > 48) {
    floorUnit = Math.max(16, Math.round(floorUnit * 0.82));
  } else if (floors > 32) {
    floorUnit = Math.max(17, Math.round(floorUnit * 0.88));
  } else if (floors > 20) {
    floorUnit = Math.max(18, Math.round(floorUnit * 0.92));
  }

  const cabinHeight = Math.round(Math.max(18, Math.min(floorUnit * 0.62, 52)));
  const paddingBottom = Math.max(20, Math.round(cabinHeight * 0.9));
  const paddingTop = Math.max(cabinHeight + 24, Math.round(floorUnit * 1.1));
  const buildingPaddingX = Math.max(22, Math.round(30 - Math.min(elevatorCount, 6) * 2));
  const shaftPadding = buildingPaddingX + Math.max(14, Math.round(10 + Math.min(elevatorCount, 6)));
  const queueBase = 180 + elevatorCount * 14;
  const queueMax = Math.max(240, Math.min(340, Math.round(viewportWidth * 0.22)));
  const queueWidth = Math.round(Math.min(queueMax, Math.max(200, queueBase)));
  const travelHeight = Math.max(floors - 1, 0) * floorUnit;
  const stageHeight = Math.max(travelHeight + paddingTop + paddingBottom, 520);

  layout.paddingTop = paddingTop;
  layout.paddingBottom = paddingBottom;
  layout.buildingPaddingX = buildingPaddingX;
  layout.shaftPaddingLeft = shaftPadding;
  layout.shaftPaddingRight = shaftPadding;
  layout.queueWidth = queueWidth;
  layout.floorUnit = floorUnit;
  layout.cabinHeight = cabinHeight;

  sceneState.stageHeightPx = stageHeight;
  sceneState.travelHeightPx = travelHeight;
  sceneState.floorPixelRange = { start: 0, end: travelHeight };
  sceneState.cabinHeightPx = cabinHeight;

  if (visualCanvasEl) {
    visualCanvasEl.style.setProperty("--floor-padding-top", `${layout.paddingTop}px`);
    visualCanvasEl.style.setProperty("--floor-padding-bottom", `${layout.paddingBottom}px`);
    visualCanvasEl.style.setProperty("--building-padding-x", `${layout.buildingPaddingX}px`);
    visualCanvasEl.style.setProperty("--shaft-padding-left", `${layout.shaftPaddingLeft}px`);
    visualCanvasEl.style.setProperty("--shaft-padding-right", `${layout.shaftPaddingRight}px`);
    visualCanvasEl.style.setProperty("--queue-width", `${layout.queueWidth}px`);
    visualCanvasEl.style.setProperty("--floor-unit", `${layout.floorUnit}px`);
  }
  if (visualStageEl) {
    visualStageEl.style.minHeight = `${stageHeight}px`;
  }
}

function resizeStageHeight(floorCount) {
  if (!visualCanvasEl) {
    return;
  }
  const stageHeight = Math.max(sceneState.stageHeightPx || 0, 520);
  visualCanvasEl.style.height = `${stageHeight}px`;
  if (visualStageEl) {
    visualStageEl.style.minHeight = `${stageHeight}px`;
  }
}

function syncElevatorShafts(elevators) {
  if (!shaftContainer) {
    return;
  }
  const seen = new Set();
  elevators.forEach((elevator, index) => {
    let node = elevatorNodes.get(elevator.id);
    if (!node) {
      node = createElevatorVisual(elevator);
    }
    seen.add(elevator.id);
    const desiredChild = shaftContainer.children[index];
    if (desiredChild !== node.shaft) {
      shaftContainer.insertBefore(node.shaft, desiredChild || null);
    }
  });

  Array.from(elevatorNodes.keys()).forEach((id) => {
    if (!seen.has(id)) {
      const node = elevatorNodes.get(id);
      if (node) {
        node.shaft.remove();
      }
      elevatorNodes.delete(id);
    }
  });
  configureStageLayout(sceneState.floorNumbers.length || 0);
  requestElevatorSizeUpdate();
}

function createElevatorVisual(elevator) {
  const shaft = document.createElement("div");
  shaft.className = "shaft";
  shaft.dataset.elevatorId = String(elevator.id);

  const cabin = document.createElement("div");
  cabin.className = "elevator-cabin";
  cabin.dataset.direction = "idle";
  cabin.dataset.doors = "closed";
  cabin.dataset.status = "stopped";
  cabin.dataset.load = "empty";

  const header = document.createElement("div");
  header.className = "cabin-header";

  const idEl = document.createElement("span");
  idEl.className = "cabin-id";
  idEl.textContent = `#${elevator.id}`;
  header.appendChild(idEl);

  const targetEl = document.createElement("span");
  targetEl.className = "cabin-target";
  targetEl.textContent = `→ ${formatTargetFloor(elevator.target)}`;
  header.appendChild(targetEl);

  cabin.appendChild(header);

  const interior = document.createElement("div");
  interior.className = "cabin-interior";

  const passengersEl = document.createElement("div");
  passengersEl.className = "cabin-passengers";
  interior.appendChild(passengersEl);

  const doors = document.createElement("div");
  doors.className = "cabin-doors";
  doors.dataset.state = "closed";

  const doorLeft = document.createElement("div");
  doorLeft.className = "cabin-door left";
  doors.appendChild(doorLeft);

  const doorRight = document.createElement("div");
  doorRight.className = "cabin-door right";
  doors.appendChild(doorRight);

  interior.appendChild(doors);
  cabin.appendChild(interior);

  shaft.appendChild(cabin);
  shaftContainer.appendChild(shaft);

  const node = {
    shaft,
    cabin,
    targetEl,
    passengersEl,
    interior,
    doors,
    lastTarget: elevator.target,
    passengerCount: 0,
    flashTimer: null,
    snapshot: null,
  };
  applyCabinSizing(node);
  updateElevatorVisual(node, elevator);
  elevatorNodes.set(elevator.id, node);
  window.requestAnimationFrame(cacheFloorCenters);
  return node;
}

function updateElevatorScene(state) {
  const elevators = Array.isArray(state.elevators) ? state.elevators : [];
  elevators.forEach((elevator) => {
    const node = elevatorNodes.get(elevator.id);
    if (!node) {
      return;
    }
    updateElevatorVisual(node, elevator);
  });
}

function updateElevatorVisual(node, elevator) {
  const direction = normalizeDirection(elevator.direction);
  if (node.cabin.dataset.direction !== direction) {
    node.cabin.dataset.direction = direction;
  }

  const rawStatus = typeof elevator.status === "string" ? elevator.status : elevator.run_status || "";
  const status = rawStatus ? String(rawStatus).toLowerCase() : "stopped";
  if (status && node.cabin.dataset.status !== status) {
    node.cabin.dataset.status = status;
  }
  const movingStatuses = new Set(["start_up", "start_down", "constant_speed"]);
  const isMoving = movingStatuses.has(status);
  node.cabin.classList.toggle("is-moving", isMoving);

  const doorState = status === "stopped" ? "open" : "closed";
  if (node.cabin.dataset.doors !== doorState) {
    node.cabin.dataset.doors = doorState;
  }
  if (node.doors && node.doors.dataset.state !== doorState) {
    node.doors.dataset.state = doorState;
  }
  const doorHold = ensureNumber(elevator.door_hold_ticks);
  if (Number.isFinite(doorHold)) {
    sceneState.doorHoldMax = Math.max(sceneState.doorHoldMax, doorHold, 2);
  }
  let doorProgress = 0;
  if (status === "stopped") {
    doorProgress = 1;
  } else if (doorHold > 0) {
    doorProgress = Math.min(1, doorHold / Math.max(sceneState.doorHoldMax, 1));
  }
  node.cabin.style.setProperty("--door-progress", doorProgress.toFixed(3));
  if (node.doors) {
    node.doors.style.setProperty("--door-progress", doorProgress.toFixed(3));
  }

  let cabinTilt = 0;
  let cabinShift = 0;
  if (isMoving && direction !== "idle") {
    const easing = Math.min(1, 1 / Math.max(currentSpeedFactor, 0.4));
    const baseTilt = direction === "up" ? -0.65 : 0.65;
    const baseShift = direction === "up" ? -2.4 : -1.2;
    cabinTilt = baseTilt * easing;
    cabinShift = baseShift * easing;
  }
  node.cabin.style.setProperty("--cabin-tilt", `${cabinTilt.toFixed(3)}deg`);
  node.cabin.style.setProperty("--cabin-shift", `${cabinShift.toFixed(3)}px`);

  const loadFactor = ensureNumber(elevator.load_factor);
  let loadState = "empty";
  if (loadFactor >= 0.8) {
    loadState = "full";
  } else if (loadFactor >= 0.4) {
    loadState = "mid";
  } else if (loadFactor > 0.05) {
    loadState = "light";
  }
  node.cabin.dataset.load = loadState;

  if (node.lastTarget !== elevator.target) {
    node.targetEl.textContent = `→ ${formatTargetFloor(elevator.target)}`;
    node.cabin.classList.add("flash");
    if (node.flashTimer) {
      clearTimeout(node.flashTimer);
    }
    const flashDuration = Math.max(240, Math.round(600 / Math.max(currentSpeedFactor, 0.25)));
    node.flashTimer = window.setTimeout(() => {
      node.cabin.classList.remove("flash");
      node.flashTimer = null;
    }, flashDuration);
    node.lastTarget = elevator.target;
  }

  const { min: metaMin, max: metaMax } = sceneState.floorMeta;
  const rawFloorValue = ensureNumber(elevator.current, metaMin);
  const currentFloor = Math.min(metaMax, Math.max(metaMin, rawFloorValue));
  const shaftHeight = node.shaft.clientHeight || sceneState.shaftHeightPx || 0;
  const baseHeight = sceneState.shaftHeightPx || shaftHeight;
  const cabinHeight = node.cabin.offsetHeight || sceneState.cabinHeightPx || 0;
  const halfCabin = cabinHeight / 2;
  let bottomPx = interpolateFloorMetric(sceneState.floorLevelsPx, currentFloor);
  const rangeStart = sceneState.floorPixelRange?.start ?? 0;
  const rangeEndFallback =
    sceneState.floorPixelRange?.end ??
    (Number.isFinite(sceneState.travelHeightPx) ? sceneState.travelHeightPx : baseHeight);

  if (!Number.isFinite(bottomPx)) {
    const boundaryRatioFallback = getFloorBoundaryRatio(currentFloor);
    if (Number.isFinite(boundaryRatioFallback)) {
      const rangeSpan = Math.max(0, rangeEndFallback - rangeStart);
      bottomPx = rangeStart + boundaryRatioFallback * rangeSpan;
    }
  }

  if (!Number.isFinite(bottomPx)) {
    let centerPx = interpolateFloorMetric(sceneState.floorCentersPx, currentFloor);
    if (!Number.isFinite(centerPx)) {
      const centerRatioFallback = getFloorCenterRatio(currentFloor);
      if (Number.isFinite(centerRatioFallback)) {
        const rangeSpan = Math.max(0, rangeEndFallback - rangeStart);
        centerPx = rangeStart + centerRatioFallback * rangeSpan;
      }
    }
    if (Number.isFinite(centerPx)) {
      bottomPx = centerPx - halfCabin;
    }
  }

  const travelHeight =
    Number.isFinite(sceneState.travelHeightPx) && sceneState.travelHeightPx >= 0
      ? sceneState.travelHeightPx
      : Math.max(0, shaftHeight - cabinHeight);
  const rangeEnd = Math.max(rangeStart, Math.min(rangeEndFallback, travelHeight));
  let clampedBottom = Number.isFinite(bottomPx) ? bottomPx : rangeStart;
  clampedBottom = Math.max(rangeStart, Math.min(rangeEnd, clampedBottom));
  node.cabin.style.bottom = `${clampedBottom}px`;
  node.snapshot = { ...elevator };
}

function updatePassengerVisuals(passengers) {
  if (!waitingAreaEl) {
    return;
  }
  const passengerList = Array.isArray(passengers) ? passengers : [];
  const waitingMap = new Map();
  const elevatorMap = new Map();
  const seenIds = new Set();
  const layerRect = motionLayer ? motionLayer.getBoundingClientRect() : null;
  let totalWaitingUp = 0;
  let totalWaitingDown = 0;

  passengerList.forEach((raw) => {
    const snapshot = normalizePassengerSnapshot(raw);
    if (!snapshot) {
      return;
    }

     // 取消的乘客直接从可视化中移除
    if (snapshot.status === "cancelled") {
      passengerRegistry.delete(snapshot.id);
      return;
    }

    seenIds.add(snapshot.id);
    const prev = passengerRegistry.get(snapshot.id);
    if (prev) {
      handlePassengerTransition(prev, snapshot, layerRect);
    }
    passengerRegistry.set(snapshot.id, snapshot);

    if (snapshot.status === "waiting") {
      const entry = waitingMap.get(snapshot.origin) || { up: [], down: [] };
      entry[snapshot.directionKey].push(snapshot);
      waitingMap.set(snapshot.origin, entry);
    } else if (snapshot.status === "in_elevator" && snapshot.elevator !== null) {
      const load = elevatorMap.get(snapshot.elevator) || [];
      load.push(snapshot);
      elevatorMap.set(snapshot.elevator, load);
    }
  });

  // 移除已经不存在的乘客缓存
  passengerRegistry.forEach((value, key) => {
    if (!seenIds.has(key)) {
      passengerRegistry.delete(key);
    }
  });

  waitingNodes.forEach((entry, floor) => {
    const waitEntry = waitingMap.get(floor) || { up: [], down: [] };
    totalWaitingUp += waitEntry.up.length;
    totalWaitingDown += waitEntry.down.length;
    renderPassengerGroup(entry.up, waitEntry.up, "waiting-up", 10);
    renderPassengerGroup(entry.down, waitEntry.down, "waiting-down", 10);
    entry.upCount = waitEntry.up.length;
    entry.downCount = waitEntry.down.length;
    entry.root.classList.toggle("inactive", waitEntry.up.length + waitEntry.down.length === 0);
    if (waitEntry.up.length + waitEntry.down.length === 0 && !entry.highlightTimer) {
      entry.root.classList.remove("is-boarding", "is-alighting");
      if (entry.guide) {
        entry.guide.classList.remove("is-boarding", "is-alighting");
      }
      if (entry.label) {
        entry.label.classList.remove("highlight");
      }
    }
  });

  elevatorNodes.forEach((node, elevatorId) => {
    const load = elevatorMap.get(elevatorId) || [];
    renderPassengerGroup(node.passengersEl, load, "in-elevator", 7);
    node.passengerCount = load.length;
  });

  if (queueSummaryEl) {
    const total = totalWaitingUp + totalWaitingDown;
    if (total === 0) {
      queueSummaryEl.textContent = "无乘客排队";
      queueSummaryEl.classList.remove("has-data");
    } else {
      queueSummaryEl.textContent = `↑${totalWaitingUp} / ↓${totalWaitingDown}`;
      queueSummaryEl.classList.add("has-data");
    }
  }
}

function updateElevatorCards(elevators) {
  if (!elevatorContainer) {
    return;
  }
  elevatorContainer.innerHTML = "";
  elevators.forEach((elevator) => {
    const currentFloor = ensureNumber(elevator.current);
    const loadPercent = Math.round(ensureNumber(elevator.load_factor) * 100);
    const passengerCount = ensureNumber(elevator.passenger_count);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <h3>电梯 #${elevator.id}</h3>
      <span>楼层：${currentFloor.toFixed(1)} → ${formatTargetFloor(
        elevator.target
      )}</span>
      <span>方向：${translateDirection(elevator.direction)}</span>
      <span>状态：${translateStatus(elevator.status)}</span>
      <span>乘客：${passengerCount}人，载重比 ${loadPercent}%</span>
      <span>车内目标：${
        elevator.pressed_floors.length ? elevator.pressed_floors.join(", ") : "-"
      }</span>
    `;
    elevatorContainer.appendChild(card);
  });
}

function updateFloorTable(floors) {
  if (!floorTableBody) {
    return;
  }
  floorTableBody.innerHTML = "";
  floors
    .slice()
    .sort((a, b) => b.floor - a.floor)
    .forEach((floor) => {
      const displayFloor = formatFloorLabel(floor.floor);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${displayFloor}</td>
        <td>${floor.up_waiting}</td>
        <td>${floor.down_waiting}</td>
        <td>${floor.total}</td>
      `;
      floorTableBody.appendChild(tr);
    });
}

function updateMetrics(metrics) {
  if (!metricsList) {
    return;
  }
  metricsList.innerHTML = "";
  Object.entries(metrics).forEach(([key, value]) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${translateMetric(key)}</strong><br />${formatMetricValue(
      key,
      value
    )}`;
    metricsList.appendChild(li);
  });
}

function normalizePassengerSnapshot(raw) {
  if (!raw || raw.id === undefined || raw.id === null) {
    return null;
  }
  const status = String(raw.status || "").toLowerCase();
  const origin = ensureNumber(raw.origin);
  const destination = ensureNumber(raw.destination);
  const direction = destination > origin ? "up" : destination < origin ? "down" : "idle";
  const directionKey = direction === "down" ? "down" : "up";
  const elevatorCandidate =
    raw.elevator ?? raw.current_elevator ?? raw.currentElevator ?? raw.elevator_id ?? raw.elevatorId;
  let elevator = null;
  if (typeof elevatorCandidate === "number" && Number.isFinite(elevatorCandidate)) {
    elevator = elevatorCandidate;
  } else if (typeof elevatorCandidate === "string" && elevatorCandidate.trim() !== "") {
    const parsed = Number(elevatorCandidate);
    if (Number.isFinite(parsed)) {
      elevator = parsed;
    }
  }
  return {
    id: Number(raw.id),
    status,
    origin,
    destination,
    direction,
    directionKey,
    elevator: elevator !== null && Number.isFinite(elevator) ? Number(elevator) : null,
  };
}

function handlePassengerTransition(prev, next, layerRect) {
  if (!layerRect || !motionLayer || prev.status === next.status) {
    return;
  }
  if (prev.status === "waiting" && next.status === "in_elevator" && next.elevator !== null) {
    const floorEntry = waitingNodes.get(prev.origin);
    const queueEl = floorEntry ? floorEntry[prev.directionKey] : null;
    const elevatorNode = elevatorNodes.get(next.elevator);
    if (queueEl && elevatorNode) {
      if (floorEntry?.root) {
        floorEntry.root.classList.remove("is-alighting");
        floorEntry.root.classList.add("is-boarding");
        if (floorEntry.highlightTimer) {
          clearTimeout(floorEntry.highlightTimer);
        }
        if (floorEntry.label) {
          floorEntry.label.classList.add("highlight");
        }
        const highlightKeep = Math.max(360, Math.round(900 / Math.max(currentSpeedFactor, 0.25)));
        floorEntry.highlightTimer = window.setTimeout(() => {
          floorEntry.root.classList.remove("is-boarding");
          if (floorEntry.guide) {
            floorEntry.guide.classList.remove("is-boarding");
          }
          if (floorEntry.label) {
            floorEntry.label.classList.remove("highlight");
          }
          floorEntry.highlightTimer = null;
        }, highlightKeep);
        if (floorEntry.guide) {
          floorEntry.guide.classList.remove("is-alighting");
          floorEntry.guide.classList.add("is-boarding");
        }
      }
      if (elevatorNode.cabin) {
        elevatorNode.cabin.classList.add("boarding");
        const boardingHold = Math.max(360, Math.round(1100 / Math.max(currentSpeedFactor, 0.25)));
        window.setTimeout(() => {
          elevatorNode.cabin.classList.remove("boarding");
        }, boardingHold);
      }
      if (elevatorNode.passengersEl) {
        elevatorNode.passengersEl.classList.add("is-boarding");
        window.setTimeout(() => {
          elevatorNode.passengersEl.classList.remove("is-boarding");
        }, Math.max(360, Math.round(900 / Math.max(currentSpeedFactor, 0.25))));
      }
      const doorTarget =
        elevatorNode.doors && layerRect ? getElementCenterRelative(elevatorNode.doors, layerRect) : null;
      spawnPassengerGhost(queueEl, elevatorNode.cabin, `waiting-${prev.directionKey}`, "boarding", layerRect, {
        duration: 820 + Math.random() * 220,
        startOffset: { x: (Math.random() - 0.5) * 14, y: -8 + Math.random() * 8 },
        endOffset: { x: (Math.random() - 0.5) * 12, y: -16 + Math.random() * 12 },
        overrideEnd: doorTarget || undefined,
        endOpacity: 0.06,
      });
    }
  } else if (prev.status === "in_elevator" && next.status === "completed" && prev.elevator !== null) {
    const elevatorNode = elevatorNodes.get(prev.elevator);
    const floorEntry = waitingNodes.get(next.destination);
    if (elevatorNode && floorEntry) {
      if (floorEntry?.root) {
        floorEntry.root.classList.remove("is-boarding");
        floorEntry.root.classList.add("is-alighting");
        if (floorEntry.highlightTimer) {
          clearTimeout(floorEntry.highlightTimer);
        }
        if (floorEntry.label) {
          floorEntry.label.classList.add("highlight");
        }
        const highlightKeep = Math.max(400, Math.round(1000 / Math.max(currentSpeedFactor, 0.25)));
        floorEntry.highlightTimer = window.setTimeout(() => {
          floorEntry.root.classList.remove("is-alighting");
          if (floorEntry.guide) {
            floorEntry.guide.classList.remove("is-alighting");
          }
          if (floorEntry.label) {
            floorEntry.label.classList.remove("highlight");
          }
          floorEntry.highlightTimer = null;
        }, highlightKeep);
        if (floorEntry.guide) {
          floorEntry.guide.classList.remove("is-boarding");
          floorEntry.guide.classList.add("is-alighting");
        }
      }
      if (elevatorNode.cabin) {
        elevatorNode.cabin.classList.add("alighting");
        const alightHold = Math.max(360, Math.round(1100 / Math.max(currentSpeedFactor, 0.25)));
        window.setTimeout(() => {
          elevatorNode.cabin.classList.remove("alighting");
        }, alightHold);
      }
      if (elevatorNode.passengersEl) {
        elevatorNode.passengersEl.classList.add("is-alighting");
        window.setTimeout(() => {
          elevatorNode.passengersEl.classList.remove("is-alighting");
        }, Math.max(360, Math.round(900 / Math.max(currentSpeedFactor, 0.25))));
      }
      const doorTarget =
        elevatorNode.doors && layerRect ? getElementCenterRelative(elevatorNode.doors, layerRect) : null;
      spawnPassengerGhost(elevatorNode.cabin, floorEntry.root, "departing", "departing", layerRect, {
        duration: 920 + Math.random() * 240,
        startOffset: { x: (Math.random() - 0.5) * 22, y: -12 + Math.random() * 10 },
        endOffset: { x: (Math.random() - 0.5) * 38, y: (Math.random() - 0.5) * 30 },
        overrideStart: doorTarget || undefined,
        endOpacity: 0.02,
      });
    }
  } else if (prev.status === "waiting" && next.status === "completed") {
    const floorEntry = waitingNodes.get(next.destination);
    if (floorEntry) {
      spawnPassengerGhost(floorEntry.root, floorEntry.root, "departing", "departing", layerRect, {
        duration: 520,
        endOffset: { x: (Math.random() - 0.5) * 20, y: -14 + Math.random() * 6 },
        endOpacity: 0,
      });
    }
  }
}

function renderPassengerGroup(container, passengers, variant, maxIcons) {
  if (!container) {
    return;
  }
  const items = Array.isArray(passengers) ? passengers : [];
  container.innerHTML = "";
  const isQueue = variant !== "in-elevator";
  container.classList.toggle("queue-container", isQueue);
  container.style.display = items.length ? "flex" : isQueue ? "none" : "flex";
  if (!items.length) {
    return;
  }
  const iconCount = Math.min(items.length, maxIcons);
  for (let i = 0; i < iconCount; i += 1) {
    const passenger = items[i];
    const icon = document.createElement("span");
    icon.className = `passenger-icon passenger-shape ${variant}`;
    icon.style.setProperty("--i", String(i));
    if (passenger?.direction) {
      icon.classList.add(`direction-${passenger.direction}`);
    }
    if (passenger?.status) {
      icon.dataset.status = passenger.status;
    }
    if (isQueue) {
      icon.classList.add("queue-icon");
    } else {
      icon.classList.add("cabin-icon");
    }
    if (passenger?.id !== undefined) {
      icon.title = `乘客 #${passenger.id}${
        passenger.destination !== undefined ? ` → ${passenger.destination}` : ""
      }`;
    }
    container.appendChild(icon);
  }
  if (items.length > iconCount) {
    const more = document.createElement("span");
    more.className = "passenger-more";
    more.textContent = `+${items.length - iconCount}`;
    container.appendChild(more);
  }
}

function spawnPassengerGhost(startEl, endEl, variant, mode, layerRect, options = {}) {
  if (!startEl || !endEl || !motionLayer) {
    return;
  }
  const {
    duration = 720,
    startOffset = { x: 0, y: 0 },
    endOffset = { x: 0, y: 0 },
    overrideStart,
    overrideEnd,
    endOpacity = 0.1,
  } = options;

  const effectiveDuration = Math.max(220, duration / Math.max(currentSpeedFactor, 0.25));

  const startPoint = overrideStart || getElementCenterRelative(startEl, layerRect);
  const endPoint = overrideEnd || getElementCenterRelative(endEl, layerRect);
  if (!startPoint || !endPoint) {
    return;
  }

  const ghost = document.createElement("div");
  ghost.className = `passenger-ghost passenger-shape ${variant} ${mode}`;
  motionLayer.appendChild(ghost);
  pruneMotionLayer();

  const baseX = endPoint.x + endOffset.x;
  const baseY = endPoint.y + endOffset.y;
  const startX = startPoint.x + startOffset.x;
  const startY = startPoint.y + startOffset.y;
  const midX = (startX + baseX) / 2 + (Math.random() - 0.5) * 30;
  const midY = (startY + baseY) / 2 + (Math.random() - 0.5) * 24;

  const deltaStartX = startX - baseX;
  const deltaStartY = startY - baseY;
  const deltaMidX = midX - baseX;
  const deltaMidY = midY - baseY;

  ghost.style.left = `${baseX}px`;
  ghost.style.top = `${baseY}px`;
  ghost.style.opacity = 0;
  ghost.style.transform = `translate(${deltaStartX}px, ${deltaStartY}px) scale(0.86)`;

  if (typeof ghost.animate === "function") {
    let keyframes;
    if (mode === "boarding") {
      const doorX = startX + (baseX - startX) * 0.55 + (Math.random() - 0.5) * 18;
      const doorY = startY + (baseY - startY) * 0.35 + (Math.random() - 0.5) * 18;
      const deltaDoorX = doorX - baseX;
      const deltaDoorY = doorY - baseY;
      keyframes = [
        {
          transform: `translate(${deltaStartX}px, ${deltaStartY}px) scale(0.82)`,
          opacity: 0,
        },
        {
          transform: `translate(${deltaMidX}px, ${deltaMidY}px) scale(1.02)`,
          opacity: 0.92,
          offset: 0.38,
        },
        {
          transform: `translate(${deltaDoorX}px, ${deltaDoorY}px) scale(0.96)`,
          opacity: 0.86,
          offset: 0.72,
        },
        {
          transform: `translate(${endOffset.x}px, ${endOffset.y}px) scale(0.92)`,
          opacity: endOpacity,
        },
      ];
    } else if (mode === "departing") {
      const doorX = startX + (baseX - startX) * 0.28 + (Math.random() - 0.5) * 22;
      const doorY = startY + (baseY - startY) * 0.25 + (Math.random() - 0.5) * 18;
      const crowdX = startX + (baseX - startX) * 0.65 + (Math.random() - 0.5) * 28;
      const crowdY = startY + (baseY - startY) * 0.6 + (Math.random() - 0.5) * 28;
      const deltaDoorX = doorX - baseX;
      const deltaDoorY = doorY - baseY;
      const deltaCrowdX = crowdX - baseX;
      const deltaCrowdY = crowdY - baseY;
      keyframes = [
        {
          transform: `translate(${deltaStartX}px, ${deltaStartY}px) scale(0.9)`,
          opacity: 0.95,
        },
        {
          transform: `translate(${deltaDoorX}px, ${deltaDoorY}px) scale(0.98)`,
          opacity: 0.9,
          offset: 0.3,
        },
        {
          transform: `translate(${deltaCrowdX}px, ${deltaCrowdY}px) scale(0.94)`,
          opacity: 0.7,
          offset: 0.68,
        },
        {
          transform: `translate(${endOffset.x}px, ${endOffset.y}px) scale(0.9)`,
          opacity: endOpacity,
        },
      ];
    } else {
      keyframes = [
        {
          transform: `translate(${deltaStartX}px, ${deltaStartY}px) scale(0.86)`,
          opacity: 0,
        },
        {
          transform: `translate(${deltaMidX}px, ${deltaMidY}px) scale(1)`,
          opacity: 1,
          offset: 0.65,
        },
        {
          transform: `translate(${endOffset.x}px, ${endOffset.y}px) scale(0.92)`,
          opacity: endOpacity,
        },
      ];
    }

    const animation = ghost.animate(keyframes, {
      duration: effectiveDuration,
      easing: "cubic-bezier(0.32, 0.01, 0.15, 1)",
      fill: "forwards",
    });

    animation.onfinish = () => {
      ghost.style.transform = `translate(${endOffset.x}px, ${endOffset.y}px) scale(0.92)`;
      ghost.style.opacity = endOpacity;
      ghost.classList.add("fading");
      const cleanupDelay = Math.max(120, Math.round(240 / Math.max(currentSpeedFactor, 0.25)));
      window.setTimeout(() => ghost.remove(), cleanupDelay);
    };
    animation.oncancel = () => ghost.remove();
  } else {
    ghost.style.transition = `left ${effectiveDuration}ms cubic-bezier(0.32, 0.01, 0.15, 1), top ${effectiveDuration}ms cubic-bezier(0.32, 0.01, 0.15, 1), opacity ${Math.max(
      240,
      420 / Math.max(currentSpeedFactor, 0.25)
    )}ms ease`;
    ghost.style.transform = "translate(0, 0)";
    ghost.style.left = `${startX}px`;
    ghost.style.top = `${startY}px`;
    ghost.style.opacity = 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ghost.style.left = `${baseX}px`;
        ghost.style.top = `${baseY}px`;
        ghost.style.opacity = endOpacity;
        ghost.style.transform = `translate(${endOffset.x}px, ${endOffset.y}px) scale(0.92)`;
      });
    });
    setTimeout(() => {
      ghost.classList.add("fading");
    }, Math.max(120, effectiveDuration - Math.max(160, 160 / Math.max(currentSpeedFactor, 0.25))));
    setTimeout(() => {
      ghost.remove();
    }, effectiveDuration + Math.max(200, 260 / Math.max(currentSpeedFactor, 0.25)));
  }
}

function getElementCenterRelative(element, layerRect) {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - layerRect.left,
    y: rect.top + rect.height / 2 - layerRect.top,
  };
}

function formatTargetFloor(target) {
  if (target === null || target === undefined) {
    return "-";
  }
  return target;
}

function interpolateFloorRatio(ratios, floors, value) {
  if (!(ratios instanceof Map) || !ratios.size || !Array.isArray(floors) || !floors.length) {
    return null;
  }
  if (ratios.has(value)) {
    const direct = ratios.get(value);
    if (Number.isFinite(direct)) {
      return direct;
    }
  }
  const first = floors[0];
  const last = floors[floors.length - 1];
  if (value <= first) {
    const lower = ratios.get(first);
    return Number.isFinite(lower) ? lower : null;
  }
  if (value >= last) {
    const upper = ratios.get(last);
    return Number.isFinite(upper) ? upper : null;
  }
  for (let i = 1; i < floors.length; i += 1) {
    const upperFloor = floors[i];
    if (upperFloor >= value) {
      const lowerFloor = floors[i - 1];
      const lowerRatio = ratios.get(lowerFloor);
      const upperRatio = ratios.get(upperFloor);
      if (!Number.isFinite(lowerRatio) || !Number.isFinite(upperRatio)) {
        break;
      }
      const span = upperFloor - lowerFloor;
      const t = span > 0 ? Math.min(1, Math.max(0, (value - lowerFloor) / span)) : 0;
      return lowerRatio + (upperRatio - lowerRatio) * t;
    }
  }
  return null;
}

function getFloorCenterRatio(floorValue) {
  const ratios = sceneState.floorCenterRatios;
  const interpolated = interpolateFloorRatio(ratios, sceneState.floorNumbers, floorValue);
  if (Number.isFinite(interpolated)) {
    return Math.min(0.98, Math.max(0.02, interpolated));
  }
  if (sceneState.floorNumbers.length <= 1) {
    return 0.5;
  }
  const first = sceneState.floorNumbers[0];
  const last = sceneState.floorNumbers[sceneState.floorNumbers.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) {
    return 0.5;
  }
  const ratio = (floorValue - first) / (last - first);
  return Math.min(0.98, Math.max(0.02, ratio));
}

function getFloorBoundaryRatio(floorValue) {
  const ratios = sceneState.floorBoundaryRatios;
  const interpolated = interpolateFloorRatio(ratios, sceneState.floorNumbers, floorValue);
  if (Number.isFinite(interpolated)) {
    return Math.min(0.995, Math.max(0, interpolated));
  }
  if (sceneState.floorNumbers.length <= 1) {
    return 0.5;
  }
  const first = sceneState.floorNumbers[0];
  const last = sceneState.floorNumbers[sceneState.floorNumbers.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) {
    return 0.5;
  }
  const ratio = (floorValue - first) / (last - first);
  return Math.min(0.995, Math.max(0, ratio));
}

function interpolateFloorMetric(metricMap, value) {
  if (!(metricMap instanceof Map) || !metricMap.size || !Array.isArray(sceneState.floorNumbers) || !sceneState.floorNumbers.length) {
    return null;
  }
  if (metricMap.has(value)) {
    const direct = metricMap.get(value);
    if (Number.isFinite(direct)) {
      return direct;
    }
  }
  const floors = sceneState.floorNumbers;
  const first = floors[0];
  const last = floors[floors.length - 1];
  if (value <= first) {
    const lower = metricMap.get(first);
    return Number.isFinite(lower) ? lower : null;
  }
  if (value >= last) {
    const upper = metricMap.get(last);
    return Number.isFinite(upper) ? upper : null;
  }
  for (let i = 1; i < floors.length; i += 1) {
    const upperFloor = floors[i];
    if (upperFloor >= value) {
      const lowerFloor = floors[i - 1];
      const lowerValue = metricMap.get(lowerFloor);
      const upperValue = metricMap.get(upperFloor);
      if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue)) {
        break;
      }
      const span = upperFloor - lowerFloor;
      const t = span > 0 ? Math.min(1, Math.max(0, (value - lowerFloor) / span)) : 0;
      return lowerValue + (upperValue - lowerValue) * t;
    }
  }
  return null;
}

function formatFloorLabel(rawFloor) {
  if (!Number.isFinite(rawFloor)) {
    return `${rawFloor}`;
  }
  const minFloor = sceneState.floorNumbers[0];
  if (typeof minFloor === "number" && minFloor >= 0) {
    return `${rawFloor + 1}F`;
  }
  if (rawFloor < 0) {
    return `B${Math.abs(rawFloor)}F`;
  }
  return `${rawFloor}F`;
}

function normalizeDirection(direction) {
  if (direction === "up") {
    return "up";
  }
  if (direction === "down") {
    return "down";
  }
  return "idle";
}

function ensureNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function translateDirection(direction) {
  switch (direction) {
    case "up":
      return "上行";
    case "down":
      return "下行";
    default:
      return "静止";
  }
}

function translateStatus(status) {
  const map = {
    start_up: "加速",
    start_down: "减速",
    constant_speed: "运行",
    stopped: "停止",
  };
  return map[status] || status;
}

function translateMetric(key) {
  const map = {
    completed_passengers: "已完成",
    total_passengers: "总乘客",
    average_floor_wait_time: "平均楼层等待",
    p95_floor_wait_time: "P95楼层等待",
    average_arrival_wait_time: "平均总等待",
    p95_arrival_wait_time: "P95总等待",
    average_travel_time: "平均行程时间",
    p95_travel_time: "P95行程时间",
    total_energy_consumption: "总能耗",
    energy_per_completed_passenger: "人均能耗",
  };
  return map[key] || key;
}

function formatMetricValue(key, value) {
  if (typeof value === "number" && key.includes("wait")) {
    return `${value.toFixed(1)} tick`;
  }
  if (typeof value === "number" && key.includes("travel_time")) {
    return `${value.toFixed(1)} tick`;
  }
  if (typeof value === "number" && key.includes("energy")) {
    return `${value.toFixed(2)} 单位`;
  }
  return value;
}

function updateControls() {
  if (!statusEl || !toggleBtn) {
    return;
  }
  if (controllerRunning) {
    statusEl.textContent = "运行中";
    statusEl.className = "status status-running";
    toggleBtn.textContent = "停止调度";
  } else {
    statusEl.textContent = "未运行";
    statusEl.className = "status status-idle";
    toggleBtn.textContent = "启动调度";
  }
  toggleBtn.disabled = pendingAction;
  updateScenarioControls();
}

async function toggleController() {
  if (!toggleBtn) {
    return;
  }
  pendingAction = true;
  updateControls();
  toggleBtn.textContent = controllerRunning ? "停止中..." : "启动中...";
  const url = controllerRunning ? "/dashboard/stop" : "/dashboard/start";
  try {
    const resp = await fetch(url, { method: "POST" });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.success) {
      const message =
        payload.message ||
        (resp.ok ? "操作失败，请稍后重试" : `操作失败 (HTTP ${resp.status})`);
      alert(message);
    }
  } catch (error) {
    console.error("切换调度状态失败:", error);
    alert("操作失败，请检查终端输出。");
  } finally {
    pendingAction = false;
    updateControls();
    fetchState();
  }
}

if (scenarioSelect) {
  scenarioSelect.addEventListener("change", () => {
    const candidate = parseInt(scenarioSelect.value, 10);
    const activeIndex = getActiveScenarioIndex(currentTrafficInfo);
    if (Number.isNaN(candidate) || activeIndex === candidate) {
      pendingScenarioIndex = null;
    } else {
      pendingScenarioIndex = candidate;
    }
    updateScenarioControls();
  });
}

if (applyScenarioBtn && scenarioSelect) {
  applyScenarioBtn.addEventListener("click", async () => {
    if (scenarioLoading) {
      return;
    }
    const selectedIndex = parseInt(scenarioSelect.value, 10);
    if (Number.isNaN(selectedIndex)) {
      alert("请选择一个有效的测试用例。");
      return;
    }
    scenarioLoading = true;
    updateScenarioControls();
    try {
      const resp = await fetch("/dashboard/traffic/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: selectedIndex }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload.success) {
        const message =
          payload.message ||
          (resp.ok ? "切换测试用例失败，请稍后重试。" : `切换测试用例失败 (HTTP ${resp.status})`);
        alert(message);
        return;
      }
      if (payload.info) {
        currentTrafficInfo = payload.info;
      }
      if (Array.isArray(payload.traffic)) {
        trafficCatalog = payload.traffic;
        renderTrafficOptions(trafficCatalog, currentTrafficInfo);
      } else {
        await fetchTrafficCatalog();
      }
      pendingScenarioIndex = null;
      resetAnimationState();
      fetchState();
    } catch (error) {
      console.error("切换测试用例失败:", error);
      alert("切换测试用例失败，请检查终端输出。");
    } finally {
      scenarioLoading = false;
      updateScenarioControls();
    }
  });
}

if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    if (pendingAction) {
      return;
    }
    toggleController();
  });
}

window.addEventListener("resize", () => requestElevatorSizeUpdate());

initializeStageControls();
initializeSpeedControls();
startPolling(false);
fetchTrafficCatalog();
fetchState();
updateControls();
