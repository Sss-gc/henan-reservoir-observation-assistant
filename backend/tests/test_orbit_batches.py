from datetime import datetime, timedelta, timezone

import numpy as np
from skyfield.api import EarthSatellite, load, wgs84

from backend.app.services.orbit import _subpoint_coordinates


def test_batched_track_matches_unbatched_sgp4_across_boundaries() -> None:
    # Frozen public TLE from Skyfield's own satellite regression fixtures.
    ts = load.timescale(builtin=True)
    satellite = EarthSatellite(
        '1 25544U 98067A   18184.80969102  .00001614  00000-0  31745-4 0  9993',
        '2 25544  51.6414 295.8524 0003435 262.6267 204.2868 15.54005638121106',
        'ISS test fixture', ts,
    )
    start = datetime(2018, 7, 3, tzinfo=timezone.utc)
    times = ts.from_datetimes([start + timedelta(seconds=30 * i) for i in range(1445)])
    expected = wgs84.subpoint_of(satellite.at(times))
    calls = []

    class MeasuredSatellite:
        def at(self, batch):
            calls.append(len(batch))
            return satellite.at(batch)

    lats, lons = _subpoint_coordinates(MeasuredSatellite(), times)
    assert calls == [720, 720, 5]
    np.testing.assert_allclose(lats, expected.latitude.degrees, rtol=0, atol=1e-10)
    np.testing.assert_allclose(lons, expected.longitude.degrees, rtol=0, atol=1e-10)
