class SimpleStageRenderer {
  constructor({ containerEl, floorListEl, headingEl }) {
    this.containerEl = containerEl;
    this.floorListEl = floorListEl;
    this.headingEl = headingEl;
    this.floorRows = new Map();
    this.elevatorIds = [];
    this.displayIdById = new Map();
    this.displayOffset = 0;
  }

  reset() {
    this.floorRows.clear();
    this.elevatorIds = [];
    this.displayIdById.clear();
    this.displayOffset = 0;
    floorDisplayOffset = 0;
    if (this.headingEl) {
      this.headingEl.innerHTML = "";
    }
    if (this.floorListEl) {
      this.floorListEl.innerHTML = "";
    }
    if (this.containerEl) {
      this.containerEl.setAttribute("data-empty", "true");
      this.containerEl.style.removeProperty("--elevator-count");
      this.containerEl.style.removeProperty("--floor-count");
      this.containerEl.style.removeProperty("--floor-scale");
    }
  }

  render({ floors, elevators }) {
    if (!this.floorListEl || !this.headingEl || !this.containerEl) {
      return;
    }
    const floorNumbers = this.prepareFloorNumbers(floors);
    const elevatorIds = this.prepareElevatorIds(elevators);
    if (!floorNumbers.length || !elevatorIds.length) {
      this.reset();
      return;
    }
    const structureChanged =
      floorNumbers.length !== this.floorRows.size ||
      elevatorIds.length !== this.elevatorIds.length ||
      floorNumbers.some((floor) => !this.floorRows.has(floor)) ||
      elevatorIds.some((id, index) => this.elevatorIds[index] !== id);
    if (structureChanged) {
      this.rebuild(floorNumbers, elevatorIds);
    }

    this.containerEl.removeAttribute("data-empty");
    const elevatorCount = Math.max(1, elevatorIds.length);
    const floorCount = Math.max(1, floorNumbers.length);
    const floorScale = Math.max(0.55, Math.min(1, 12 / Math.max(floorCount, 1)));
    this.containerEl.style.setProperty("--elevator-count", String(elevatorCount));
    this.containerEl.style.setProperty("--floor-count", String(floorCount));
    this.containerEl.style.setProperty("--floor-scale", floorScale.toFixed(2));

    const floorMap = new Map();
    floors.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const key = ensureNumber(item.floor, NaN);
      if (Number.isFinite(key)) {
        floorMap.set(key, item);
      }
    });

    this.floorRows.forEach((entry) => {
      entry.rowEl.classList.remove("active");
      entry.upGroup.classList.remove("queue-rise", "queue-drop");
      entry.downGroup.classList.remove("queue-rise", "queue-drop");
      entry.cells.forEach((cellEntry) => {
        const { cell, labelEl, avatarsEl } = cellEntry;
        cell.className = "stage-elevator-cell";
        cell.removeAttribute("data-direction");
        cell.removeAttribute("title");
        cell.dataset.passengers = "0";
        labelEl.textContent = "";
        renderPopulationStrip(avatarsEl, 0, {
          baseScale: 0.95,
          minScale: 0.38,
          maxColumns: 4,
          capacity: 16,
        });
        cellEntry.lastCount = 0;
      });

      const floorData = floorMap.get(entry.floor) || {};
      const up = ensureNumber(
        floorData.up_waiting ?? floorData.up ?? floorData.waiting_up ?? floorData.waitingUp,
        0
      );
      const down = ensureNumber(
        floorData.down_waiting ?? floorData.down ?? floorData.waiting_down ?? floorData.waitingDown,
        0
      );
      const total = ensureNumber(floorData.total ?? floorData.total_waiting ?? up + down, up + down);

      if (entry.lastUp !== undefined) {
        if (up > entry.lastUp) {
          addTransientClass(entry.upGroup, "queue-rise", 700);
        } else if (up < entry.lastUp) {
          addTransientClass(entry.upGroup, "queue-drop", 700);
        }
      }
      if (entry.lastDown !== undefined) {
        if (down > entry.lastDown) {
          addTransientClass(entry.downGroup, "queue-rise", 700);
        } else if (down < entry.lastDown) {
          addTransientClass(entry.downGroup, "queue-drop", 700);
        }
      }

      entry.lastUp = up;
      entry.lastDown = down;

      entry.upEl.textContent = `↑${up}`;
      entry.downEl.textContent = `↓${down}`;
      entry.totalEl.textContent = total > 0 ? `${total}人` : "—";
      renderPopulationStrip(entry.upAvatars, up, {
        baseScale: 0.9,
        minScale: 0.35,
        maxColumns: 6,
        capacity: 42,
      });
      renderPopulationStrip(entry.downAvatars, down, {
        baseScale: 0.9,
        minScale: 0.35,
        maxColumns: 6,
        capacity: 42,
      });
      entry.rowEl.classList.toggle("has-waiting", total > 0);
    });

    const floorsForPlacement = Array.from(this.floorRows.keys()).sort((a, b) => b - a);
    elevators.forEach((elevator) => {
      const id = ensureNumber(elevator.id, NaN);
      if (!Number.isFinite(id)) {
        return;
      }
      const displayFloor = this.pickDisplayFloor(ensureNumber(elevator.current, NaN), floorsForPlacement);
      const entry = this.floorRows.get(displayFloor);
      if (!entry) {
        return;
      }
      const cellEntry = entry.cells.get(id);
      if (!cellEntry) {
        return;
      }
      const { cell, labelEl, avatarsEl } = cellEntry;
      cell.classList.add("occupied");
      const direction = normalizeDirection(elevator.direction);
      cell.dataset.direction = direction;
      const loadPercent = Math.round(ensureNumber(elevator.load_factor, 0) * 100);
      const passengerCount = ensureNumber(elevator.passenger_count, 0);
      const currentFloor = ensureNumber(elevator.current, displayFloor);
      const targetFloor = ensureNumber(elevator.target, currentFloor);
      const currentLabel = formatFloorValue(currentFloor);
      const targetLabel = formatFloorValue(targetFloor);
      let displayId = this.displayIdById.get(id);
      if (displayId === undefined) {
        displayId = this.displayIdById.size;
        this.displayIdById.set(id, displayId);
      }
      labelEl.textContent = `#${displayId}`;
      renderPopulationStrip(avatarsEl, passengerCount, {
        baseScale: 0.95,
        minScale: 0.38,
        maxColumns: 4,
        capacity: 18,
      });
      const previousCount = cellEntry.lastCount ?? 0;
      if (passengerCount > previousCount) {
        addTransientClass(cell, "boarding", 650);
      } else if (passengerCount < previousCount) {
        addTransientClass(cell, "alighting", 650);
      }
      cell.dataset.passengers = String(passengerCount);
      cellEntry.lastCount = passengerCount;
      cell.title = [
        `电梯 #${displayId}`,
        `当前位置：${currentLabel}`,
        `目标：${targetLabel}`,
        `方向：${translateDirection(direction)}`,
        `乘客：${passengerCount}人`,
        `载重：${loadPercent}%`,
      ].join(" | ");
      entry.rowEl.classList.add("active");
    });
  }

  rebuild(floorNumbers, elevatorIds) {
    this.floorRows.clear();
    this.elevatorIds = elevatorIds.slice();
    this.displayIdById.clear();
    elevatorIds.forEach((id, index) => {
      this.displayIdById.set(id, index);
    });
    this.displayOffset = this.calculateDisplayOffset(floorNumbers);
    floorDisplayOffset = this.displayOffset;
    if (this.headingEl) {
      this.headingEl.innerHTML = "";
    }
    if (this.floorListEl) {
      this.floorListEl.innerHTML = "";
    }
    if (this.containerEl) {
      const elevatorCount = Math.max(1, elevatorIds.length);
      this.containerEl.style.setProperty("--elevator-count", String(elevatorCount));
    }

    if (this.headingEl) {
      elevatorIds.forEach((id) => {
        const displayId = this.displayIdById.has(id) ? this.displayIdById.get(id) : this.getDisplayId(id);
        const span = document.createElement("span");
        span.className = "stage-elevator-heading";
        span.textContent = `#${displayId}`;
        this.headingEl.appendChild(span);
      });
    }

    floorNumbers.forEach((floor) => {
      const row = document.createElement("div");
      row.className = "stage-floor-row";
      row.dataset.floor = String(floor);

      const floorLabel = document.createElement("span");
      floorLabel.className = "stage-floor-label";
      floorLabel.textContent = formatFloorLabel(floor);
      row.appendChild(floorLabel);

      const cellsWrapper = document.createElement("div");
      cellsWrapper.className = "stage-elevator-cells";
      const cellMap = new Map();
      elevatorIds.forEach((id, index) => {
        const cell = document.createElement("div");
        cell.className = "stage-elevator-cell";
        cell.dataset.elevator = String(id);

        const labelEl = document.createElement("span");
        labelEl.className = "stage-elevator-label";
        const avatarEl = document.createElement("div");
        avatarEl.className = "person-strip strip-cabin";

        cell.append(labelEl, avatarEl);
        cellsWrapper.appendChild(cell);
        cellMap.set(id, { cell, labelEl, avatarsEl: avatarEl, lastCount: 0 });
      });
      row.appendChild(cellsWrapper);

      const waitingWrapper = document.createElement("div");
      waitingWrapper.className = "stage-waiting";
      const upGroup = document.createElement("div");
      upGroup.className = "stage-waiting-group stage-waiting-up";
      const upEl = document.createElement("span");
      upEl.className = "stage-waiting-count";
      const upAvatars = document.createElement("div");
      upAvatars.className = "person-strip strip-up";
      upGroup.append(upEl, upAvatars);

      const downGroup = document.createElement("div");
      downGroup.className = "stage-waiting-group stage-waiting-down";
      const downEl = document.createElement("span");
      downEl.className = "stage-waiting-count";
      const downAvatars = document.createElement("div");
      downAvatars.className = "person-strip strip-down";
      downGroup.append(downEl, downAvatars);

      const totalEl = document.createElement("span");
      totalEl.className = "stage-waiting-total";

      waitingWrapper.append(upGroup, downGroup, totalEl);
      row.appendChild(waitingWrapper);

      if (this.floorListEl) {
        this.floorListEl.appendChild(row);
      }
      this.floorRows.set(floor, {
        floor,
        rowEl: row,
        cells: cellMap,
        upGroup,
        downGroup,
        upEl,
        downEl,
        totalEl,
        upAvatars,
        downAvatars,
        lastUp: 0,
        lastDown: 0,
      });
    });
  }

  prepareFloorNumbers(floors) {
    const values = Array.isArray(floors) ? floors : [];
    const unique = new Set();
    values.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const floor = ensureNumber(item.floor, NaN);
      if (Number.isFinite(floor)) {
        unique.add(floor);
      }
    });
    return Array.from(unique).sort((a, b) => b - a);
  }

  prepareElevatorIds(elevators) {
    const values = Array.isArray(elevators) ? elevators : [];
    const ids = values
      .map((item) => {
        if (!item || typeof item !== "object") {
          return NaN;
        }
        return ensureNumber(item.id, NaN);
      })
      .filter((id) => Number.isFinite(id));
    ids.sort((a, b) => a - b);
    return ids;
  }

  pickDisplayFloor(value, floors) {
    if (!floors.length) {
      return 0;
    }
    if (!Number.isFinite(value)) {
      return floors[floors.length - 1];
    }
    let closest = floors[0];
    let minDiff = Math.abs(value - closest);
    for (let i = 1; i < floors.length; i += 1) {
      const diff = Math.abs(value - floors[i]);
      if (diff < minDiff) {
        minDiff = diff;
        closest = floors[i];
      }
    }
    return closest;
  }

  getDisplayId(id) {
    if (this.displayIdById.has(id)) {
      return this.displayIdById.get(id);
    }
    const numericId = ensureNumber(id, NaN);
    if (Number.isFinite(numericId)) {
      return numericId;
    }
    return id;
  }

  calculateDisplayOffset(floorNumbers) {
    if (!Array.isArray(floorNumbers) || floorNumbers.length === 0) {
      return 0;
    }
    let min = floorNumbers[0];
    floorNumbers.forEach((floor) => {
      if (Number.isFinite(floor)) {
        min = Math.min(min, floor);
      }
    });
    return min > 0 ? min : 0;
  }
}

let floorDisplayOffset = 0;

const tickEl = document.getElementById("tick");
const lastUpdateEl = document.getElementById("last-update");
const statusEl = document.getElementById("controller-status");
const toggleBtn = document.getElementById("toggle-controller");
const scenarioSelect = document.getElementById("scenario-select");
const scenarioMetaEl = document.getElementById("scenario-meta");
const speedControlsEl = document.getElementById("speed-controls");
const overviewTickEl = document.getElementById("overview-tick");
const overviewStatusEl = document.getElementById("overview-status");
const overviewWaitingEl = document.getElementById("overview-waiting");
const overviewMetricsEl = document.getElementById("overview-metrics");
const overviewTrafficEl = document.getElementById("overview-traffic");
const overviewUpdateEl = document.getElementById("overview-update");
const overviewCompletedEl = document.getElementById("overview-completed");
const overviewCompletionRateEl = document.getElementById("overview-completion-rate");
const stageTrafficEl = document.getElementById("stage-traffic");
const elevatorContainer = document.getElementById("elevator-cards");
const floorTableBody = document.querySelector("#floor-table tbody");
const metricsList = document.getElementById("metrics-list");
const stageMiniMap = document.getElementById("stage-mini-map");

const stageRenderer = new SimpleStageRenderer({
  containerEl: document.getElementById("simple-stage"),
  floorListEl: document.getElementById("stage-floor-list"),
  headingEl: document.getElementById("stage-elevator-headings"),
});

const POLL_BASE_INTERVAL = 900;
const POLL_MIN_INTERVAL = 250;

let controllerRunning = false;
let pendingAction = false;
let scenarioLoading = false;
let pollTimer = null;
let currentSpeedFactor = 1;
let trafficCatalog = [];
let currentTrafficInfo = null;
let pendingScenarioIndex = null;
let previousTick = null;

function ensureNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeDirection(value) {
  if (!value) {
    return "idle";
  }
  const text = String(value).toLowerCase();
  if (text.includes("up")) {
    return "up";
  }
  if (text.includes("down")) {
    return "down";
  }
  return "idle";
}

function formatFloorLabel(value) {
  if (!Number.isFinite(value)) {
    return String(value ?? "--");
  }
  const offset = getFloorDisplayOffset();
  const adjusted = Math.round(value - offset);
  return String(adjusted);
}

function formatFloorValue(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const offset = getFloorDisplayOffset();
  const adjusted = value - offset;
  const rounded = Math.round(adjusted);
  if (Math.abs(adjusted - rounded) < 0.01) {
    return String(rounded);
  }
  return adjusted.toFixed(1);
}

function formatTargetFloor(value) {
  return formatFloorValue(value);
}

function getFloorDisplayOffset() {
  return floorDisplayOffset > 0 ? floorDisplayOffset : 0;
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
  const normalized = String(status || "").toLowerCase();
  const map = {
    start_up: "加速",
    start_down: "减速",
    constant_speed: "运行",
    stopped: "停止",
  };
  return map[normalized] || normalized || "未知";
}

function translateMetric(key) {
  const map = {
    completed_passengers: "已完成",
    total_passengers: "总乘客",
    average_floor_wait_time: "平均楼层等待",
    p95_floor_wait_time: "P95 楼层等待",
    average_arrival_wait_time: "平均总等待",
    p95_arrival_wait_time: "P95 总等待",
    total_energy_consumption: "总能耗",
    energy_per_completed_passenger: "人均能耗",
    last_passenger_tick: "最后乘客出现Tick",
    settlement_tick: "评测结算Tick",
  };
  return map[key] || key;
}

function formatMetricValue(key, value) {
  if (typeof value === "number" && key) {
    if (key.includes("wait")) {
      return `${value.toFixed(1)} tick`;
    }
    if (key.endsWith("_tick") || key === "tick") {
      return `${Math.round(value)} tick`;
    }
  }
  return value;
}

function buildElevatorDisplayMap(elevators) {
  const map = new Map();
  const items = Array.isArray(elevators) ? elevators : [];
  const numericIds = [];
  items.forEach((elevator) => {
    if (!elevator || typeof elevator !== "object") {
      return;
    }
    const id = ensureNumber(elevator.id, NaN);
    if (Number.isFinite(id)) {
      numericIds.push(id);
    }
  });
  numericIds.sort((a, b) => a - b);
  let indexCounter = 0;
  numericIds.forEach((id) => {
    if (!map.has(id)) {
      map.set(id, indexCounter);
      const stringKey = String(id);
      if (!map.has(stringKey)) {
        map.set(stringKey, indexCounter);
      }
      indexCounter += 1;
    }
  });
  items.forEach((elevator) => {
    if (!elevator || typeof elevator !== "object") {
      return;
    }
    const numericId = ensureNumber(elevator.id, NaN);
    if (!Number.isFinite(numericId)) {
      const key = typeof elevator.id !== "undefined" ? elevator.id : indexCounter;
      if (!map.has(key)) {
        map.set(key, indexCounter);
        indexCounter += 1;
      }
    }
  });
  return map;
}

function addTransientClass(element, className, duration = 600) {
  if (!element) {
    return;
  }
  element.classList.remove(className);
  // eslint-disable-next-line no-unused-expressions
  element.offsetWidth;
  element.classList.add(className);
  window.setTimeout(() => {
    element.classList.remove(className);
  }, duration);
}

function renderPopulationStrip(container, count, options = {}) {
  if (!container) {
    return;
  }
  const total = Math.max(0, Math.floor(ensureNumber(count, 0)));
  const baseScale = options.baseScale ?? 1;
  const minScale = options.minScale ?? 0.35;
  const capacity = Math.max(1, options.capacity ?? 24);
  const maxColumns = Math.max(1, options.maxColumns ?? 6);

  container.innerHTML = "";
  container.dataset.occupancy = String(total);
  container.classList.toggle("is-empty", total === 0);

  if (total === 0) {
    container.style.setProperty("--person-scale", baseScale.toFixed(2));
    container.style.setProperty("--person-columns", "1");
    return;
  }

  const scale =
    total <= capacity
      ? baseScale
      : Math.max(minScale, Math.min(baseScale, baseScale * Math.sqrt(capacity / total)));

  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(Math.sqrt(total))));

  container.style.setProperty("--person-scale", scale.toFixed(2));
  container.style.setProperty("--person-columns", String(columns));

  for (let i = 0; i < total; i += 1) {
    const dot = document.createElement("span");
    dot.className = "person-figure";
    if (columns > 1) {
      const columnIndex = i % columns;
      const rowIndex = Math.floor(i / columns);
      const seed = columns > 1 ? (columnIndex + rowIndex * 0.35) / columns : 0;
      dot.style.setProperty("--person-seed", seed.toFixed(2));
    }
    container.appendChild(dot);
  }
}

function renderMiniMap(floors, elevators) {
  if (!stageMiniMap) {
    return;
  }
  const floorItems = Array.isArray(floors) ? floors.slice() : [];
  if (!floorItems.length) {
    stageMiniMap.innerHTML = "";
    return;
  }
  const sortedFloors = floorItems
    .map((item) => ({
      floor: ensureNumber(item.floor, NaN),
      up: ensureNumber(item.up_waiting ?? item.up ?? item.waiting_up ?? item.waitingUp, 0),
      down: ensureNumber(item.down_waiting ?? item.down ?? item.waiting_down ?? item.waitingDown, 0),
      total: ensureNumber(
        item.total ?? item.total_waiting ??
        ensureNumber(item.up_waiting ?? item.up ?? item.waiting_up ?? item.waitingUp, 0) +
          ensureNumber(item.down_waiting ?? item.down ?? item.waiting_down ?? item.waitingDown, 0),
        0
      ),
    }))
    .filter((item) => Number.isFinite(item.floor))
    .sort((a, b) => b.floor - a.floor);

  if (!sortedFloors.length) {
    stageMiniMap.innerHTML = '<div class="mini-map-empty">暂无楼层数据</div>';
    return;
  }

  const maxWaiting = sortedFloors.reduce((acc, item) => Math.max(acc, item.total), 0) || 1;
  const elevatorLoads = new Map();
  const elevatorList = Array.isArray(elevators) ? elevators : [];
  elevatorList.forEach((elevator) => {
    if (!elevator || typeof elevator !== "object") {
      return;
    }
    const approxFloor = Math.round(ensureNumber(elevator.current, NaN));
    if (!Number.isFinite(approxFloor)) {
      return;
    }
    const passengerCount = ensureNumber(elevator.passenger_count, 0);
    if (passengerCount <= 0) {
      return;
    }
    const prev = elevatorLoads.get(approxFloor) ?? 0;
    elevatorLoads.set(approxFloor, prev + passengerCount);
  });

  stageMiniMap.innerHTML = "";
  sortedFloors.forEach((item) => {
    const waiting = item.total;
    const cabin = elevatorLoads.get(item.floor) ?? 0;
    const row = document.createElement("div");
    row.className = "mini-map-row";
    row.dataset.floor = String(item.floor);
    if (waiting > 0) {
      row.classList.add("waiting");
    }
    if (cabin > 0) {
      row.classList.add("active");
    }

    const label = document.createElement("span");
    label.className = "mini-map-label";
    label.innerHTML = `<span>F${formatFloorLabel(item.floor)}</span><span>${waiting}人</span>`;

    const waitingBar = document.createElement("div");
    waitingBar.className = "mini-map-bar waiting";
    waitingBar.style.setProperty("--waiting-ratio", Math.min(waiting / maxWaiting, 1).toFixed(3));

    const cabinBar = document.createElement("div");
    cabinBar.className = "mini-map-bar cabin";
    const cabinRatio = Math.min(cabin / 16, 1);
    cabinBar.style.setProperty("--cabin-ratio", cabinRatio.toFixed(3));

    const note = document.createElement("span");
    note.className = "mini-map-note";
    if (waiting > 0 || cabin > 0) {
      note.textContent = cabin > 0 ? `车内 ${cabin} 人` : "等待中";
    } else {
      note.textContent = "无乘客";
    }

    row.title = `F${formatFloorLabel(item.floor)} 等待 ${waiting} 人，车内 ${cabin} 人`;

    row.append(label, waitingBar, cabinBar, note);
    row.addEventListener("click", () => {
      const target = document.querySelector(
        `.stage-floor-row[data-floor="${item.floor}"]`
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        addTransientClass(target, "mini-map-focus", 900);
      }
    });

    stageMiniMap.appendChild(row);
  });
}

function getPollInterval() {
  const effective = Math.max(currentSpeedFactor, 0.25);
  return Math.max(POLL_MIN_INTERVAL, Math.round(POLL_BASE_INTERVAL / effective));
}

function updateSpeedButtons() {
  if (!speedControlsEl) {
    return;
  }
  const buttons = speedControlsEl.querySelectorAll("button[data-speed]");
  buttons.forEach((button) => {
    const factor = parseFloat(button.dataset.speed || "1");
    const active = Math.abs(factor - currentSpeedFactor) < 0.01;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function setSpeedFactor(factor) {
  const normalized = Math.max(0.25, Math.min(factor, 6));
  if (Math.abs(normalized - currentSpeedFactor) < 0.01) {
    return;
  }
  currentSpeedFactor = normalized;
  updateSpeedButtons();
  startPolling();
}

function initializeSpeedControls() {
  if (!speedControlsEl) {
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
  updateSpeedButtons();
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

async function fetchState() {
  try {
    const resp = await fetch(`/dashboard/state?_=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    renderState(data);
  } catch (error) {
    console.error("获取状态失败:", error);
  }
}

function updateOverview({ running, tick, floors, metrics }) {
  if (overviewStatusEl) {
    overviewStatusEl.textContent = running ? "运行中" : "未运行";
    overviewStatusEl.dataset.state = running ? "running" : "idle";
  }
  if (overviewTickEl) {
    overviewTickEl.textContent = Number.isFinite(tick) ? String(tick) : "--";
  }
  const totalWaiting = floors.reduce(
    (acc, floor) => acc + ensureNumber(floor.total ?? floor.total_waiting ?? 0, 0),
    0
  );
  if (overviewWaitingEl) {
    overviewWaitingEl.textContent = String(totalWaiting);
  }
  const averageWait = ensureNumber(metrics.average_floor_wait_time, 0);
  if (overviewMetricsEl) {
    overviewMetricsEl.textContent = `平均等候 ${averageWait.toFixed(1)} tick`;
  }
  const completedPassengers = ensureNumber(metrics.completed_passengers, 0);
  const totalPassengers = ensureNumber(metrics.total_passengers, 0);
  if (overviewCompletedEl) {
    overviewCompletedEl.textContent =
      totalPassengers > 0 ? `${completedPassengers}/${totalPassengers}` : String(completedPassengers);
  }
  if (overviewCompletionRateEl) {
    const completionRate =
      totalPassengers > 0
        ? `完成率 ${(completedPassengers / Math.max(totalPassengers, 1) * 100).toFixed(1)}%`
        : "完成率 --";
    overviewCompletionRateEl.textContent = completionRate;
  }
}

function updateElevatorCards(elevators) {
  if (!elevatorContainer) {
    return;
  }
  elevatorContainer.innerHTML = "";
  const displayMap = buildElevatorDisplayMap(elevators);
  elevators.forEach((elevator, index) => {
    const currentFloor = ensureNumber(elevator.current, 0);
    const loadPercent = Math.round(ensureNumber(elevator.load_factor, 0) * 100);
    const passengerCount = ensureNumber(elevator.passenger_count, 0);
    const numericId = ensureNumber(elevator.id, NaN);
    const displayKey = Number.isFinite(numericId) ? numericId : elevator.id;
    const displayId = displayMap.has(displayKey) ? displayMap.get(displayKey) : index;
    const currentLabel = formatFloorValue(currentFloor);
    const targetLabel = formatFloorValue(ensureNumber(elevator.target, currentFloor));
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <h3>电梯 #${displayId}</h3>
      <span>楼层：${currentLabel} → ${targetLabel}</span>
      <span>方向：${translateDirection(normalizeDirection(elevator.direction))}</span>
      <span>状态：${translateStatus(elevator.status)}</span>
      <span>乘客：${passengerCount}人，载重比 ${loadPercent}%</span>
      <span>车内目标：${
        Array.isArray(elevator.pressed_floors) && elevator.pressed_floors.length
          ? elevator.pressed_floors.join(", ")
          : "-"
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
    .sort((a, b) => ensureNumber(b.floor, 0) - ensureNumber(a.floor, 0))
    .forEach((floor) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatFloorLabel(ensureNumber(floor.floor, 0))}</td>
        <td>${ensureNumber(floor.up_waiting ?? floor.up ?? 0, 0)}</td>
        <td>${ensureNumber(floor.down_waiting ?? floor.down ?? 0, 0)}</td>
        <td>${ensureNumber(floor.total ?? floor.total_waiting ?? 0, 0)}</td>
      `;
      floorTableBody.appendChild(tr);
    });
}

function updateMetrics(metrics) {
  if (!metricsList) {
    return;
  }
  metricsList.innerHTML = "";
  Object.entries(metrics || {}).forEach(([key, value]) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${translateMetric(key)}</strong><br />${formatMetricValue(key, value)}`;
    metricsList.appendChild(li);
  });
}

function renderScenarioMeta(info) {
  if (!scenarioMetaEl) {
    return;
  }
  if (!info) {
    const fallback = "当前测试：--";
    scenarioMetaEl.textContent = fallback;
    if (overviewTrafficEl) {
      overviewTrafficEl.textContent = fallback;
    }
    if (stageTrafficEl) {
      stageTrafficEl.textContent = fallback;
    }
    return;
  }
  const currentFile = info.current_file && typeof info.current_file === "object" ? info.current_file : {};
  const label = info.label || info.name || info.filename || currentFile.label || currentFile.name;
  const description = info.description || info.summary;
  const parts = [];
  parts.push(`当前测试：${label || "--"}`);
  if (description) {
    parts.push(description);
  }
  const displayText = parts.join(" | ");
  const headline = parts[0] || displayText;
  scenarioMetaEl.textContent = displayText;
  if (overviewTrafficEl) {
    overviewTrafficEl.textContent = headline;
  }
  if (stageTrafficEl) {
    stageTrafficEl.textContent = headline;
  }
}

function getActiveScenarioIndex(info) {
  if (!info) {
    return null;
  }
  if (Number.isFinite(info.current_index)) {
    return info.current_index;
  }
  if (info.current_file && Number.isFinite(info.current_file.index)) {
    return info.current_file.index;
  }
  return null;
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
    return;
  }
  catalog.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item.index);
    const label = item.label || item.name || item.filename || `测试 #${item.index}`;
    option.textContent = label;
    scenarioSelect.appendChild(option);
  });
  const activeIndex = getActiveScenarioIndex(info);
  if (activeIndex !== null) {
    scenarioSelect.value = String(activeIndex);
  }
  scenarioSelect.disabled = false;
  renderScenarioMeta(info);
}

function updateScenarioControls() {
  if (!scenarioSelect) {
    return;
  }
  const noOptions = !trafficCatalog.length;
  const disableSelect = pendingAction || scenarioLoading || controllerRunning || noOptions;
  scenarioSelect.disabled = disableSelect;
  if (!disableSelect && pendingScenarioIndex !== null) {
    scenarioSelect.value = String(pendingScenarioIndex);
  }
}

async function fetchTrafficCatalog() {
  try {
    const resp = await fetch(`/dashboard/traffic/list?_=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const payload = await resp.json();
    trafficCatalog = Array.isArray(payload.traffic) ? payload.traffic : [];
    if (payload.info) {
      currentTrafficInfo = payload.info;
    }
    renderTrafficOptions(trafficCatalog, currentTrafficInfo);
    updateScenarioControls();
  } catch (error) {
    console.error("获取测试用例列表失败:", error);
    trafficCatalog = [];
    renderTrafficOptions(trafficCatalog, currentTrafficInfo);
    updateScenarioControls();
  }
}

async function applyScenario(index) {
  scenarioLoading = true;
  updateScenarioControls();
  try {
    const resp = await fetch("/dashboard/traffic/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.success) {
      const message =
        payload.message || (resp.ok ? "切换测试用例失败，请稍后重试。" : `切换测试用例失败 (HTTP ${resp.status})`);
      alert(message);
      pendingScenarioIndex = null;
      fetchState();
      return;
    }
    const nextInfo =
      payload.info && typeof payload.info === "object"
        ? payload.info
        : {
            ...(currentTrafficInfo || {}),
            current_index: index,
          };
    currentTrafficInfo = nextInfo;
    if (Array.isArray(payload.traffic)) {
      trafficCatalog = payload.traffic;
    }
    renderTrafficOptions(trafficCatalog, currentTrafficInfo);
    pendingScenarioIndex = null;
    stageRenderer.reset();
    previousTick = null;
    fetchState();
  } catch (error) {
    console.error("切换测试用例失败:", error);
    alert("切换测试用例失败，请检查终端输出。");
  } finally {
    scenarioLoading = false;
    updateScenarioControls();
  }
}

function updateControls() {
  if (!statusEl || !toggleBtn) {
    return;
  }
  statusEl.textContent = controllerRunning ? "运行中" : "未运行";
  statusEl.className = controllerRunning ? "status status-running" : "status status-idle";
  toggleBtn.textContent = pendingAction ? (controllerRunning ? "停止中..." : "启动中...") : controllerRunning ? "停止调度" : "启动调度";
  toggleBtn.disabled = pendingAction;
  updateScenarioControls();
}

async function toggleController() {
  if (pendingAction) {
    return;
  }
  pendingAction = true;
  updateControls();
  const url = controllerRunning ? "/dashboard/stop" : "/dashboard/start";
  try {
    const resp = await fetch(url, { method: "POST" });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.success) {
      const message =
        payload.message || (resp.ok ? "操作失败，请稍后重试" : `操作失败 (HTTP ${resp.status})`);
      alert(message);
    }
  } catch (error) {
    console.error("切换调度状态失败:", error);
    alert("操作失败，请检查终端输出。");
  } finally {
    pendingAction = false;
    fetchState();
    updateControls();
  }
}

function renderState(state) {
  if (!state) {
    return;
  }
  const currentTick = ensureNumber(state.tick, 0);
  const running = Boolean(state.controller_running);
  if (previousTick !== null && currentTick < previousTick) {
    stageRenderer.reset();
  }

  const tickDisplay = Number.isFinite(currentTick) ? currentTick : state.tick ?? "--";
  if (tickEl) {
    tickEl.textContent = `Tick: ${tickDisplay}`;
  }
  const now = new Date();
  const lastUpdateText = `上次更新：${now.toLocaleTimeString("zh-CN", { hour12: false }).padStart(8, "0")}`;
  if (lastUpdateEl) {
    lastUpdateEl.textContent = lastUpdateText;
  }
  if (overviewUpdateEl) {
    overviewUpdateEl.textContent = lastUpdateText;
  }

  const floors = Array.isArray(state.floors) ? state.floors : [];
  const elevators = Array.isArray(state.elevators) ? state.elevators : [];
  const metrics = state.metrics || {};

  stageRenderer.render({ floors, elevators });
  renderMiniMap(floors, elevators);
  updateOverview({ running, tick: currentTick, floors, metrics });
  updateElevatorCards(elevators);
  updateFloorTable(floors);
  updateMetrics(metrics);

  if (state.traffic) {
    currentTrafficInfo = state.traffic;
    const activeIndex = getActiveScenarioIndex(currentTrafficInfo);
    if (pendingScenarioIndex !== null && activeIndex === pendingScenarioIndex) {
      pendingScenarioIndex = null;
    }
    if (
      scenarioSelect &&
      activeIndex !== null &&
      !scenarioLoading &&
      (pendingScenarioIndex === null || pendingScenarioIndex === activeIndex)
    ) {
      scenarioSelect.value = String(activeIndex);
    }
    renderScenarioMeta(currentTrafficInfo);
  } else {
    renderScenarioMeta(null);
  }

  controllerRunning = running;
  updateControls();
  previousTick = currentTick;
}

if (toggleBtn) {
  toggleBtn.addEventListener("click", toggleController);
}

if (scenarioSelect) {
  scenarioSelect.addEventListener("change", () => {
    const candidate = parseInt(scenarioSelect.value, 10);
    const activeIndex = getActiveScenarioIndex(currentTrafficInfo);
    if (Number.isNaN(candidate) || candidate === activeIndex) {
      pendingScenarioIndex = null;
      updateScenarioControls();
      return;
    }
    if (controllerRunning) {
      alert("调度运行中，请先停止再切换测试用例。");
      if (activeIndex !== null) {
        scenarioSelect.value = String(activeIndex);
      }
      pendingScenarioIndex = null;
      updateScenarioControls();
      return;
    }
    pendingScenarioIndex = candidate;
    updateScenarioControls();
    if (!scenarioLoading && !pendingAction) {
      applyScenario(candidate);
    }
  });
}

initializeSpeedControls();
fetchTrafficCatalog();
fetchState();
startPolling();
updateControls();
