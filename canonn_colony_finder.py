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

RARE_SUBTYPES = {
    "High metal content world",
    "Rocky body",
    "Metal-rich body",
    "Water world",
    "Gas giant with water-based life",
    "Neutron Star",
    "T Tauri Star",
    "Gas giant with ammonia-based life",
    "Ammonia world",
    "Earth-like world",
    "Black Hole",
    "Water giant",
    "Helium-rich gas giant",
    "M (Red giant) Star",
    "White Dwarf (DC) Star",
    "Herbig Ae/Be Star",
    "White Dwarf (DA) Star",
    "White Dwarf (DAB) Star",
    "K (Yellow-Orange giant) Star",
    "Wolf-Rayet O Star",
    "S-type Star",
    "MS-type Star",
    "White Dwarf (DB) Star",
    "CN Star",
    "A (Blue-White super giant) Star",
    "White Dwarf (DCV) Star",
    "B (Blue-White super giant) Star",
    "White Dwarf (DAV) Star",
    "Wolf-Rayet C Star",
    "Wolf-Rayet N Star",
    "Wolf-Rayet NC Star",
    "F (White super giant) Star",
    "G (White-Yellow super giant) Star",
    "White Dwarf (DBV) Star",
    "M (Red super giant) Star",
    "CJ Star",
    "White Dwarf (DAZ) Star",
    "White Dwarf (DBZ) Star",
    "C Star",
    "Wolf-Rayet Star",
    "White Dwarf (DQ) Star",
    "Helium gas giant",
    "White Dwarf (D) Star",
}

# Matched against raw bytes before the line is ever decoded - see scan_galaxy().
# Spansh's dumps are minified (no space after a colon, confirmed against
# factions.json.gz), so a single no-space pattern is enough.
ID64_RE = re.compile(rb'"id64":(\d+)')
POPULATION_ZERO = b'"population":0'
# Cheap pre-parse coords extraction (see scan_galaxy()) - same minified-format
# assumption as ID64_RE. Only used to bound-reject before a full json.loads;
# a non-match always falls back to parsing the line, so it's never load-bearing
# for correctness, only for speed.
COORDS_RE = re.compile(rb'"coords":\{"x":(-?[0-9.]+),"y":(-?[0-9.]+),"z":(-?[0-9.]+)\}')


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

GENUS_PREFIX = "$Codex_Ent_"
# Raw codex genus string for Bark Mounds - checked before cleaning, see interesting_bodies().
CONE_GENUS = "$Codex_Ent_Cone_Name;"
# Most genus codex names end in "_Genus_Name;" (e.g. "Bacterial"), but a few -
# Brain Trees among them - skip the "_Genus_" segment and just end in "_Name;".
GENUS_SUFFIXES = ("_Genus_Name;", "_Name;")

# Codex internal names that don't read as an English genus name even once the
# prefix/suffix are stripped (e.g. "Brancae" -> "Brain Trees").
GENUS_NAME_OVERRIDES = {
    "Brancae": "Brain Trees",
    "Cone": "Bark Mounds",
}


def clean_genus_name(raw):
    """"$Codex_Ent_Bacterial_Genus_Name;" -> "Bacterial"; "$Codex_Ent_Brancae_Name;" -> "Brain Trees"."""
    name = raw or ""
    if name.startswith(GENUS_PREFIX):
        name = name[len(GENUS_PREFIX):]
    for suffix in GENUS_SUFFIXES:
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return GENUS_NAME_OVERRIDES.get(name, name)


def normalize_terraforming(raw):
    """Spansh's free-text terraformingState, collapsed to one of four states."""
    value = (raw or "").strip().lower()
    if not value or value == "not terraformable":
        return "not"
    if "terraformed" in value:
        return "terraformed"
    if "terraforming" in value:
        return "terraforming"
    return "terraformable"  # e.g. "Terraformable" / "Candidate for terraforming"


def interesting_bodies(bodies):
    found = []
    for body in bodies:
        sub_type = body.get("subType") or ""
        body_type = body.get("type")
        is_gas_giant = body_type == "Planet" and "gas giant" in sub_type.lower()
        rare = sub_type in RARE_SUBTYPES or is_gas_giant
        if rare:
            found.append({
                "name": body.get("name"),
                "subType": sub_type,
                "ringed": bool(body.get("rings")),
                "terraform": normalize_terraforming(body.get("terraformingState")),
            })

        genuses = (body.get("signals") or {}).get("genuses") or []
        for genus in genuses:
            # Bark Mounds (Cone) are a volcanic-activity signal - without an
            # actual volcanism type on the body, this genus entry is noise.
            if genus == CONE_GENUS and not has_volcanism(body):
                continue
            found.append({
                "name": body.get("name"),
                "subType": clean_genus_name(genus),
                "ringed": False,
                "terraform": "not",
            })
    return found


def has_volcanism(body):
    volcanism = (body.get("volcanismType") or "").strip()
    return bool(volcanism) and volcanism.lower() != "no volcanism"


def faction_name(value):
    """A faction field's name, whether it's a plain string or an object (dump
    formats vary - stations use a plain string, but the system-level
    controllingFaction field has been observed as a {"name": ...} object)."""
    if isinstance(value, dict):
        return value.get("name")
    return value


def controlled_stations(stations):
    names = []
    for st in stations or []:
        if faction_name(st.get("controllingFaction")) in TARGET_FACTIONS:
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


def nearest_anchor(grid, x, y, z):
    """Like nearest_in_grid, but for picking a system's home anchor specifically:
    an anchor whose SYSTEM (not just a station in it) is Canonn/CDSR-controlled
    always wins over one where Canonn/CDSR only controls a station in a system
    otherwise controlled by someone else (or no one) - the former is a much
    stronger signal that the system is actually "home". Distance is only the
    tiebreaker within the same preference tier."""
    cx, cy, cz = cell_key(x, y, z)
    best, best_rank = None, None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for loc in grid.get((cx + dx, cy + dy, cz + dz), []):
                    c = loc["coords"]
                    dist = math.sqrt((x - c["x"]) ** 2 + (y - c["y"]) ** 2 + (z - c["z"]) ** 2)
                    if dist > RADIUS_LY:
                        continue
                    rank = (0 if loc.get("controls_system") else 1, dist)
                    if best_rank is None or rank < best_rank:
                        best, best_rank = loc, rank
    return (best, best_rank[1]) if best is not None else (None, None)


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

    # Binary mode: the cheap per-line checks below run against raw bytes, so the
    # large majority of lines (ones we're about to reject) never pay UTF-8
    # decoding cost. Only a line that passes those checks gets decoded.
    with gzip.open(galaxy_file, "rb") as f:
        for line in f:
            scanned += 1
            if scanned % 500_000 == 0:
                elapsed = time.time() - start
                print(f"  scanned {scanned:,} lines, "
                      f"{len(anchors)} anchors, {len(interesting_pool)} interesting candidates, "
                      f"{elapsed:.0f}s elapsed")

            id_match = ID64_RE.search(line)
            line_id64 = int(id_match.group(1)) if id_match else None
            is_candidate = line_id64 is not None and line_id64 in candidate_ids and \
                line_id64 not in found_candidate_ids

            # Cheap reject: only fully parse lines that are either a station
            # candidate check, or that *might* pass the interesting-pool filter
            # (unpopulated systems only - skip inhabited systems outright). The
            # "[" / "]" array-boundary lines fall through here too, since they
            # match neither, so there's no separate check needed for them.
            if not is_candidate and POPULATION_ZERO not in line:
                continue

            if not is_candidate:
                # json.loads parses the entire line - including a potentially
                # large bodies array - regardless of which fields are read
                # afterward, so it's worth avoiding entirely for a population-0
                # system that's nowhere near any candidate. Pull coords straight
                # out of the raw bytes and apply the same distance bound used
                # later for the interesting pool, before paying for a full parse.
                coords_match = COORDS_RE.search(line)
                if coords_match:
                    x, y, z = (float(v) for v in coords_match.groups())
                    nearby_candidate, _ = nearest_in_grid(candidate_grid, x, y, z)
                    if nearby_candidate is None:
                        continue

            try:
                system = json.loads(line.decode("utf-8").rstrip(" \t\r\n,"))
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
                        "controls_system": faction_name(system.get("controllingFaction")) in TARGET_FACTIONS,
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

            # Bound memory, and skip the expensive per-body classification below:
            # only keep going if this system is within range of *some* candidate.
            # Most unpopulated systems in the galaxy are nowhere near a Canonn
            # anchor, so rejecting those here - before interesting_bodies() loops
            # every body - avoids that work for the vast majority of systems that
            # reach this point. Confirmed-anchor filtering happens later, in
            # join_and_write, since not every candidate turns out to control a
            # station.
            nearby_candidate, _ = nearest_in_grid(candidate_grid, coords["x"], coords["y"], coords["z"])
            if nearby_candidate is None:
                continue

            bodies = system.get("bodies") or []
            body_count = system.get("bodyCount") or len(bodies)
            rare_bodies = interesting_bodies(bodies)

            if body_count <= MIN_BODY_COUNT and not rare_bodies:
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
        anchor, distance = nearest_anchor(grid, c["x"], c["y"], c["z"])
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
