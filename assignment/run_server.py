#!/usr/bin/env python3
"""
以非调试模式启动电梯模拟器，避免 Flask Debugger 造成的共享内存权限问题。
"""
from __future__ import annotations

import os
import logging

from elevator_saga.server import simulator


def _ensure_energy_cost_patch() -> None:
    """在运行时补齐旧版本模拟器缺失的能耗计算方法。"""

    if hasattr(simulator.ElevatorSimulation, "_calculate_step_energy_cost"):
        return

    def _calculate_step_energy_cost(elevator, movement_speed: int, old_position: float, new_position: float) -> float:
        if movement_speed <= 0 or new_position == old_position:
            return 0.0
        base_cost = 2.0 if elevator.id == 3 else 1.0
        return base_cost

    simulator.ElevatorSimulation._calculate_step_energy_cost = staticmethod(_calculate_step_energy_cost)  # type: ignore[attr-defined]


_ensure_energy_cost_patch()


def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    simulator.set_server_debug_mode(False)
    simulator.app.config["DEBUG"] = False

    project_root = os.path.dirname(os.path.dirname(simulator.__file__))
    custom_dir = os.path.join(project_root, "data", "scenarios")
    if os.path.isdir(custom_dir):
        traffic_dir = custom_dir
    else:
        traffic_dir = os.path.join(project_root, "traffic")
    simulator.simulation = simulator.ElevatorSimulation(traffic_dir)

    simulator.app.run(host="127.0.0.1", port=8000, debug=False, threaded=True)


if __name__ == "__main__":
    main()
