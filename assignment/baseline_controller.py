#!/usr/bin/env python3
"""
改进版调度算法：两层 Trip 规划 + 事件驱动插站

核心特点：
1. 将一次完整行程抽象为 Trip，携带方向、走廊区间、停靠序列与容量预占。
2. 通过楼层快照判定上/下行高峰或均衡模式，动态划分服务分区。
3. Trip 层负责离线式分配：成段规划、目的地分桶、预留容量避免超载。
4. 事件层利用 PASSING_FLOOR / APPROACHING 即时插站，支持 immediate 调度。
5. 空闲电梯按分区驻站，能耗较高的电梯延迟唤醒。
"""
from __future__ import annotations

import math
import os
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Deque, Dict, Iterable, List, Optional, Set, Tuple

from elevator_saga.client.base_controller import ElevatorController
from elevator_saga.client.proxy_models import ProxyElevator, ProxyFloor, ProxyPassenger
from elevator_saga.core.models import Direction, SimulationEvent, SimulationState, PassengerStatus


class TrafficMode(Enum):
    """电梯运行模式枚举"""

    UP_PEAK = auto()
    DOWN_PEAK = auto()
    INTERFLOOR = auto()


@dataclass
class FloorDemand:
    """楼层的上下行需求聚合"""

    up_count: int = 0
    down_count: int = 0
    up_destinations: Counter = field(default_factory=Counter)
    down_destinations: Counter = field(default_factory=Counter)


@dataclass
class Trip:
    """封装一次完整趟次的调度信息"""

    direction: Direction
    corridor_low: int
    corridor_high: int
    stops: Deque[int] = field(default_factory=deque)
    reserved_pickups: Dict[int, int] = field(default_factory=dict)
    reserved_passengers: Set[int] = field(default_factory=set)
    current_stop: Optional[int] = None

    def has_pending(self) -> bool:
        return self.current_stop is not None or bool(self.stops)

    def peek_next(self) -> Optional[int]:
        if self.current_stop is not None:
            return self.current_stop
        if self.stops:
            return self.stops[0]
        return None

    def pop_next(self) -> Optional[int]:
        if self.current_stop is not None:
            return self.current_stop
        if not self.stops:
            return None
        self.current_stop = self.stops.popleft()
        return self.current_stop

    def mark_stop_completed(self, floor: int) -> None:
        if self.current_stop == floor:
            self.current_stop = None
        else:
            self.stops = deque(f for f in self.stops if f != floor)

    def add_stop(self, floor: int, *, to_front: bool = False) -> None:
        if floor == self.current_stop:
            return
        if to_front:
            if floor in self.stops:
                self.stops = deque([floor] + [f for f in self.stops if f != floor])
            else:
                self.stops.appendleft(floor)
            return
        if floor in self.stops:
            return
        if self.direction == Direction.UP:
            self._insert_ascending(floor)
        elif self.direction == Direction.DOWN:
            self._insert_descending(floor)
        else:
            self.stops.append(floor)

    def replace_current_stop(self, new_floor: int) -> None:
        if self.current_stop == new_floor:
            return
        previous = self.current_stop
        if previous is not None:
            if previous not in self.stops:
                self.stops.appendleft(previous)
            else:
                self.stops = deque([previous] + [f for f in self.stops if f != previous])
        if new_floor in self.stops:
            self.stops = deque(f for f in self.stops if f != new_floor)
        self.current_stop = new_floor

    def total_reserved_boarding(self) -> int:
        return sum(self.reserved_pickups.values())

    def adjust_reservation(self, floor: int, delta: int, passenger_id: Optional[int] = None) -> None:
        if delta == 0:
            return
        self.reserved_pickups[floor] = self.reserved_pickups.get(floor, 0) + delta
        if self.reserved_pickups[floor] <= 0:
            self.reserved_pickups.pop(floor, None)
        if passenger_id is not None:
            if delta > 0:
                self.reserved_passengers.add(passenger_id)
            else:
                self.reserved_passengers.discard(passenger_id)

    def clear_reservations(self) -> None:
        self.reserved_pickups.clear()
        self.reserved_passengers.clear()

    def _insert_ascending(self, floor: int) -> None:
        inserted = False
        new_stops: Deque[int] = deque()
        for existing in self.stops:
            if not inserted and floor < existing:
                new_stops.append(floor)
                inserted = True
            new_stops.append(existing)
        if not inserted:
            new_stops.append(floor)
        self.stops = new_stops

    def _insert_descending(self, floor: int) -> None:
        inserted = False
        new_stops: Deque[int] = deque()
        for existing in self.stops:
            if not inserted and floor > existing:
                new_stops.append(floor)
                inserted = True
            new_stops.append(existing)
        if not inserted:
            new_stops.append(floor)
        self.stops = new_stops


@dataclass
class PendingRequest:
    """存储一名等待乘客的调度请求"""

    passenger_id: int
    origin: int
    destination: int
    direction: Direction
    arrive_tick: int
    assigned_elevator: Optional[int] = None
    assigned_tick: Optional[int] = None

    def priority_key(self, reference_floor: int) -> Tuple[int, int]:
        return abs(self.origin - reference_floor), self.origin


class GreedyNearestController(ElevatorController):
    """Trip 驱动调度器，实现两层调度体系"""

    def __init__(
        self,
        server_url: str = "http://127.0.0.1:8000",
        debug: bool = False,
        tick_delay: Optional[float] = None,
    ):
        super().__init__(server_url, debug)
        self.waiting_requests: Dict[int, PendingRequest] = {}
        self.last_known_tick: int = 0
        self.dispatch_history: Dict[int, List[int]] = {}
        self.pending_assignments_count: Dict[int, int] = {}
        self.pending_targets: Dict[int, Optional[int]] = {}
        self.reassign_after_ticks: int = 4
        self.active_trips: Dict[int, Trip] = {}
        self.floor_snapshot: Dict[int, FloorDemand] = {}
        self.mode: TrafficMode = TrafficMode.INTERFLOOR
        self.zone_bounds: Dict[int, Tuple[int, int]] = {}
        self.idle_station_map: Dict[int, int] = {}
        self.base_floor: int = 0
        self.top_floor: int = 0
        self.target_load_factor: float = 0.8
        self.heavy_elevators: Set[int] = {3}
        self.heavy_activation_ratio: float = 0.7
        self.energy_weight: Dict[int, float] = {}
        if tick_delay is not None:
            self.tick_delay = tick_delay
        else:
            env_value = os.environ.get("ASSIGNMENT_TICK_DELAY", "0.2")
            try:
                self.tick_delay = max(0.0, float(env_value))
            except ValueError:
                self.tick_delay = 0.2

    # ========= 生命周期回调 ========= #
    def on_init(self, elevators: List[ProxyElevator], floors: List[ProxyFloor]) -> None:
        self.waiting_requests.clear()
        self.dispatch_history = {e.id: [] for e in elevators}
        self.pending_assignments_count = {e.id: 0 for e in elevators}
        self.pending_targets = {e.id: None for e in elevators}
        self.active_trips.clear()
        self.base_floor = floors[0].floor if floors else 0
        self.top_floor = floors[-1].floor if floors else 0
        self.mode = TrafficMode.INTERFLOOR
        self.zone_bounds = {e.id: (self.base_floor, self.top_floor) for e in elevators}
        self._compute_idle_layout(elevators)
        self.energy_weight = {e.id: (2.0 if e.id in self.heavy_elevators else 1.0) for e in elevators}
        print(f"初始化完成：{len(elevators)} 部电梯，服务楼层 {len(floors)} 层")

    def on_event_execute_start(
        self, tick: int, events: List[SimulationEvent], elevators: List[ProxyElevator], floors: List[ProxyFloor]
    ) -> None:
        self.last_known_tick = tick
        if self.debug and events:
            joined = ", ".join(event.type.value for event in events)
            print(f"[Tick {tick}] 事件：{joined}")

    def on_event_execute_end(
        self, tick: int, events: List[SimulationEvent], elevators: List[ProxyElevator], floors: List[ProxyFloor]
    ) -> None:
        if self.tick_delay > 0:
            time.sleep(self.tick_delay)

    # ========= 自定义运行循环（保持与原基类一致） ========= #
    def _run_event_driven_simulation(self) -> None:  # type: ignore[override]
        try:
            state = self.api_client.get_state()
            if state.tick > 0:
                self.api_client.reset()
                time.sleep(0.3)
                state = self.api_client.get_state()
            self._update_wrappers(state, init=True)
            self._update_traffic_info()
            refresh_attempts = 0
            while self.current_traffic_max_tick == 0 and refresh_attempts < 3:
                print("模拟器接收到的最大tick时间为0，尝试请求下一轮测试...")
                if not self.api_client.next_traffic_round(full_reset=True):
                    break
                time.sleep(0.3)
                state = self.api_client.get_state(force_reload=True)
                self._update_wrappers(state, init=True)
                self._update_traffic_info()
                refresh_attempts += 1
            if self.current_traffic_max_tick == 0:
                print("未获取到可用测试案例，请稍后重试。")
                return

            self._internal_init(self.elevators, self.floors)
            self.api_client.mark_tick_processed()

            while self.is_running:
                if self.current_tick >= self.current_traffic_max_tick:
                    break

                step_response = self.api_client.step(1)
                self.current_tick = step_response.tick
                events = step_response.events

                state = self.api_client.get_state()
                self._update_wrappers(state)

                self.on_event_execute_start(self.current_tick, events, self.elevators, self.floors)

                if events:
                    for event in events:
                        self._handle_single_event(event)

                state = self.api_client.get_state()
                self._update_wrappers(state)

                should_stop = self._should_terminate(state)
                self.on_event_execute_end(self.current_tick, events, self.elevators, self.floors)
                self.api_client.mark_tick_processed()

                if should_stop:
                    self._print_final_metrics(state)
                    self.is_running = False
                    break
                if self.current_tick >= self.current_traffic_max_tick:
                    self._print_final_metrics(state)
                    break

        except Exception as exc:
            print(f"模拟运行错误: {exc}")
            raise

    # ========= 事件回调 ========= #
    def on_passenger_call(self, passenger: ProxyPassenger, floor: ProxyFloor, direction: str) -> None:
        if passenger.id not in self.waiting_requests:
            request = PendingRequest(
                passenger_id=passenger.id,
                origin=floor.floor,
                destination=passenger.destination,
                direction=passenger.travel_direction,
                arrive_tick=passenger.arrive_tick,
            )
            self.waiting_requests[passenger.id] = request
            if self.debug:
                print(f"记录呼叫：乘客 {passenger.id} @F{floor.floor} -> F{passenger.destination}")
        self._refresh_operational_context()
        self._wake_idle_elevators()

    def on_elevator_idle(self, elevator: ProxyElevator) -> None:
        self.pending_targets[elevator.id] = None
        self._assign_trip_or_idle(elevator)

    def on_elevator_stopped(self, elevator: ProxyElevator, floor: ProxyFloor) -> None:
        trip = self.active_trips.get(elevator.id)
        if trip:
            trip.mark_stop_completed(floor.floor)
        self.pending_targets[elevator.id] = None
        self._assign_trip_or_idle(elevator)

    def on_passenger_board(self, elevator: ProxyElevator, passenger: ProxyPassenger) -> None:
        request = self.waiting_requests.pop(passenger.id, None)
        if request is not None:
            self._clear_request_assignment(request)
            trip = self.active_trips.get(elevator.id)
            if trip:
                trip.adjust_reservation(request.origin, -1, passenger.id)
        self._refresh_operational_context()
        self._wake_idle_elevators()

    def on_passenger_alight(self, elevator: ProxyElevator, passenger: ProxyPassenger, floor: ProxyFloor) -> None:
        self._refresh_operational_context()
        self._wake_idle_elevators()

    def on_stop(self) -> None:
        super().on_stop()
        if self.debug:
            print(f"剩余等待乘客: {len(self.waiting_requests)}")

    def on_elevator_passing_floor(self, elevator: ProxyElevator, floor: ProxyFloor, direction: str) -> None:
        self._attempt_inline_stop(elevator, floor.floor, Direction[direction.upper()])

    def on_elevator_approaching(self, elevator: ProxyElevator, floor: ProxyFloor, direction: str) -> None:
        self._attempt_inline_stop(elevator, floor.floor, Direction[direction.upper()])

    # ========= Trip 规划与调度 ========= #
    def _assign_trip_or_idle(self, elevator: ProxyElevator) -> None:
        trip = self.active_trips.get(elevator.id)
        if trip and trip.has_pending():
            self._dispatch_next_stop(elevator, trip)
            return
        if trip:
            self._release_trip(elevator.id)
        new_trip = self._plan_trip_for_elevator(elevator)
        if new_trip and new_trip.has_pending():
            self.active_trips[elevator.id] = new_trip
            self._dispatch_next_stop(elevator, new_trip)
            return
        self._send_elevator_to_idle(elevator)

    def _dispatch_next_stop(self, elevator: ProxyElevator, trip: Trip, *, immediate: bool = False) -> None:
        target = trip.pop_next()
        if target is None:
            return
        pending_command = self.pending_targets.get(elevator.id)
        if pending_command is not None and pending_command == target:
            return
        if immediate:
            trip.replace_current_stop(target)
        if elevator.go_to_floor(target, immediate=immediate):
            self.dispatch_history[elevator.id].append(target)
            self.pending_targets[elevator.id] = target
        else:
            if self.debug:
                print(f"电梯 {elevator.id} 目标 F{target} 下发失败")
            trip.add_stop(target, to_front=True)

    def _release_trip(self, elevator_id: int) -> None:
        trip = self.active_trips.pop(elevator_id, None)
        if not trip:
            return
        for passenger_id in list(trip.reserved_passengers):
            request = self.waiting_requests.get(passenger_id)
            if request is not None:
                self._clear_request_assignment(request)
        trip.clear_reservations()

    def _plan_trip_for_elevator(self, elevator: ProxyElevator) -> Optional[Trip]:
        total_waiting = len(self.waiting_requests)
        if elevator.id in self.heavy_elevators and not self._should_activate_heavy(total_waiting):
            return None
        zone = self.zone_bounds.get(elevator.id, (self.base_floor, self.top_floor))
        drop_floors = self._collect_drop_targets(elevator)
        if drop_floors:
            inferred_direction = Direction.UP if max(drop_floors) > elevator.current_floor else Direction.DOWN
        else:
            inferred_direction = Direction.UP if self.mode == TrafficMode.UP_PEAK else (
                Direction.DOWN if self.mode == TrafficMode.DOWN_PEAK else Direction.STOPPED
            )
        if self.mode == TrafficMode.UP_PEAK:
            direction = Direction.UP
            trip = Trip(direction=direction, corridor_low=zone[0], corridor_high=zone[1])
            self._populate_trip_with_dropoffs(trip, drop_floors)
            self._allocate_up_peak_requests(elevator, trip, zone)
            return trip if trip.has_pending() else None
        if self.mode == TrafficMode.DOWN_PEAK:
            direction = Direction.DOWN
            trip = Trip(direction=direction, corridor_low=zone[0], corridor_high=zone[1])
            self._populate_trip_with_dropoffs(trip, drop_floors)
            self._allocate_down_peak_requests(elevator, trip, zone)
            return trip if trip.has_pending() else None
        # 均衡模式
        direction = inferred_direction if inferred_direction != Direction.STOPPED else self._pick_balanced_direction(elevator, zone)
        if direction == Direction.STOPPED:
            direction = Direction.UP if elevator.current_floor <= zone[0] else Direction.DOWN
        trip = Trip(direction=direction, corridor_low=zone[0], corridor_high=zone[1])
        self._populate_trip_with_dropoffs(trip, drop_floors)
        self._allocate_balanced_requests(elevator, trip, zone, direction)
        return trip if trip.has_pending() else None

    def _populate_trip_with_dropoffs(self, trip: Trip, drop_floors: List[int]) -> None:
        if not drop_floors:
            return
        if trip.direction == Direction.UP:
            for floor in sorted(drop_floors):
                trip.add_stop(floor)
        elif trip.direction == Direction.DOWN:
            for floor in sorted(drop_floors, reverse=True):
                trip.add_stop(floor)
        else:
            for floor in drop_floors:
                trip.add_stop(floor)

    def _allocate_up_peak_requests(self, elevator: ProxyElevator, trip: Trip, zone: Tuple[int, int]) -> None:
        capacity = self._available_capacity(elevator, trip)
        if capacity <= 0:
            return
        target_load = max(0, int(math.ceil(elevator.max_capacity * self.target_load_factor)) - len(elevator.passengers))
        capacity = min(capacity, target_load)
        if capacity <= 0:
            return
        lobby_requests = self._collect_requests_for_direction(
            Direction.UP,
            zone,
            elevator.id,
            origins=[self.base_floor],
            check_destination=True,
            ignore_origin_zone=True,
        )
        picked = self._reserve_requests_for_trip(elevator, trip, lobby_requests, capacity)
        capacity -= picked
        if capacity <= 0:
            return
        corridor_requests = self._collect_requests_for_direction(
            Direction.UP,
            zone,
            elevator.id,
            check_destination=True,
        )
        corridor_requests = [req for req in corridor_requests if req.passenger_id not in trip.reserved_passengers]
        self._reserve_requests_for_trip(elevator, trip, corridor_requests, capacity)

    def _allocate_down_peak_requests(self, elevator: ProxyElevator, trip: Trip, zone: Tuple[int, int]) -> None:
        capacity = self._available_capacity(elevator, trip)
        if capacity <= 0:
            return
        target_load = max(0, int(math.ceil(elevator.max_capacity * self.target_load_factor)) - len(elevator.passengers))
        capacity = min(capacity, target_load)
        if capacity <= 0:
            return
        down_requests = self._collect_requests_for_direction(Direction.DOWN, zone, elevator.id)
        down_requests.sort(key=lambda req: (-req.origin, req.arrive_tick))
        self._reserve_requests_for_trip(elevator, trip, down_requests, capacity)

    def _allocate_balanced_requests(
        self, elevator: ProxyElevator, trip: Trip, zone: Tuple[int, int], direction: Direction
    ) -> None:
        capacity = self._available_capacity(elevator, trip)
        if capacity <= 0:
            return
        target_load = max(0, int(math.ceil(elevator.max_capacity * self.target_load_factor)) - len(elevator.passengers))
        capacity = min(capacity, target_load)
        if capacity <= 0:
            return
        requests = self._collect_requests_for_direction(direction, zone, elevator.id)
        requests.sort(key=lambda req: (abs(req.origin - elevator.current_floor), req.arrive_tick))
        self._reserve_requests_for_trip(elevator, trip, requests, capacity)

    def _available_capacity(self, elevator: ProxyElevator, trip: Trip) -> int:
        return max(0, elevator.max_capacity - len(elevator.passengers) - trip.total_reserved_boarding())

    def _reserve_requests_for_trip(
        self, elevator: ProxyElevator, trip: Trip, requests: Iterable[PendingRequest], capacity: int
    ) -> int:
        reserved = 0
        for request in requests:
            if reserved >= capacity:
                break
            assigned_id = self._ensure_assignment_valid(request)
            if assigned_id is not None and assigned_id != elevator.id:
                continue
            if not self._elevator_can_serve_request(elevator, request):
                continue
            self._mark_request_assigned(request, elevator.id)
            trip.adjust_reservation(request.origin, 1, request.passenger_id)
            trip.add_stop(request.origin, to_front=True)
            if trip.direction == Direction.UP:
                trip.add_stop(request.destination)
            elif trip.direction == Direction.DOWN:
                trip.add_stop(request.destination)
            else:
                trip.add_stop(request.destination)
            reserved += 1
        return reserved

    def _pick_balanced_direction(self, elevator: ProxyElevator, zone: Tuple[int, int]) -> Direction:
        up_count = sum(1 for req in self.waiting_requests.values() if req.direction == Direction.UP and zone[0] <= req.origin <= zone[1])
        down_count = sum(1 for req in self.waiting_requests.values() if req.direction == Direction.DOWN and zone[0] <= req.origin <= zone[1])
        if up_count == 0 and down_count == 0:
            return Direction.STOPPED
        if up_count >= down_count:
            return Direction.UP
        return Direction.DOWN

    # ========= 即时插站 ========= #
    def _attempt_inline_stop(self, elevator: ProxyElevator, floor: int, direction: Direction) -> None:
        if direction not in (Direction.UP, Direction.DOWN):
            return
        trip = self.active_trips.get(elevator.id)
        if trip is None or trip.direction != direction:
            return
        if trip.current_stop == floor or floor in trip.stops:
            return
        zone = self.zone_bounds.get(elevator.id, (self.base_floor, self.top_floor))
        if not (zone[0] <= floor <= zone[1]):
            return
        remaining_capacity = self._available_capacity(elevator, trip)
        if remaining_capacity <= 0:
            return
        inline_requests = self._collect_requests_specific_floor(floor, direction, elevator.id)
        inline_requests = [req for req in inline_requests if req.passenger_id not in trip.reserved_passengers]
        if not inline_requests:
            return
        picked = self._reserve_requests_for_trip(elevator, trip, inline_requests, remaining_capacity)
        if picked == 0:
            return
        previous_target = trip.peek_next()
        trip.replace_current_stop(floor)
        if previous_target is not None and previous_target != floor:
            trip.add_stop(previous_target, to_front=True)
        self._dispatch_next_stop(elevator, trip, immediate=True)

    # ========= 模式判别与分区 ========= #
    def _refresh_operational_context(self) -> None:
        self._rebuild_floor_snapshot()
        new_mode = self._analyze_mode()
        mode_changed = new_mode != self.mode
        self.mode = new_mode
        self._recompute_zones()
        if mode_changed:
            self._reset_all_trips()

    def _rebuild_floor_snapshot(self) -> None:
        snapshot: Dict[int, FloorDemand] = {}
        for request in self.waiting_requests.values():
            data = snapshot.setdefault(request.origin, FloorDemand())
            if request.direction == Direction.UP:
                data.up_count += 1
                data.up_destinations[request.destination] += 1
            elif request.direction == Direction.DOWN:
                data.down_count += 1
                data.down_destinations[request.destination] += 1
        for floor in range(self.base_floor, self.top_floor + 1):
            snapshot.setdefault(floor, FloorDemand())
        self.floor_snapshot = snapshot

    def _analyze_mode(self) -> TrafficMode:
        total_up = sum(data.up_count for data in self.floor_snapshot.values())
        total_down = sum(data.down_count for data in self.floor_snapshot.values())
        total_waiting = total_up + total_down
        if total_waiting == 0:
            return TrafficMode.INTERFLOOR
        base_up = self.floor_snapshot.get(self.base_floor, FloorDemand()).up_count
        top_down = max((data.down_count for floor, data in self.floor_snapshot.items() if floor >= self.top_floor - 1), default=0)
        up_ratio = total_up / total_waiting
        down_ratio = total_down / total_waiting
        if up_ratio >= 0.6 and total_up > 0 and base_up / total_up >= 0.5:
            return TrafficMode.UP_PEAK
        if down_ratio >= 0.6 and total_down > 0 and top_down / total_down >= 0.4:
            return TrafficMode.DOWN_PEAK
        return TrafficMode.INTERFLOOR

    def _recompute_zones(self) -> None:
        elevators = list(self.elevators)
        if not elevators:
            return
        floors_count = self.top_floor - self.base_floor + 1
        if floors_count <= 0:
            self.zone_bounds = {e.id: (self.base_floor, self.top_floor) for e in elevators}
            return
        sorted_ids = sorted(e.id for e in elevators)
        chunk = math.ceil(floors_count / len(elevators))
        if self.mode == TrafficMode.UP_PEAK:
            for index, elevator_id in enumerate(sorted_ids):
                low = self.base_floor + index * chunk
                high = min(self.top_floor, low + chunk - 1)
                self.zone_bounds[elevator_id] = (low, high)
        elif self.mode == TrafficMode.DOWN_PEAK:
            for index, elevator_id in enumerate(sorted_ids):
                high = self.top_floor - index * chunk
                low = max(self.base_floor, high - chunk + 1)
                self.zone_bounds[elevator_id] = (low, high)
        else:
            for index, elevator_id in enumerate(sorted_ids):
                low = self.base_floor + index * chunk
                high = min(self.top_floor, low + chunk - 1)
                self.zone_bounds[elevator_id] = (low, high)
        self._compute_idle_layout(elevators)

    def _reset_all_trips(self) -> None:
        for request in self.waiting_requests.values():
            if request.assigned_elevator is not None:
                self._clear_request_assignment(request)
        self.active_trips.clear()
        for elevator_id in self.pending_targets:
            self.pending_targets[elevator_id] = None
        for elevator in self.elevators:
            self.pending_assignments_count[elevator.id] = 0

    # ========= 超时与唤醒 ========= #
    def _wake_idle_elevators(self) -> None:
        for elevator in self.elevators:
            if elevator.run_status.name.lower() == "stopped" and not elevator.passengers:
                self._assign_trip_or_idle(elevator)

    def _should_activate_heavy(self, total_waiting: int) -> bool:
        baseline_capacity = sum(
            elevator.max_capacity for elevator in self.elevators if elevator.id not in self.heavy_elevators
        )
        if baseline_capacity == 0:
            return True
        return total_waiting >= baseline_capacity * self.heavy_activation_ratio

    # ========= 工具函数 ========= #
    def _compute_idle_layout(self, elevators: List[ProxyElevator]) -> None:
        count = len(elevators)
        if count == 0:
            self.idle_station_map = {}
            return
        span = max(1, self.top_floor - self.base_floor)
        stations: List[int] = []
        if count == 1:
            stations = [self.base_floor]
        else:
            for index in range(count):
                ratio = index / (count - 1)
                station = int(round(self.base_floor + ratio * span))
                stations.append(min(max(station, self.base_floor), self.top_floor))
        sorted_elevators = sorted(elevators, key=lambda e: e.id)
        self.idle_station_map = {elevator.id: stations[idx] for idx, elevator in enumerate(sorted_elevators)}

    def _send_elevator_to_idle(self, elevator: ProxyElevator) -> None:
        if self.waiting_requests:
            return
        station = self.idle_station_map.get(elevator.id, self.base_floor)
        if elevator.current_floor != station:
            if elevator.go_to_floor(station):
                self.pending_targets[elevator.id] = station

    def _collect_requests_for_direction(
        self,
        direction: Direction,
        zone: Tuple[int, int],
        allow_elevator: Optional[int],
        origins: Optional[List[int]] = None,
        *,
        check_destination: bool = False,
        ignore_origin_zone: bool = False,
    ) -> List[PendingRequest]:
        result: List[PendingRequest] = []
        for request in self.waiting_requests.values():
            if request.direction != direction:
                continue
            assigned_id = self._ensure_assignment_valid(request)
            if assigned_id is not None and assigned_id != allow_elevator:
                continue
            if origins is not None and request.origin not in origins:
                continue
            if not ignore_origin_zone and (request.origin < zone[0] or request.origin > zone[1]):
                continue
            if check_destination and (request.destination < zone[0] or request.destination > zone[1]):
                continue
            result.append(request)
        result.sort(key=lambda req: (req.arrive_tick, req.origin))
        return result

    def _collect_requests_specific_floor(
        self, floor: int, direction: Direction, allow_elevator: Optional[int] = None
    ) -> List[PendingRequest]:
        result = []
        for request in self.waiting_requests.values():
            if request.origin != floor or request.direction != direction:
                continue
            assigned_id = self._ensure_assignment_valid(request)
            if assigned_id is not None and assigned_id != allow_elevator:
                continue
            result.append(request)
        result.sort(key=lambda req: req.arrive_tick)
        return result

    def _ensure_assignment_valid(self, request: PendingRequest) -> Optional[int]:
        assigned_id = request.assigned_elevator
        if assigned_id is None:
            return None
        assigned_elevator = next((e for e in self.elevators if e.id == assigned_id), None)
        wait_duration = self.last_known_tick - (request.assigned_tick or self.last_known_tick)
        if assigned_elevator is None:
            self._clear_request_assignment(request)
            return None
        assigned_pending = self.pending_assignments_count.get(assigned_id, 0)
        assigned_passengers = len(assigned_elevator.passengers)
        effective_load = assigned_pending + assigned_passengers
        busy = assigned_elevator.run_status.name.lower() != "stopped" or bool(assigned_elevator.passengers)
        if wait_duration >= self.reassign_after_ticks and (busy or effective_load > 1):
            self._clear_request_assignment(request)
            return None
        return assigned_id

    def _collect_drop_targets(self, elevator: ProxyElevator) -> List[int]:
        destinations = list(elevator.passenger_destinations.values())
        unique = sorted(set(destinations))
        return unique

    def _should_terminate(self, state: SimulationState) -> bool:
        if self.waiting_requests:
            return False
        if any(trip.has_pending() for trip in self.active_trips.values()):
            return False
        if any(self.pending_assignments_count.get(e.id, 0) for e in state.elevators):
            return False
        if any(elevator.passengers for elevator in state.elevators):
            return False
        if any(floor.total_waiting for floor in state.floors):
            return False
        metrics = state.metrics
        if metrics.total_passengers == 0:
            return False
        if metrics.completed_passengers < metrics.total_passengers:
            return False
        if any(
            passenger.status not in (PassengerStatus.COMPLETED, PassengerStatus.CANCELLED)
            for passenger in state.passengers.values()
        ):
            return False
        return True

    def _print_final_metrics(self, state: SimulationState) -> None:
        metrics = state.metrics.to_dict()
        print(metrics)
        last_arrive_tick = 0
        if state.passengers:
            last_arrive_tick = max(passenger.arrive_tick for passenger in state.passengers.values())
        floor_count = len(state.floors)
        per_floor_buffer = 2 * 2 * 5
        settlement_tick = last_arrive_tick + floor_count * per_floor_buffer
        print(
            f"评测结算Tick: {settlement_tick} "
            f"(最后乘客出现Tick={last_arrive_tick}, 楼层数={floor_count}, 单层补偿={per_floor_buffer}, "
            f"公式: 最晚出现Tick + 楼层数×单层补偿)"
        )

    def _mark_request_assigned(self, request: PendingRequest, elevator_id: int) -> None:
        previous = request.assigned_elevator
        if previous is not None and previous != elevator_id:
            self._adjust_pending_count(previous, -1)
        if previous != elevator_id:
            self._adjust_pending_count(elevator_id, 1)
        request.assigned_elevator = elevator_id
        request.assigned_tick = self.last_known_tick

    def _clear_request_assignment(self, request: PendingRequest) -> None:
        previous = request.assigned_elevator
        if previous is not None:
            self._adjust_pending_count(previous, -1)
        request.assigned_elevator = None
        request.assigned_tick = None

    def _adjust_pending_count(self, elevator_id: int, delta: int) -> None:
        current = self.pending_assignments_count.get(elevator_id, 0) + delta
        self.pending_assignments_count[elevator_id] = current if current > 0 else 0

    def _elevator_can_serve_request(self, elevator: ProxyElevator, request: PendingRequest) -> bool:
        served = getattr(elevator, "served_floors", None)
        if not served:
            return True
        if request.origin not in served:
            return False
        if request.destination not in served:
            return False
        return True
