from __future__ import annotations

from datetime import datetime

import numpy as np
import pytest

from backend.app.services.orbit import _glint_risk, _solar_direction_enu


def test_solar_direction_is_a_unit_vector_with_valid_angles() -> None:
    elevation, azimuth, vector = _solar_direction_enu(
        datetime(2026, 8, 28, 3, 30), 36.0736, 114.1324
    )
    assert 10 < elevation < 90
    assert 0 <= azimuth < 360
    assert np.linalg.norm(vector) == pytest.approx(1.0)


def test_glint_risk_thresholds_are_conservative() -> None:
    assert _glint_risk(0) == "high"
    assert _glint_risk(9.99) == "high"
    assert _glint_risk(10) == "medium"
    assert _glint_risk(20) == "low"
    assert _glint_risk(40) == "minimal"
