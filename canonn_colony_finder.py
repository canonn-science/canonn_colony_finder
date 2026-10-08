"""Single-pass pipeline: find unpopulated, faction-free, "interesting" systems
within 15 ly of a station actually controlled by Canonn or Canonn Deep Space
Research.

Only one read of galaxy.json.gz is performed. During that single pass we:
  1. Check every candidate system (from factions.json.gz presence data, which
     also carries each candidate's coords) for a station actually controlled
     by Canonn / Canonn Deep Space Research -> these become "anchors". Which
     candidates turn out to be real anchors is only known once their line is
     reached in the file, which can be before or after any given system.
  2. Collect unpopulated, faction-free, "interesting" systems (rare body
     types, or >40 bodies) into an in-memory pool - but ONLY those within
     15 ly of some candidate (using a grid built from candidate coords, known
     up front from factions.json.gz, before the galaxy.json.gz pass starts).
     This keeps the pool bounded to the handful of 15 ly bubbles around
     candidate systems, instead of every interesting system in the galaxy.

Once the pass is done, both the confirmed-anchor list and the (already
distance-bounded) interesting pool are small, so re-checking the pool against
only the *confirmed* anchors (a subset of candidates) is a cheap in-memory
step afterwards - not a second file pass.

Usage:
    python3 canonn_colony_finder.py /path/to/galaxy.json.gz

Output: site/data/canonn_colony_targets.json (written next to this script)
"""
import argparse
import gzip
import json
import math
import os
import re
import time
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

FACTIONS_URL = "https://downloads.spansh.co.uk/factions.json.gz"
FACTIONS_FILE = os.path.join(SCRIPT_DIR, "factions.json.gz")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "site", "data", "canonn_colony_targets.json")

TARGET_FACTIONS = {"Canonn", "Canonn Deep Space Research"}

RADIUS_LY = 15.0
MIN_BODY_COUNT = 40
GRID_SIZE = RADIUS_LY  # one grid cell = one radius, so a 1-cell neighborhood covers it

RARE_STAR_MARKERS = (
    "Black Hole",
    "Neutron Star",
    "Herbig",
    "Wolf-Rayet",
    "T Tauri",
    "White Dwarf",
)
RARE_PLANET_TYPES = {
    "Earth-like world",
    "Water world",
    "Ammonia world",
    "Water giant",
}

ID64_RE = re.compile(r'"id64":(\d+)')


# ---------------------------------------------------------------- step 1: candidates

def download_factions():
    if os.path.exists(FACTIONS_FILE):
        print(f"{FACTIONS_FILE} already exists, skipping download.")
        return
    print(f"Downloading {FACTIONS_URL} ...")
    urllib.request.urlretrieve(FACTIONS_URL, FACTIONS_FILE)
    print("Download complete.")


def load_candidates():
    """Systems where Canonn / Canonn Deep Space Research has any faction
    presence, from factions.json.gz (which conveniently also carries each
    system's coords). This is just a shortlist to check for real station
    control during the galaxy.json.gz pass - presence here does NOT mean
    they control a station."""
    with gzip.open(FACTIONS_FILE, "rt", encoding="utf-8") as f:
        data = json.load(f)

    candidates = {}
    for faction in data:
        if faction.get("name") not in TARGET_FACTIONS:
            continue
        for sys_entry in faction.get("systems", []):
            id64 = sys_entry.get("systemId64")
            if id64 is None:
                continue
            candidates[id64] = {
                "name": sys_entry.get("systemName"),
                "coords": sys_entry.get("coords") or {},
            }
    return candidates


# ---------------------------------------------------------------- body classification

def is_rare_star(sub_type):
    return any(marker in sub_type for marker in RARE_STAR_MARKERS)


def is_rare_planet(sub_type):
    if sub_type in RARE_PLANET_TYPES:
        return True
    return "life" in sub_type.lower() and "gas giant" in sub_type.lower()


def interesting_bodies(bodies):
    found = []
    for body in bodies:
        sub_type = body.get("subType") or ""
        body_type = body.get("type")
        rare = False
        if body_type == "Star" and is_rare_star(sub_type):
            rare = True
        elif body_type == "Planet" and is_rare_planet(sub_type):
            rare = True
        elif (
            body.get("isLandable")
            and body.get("rings")
            and (body.get("atmosphereType") or "No atmosphere") != "No atmosphere"
        ):
            rare = True
        if rare:
            found.append({"name": body.get("name"), "subType": sub_type})
    return found


def controlled_stations(stations):
    names = []
    for st in stations or []:
        if st.get("controllingFaction") in TARGET_FACTIONS:
            names.append(st.get("name"))
    return names


# ---------------------------------------------------------------- step 2: single pass

def cell_key(x, y, z):
    return (math.floor(x / GRID_SIZE), math.floor(y / GRID_SIZE), math.floor(z / GRID_SIZE))


def build_grid(locations):
    """locations: iterable of dicts with a "coords" key."""
    grid = {}
    for loc in locations:
        c = loc["coords"]
        if "x" not in c:
            continue
        grid.setdefault(cell_key(c["x"], c["y"], c["z"]), []).append(loc)
    return grid


def nearest_in_grid(grid, x, y, z):
    cx, cy, cz = cell_key(x, y, z)
    best, best_dist = None, None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for loc in grid.get((cx + dx, cy + dy, cz + dz), []):
                    c = loc["coords"]
                    dist = math.sqrt((x - c["x"]) ** 2 + (y - c["y"]) ** 2 + (z - c["z"]) ** 2)
                    if dist <= RADIUS_LY and (best_dist is None or dist < best_dist):
                        best, best_dist = loc, dist
    return best, best_dist


def scan_galaxy(candidates, galaxy_file):
    """candidates: dict of id64 -> {"name": ..., "coords": {...}}."""
    candidate_ids = set(candidates.keys())
    # Pre-built from factions.json.gz coords - lets us reject systems far from
    # EVERY candidate up front, so the in-memory pool stays bounded to the
    # handful of 15 ly bubbles around candidate systems instead of every
    # unpopulated/interesting system in the galaxy.
    candidate_grid = build_grid(
        {"coords": c["coords"]} for c in candidates.values() if c.get("coords")
    )

    anchors = []
    found_candidate_ids = set()
    interesting_pool = []

    start = time.time()
    scanned = 0

    with gzip.open(galaxy_file, "rt", encoding="utf-8") as f:
        for line in f:
            scanned += 1
            if scanned % 500_000 == 0:
                elapsed = time.time() - start
                print(f"  scanned {scanned:,} lines, "
                      f"{len(anchors)} anchors, {len(interesting_pool)} interesting candidates, "
                      f"{elapsed:.0f}s elapsed")

            stripped = line.strip()
            if stripped in ("[", "]", ""):
                continue

            id_match = ID64_RE.search(line)
            is_candidate = bool(id_match) and int(id_match.group(1)) in candidate_ids and \
                int(id_match.group(1)) not in found_candidate_ids

            population_hint = '"population":0' in line or '"population": 0' in line
            # Cheap reject: only fully parse lines that are either a station
            # candidate check, or that *might* pass the interesting-pool filter
            # (unpopulated systems only - skip inhabited systems outright).
            if not is_candidate and not population_hint:
                continue

            try:
                system = json.loads(stripped.rstrip(","))
            except json.JSONDecodeError:
                continue

            id64 = system.get("id64")

            # --- anchor check ---
            if is_candidate:
                found_candidate_ids.add(id64)
                names = controlled_stations(system.get("stations"))
                for body in system.get("bodies", []):
                    names.extend(controlled_stations(body.get("stations")))
                if names:
                    coords = system.get("coords") or {}
                    anchors.append({
                        "id64": id64,
                        "name": system.get("name"),
                        "coords": coords,
                        "stations": sorted(set(names)),
                    })

            # --- interesting-pool check ---
            population = system.get("population") or 0
            if population > 0:
                continue
            if system.get("controllingFaction"):
                continue

            coords = system.get("coords") or {}
            if "x" not in coords:
                continue

            bodies = system.get("bodies") or []
            body_count = system.get("bodyCount") or len(bodies)
            rare_bodies = interesting_bodies(bodies)

            if body_count <= MIN_BODY_COUNT and not rare_bodies:
                continue

            # Bound memory: only keep it if it's within range of *some*
            # candidate. Confirmed-anchor filtering happens later, in
            # join_and_write, since not every candidate turns out to control
            # a station.
            nearby_candidate, _ = nearest_in_grid(candidate_grid, coords["x"], coords["y"], coords["z"])
            if nearby_candidate is None:
                continue

            interesting_pool.append({
                "name": system.get("name"),
                "id64": id64,
                "coords": coords,
                "bodyCount": body_count,
                "population": population,
                "interestingBodies": rare_bodies,
            })

    elapsed = time.time() - start
    print(f"Galaxy pass done in {elapsed:.0f}s. Scanned {scanned:,} lines.")
    print(f"Resolved {len(found_candidate_ids)}/{len(candidate_ids)} candidates; "
          f"{len(anchors)} confirmed Canonn anchors.")
    print(f"{len(interesting_pool)} unpopulated/faction-free/interesting systems in pool.")

    return anchors, interesting_pool


# ---------------------------------------------------------------- step 3: final join

def join_and_write(anchors, interesting_pool):
    # interesting_pool was already pre-filtered against candidate_grid during
    # the scan, but candidates != confirmed anchors - a provisional entry may
    # only be near a candidate that turned out NOT to control a station, so
    # re-check against the (smaller) confirmed-anchors grid here. This is an
    # in-memory check only, not a second file pass.
    grid = build_grid(anchors)
    results = []

    for system in interesting_pool:
        c = system["coords"]
        anchor, distance = nearest_in_grid(grid, c["x"], c["y"], c["z"])
        if anchor is None:
            continue
        results.append({
            "name": system["name"],
            "id64": system["id64"],
            "coords": c,
            "bodyCount": system["bodyCount"],
            "population": system["population"],
            "distanceToHome": round(distance, 2),
            "homeSystem": anchor["name"],
            "homeStations": anchor["stations"],
            "interestingBodies": system["interestingBodies"],
        })

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as out:
        json.dump(results, out, indent=2)

    print(f"{len(results)} colony target systems written to {OUTPUT_FILE}.")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Find unpopulated, interesting systems within 15 ly of a "
                     "Canonn / Canonn Deep Space Research controlled station."
    )
    parser.add_argument(
        "galaxy_file",
        help="Path to the Spansh galaxy.json.gz dump (not bundled - get it "
             "from https://downloads.spansh.co.uk/galaxy.json.gz).",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    download_factions()
    candidates = load_candidates()
    print(f"Loaded {len(candidates)} candidate systems with Canonn / "
          f"Canonn Deep Space Research presence.")

    anchors, interesting_pool = scan_galaxy(candidates, args.galaxy_file)
    join_and_write(anchors, interesting_pool)


if __name__ == "__main__":
    main()
