#!/usr/bin/env python3
"""
以非调试模式启动电梯模拟器，避免 Flask Debugger 造成的共享内存权限问题。
"""
from __future__ import annotations

import os
import logging

from elevator_saga.server import simulator


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
