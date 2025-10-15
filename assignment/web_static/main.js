const tickEl = document.getElementById("tick");
const elevatorContainer = document.getElementById("elevator-cards");
const floorTableBody = document.querySelector("#floor-table tbody");
const metricsList = document.getElementById("metrics-list");
const statusEl = document.getElementById("controller-status");
const toggleBtn = document.getElementById("toggle-controller");
const lastUpdateEl = document.getElementById("last-update");
const scenarioSelect = document.getElementById("scenario-select");
const applyScenarioBtn = document.getElementById("apply-scenario");
const scenarioMetaEl = document.getElementById("scenario-meta");
const speedControlsEl = document.getElementById("speed-controls");
const stageScaleInput = document.getElementById("stage-scale");
const stageScaleValueEl = document.getElementById("stage-scale-value");
const viewportResetBtn = document.getElementById("viewport-reset");
const visualViewportEl = document.getElementById("visual-viewport");
const queueSummaryEl = document.getElementById("queue-summary");
const overviewTickEl = document.getElementById("overview-tick");
const overviewStatusEl = document.getElementById("overview-status");
const overviewWaitingEl = document.getElementById("overview-waiting");
const overviewMetricsEl = document.getElementById("overview-metrics");
const overviewTrafficEl = document.getElementById("overview-traffic");
const overviewUpdateEl = document.getElementById("overview-update");
const overviewCompletedEl = document.getElementById("overview-completed");
const overviewCompletionRateEl = document.getElementById("overview-completion-rate");
const sceneWrapperEl = document.getElementById("scene-wrapper");
const sceneAxisShellEl = document.querySelector(".scene-axis-shell");
const sceneStageEl = document.getElementById("scene-stage");
const sceneFloorLinesEl = document.getElementById("scene-floor-lines");
const sceneAxisEl = document.getElementById("scene-axis");
const sceneElevatorLayerEl = document.getElementById("scene-elevator-layer");
const scenePanelBodyEl = document.getElementById("scene-panel-body");

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function ensureNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
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

class StageRenderer {
  constructor({ wrapperEl, stageEl, floorLinesEl, axisShellEl, axisEl, elevatorLayerEl, panelBodyEl, summaryEl }) {
    this.wrapperEl = wrapperEl;
    this.stageEl = stageEl;
    this.floorLinesEl = floorLinesEl;
    this.axisShellEl = axisShellEl;
    this.axisEl = axisEl;
    this.elevatorLayerEl = elevatorLayerEl;
    this.panelBodyEl = panelBodyEl;
    this.summaryEl = summaryEl;
    this.layout = null;
    this.floorEntries = new Map();
    this.elevatorNodes = new Map();
    this.lastFloors = null;
    this.lastElevators = null;
    this.lastSummary = null;
    this.floorRatioMap = new Map();
    this.prevPassengerCount = new Map();
    this.passengerAnimTimers = new Map();
  }

  buildFloorLines() {
    if (!this.layout || !this.floorLinesEl) {
      return;
    }
    this.floorLinesEl.innerHTML = "";
    const floors = this.layout.floorNumbers;
    floors.forEach((floor, index) => {
      const bottom = this.getBottomForValue(floor);
      const line = document.createElement("div");
      line.className = "scene-floor-line";
      if (floors.length === 1) {
        line.classList.add("scene-floor-line-ground", "scene-floor-line-top");
      } else if (index === floors.length - 1) {
        line.classList.add("scene-floor-line-top");
      } else if (index === 0) {
        line.classList.add("scene-floor-line-ground");
      }
      line.dataset.floor = String(floor);
      line.style.bottom = `${bottom}px`;
      this.floorLinesEl.appendChild(line);
      const entry = this.floorEntries.get(floor);
      if (entry) {
        entry.line = line;
      } else {
        this.floorEntries.set(floor, { line });
      }
    });
  }

  reset() {
    this.layout = null;
    this.floorRatioMap = new Map();
    this.floorEntries.clear();
    this.elevatorNodes.clear();
    this.lastFloors = null;
    this.lastElevators = null;
    this.lastSummary = null;
    if (this.axisEl) {
      this.axisEl.innerHTML = "";
      this.axisEl.style.height = "";
    }
    if (this.axisShellEl) {
      this.axisShellEl.style.minHeight = "";
      this.axisShellEl.style.height = "";
    }
    if (this.panelBodyEl) {
      this.panelBodyEl.innerHTML = "";
    }
    if (this.elevatorLayerEl) {
      this.elevatorLayerEl.innerHTML = "";
    }
    if (this.floorLinesEl) {
      this.floorLinesEl.innerHTML = "";
      this.floorLinesEl.style.removeProperty("--floor-count");
    }
    if (this.summaryEl) {
      this.summaryEl.textContent = "无乘客排队";
      this.summaryEl.classList.remove("has-data");
    }
  }

  render({ floors, elevators, summary }) {
    const floorSnapshots = Array.isArray(floors) ? floors.map((item) => ({ ...item })) : [];
    const elevatorSnapshots = Array.isArray(elevators) ? elevators.map((item) => ({ ...item })) : [];
    this.lastFloors = floorSnapshots;
    this.lastElevators = elevatorSnapshots;
    if (summary) {
      this.lastSummary = {
        up: ensureNumber(summary.up, 0),
        down: ensureNumber(summary.down, 0),
      };
    }
    this.ensureLayout(floorSnapshots, elevatorSnapshots);
    this.updateFloors(floorSnapshots);
    this.updateElevators(elevatorSnapshots);
    if (summary) {
      this.updateSummary(summary.up, summary.down);
    } else if (this.lastSummary) {
      this.updateSummary(this.lastSummary.up, this.lastSummary.down);
    }
  }

  handleResize() {
    if (!this.lastFloors && !this.lastElevators) {
      return;
    }
    const floorSnapshots = this.lastFloors ? this.lastFloors.map((item) => ({ ...item })) : [];
    const elevatorSnapshots = this.lastElevators ? this.lastElevators.map((item) => ({ ...item })) : [];
    const summarySnapshot = this.lastSummary ? { ...this.lastSummary } : null;
    this.layout = null;
    this.ensureLayout(floorSnapshots, elevatorSnapshots);
    this.updateFloors(floorSnapshots);
    this.updateElevators(elevatorSnapshots);
    if (summarySnapshot) {
      this.updateSummary(summarySnapshot.up, summarySnapshot.down);
    }
  }

  ensureLayout(floors, elevators) {
    const floorNumbers = floors
      .map((item) => ensureNumber(item.floor, Number.NaN))
      .filter((value, index, arr) => Number.isFinite(value) && arr.indexOf(value) === index)
      .sort((a, b) => a - b);
    const elevatorCount = Array.isArray(elevators) ? elevators.length : 0;

    if (this.layout && arraysEqual(this.layout.floorNumbers, floorNumbers) && this.layout.elevatorCount === elevatorCount) {
      return;
    }

    this.layout = this.calculateLayout(floorNumbers, elevatorCount);
    this.floorRatioMap = this.layout.floorRatios ?? new Map();
    this.applyLayout();
    this.buildAxis();
    this.buildFloorLines();
    this.buildElevatorLanes(elevators);
  }

  calculateLayout(floorNumbers, elevatorCount) {
    const effectiveFloors = floorNumbers.length ? floorNumbers : [0];
    const minFloor = effectiveFloors[0];
    const maxFloor = effectiveFloors[effectiveFloors.length - 1];
    const floorCount = effectiveFloors.length;
    const floorSpan = Math.max(maxFloor - minFloor, floorCount > 1 ? floorCount - 1 : 1);

    const containerHeight =
      this.wrapperEl?.clientHeight ?? this.stageEl?.clientHeight ?? window.innerHeight ?? 720;
    const targetInner = clamp(Math.round(containerHeight * 0.55), 320, 820);
    let floorUnit = clamp(Math.round(targetInner / Math.max(floorCount, 6)), 26, 92);
    if (floorCount > 24) {
      floorUnit = clamp(Math.round(floorUnit * 0.9), 22, floorUnit);
    }
    if (floorCount > 40) {
      floorUnit = clamp(Math.round(floorUnit * 0.82), 18, floorUnit);
    }

    const cabinHeight = clamp(Math.round(floorUnit * 0.7), 42, 96);
    const innerHeight = floorCount > 1 ? floorUnit * (floorCount - 1) : floorUnit;
    const paddingTop = Math.max(Math.round(cabinHeight * 1.05), Math.round(floorUnit * 1.2));
    const paddingBottom = Math.max(Math.round(cabinHeight * 0.75), Math.round(floorUnit * 0.9));
    const paddingHorizontal = Math.max(28, Math.round(Math.min(56, floorUnit * 1.15)));
    const effectiveElevators = Math.max(elevatorCount, 1);
    const laneWidth = clamp(Math.round(118 - (effectiveElevators - 1) * 8), 78, 138);
    const laneGap = clamp(Math.round(32 - Math.max(0, effectiveElevators - 2) * 3), 18, 48);
    const ratioMap = new Map();
    if (floorSpan > 0) {
      effectiveFloors.forEach((floor) => {
        const ratio = clamp((floor - minFloor) / floorSpan, 0, 1);
        ratioMap.set(floor, ratio);
      });
    } else if (floorCount > 1) {
      effectiveFloors.forEach((floor, index) => {
        const ratio = clamp(index / (floorCount - 1), 0, 1);
        ratioMap.set(floor, ratio);
      });
    } else {
      ratioMap.set(effectiveFloors[0], 0);
    }
    const stepHeight = floorCount > 1 ? innerHeight / (floorCount - 1) : innerHeight;

    return {
      floorNumbers: effectiveFloors,
      floorCount,
      minFloor,
      maxFloor,
      floorSpan,
      floorUnit,
      cabinHeight,
      innerHeight,
      paddingTop,
      paddingBottom,
      paddingHorizontal,
      laneWidth,
      laneGap,
      elevatorCount: effectiveElevators,
      floorLabelOffset: minFloor >= 0 ? 1 : 0,
      floorRatios: ratioMap,
      stepHeight,
    };
  }

  applyLayout() {
    if (!this.layout) {
      return;
    }
    const layout = this.layout;
    const stageHeight = Math.round(layout.innerHeight + layout.paddingTop + layout.paddingBottom);
    if (this.wrapperEl) {
      this.wrapperEl.style.setProperty("--scene-inner-height", `${layout.innerHeight}px`);
      this.wrapperEl.style.setProperty("--scene-padding-top", `${layout.paddingTop}px`);
      this.wrapperEl.style.setProperty("--scene-padding-bottom", `${layout.paddingBottom}px`);
      this.wrapperEl.style.setProperty("--scene-padding-horizontal", `${layout.paddingHorizontal}px`);
    }
    if (this.stageEl) {
      this.stageEl.style.minHeight = `${stageHeight}px`;
      this.stageEl.style.setProperty("--scene-padding-top", `${layout.paddingTop}px`);
      this.stageEl.style.setProperty("--scene-padding-bottom", `${layout.paddingBottom}px`);
      this.stageEl.style.setProperty("--scene-padding-horizontal", `${layout.paddingHorizontal}px`);
      this.stageEl.style.setProperty("--scene-inner-height", `${layout.innerHeight}px`);
    }
    if (this.elevatorLayerEl) {
      this.elevatorLayerEl.style.setProperty("--elevator-count", String(Math.max(layout.elevatorCount, 1)));
      this.elevatorLayerEl.style.setProperty("--scene-inner-height", `${layout.innerHeight}px`);
      this.elevatorLayerEl.style.setProperty("--scene-cabin-height", `${layout.cabinHeight}px`);
      this.elevatorLayerEl.style.setProperty("--scene-lane-width", `${layout.laneWidth}px`);
      this.elevatorLayerEl.style.setProperty("--scene-lane-gap", `${layout.laneGap}px`);
    }
    // 地板线容器的几何范围改为纯 CSS 变量控制（top/bottom/left/right），
    // 这里不再直接写 height，避免与 inset:0 冲突导致错位。
    if (this.axisShellEl) {
      this.axisShellEl.style.setProperty("--scene-inner-height", `${layout.innerHeight}px`);
      const shellHeight = layout.innerHeight + layout.paddingTop + layout.paddingBottom;
      this.axisShellEl.style.minHeight = `${shellHeight}px`;
      this.axisShellEl.style.height = `${shellHeight}px`;
    }
    if (this.axisEl) {
      this.axisEl.style.height = `${layout.innerHeight}px`;
    }
  }

  buildAxis() {
    if (!this.layout) {
      return;
    }
    // 左侧楼层轴整体取消，但仍需构建右侧面板的每层行
    if (this.axisEl) {
      this.axisEl.innerHTML = "";
    }
    if (this.panelBodyEl) {
      this.panelBodyEl.innerHTML = "";
    }
    this.floorEntries.clear();
    const rows = this.layout.floorNumbers;
    // 根据楼层数量自适应标签密度，避免高楼层场景挤压
    const denseStep = rows.length > 60 ? 5 : rows.length > 32 ? 2 : 1;
    rows.forEach((floor, idx) => {
      const bottom = this.getBottomForValue(floor);
      // 取消左侧轴，仅在存在 axisEl 时才生成（当前为 null，不会生成）
      let axisRow = null;
      let upChip = null;
      let downChip = null;
      if (this.axisEl) {
        axisRow = document.createElement("div");
        axisRow.className = "scene-axis-row";
        axisRow.dataset.floor = String(floor);
        axisRow.style.bottom = `${bottom}px`;
        if (denseStep > 1 && idx % denseStep !== 0 && idx !== 0 && idx !== rows.length - 1) {
          axisRow.classList.add("compact");
        }
        const labelEl = document.createElement("span");
        labelEl.className = "scene-floor-label";
        labelEl.textContent = this.formatFloorLabel(floor);
        axisRow.appendChild(labelEl);
        const counterWrap = document.createElement("div");
        counterWrap.className = "scene-wait-counters";
        upChip = document.createElement("span");
        upChip.className = "wait-chip up";
        upChip.textContent = "↑0";
        downChip = document.createElement("span");
        downChip.className = "wait-chip down";
        downChip.textContent = "↓0";
        counterWrap.append(upChip, downChip);
        axisRow.appendChild(counterWrap);
        this.axisEl.appendChild(axisRow);
      }

      const panelRow = document.createElement("div");
      panelRow.className = "scene-panel-row";
      panelRow.dataset.floor = String(floor);
      const floorSpan = document.createElement("span");
      floorSpan.className = "panel-floor";
      floorSpan.textContent = this.formatFloorLabel(floor);
      const upQueue = document.createElement("div");
      upQueue.className = "panel-queue up";
      const downQueue = document.createElement("div");
      downQueue.className = "panel-queue down";
      panelRow.append(floorSpan, upQueue, downQueue);
      if (this.panelBodyEl) {
        this.panelBodyEl.appendChild(panelRow);
      }

      this.floorEntries.set(floor, {
        row: axisRow || null,
        upAxis: upChip || null,
        downAxis: downChip || null,
        panelRow,
        upQueue,
        downQueue,
        prevUp: 0,
        prevDown: 0,
      });
    });
  }

  buildElevatorLanes(elevators) {
    if (!this.elevatorLayerEl) {
      return;
    }
    this.elevatorLayerEl.innerHTML = "";
    this.elevatorNodes.clear();
    const layout = this.layout;
    const dataset =
      Array.isArray(elevators) && elevators.length
        ? elevators
        : Array.from({ length: layout ? layout.elevatorCount : 1 }, (_, index) => ({ id: index + 1 }));
    dataset.forEach((info, index) => {
      const node = this.createElevatorNode(info, index);
      const key = String(info.id ?? index + 1);
      this.elevatorNodes.set(key, node);
    });
  }

  createElevatorNode(info, index) {
    const lane = document.createElement("div");
    lane.className = "scene-elevator-lane";
    lane.dataset.elevatorId = String(info.id ?? index + 1);

    const cabin = document.createElement("div");
    cabin.className = "scene-elevator-cabin";
    cabin.dataset.direction = "idle";
    cabin.dataset.state = "idle";
    cabin.dataset.load = "empty";

    const header = document.createElement("div");
    header.className = "scene-cabin-header";
    const idEl = document.createElement("span");
    idEl.className = "scene-cabin-id";
    idEl.textContent = `#${info.id ?? index + 1}`;
    const floorEl = document.createElement("span");
    floorEl.className = "scene-cabin-floor";
    floorEl.textContent = "--";
    const targetEl = document.createElement("span");
    targetEl.className = "scene-cabin-target";
    targetEl.textContent = "→ --";
    header.append(idEl, floorEl, targetEl);

    const body = document.createElement("div");
    body.className = "scene-cabin-body";
    const loadWrap = document.createElement("div");
    loadWrap.className = "scene-cabin-load";
    const loadBar = document.createElement("div");
    loadBar.className = "scene-cabin-load-bar";
    loadWrap.appendChild(loadBar);
    const passengersEl = document.createElement("div");
    passengersEl.className = "scene-cabin-passengers";
    body.append(loadWrap, passengersEl);

    cabin.append(header, body);
    lane.appendChild(cabin);
    if (this.elevatorLayerEl) {
      this.elevatorLayerEl.appendChild(lane);
    }

    return {
      lane,
      cabin,
      idEl,
      floorEl,
      targetEl,
      loadBar,
      passengersEl,
    };
  }

  updateFloors(floors) {
    if (!this.layout || !this.floorEntries.size) {
      return;
    }
    const floorMap = new Map();
    floors.forEach((item) => {
      const floorNumber = ensureNumber(item.floor, Number.NaN);
      if (!Number.isFinite(floorNumber)) {
        return;
      }
      const up = ensureNumber(
        item.up_waiting ?? item.waiting_up ?? item.waiting_up_count ?? item.up ?? 0,
        0
      );
      const down = ensureNumber(
        item.down_waiting ?? item.waiting_down ?? item.waiting_down_count ?? item.down ?? 0,
        0
      );
      const total = ensureNumber(item.total ?? item.total_waiting ?? up + down, up + down);
      floorMap.set(floorNumber, { up, down, total });
    });

    this.floorEntries.forEach((entry, floor) => {
      const stats = floorMap.get(floor) || { up: 0, down: 0, total: 0 };
      if (entry.upAxis) entry.upAxis.textContent = `↑${stats.up}`;
      if (entry.downAxis) entry.downAxis.textContent = `↓${stats.down}`;
      if (entry.upQueue) {
        this.renderQueueDots(entry.upQueue, stats.up, entry.prevUp ?? stats.up);
        entry.prevUp = stats.up;
      }
      if (entry.downQueue) {
        this.renderQueueDots(entry.downQueue, stats.down, entry.prevDown ?? stats.down);
        entry.prevDown = stats.down;
      }
      const hasWaiting = stats.total > 0;
      if (entry.row) entry.row.classList.toggle("has-waiting", hasWaiting);
      if (entry.panelRow) entry.panelRow.classList.toggle("has-waiting", hasWaiting);
      if (entry.line) entry.line.classList.toggle("has-waiting", hasWaiting);
    });
  }

  updateElevators(elevators) {
    if (!this.layout) {
      return;
    }
    const seen = new Set();
    const activeFloors = new Map();

    elevators.forEach((elevator, index) => {
      const key = String(elevator.id ?? index + 1);
      let node = this.elevatorNodes.get(key);
      if (!node) {
        node = this.createElevatorNode(elevator, index);
        this.elevatorNodes.set(key, node);
      }
      if (this.elevatorLayerEl && node.lane !== this.elevatorLayerEl.children[index]) {
        this.elevatorLayerEl.insertBefore(node.lane, this.elevatorLayerEl.children[index] || null);
      }
      seen.add(key);
      this.applyElevatorState(node, elevator);

      const closestFloor = this.findClosestFloor(ensureNumber(elevator.current, this.layout.minFloor));
      if (closestFloor !== null) {
        activeFloors.set(closestFloor, (activeFloors.get(closestFloor) || 0) + 1);
      }
    });

    this.elevatorNodes.forEach((node, id) => {
      if (!seen.has(id)) {
        node.lane.remove();
        this.elevatorNodes.delete(id);
      }
    });

    this.floorEntries.forEach((entry, floor) => {
      const isActive = activeFloors.has(floor);
      if (entry.row) entry.row.classList.toggle("is-active", isActive);
      if (entry.panelRow) entry.panelRow.classList.toggle("is-active", isActive);
      if (entry.line) entry.line.classList.toggle("is-active", isActive);
    });
  }

  applyElevatorState(node, elevator) {
    if (!this.layout) {
      return;
    }
    const floorValue = ensureNumber(elevator.current, this.layout.minFloor);
    const bottom = this.getBottomForValue(floorValue);
    node.cabin.style.bottom = `${bottom}px`;

    // 在电梯内显示当前楼层（替代左侧楼层轴）
    if (node.floorEl) {
      node.floorEl.textContent = this.formatFloorLabel(Math.round(floorValue));
    }

    const loadFactor = clamp(ensureNumber(elevator.load_factor, 0), 0, 1);
    node.loadBar.style.transform = `scaleX(${loadFactor.toFixed(3)})`;
    let loadState = "empty";
    if (loadFactor >= 0.85) {
      loadState = "full";
    } else if (loadFactor >= 0.55) {
      loadState = "mid";
    } else if (loadFactor >= 0.25) {
      loadState = "light";
    }
    node.cabin.dataset.load = loadState;

    const direction = (elevator.direction || "").toString().toLowerCase();
    node.cabin.dataset.direction = direction === "up" || direction === "down" ? direction : "idle";

    const rawStatus = (elevator.status || elevator.run_status || "").toString().toLowerCase();
    node.cabin.dataset.state = rawStatus || "idle";
    node.cabin.dataset.doors = rawStatus === "stopped" ? "open" : "closed";

    const passengerCount = ensureNumber(elevator.passenger_count, 0);
    this.renderPassengerDots(node.passengersEl, passengerCount);
    // 乘客动画：根据人数变化判断上/下客，短暂展示流动效果
    const key = String(elevator.id ?? "__unknown");
    const prev = ensureNumber(this.prevPassengerCount.get(key), passengerCount);
    const delta = passengerCount - prev;
    this.prevPassengerCount.set(key, passengerCount);
    if (node.passengersEl) {
      node.passengersEl.classList.toggle("is-boarding", delta > 0);
      node.passengersEl.classList.toggle("is-alighting", delta < 0);
      // 600ms 后自动清除动画标记
      const prevTimer = this.passengerAnimTimers.get(key);
      if (prevTimer) window.clearTimeout(prevTimer);
      if (delta !== 0) {
        const t = window.setTimeout(() => {
          node.passengersEl.classList.remove("is-boarding", "is-alighting");
          this.passengerAnimTimers.delete(key);
        }, 600);
        this.passengerAnimTimers.set(key, t);
      }
    }

    if (node.idEl) {
      node.idEl.textContent = `#${elevator.id ?? ""}`;
    }
    if (node.targetEl) {
      node.targetEl.textContent = `→ ${formatTargetFloor(elevator.target ?? elevator.next_target ?? null)}`;
    }
  }

  renderPassengerDots(container, count) {
    if (!container) {
      return;
    }
    const safeCount = Math.max(0, ensureNumber(count, 0));
    container.innerHTML = "";
    const visible = Math.min(safeCount, 6);
    for (let i = 0; i < visible; i += 1) {
      const dot = document.createElement("span");
      dot.className = "scene-passenger-dot";
      dot.style.setProperty("--dot-index", String(i));
      container.appendChild(dot);
    }
    if (safeCount > visible) {
      const extra = document.createElement("span");
      extra.className = "scene-passenger-extra";
      extra.textContent = `+${safeCount - visible}`;
      container.appendChild(extra);
    }
  }

  renderQueueDots(container, count, prevCount = 0) {
    if (!container) return;
    const safeCount = Math.max(0, ensureNumber(count, 0));
    const prev = Math.max(0, ensureNumber(prevCount, 0));
    const maxVisible = 10;
    // 预留一个 extra 占位
    const existingDots = Array.from(container.querySelectorAll('.queue-dot'));
    const extraEl = container.querySelector('.queue-extra');
    const needVisible = Math.min(safeCount, maxVisible);

    // 删除多余节点（带退出动画）
    if (existingDots.length > needVisible) {
      const toRemove = existingDots.slice(needVisible);
      toRemove.forEach((el) => {
        el.classList.add('exit');
        setTimeout(() => el.remove(), 320);
      });
    }

    // 添加缺失节点（带进入动画）
    if (existingDots.length < needVisible) {
      for (let i = existingDots.length; i < needVisible; i += 1) {
        const dot = document.createElement('span');
        dot.className = 'queue-dot enter';
        container.appendChild(dot);
        // 进入动画结束后移除 enter 标记
        setTimeout(() => dot.classList.remove('enter'), 360);
      }
    }

    // 更新 extra
    const extra = safeCount - needVisible;
    if (extra > 0) {
      if (!extraEl) {
        const badge = document.createElement('span');
        badge.className = 'queue-extra';
        badge.textContent = `+${extra}`;
        container.appendChild(badge);
      } else {
        extraEl.textContent = `+${extra}`;
      }
    } else if (extraEl) {
      extraEl.remove();
    }

    // 入队/出队整体动效
    if (safeCount !== prev) {
      container.classList.toggle('is-enqueue', safeCount > prev);
      container.classList.toggle('is-dequeue', safeCount < prev);
      setTimeout(() => {
        container.classList.remove('is-enqueue', 'is-dequeue');
      }, 320);
    }
  }

  getValueRatio(value) {
    if (!this.layout || !Number.isFinite(value)) {
      return 0;
    }
    if (this.floorRatioMap?.has(value)) {
      return clamp(this.floorRatioMap.get(value), 0, 1);
    }
    if (this.layout.floorSpan > 0) {
      return clamp((value - this.layout.minFloor) / this.layout.floorSpan, 0, 1);
    }
    const floors = this.layout.floorNumbers;
    if (!floors.length) {
      return 0;
    }
    if (floors.length === 1) {
      return 0;
    }
    const minFloor = floors[0];
    const maxFloor = floors[floors.length - 1];
    if (value <= minFloor) {
      return 0;
    }
    if (value >= maxFloor) {
      return 1;
    }
    for (let i = 1; i < floors.length; i += 1) {
      const upper = floors[i];
      if (upper >= value) {
        const lower = floors[i - 1];
        const lowerRatio = this.floorRatioMap?.get(lower) ?? clamp((lower - minFloor) / (maxFloor - minFloor || 1), 0, 1);
        const upperRatio = this.floorRatioMap?.get(upper) ?? clamp((upper - minFloor) / (maxFloor - minFloor || 1), 0, 1);
        const span = upper - lower;
        const t = span !== 0 ? (value - lower) / span : 0;
        return clamp(lowerRatio + (upperRatio - lowerRatio) * t, 0, 1);
      }
    }
    return 0;
  }

  getBottomForValue(value) {
    const ratio = this.getValueRatio(value);
    const innerHeight = this.layout?.innerHeight ?? 0;
    return clamp(ratio, 0, 1) * innerHeight;
  }

  updateSummary(up = 0, down = 0) {
    const upCount = ensureNumber(up, 0);
    const downCount = ensureNumber(down, 0);
    this.lastSummary = { up: upCount, down: downCount };
    if (!this.summaryEl) {
      return;
    }
    const total = upCount + downCount;
    if (total === 0) {
      this.summaryEl.textContent = "无乘客排队";
      this.summaryEl.classList.remove("has-data");
    } else {
      this.summaryEl.textContent = `↑${upCount} / ↓${downCount}`;
      this.summaryEl.classList.add("has-data");
    }
  }

  formatFloorLabel(floor) {
    if (!Number.isFinite(floor)) {
      return `${floor}`;
    }
    if (floor < 0) {
      return `B${Math.abs(floor)}F`;
    }
    if (this.layout?.floorLabelOffset) {
      return `${floor + this.layout.floorLabelOffset}F`;
    }
    return `${floor}F`;
  }

  findClosestFloor(value) {
    if (!this.layout || !this.layout.floorNumbers.length || !Number.isFinite(value)) {
      return null;
    }
    let closest = this.layout.floorNumbers[0];
    let minDistance = Math.abs(value - closest);
    for (let i = 1; i < this.layout.floorNumbers.length; i += 1) {
      const candidate = this.layout.floorNumbers[i];
      const distance = Math.abs(value - candidate);
      if (distance < minDistance) {
        closest = candidate;
        minDistance = distance;
      }
    }
    return closest;
  }
}

const stageRenderer = new StageRenderer({
  wrapperEl: sceneWrapperEl,
  stageEl: sceneStageEl,
  floorLinesEl: sceneFloorLinesEl,
  axisShellEl: sceneAxisShellEl,
  axisEl: sceneAxisEl,
  elevatorLayerEl: sceneElevatorLayerEl,
  panelBodyEl: scenePanelBodyEl,
  summaryEl: queueSummaryEl,
});

let controllerRunning = false;
let pendingAction = false;
let scenarioLoading = false;
let currentSpeedFactor = 1;
const POLL_INTERVAL_BASE = 650;
const MIN_POLL_INTERVAL = 180;
let pollTimer = null;
let previousTick = null;
let trafficCatalog = [];
let currentTrafficInfo = null;
let pendingScenarioIndex = null;
let stageScale = 1;

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

function updateStageScaleDisplay(scale) {
  if (stageScaleInput) {
    const targetValue = Math.round(scale * 100);
    if (Number(stageScaleInput.value) !== targetValue) {
      stageScaleInput.value = String(targetValue);
    }
  }
  if (stageScaleValueEl) {
    stageScaleValueEl.textContent = `${Math.round(scale * 100)}%`;
  }
}

function setStageScale(multiplier, { silent = false } = {}) {
  const normalized = clamp(multiplier, 0.7, 1.4);
  if (Math.abs(normalized - stageScale) < 0.01) {
    if (!silent) {
      updateStageScaleDisplay(normalized);
    }
    return;
  }
  stageScale = normalized;
  updateStageScaleDisplay(normalized);
  if (sceneWrapperEl) {
    sceneWrapperEl.style.setProperty("--stage-scale", normalized.toFixed(3));
  }
}

function initializeStageControls() {
  setStageScale(stageScale, { silent: true });
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
        visualViewportEl.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      }
    });
  }
}

function setSpeedFactor(factor) {
  const normalized = clamp(factor, 0.25, 6);
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
  stageRenderer.reset();
}

async function fetchTrafficCatalog() {
  try {
    const resp = await fetch(`/dashboard/traffic/list?_=${Date.now()}`, { cache: "no-store" });
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

function renderState(state) {
  if (!state) {
    return;
  }
  const currentTick = ensureNumber(state.tick, 0);
  const running = Boolean(state.controller_running);
  if (previousTick !== null && currentTick < previousTick) {
    resetAnimationState();
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
  if (overviewTickEl) {
    overviewTickEl.textContent = Number.isFinite(currentTick) ? String(currentTick) : "--";
  }

  const floors = Array.isArray(state.floors) ? state.floors : [];
  const elevators = Array.isArray(state.elevators) ? state.elevators : [];
  const metrics = state.metrics || {};

  let totalWaiting = 0;
  let totalUp = 0;
  let totalDown = 0;
  floors.forEach((floor) => {
    const up = ensureNumber(
      floor.up_waiting ?? floor.waiting_up ?? floor.waiting_up_count ?? floor.up ?? 0,
      0
    );
    const down = ensureNumber(
      floor.down_waiting ?? floor.waiting_down ?? floor.waiting_down_count ?? floor.down ?? 0,
      0
    );
    const total = ensureNumber(floor.total ?? floor.total_waiting ?? up + down, up + down);
    totalUp += up;
    totalDown += down;
    totalWaiting += total;
  });

  if (overviewStatusEl) {
    overviewStatusEl.textContent = running ? "运行中" : "未运行";
    overviewStatusEl.dataset.state = running ? "running" : "idle";
  }
  if (overviewWaitingEl) {
    overviewWaitingEl.textContent = String(totalWaiting);
  }
  if (overviewMetricsEl) {
    const averageWait = ensureNumber(metrics.average_floor_wait_time, 0);
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
      totalPassengers > 0 ? `完成率 ${(completedPassengers / totalPassengers * 100).toFixed(1)}%` : "完成率 --";
    overviewCompletionRateEl.textContent = completionRate;
  }

  stageRenderer.render({
    floors,
    elevators,
    summary: { up: totalUp, down: totalDown },
  });

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
      (scenarioLoading || pendingScenarioIndex === null) &&
      (scenarioLoading || document.activeElement !== scenarioSelect)
    ) {
      const targetValue = String(activeIndex);
      if (scenarioSelect.value !== targetValue) {
        scenarioSelect.value = targetValue;
      }
    }
    renderScenarioMeta(currentTrafficInfo);
    if (overviewTrafficEl) {
      const info = currentTrafficInfo.current_file || currentTrafficInfo;
      const label = info?.label || info?.filename || "未选择";
      overviewTrafficEl.textContent = `当前测试：${label}`;
    }
  } else if (overviewTrafficEl) {
    overviewTrafficEl.textContent = "当前测试：--";
  }

  controllerRunning = running;
  updateControls();
  previousTick = currentTick;
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
  applyScenarioBtn.textContent = scenarioLoading ? "载入中..." : "载入测试";
}

function updateElevatorCards(elevators) {
  if (!elevatorContainer) {
    return;
  }
  elevatorContainer.innerHTML = "";
  elevators.forEach((elevator) => {
    const currentFloor = ensureNumber(elevator.current, 0);
    const loadPercent = Math.round(clamp(ensureNumber(elevator.load_factor, 0), 0, 1) * 100);
    const passengerCount = ensureNumber(elevator.passenger_count, 0);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <h3>电梯 #${elevator.id}</h3>
      <span>楼层：${currentFloor.toFixed(1)} → ${formatTargetFloor(elevator.target)}</span>
      <span>方向：${translateDirection(elevator.direction)}</span>
      <span>状态：${translateStatus(elevator.status || elevator.run_status)}</span>
      <span>乘客：${passengerCount}人，载重比 ${loadPercent}%</span>
      <span>车内目标：${
        Array.isArray(elevator.pressed_floors) && elevator.pressed_floors.length
          ? elevator.pressed_floors.map((floor) => formatFloorLabelForDisplay(floor)).join(", ")
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
      const up = ensureNumber(floor.up_waiting ?? floor.waiting_up ?? floor.waiting_up_count ?? floor.up ?? 0, 0);
      const down = ensureNumber(
        floor.down_waiting ?? floor.waiting_down ?? floor.waiting_down_count ?? floor.down ?? 0,
        0
      );
      const total = ensureNumber(floor.total ?? floor.total_waiting ?? up + down, up + down);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatFloorLabelForDisplay(floor.floor)}</td>
        <td>${up}</td>
        <td>${down}</td>
        <td>${total}</td>
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
    li.innerHTML = `<strong>${translateMetric(key)}</strong><br />${formatMetricValue(key, value)}`;
    metricsList.appendChild(li);
  });
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
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return map[normalized] || normalized || "未知";
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

function formatFloorLabelForDisplay(floor) {
  if (stageRenderer) {
    return stageRenderer.formatFloorLabel(ensureNumber(floor, 0));
  }
  if (!Number.isFinite(floor)) {
    return `${floor}`;
  }
  if (floor < 0) {
    return `B${Math.abs(floor)}F`;
  }
  return `${floor}F`;
}

function formatTargetFloor(target) {
  if (target === null || target === undefined) {
    return "-";
  }
  return formatFloorLabelForDisplay(target);
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

window.addEventListener("resize", () => {
  stageRenderer.handleResize();
});
window.addEventListener("load", () => {
  stageRenderer.handleResize();
});
if (document.fonts?.ready) {
  document.fonts.ready.then(() => stageRenderer.handleResize());
}

initializeStageControls();
initializeSpeedControls();
applySpeedStyling();
stageRenderer.handleResize();
startPolling(false);
fetchTrafficCatalog();
fetchState();
updateControls();
