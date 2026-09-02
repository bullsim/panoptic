# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `firms-viirs-noaa20-sample.csv` — 45 real NASA FIRMS active-fire detections in
  the source CSV format (header + 45 rows, 3,962 bytes). All rows are
  `satellite=N20`, `instrument=VIIRS`, `version=2.0NRT`, `acq_date=2026-07-16`.
  Source family: the FIRMS area CSV API,
  `firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/world/{days}`
  (the key is server-side and never appears in a fixture). **The download date
  is not recorded**: the fixture entered the repository in commit `880a672`
  (2026-08-24, "Release God's Eye View as open source"), and `acq_date` is the
  detection date, not the capture date — neither establishes when it was
  fetched. Consumed by `src/data/firmsCsv.test.mjs` (CSV parsing) and
  `src/data/observationContract.test.mjs` (Observation v1 normalisation).
  CC0 / U.S. public-domain data. NASA asks that use be acknowledged: "We
  acknowledge the use of data and/or imagery from NASA's Fire Information for
  Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of
  NASA's Earth Observing System Data and Information System (EOSDIS)."
  See DATA_SOURCES.md.

- `celestrak-gp-sample.tle` — four real CelesTrak GP/TLE records in the 3-line
  (named) format, captured 2026-09-02 from
  `celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle` and the
  `active` group. Used ONLY by `src/data/observationContract.test.mjs` to pin
  TLE parsing offline. The four objects are chosen to cover every
  implied-decimal/exponent shape the format allows, which is where a TLE parser
  actually goes wrong:
    * `ISS (ZARYA)`     — positive BSTAR (` 79223-4`), 6-character designator
    * `LCS 1`           — negative BSTAR (`-60455-3`)
    * `LES-5`           — zero BSTAR (` 00000+0`), negative first derivative
    * `STARLINK-5823`   — negative mantissa with positive exponent (`-20781+0`),
                          8-character international designator (`23028AX`)
  US-government-origin data, no licence; citation requested — "CelesTrak
  (celestrak.org), Dr. T.S. Kelso" (see DATA_SOURCES.md).
