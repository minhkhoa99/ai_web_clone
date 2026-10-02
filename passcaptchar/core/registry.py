from typing import Dict, List
from solvers.base import BaseSolver

class SolverRegistry:
    def __init__(self):
        self._solvers: Dict[str, BaseSolver] = {}

    def register(self, name: str, solver: BaseSolver) -> None:
        self._solvers[name] = solver

    def get(self, name: str) -> BaseSolver:
        if name not in self._solvers:
            raise ValueError(f"Solver '{name}' not found.")
        solver = self._solvers[name]
        if not solver._loaded:
            solver.load_model()
            solver._loaded = True
        return solver

    def list_loaded(self) -> List[str]:
        return [name for name, solver in self._solvers.items() if solver._loaded]

    def list_all(self) -> List[str]:
        return list(self._solvers.keys())

solver_registry = SolverRegistry()
