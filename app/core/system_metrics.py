"""Host metrics helpers."""

import subprocess
from typing import Optional


def read_gpu_utilization() -> Optional[float]:
    """Return GPU utilization % via nvidia-smi, or None if unavailable."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=1.0,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return float(result.stdout.strip().split("\n")[0].strip())
    except (FileNotFoundError, ValueError, subprocess.TimeoutExpired, OSError):
        return None
