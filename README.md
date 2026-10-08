# Canonn Colony Finder

Finds unpopulated, faction-free star systems within **15 ly** of a station
actually controlled by **Canonn** or **Canonn Deep Space Research**, limited
to systems that are "interesting" (rare body types, or more than 40 bodies).

The output is a JSON list meant to feed a UI that tells a player which
Canonn-controlled system/station to colonise *from* in order to reach a given
target system.

## Usage

```bash
python3 canonn_colony_finder.py /path/to/galaxy.json.gz
```

- `galaxy.json.gz` is the full Spansh galaxy dump
  (https://downloads.spansh.co.uk/galaxy.json.gz). It is **not** bundled here
  — it's currently ~117 GB, so point the script at wherever you've downloaded
  it (any path/drive).
- `factions.json.gz` (Spansh's per-faction presence dump) is bundled in this
  folder already. If it's ever missing, the script re-downloads it
  automatically from https://downloads.spansh.co.uk/factions.json.gz.
- Output is written next to the script, as `canonn_colony_targets.json`.
- Progress is logged to stdout every 500,000 lines scanned.

This is a long-running job (one full read of a 117 GB file) — run it under
`tmux`/`screen`/`nohup` on whatever machine holds the dump.

## How it works

The whole pipeline is one script, and it only reads `galaxy.json.gz` **once**
— that file is too large to read twice, so the script is structured
specifically to avoid needing a second pass.

### Step 1 — Candidates (from `factions.json.gz`)

`factions.json.gz` lists, per faction, every system where that faction has
*any* presence (not necessarily control of anything), along with each
system's `id64` and galactic coordinates.

The script pulls every system listed under the `"Canonn"` or
`"Canonn Deep Space Research"` faction entries. This is the **candidate**
list — a few thousand systems. Presence here does *not* mean Canonn controls
a station there; it just means they have some influence, which is enough to
know roughly where to look.

Having coordinates for every candidate up front (straight from
`factions.json.gz`, no need to touch the galaxy dump for this) is what makes
the single-pass design possible — see Step 2b.

### Step 2 — The single pass over `galaxy.json.gz`

`galaxy.json.gz` is a huge JSON array, one system object per line. The
script streams it line by line (`gzip` + `json.loads` per line, never loading
the whole file into memory) and does two independent things per line:

**2a. Confirm real anchors.** If the line's `id64` is in the candidate set,
the script fully parses that system and checks every station (both
system-level `stations` and any body-level `stations`) for a
`controllingFaction` equal to `"Canonn"` or `"Canonn Deep Space Research"`.
Only candidates that actually control at least one station become
**anchors** — most candidates (faction presence without control) are
dropped here. An anchor keeps its name, coordinates, and the list of station
names Canonn/Canonn DSR actually control there.

**2b. Collect interesting, in-range, unclaimed systems.** For every system
(not just candidates), the script checks:
- `population` is 0 (or absent)
- no `controllingFaction` set at the system level
- "interesting": `bodyCount > 40`, or it contains a rare body (see below)
- it's within 15 ly of **some candidate** — checked against a spatial grid
  built from all candidates' coordinates *before* the galaxy pass even
  starts (that's why Step 1 collecting coordinates mattered)

That last check is the key to keeping memory bounded. Without it, the
in-memory pool of "interesting, unpopulated, faction-free" systems would grow
to cover the entire galaxy. Restricting it to systems near *some* candidate
keeps the pool limited to the handful of small 15 ly bubbles actually
relevant to Canonn space.

Note that at this point we only know candidates, not confirmed anchors —
whether a given candidate actually controls a station is discovered
independently as its own line is reached (Step 2a), which might happen before
or after any particular system in Step 2b is being considered. This is
exactly why the two checks are kept separate within the same pass instead of
filtering 2b directly against confirmed anchors.

### Step 3 — Final join (in memory, no second file read)

Once the single pass over `galaxy.json.gz` finishes, both collections are
small:
- the confirmed anchors (candidates that really do control a station)
- the interesting pool (already bounded to systems near *some* candidate,
  confirmed anchor or not)

The script builds a spatial grid from just the confirmed anchors and
re-checks every system in the interesting pool against it, keeping only
those within 15 ly of a *confirmed* anchor and discarding any that were only
near a candidate that turned out not to control anything. This re-check is
cheap — both collections are already small — so it does not require touching
`galaxy.json.gz` again.

The surviving systems are written to `canonn_colony_targets.json`.

### Spatial grid (used in both Step 2b and Step 3)

Distance filtering (within a fixed radius) would be an O(n²) comparison
against a naive list of anchors/candidates, which doesn't scale once there
are thousands of them. Instead, locations are bucketed into a grid of cubes
exactly `15 ly` on a side, keyed by `(floor(x/15), floor(y/15), floor(z/15))`.
To find anything within 15 ly of a point, it's enough to look at the point's
own grid cell plus its 26 neighbours (3×3×3 cube of cells) — anything closer
than 15 ly must fall in one of those 27 cells. This turns each lookup into a
handful of dictionary lookups instead of a scan of every anchor/candidate.

### "Interesting" body criteria

A system counts as interesting if `bodyCount > 40`, **or** it contains any
body matching:

- **Rare stars** (subtype contains): `Black Hole`, `Neutron Star`, `Herbig`
  (Ae/Be), `Wolf-Rayet`, `T Tauri`, `White Dwarf`
- **Rare planets** (exact subtype): `Earth-like world`, `Water world`,
  `Ammonia world`, `Water giant`, or any gas giant subtype containing "life"
  (biological gas giants)
- **Ringed landable with an atmosphere**: any body that is landable, has
  rings, and has an `atmosphereType` other than "No atmosphere"

These lists are plain constants (`RARE_STAR_MARKERS`, `RARE_PLANET_TYPES`) at
the top of the script — edit them directly to change what counts as
"interesting".

## Output format

`canonn_colony_targets.json` is a JSON array of objects:

```json
{
  "name": "Target System Name",
  "id64": 123456789,
  "coords": { "x": 0.0, "y": 0.0, "z": 0.0 },
  "bodyCount": 42,
  "population": 0,
  "distanceToHome": 12.34,
  "homeSystem": "Canonn Anchor System",
  "homeStations": ["Station Controlled By Canonn"],
  "interestingBodies": [
    { "name": "Target System Name A 1", "subType": "Neutron Star" }
  ]
}
```

- `distanceToHome` / `homeSystem` / `homeStations` describe the nearest
  confirmed Canonn anchor, which is where a player would colonise *from* to
  reach this system.
- `interestingBodies` is empty if the system only qualified via
  `bodyCount > 40`.
