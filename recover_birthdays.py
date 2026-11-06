#!/usr/bin/env python3
"""
Recover birth dates for House members that congress-legislators leaves blank.

The population is everyone with at least one House term in legislators-current
or legislators-historical, read from the JSON rather than the flat CSV: the CSV
records only a member's last term, so filtering it to type=rep drops everyone
who later moved to the Senate.

Three sources are compared, none of which is sufficient alone:

  directory  Biographical Directory of the United States Congress, 1774-2005
             (H. Doc. 108-222, GPO). The official record, and it says outright
             when a date is approximate or unknown. Frozen at 2005.
  voteview   HSall_members.csv, a birth year per member. Keyed by Bioguide ID,
             but not independent of the directory, and not always right.
  wikidata   P569 on the QID congress-legislators gives for that member. The
             only source with full dates for these people; quality varies.

Outputs:
  birthdays_supplement.csv  one row per recovered member (same leading columns
                            as SenateAgeHistogram/birthdays_supplement.csv)
  birthdays_overrides.csv   upstream dates that cannot be right, and what replaces
                            them. Unlike the supplement, these win over upstream
  birthdays_review.csv      every member whose row needs a human look, or who
                            could not be dated at all

Sources are cached in data/; pass --refresh to re-download. Needs pdftotext
(poppler) the first time, to extract the directory's text. Otherwise stdlib.
"""

import csv
import json
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RETRIEVED = date.today().isoformat()
USER_AGENT = "HouseAgeViz-birthday-recovery/1.0"

LEGISLATORS = "https://unitedstates.github.io/congress-legislators"
VOTEVIEW = "https://voteview.com/static/data/out/members/HSall_members.csv"
DIRECTORY_PKG = "https://www.govinfo.gov/content/pkg/GPO-CDOC-108hdoc222"
DIRECTORY_PDF = f"{DIRECTORY_PKG}/pdf/GPO-CDOC-108hdoc222.pdf"

MIN_HOUSE_AGE = 25  # Art. I, sec. 2. Below this a date is suspect, not impossible.

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico", "PI": "Philippines",
    "DK": "Dakota", "OL": "Orleans", "GU": "Guam", "VI": "Virgin Islands",
    "AS": "American Samoa", "MP": "Northern Mariana",
}

MONTHS = ("January February March April May June July August September "
          "October November December").split()
MONTH_RE = "|".join(MONTHS)


# ── sources ──────────────────────────────────────────────────────────────────

def download(url, path, refresh):
    if refresh or not path.exists():
        print(f"  downloading {path.name} ...", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=300) as resp:
            path.write_bytes(resp.read())
    return path


def load_house_people(refresh):
    people = []
    for name in ("legislators-current.json", "legislators-historical.json"):
        path = download(f"{LEGISLATORS}/{name}", DATA / name, refresh)
        people.extend(json.loads(path.read_text(encoding="utf-8")))
    return [p for p in people if house_terms(p)]


def house_terms(p):
    return [t for t in p.get("terms", []) if t.get("type") == "rep"]


def load_voteview(refresh):
    """Birth year by Bioguide ID, House and Senate rows alike."""
    path = download(VOTEVIEW, DATA / "HSall_members.csv", refresh)
    years = defaultdict(set)
    with open(path, encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            if row["bioguide_id"] and row["born"]:
                years[row["bioguide_id"]].add(int(float(row["born"])))
    return years


def load_wikidata(qids, refresh):
    path = DATA / "wikidata_entities.json"
    if path.exists() and not refresh:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if set(qids) <= set(cached):
            return cached
    print(f"  querying Wikidata for {len(qids)} entities ...", flush=True)
    entities = {}
    for i in range(0, len(qids), 50):
        query = urllib.parse.urlencode({
            "action": "wbgetentities", "ids": "|".join(qids[i:i + 50]),
            "props": "claims", "format": "json",
        })
        req = urllib.request.Request(f"https://www.wikidata.org/w/api.php?{query}",
                                     headers={"User-Agent": USER_AGENT})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    entities.update(json.load(resp)["entities"])
                break
            except urllib.error.HTTPError as err:
                if err.code != 429 or attempt == 2:
                    raise
                wait = int(err.headers.get("Retry-After") or 60)
                print(f"  rate limited; waiting {wait}s", flush=True)
                time.sleep(wait)
        time.sleep(2)
    path.write_text(json.dumps(entities), encoding="utf-8")
    return entities


def wikidata_values(entity):
    """
    P569 values as (year, month, day, precision, rank), best rank only.

    Wikidata precision: 11 day, 10 month, 9 year, 8 decade, 7 century. Decade
    and century are not birth dates, so they come back separately as `coarse`.
    Over-precise bulk imports are common: "+1800-01-01" at precision 7 is on
    most of the undated members here and means nothing.
    """
    claims = entity.get("claims", {}).get("P569", [])
    live = [c for c in claims
            if c["rank"] != "deprecated" and c["mainsnak"]["snaktype"] == "value"]
    preferred = [c for c in live if c["rank"] == "preferred"] or live
    usable, coarse = [], []
    for c in preferred:
        v = c["mainsnak"]["datavalue"]["value"]
        y, m, d = int(v["time"][1:5]), int(v["time"][6:8]), int(v["time"][9:11])
        if v["precision"] >= 9:
            usable.append((y, m, d, v["precision"]))
        else:
            coarse.append((y, v["precision"]))
    return usable, coarse


# ── the printed directory ────────────────────────────────────────────────────

def load_directory(refresh):
    """
    Parse the directory's text into whole entries, keyed by folded surname.

    pdftotext breaks an entry wherever the printed line or page did, sometimes
    between a month and its year, so an entry runs to the next heading. Running
    heads and page numbers are dropped on the way: a stray "1655" inside a born
    clause would otherwise read as a birth year.
    """
    pdf = download(DIRECTORY_PDF, DATA / "GPO-CDOC-108hdoc222.pdf", refresh)
    txt = DATA / "GPO-CDOC-108hdoc222.txt"
    if refresh or not txt.exists():
        subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf), str(txt)], check=True)

    head = re.compile(
        r"^(?P<last>[A-Za-z][A-Za-z'’\-\. ]*?),\s+(?P<given>[^;]*?),\s+"
        r"an?\s+(?P<role>[^;]*?\bfrom\b[^;]*);\s*(?P<bio>.*)$"
    )
    start = re.compile(r"^(?:[a-z]+ )*[A-Z][A-Za-z'’\-\. ]*[A-Z'’], [A-Z]")
    furniture = re.compile(r"^\s*(?:\d{1,4}\s+)?(?:Biographies|Biographical Directory.*)?(?:\s+\d{1,4})?\s*$")

    lines = txt.read_text(encoding="utf-8").splitlines()
    heads = []
    for i, line in enumerate(lines):
        if not start.match(line):
            continue
        # A heading can wrap, with blank lines, before its semicolon.
        joined = line if ";" in line else " ".join(
            [line] + [l for l in lines[i + 1:i + 4] if l.strip()][:1])
        # Family notes in the heading can hold commas and the word "a", so drop
        # them. Only there: later parentheses hold the service dates.
        heading, sep, rest = joined.partition(";")
        m = head.match(re.sub(r"\s*\([^)]*\)", "", heading) + sep + rest)
        if m:
            heads.append((i, m))

    entries = defaultdict(list)
    for n, (i, m) in enumerate(heads):
        if not re.search(r"Representative|Delegate|Commissioner", m["role"]):
            continue
        end = heads[n + 1][0] if n + 1 < len(heads) else i + 40
        tail = [l.strip() for l in lines[i + 1:min(end, i + 40)]
                if l.strip() and not furniture.match(l)]
        if ";" not in lines[i]:
            tail = tail[1:]   # that line is already inside m["bio"]
        bio = re.sub(r"-\s+(?=[a-z])", "", " ".join([m["bio"]] + tail))
        entries[fold(m["last"])].append({"given": m["given"], "role": m["role"], "bio": bio})
    return entries


def fold(s):
    s = unicodedata.normalize("NFKD", s)
    return re.sub(r"[^a-z]", "", "".join(c for c in s if not unicodedata.combining(c)).lower())


def directory_entry(p, entries):
    """
    The directory has no Bioguide IDs, so match on surname, state, given name
    and service years. Namesakes are the hazard: a wrong match here would ship a
    wrong date with an official-looking citation, so all four must line up or
    there is no match at all.
    """
    candidates = entries.get(fold(p["name"]["last"]), [])
    if not candidates:
        return None, "surname not in directory"
    terms = house_terms(p)
    states = {STATES.get(t.get("state"), "?") for t in terms}
    pool = [e for e in candidates if any(s in e["role"] for s in states)]
    if not pool:
        return None, "no same-state entry"

    # A full date, not a bare year: "graduated in 1949" must not make a son look
    # like his father, who took his seat on January 3, 1949. Any year within the
    # member's span counts, because the source's term start can precede the real
    # one: Daniel Kilgore's reads 1833 for a seat he took in December 1834.
    lo, hi = int(terms[0]["start"][:4]), int(terms[-1]["end"][:4])
    span = "|".join(str(y) for y in range(lo, hi + 1))
    served = re.compile(rf"(?:{MONTH_RE})\.?\s+\d{{1,2}},?\s+(?:{span})")
    pool = [e for e in pool if served.search(e["bio"])]
    if not pool:
        return None, "service dates not in entry"

    named = [e for e in pool if name_fits(p["name"], e["given"])]
    if not named:
        return None, "given name differs"
    if len(named) > 1:
        # Start of the first term is the sharpest remaining discriminator.
        y = terms[0]["start"][:4]
        named = [e for e in named if re.search(rf"(?:{MONTH_RE})\.?\s+\d{{1,2}},?\s+{y}", e["bio"])] or named
    if len(named) > 1:
        wants_jr = bool(fold(p["name"].get("suffix", "")))
        named = [e for e in named if bool(JUNIOR.search(e["given"])) == wants_jr] or named
    if len(named) > 1:
        return None, f"{len(named)} same-name entries"
    return named[0], None


JUNIOR = re.compile(r",\s*(Jr|Sr|II|III|IV)\b")


def name_fits(name, given):
    """First names must match; a middle name, where both have one, must not clash."""
    def compatible(a, b):
        if len(a) == 1 or len(b) == 1:
            return a[:1] == b[:1]
        return a == b

    theirs = [fold(t) for t in JUNIOR.sub("", given).split()]
    first = fold(name.get("first", ""))
    if not theirs or not first or not compatible(first, theirs[0]):
        return False
    # Compare first words only: the source has middle = "Charles Cole".
    middle_words = name.get("middle", "").split()
    middle = fold(middle_words[0]) if middle_words else ""
    if middle and len(theirs) > 1 and not compatible(middle, theirs[1]):
        return False
    return True


def parse_birth(bio):
    """
    Read the born clause. Returns a dict with the verbatim text and whichever of
    year/month/day it states; `circa` when the directory hedges (including its
    "1769c" form), `unknown` when it says so outright, `ambiguous` for "in
    either 1732 or 1760".
    """
    head = ";".join(bio[:700].split(";")[:2])
    m = re.search(r"\bborn\b([^;]*)", head)
    # "Bath, Maine (until 1820 a district of Massachusetts)" is not a second year.
    text = re.sub(r"\([^)]*\)", "", m[1]) if m else ""
    clause = m[0].strip() if m else head[:120].strip()
    out = {"text": clause, "year": None, "month": None, "day": None,
           "circa": False, "unknown": False, "ambiguous": False}
    if re.search(r"(birth\s*date|date of birth)[^;]{0,25}unknown", head, re.I):
        out["unknown"] = True
        out["text"] = head.strip()
        return out

    full = re.search(rf"({MONTH_RE})\.?\s+(\d{{1,2}}),?\s+(1[6-9]\d\d)", text)
    month = re.search(rf"({MONTH_RE})\.?,?\s+(?:of\s+)?(1[6-9]\d\d)", text)
    years = re.findall(r"\b(1[6-9]\d\d)c?\b", text)
    if full:
        out.update(year=int(full[3]), month=MONTHS.index(full[1]) + 1, day=int(full[2]))
    elif month:
        out.update(year=int(month[2]), month=MONTHS.index(month[1]) + 1)
    elif years:
        out["year"] = int(years[0])
        out["ambiguous"] = len(set(years)) > 1
    out["circa"] = bool(re.search(
        r"\b(about|circa|ca\.|c\.|probably|possibly)\s*(in\s+)?\d|\d{4}c\b", text))
    return out


# ── reconciliation ───────────────────────────────────────────────────────────

def pick_wikidata(usable):
    """Finest value if all share a year; None if the values disagree on year."""
    if not usable:
        return None
    if len({u[0] for u in usable}) > 1:
        return None
    return max(usable, key=lambda u: u[3])


def reconcile(directory, vv_years, wd_values):
    """
    Decide one birth year, then take the finest date that agrees with it.

    Year: any two of the three sources agreeing wins. With no majority the
    directory wins as the official record; with no directory year, a lone source
    is taken as it stands. A row settled by rule rather than by agreement is
    always written to the review file.
    """
    votes = {}
    if directory and directory["year"] and not directory["ambiguous"]:
        votes["directory"] = directory["year"]
    if len(vv_years) == 1:
        votes["voteview"] = next(iter(vv_years))
    wd = pick_wikidata(wd_values)
    if wd:
        votes["wikidata"] = wd[0]

    if not votes:
        return None

    tally = Counter(votes.values())
    year, n = tally.most_common(1)[0]
    if n >= 2:
        how = "agree" if len(tally) == 1 else "majority"
    elif "directory" in votes:
        year, how = votes["directory"], "directory-tiebreak" if len(votes) > 1 else "single"
    else:
        if len(votes) > 1:   # voteview and wikidata split, directory silent
            return {"year": None, "how": "unresolvable", "votes": votes}
        how = "single"
    backers = [s for s, y in votes.items() if y == year]

    # Finest date consistent with that year.
    if directory and directory["year"] == year and directory["day"]:
        y, m, d, prec, src = year, directory["month"], directory["day"], "day", "directory"
    elif wd and wd[0] == year and wd[3] == 11 and not (wd[1] == 1 and wd[2] == 1):
        y, m, d, prec, src = wd[0], wd[1], wd[2], "day", "wikidata"
    elif wd and wd[0] == year and wd[3] == 10:
        y, m, d, prec, src = wd[0], wd[1], 1, "month", "wikidata"
    elif directory and directory["year"] == year and directory["month"]:
        y, m, d, prec, src = year, directory["month"], 1, "month", "directory"
    else:
        # Includes day-precision January 1 from Wikidata: indistinguishable from
        # a year-only import, so it is not allowed to claim a day.
        y, m, d, prec = year, 1, 1, "year"
        src = "directory" if "directory" in backers else backers[0]

    return {"year": year, "how": how, "votes": votes, "backers": backers,
            "date": f"{y:04d}-{m:02d}-{d:02d}", "precision": prec, "date_source": src}


def full_name(p):
    n = p["name"]
    if n.get("official_full"):
        return n["official_full"]
    return " ".join(x.strip(" ,") for x in [n.get("first"), n.get("middle"), n.get("last")] if x)


def source_url(src, qid):
    return {
        "wikidata": f"https://www.wikidata.org/wiki/{qid}",
        "directory": f"{DIRECTORY_PKG}/pdf/GPO-CDOC-108hdoc222.pdf",
        "voteview": VOTEVIEW,
    }[src]


# ── control: can the directory parser reproduce dates we already have? ───────

def control(people, entries, voteview):
    tally = Counter()
    for p in people:
        known = p.get("bio", {}).get("birthday")
        if not known:
            continue
        vv = voteview.get(p["id"]["bioguide"], set())
        if vv:
            tally["voteview_year_match" if int(known[:4]) in vv else "voteview_year_diff"] += 1
        e, _ = directory_entry(p, entries)
        if not e:
            tally["directory_unmatched"] += 1
            continue
        b = parse_birth(e["bio"])
        tally["directory_matched"] += 1
        if b["year"] is None:
            tally["directory_no_year"] += 1
        elif str(b["year"]) != known[:4]:
            tally["directory_year_diff"] += 1
        elif b["day"]:
            same = f"{b['year']:04d}-{b['month']:02d}-{b['day']:02d}" == known
            tally["directory_day_match" if same else "directory_day_diff"] += 1
        else:
            tally["directory_year_match_only"] += 1
    return tally


def upstream_suspects(people):
    """
    Dates already in congress-legislators that cannot be right: Jeremiah Cosden
    carries his own term-start date as a birthday. decide_override() says what
    happens to each one.
    """
    out = []
    for p in people:
        born = p.get("bio", {}).get("birthday")
        if not born:
            continue
        first = house_terms(p)[0]
        age = int(first["start"][:4]) - int(born[:4])
        if age < MIN_HOUSE_AGE - 1:   # -1: a difference of years can overstate by one
            out.append((p, first, born, age))
    return out


def decide_override(birth, vv_years):
    """
    Replace an impossible upstream date only on firm ground. The directory's
    year stands if Voteview gives the same one; a directory that says "unknown"
    makes the member undated. Anything else stays as published, for review.
    Returns (action, date, precision).
    """
    if birth and birth["unknown"]:
        return "treat_undated", "", ""
    if birth and birth["year"] and not birth["ambiguous"] and vv_years == {birth["year"]}:
        if birth["day"]:
            return "use_directory", f"{birth['year']:04d}-{birth['month']:02d}-{birth['day']:02d}", "day"
        if birth["month"]:
            return "use_directory", f"{birth['year']:04d}-{birth['month']:02d}-01", "month"
        return "use_directory", f"{birth['year']:04d}-01-01", "year"
    return None, "", ""


# ── per-Congress coverage ────────────────────────────────────────────────────

def congress_opens(n):
    year = 1789 + 2 * (n - 1)
    return f"{year}-03-04" if n <= 73 else f"{year}-01-03"


def coverage(people, recovered, undated=frozenset()):
    """
    Share of seats on each convening day that carry a birth date, before and
    after this script's work. `undated` holds upstream dates thrown out.
    """
    terms = [(p, t) for p in people for t in house_terms(p)]
    rows = []
    n = 1
    while congress_opens(n) <= date.today().isoformat():
        lo, hi = congress_opens(n), congress_opens(n + 1)
        starts = Counter(t["start"] for _, t in terms if lo <= t["start"] < hi)
        if starts:
            when = starts.most_common(1)[0][0]
            seated = {p["id"]["bioguide"]: p for p, t in terms if t["start"] <= when < t["end"]}
            before = sum(bool(p.get("bio", {}).get("birthday")) for p in seated.values())
            after = sum((bool(p.get("bio", {}).get("birthday")) or b in recovered)
                        and b not in undated for b, p in seated.items())
            rows.append((n, when, len(seated), before, after))
        n += 1
    return rows


# ── main ─────────────────────────────────────────────────────────────────────

OVERRIDE_COLS = ["bioguide", "name", "upstream_birthday", "action", "birth_date",
                 "precision", "circa", "source", "retrieved", "directory_says",
                 "voteview_year", "reason"]
SUPPLEMENT_COLS = ["bioguide", "name", "birth_date", "precision", "wikidata_id",
                   "source", "retrieved", "circa", "agreement", "directory_says",
                   "voteview_year", "wikidata_values"]
REVIEW_COLS = ["status", "bioguide", "name", "first_house_term", "state",
               "chosen_date", "precision", "age_at_first_term", "reason",
               "directory_says", "voteview_year", "wikidata_values", "wikidata_id"]


def main(refresh=False):
    DATA.mkdir(exist_ok=True)
    print("Loading sources ...")
    people = load_house_people(refresh)
    voteview = load_voteview(refresh)
    entries = load_directory(refresh)
    missing = [p for p in people if not p.get("bio", {}).get("birthday")]
    qids = [p["id"]["wikidata"] for p in missing]
    wikidata = load_wikidata(qids, refresh)
    print(f"  {len(people):,} people with House service; {len(missing)} without a birthday")

    print("\nControl: sources against dates congress-legislators already has")
    for k, v in sorted(control(people, entries, voteview).items()):
        print(f"  {k:28s} {v:6,d}")

    supplement, review, recovered = [], [], set()
    stats = Counter()

    for p in sorted(missing, key=lambda p: house_terms(p)[0]["start"]):
        bg, qid = p["id"]["bioguide"], p["id"]["wikidata"]
        first_term = house_terms(p)[0]

        entity = wikidata.get(qid, {})
        on_entity = {c["mainsnak"].get("datavalue", {}).get("value")
                     for c in entity.get("claims", {}).get("P1157", [])}
        qid_ok = bg in on_entity
        usable, coarse = wikidata_values(entity) if qid_ok else ([], [])

        entry, why_not = directory_entry(p, entries)
        birth = parse_birth(entry["bio"]) if entry else None
        vv = voteview.get(bg, set())

        wd_text = "; ".join(
            f"{y:04d}-{m:02d}-{d:02d}/p{pr}" for y, m, d, pr in usable
        ) + ("; " if usable and coarse else "") + "; ".join(f"{y}/p{pr}" for y, pr in coarse)
        dir_text = birth["text"] if birth else f"[no match: {why_not}]"
        vv_text = "|".join(map(str, sorted(vv)))

        result = reconcile(birth, vv, usable)

        # Voteview occasionally holds a year the directory flatly declines to
        # give. Keep it out unless something else backs it.
        if (result and result.get("year") and birth and birth["unknown"]
                and result["backers"] == ["voteview"]):
            stats["voteview_only_rejected"] += 1
            review.append(review_row("rejected", p, first_term, None, None,
                                     "Voteview-only year; directory says unknown",
                                     dir_text, vv_text, wd_text, qid))
            continue

        if not result or result.get("year") is None:
            reason = ("sources split and directory silent" if result
                      else "no source gives a year")
            stats["unrecovered"] += 1
            review.append(review_row("unrecovered", p, first_term, None, None, reason,
                                     dir_text, vv_text, wd_text, qid))
            continue

        age = int(first_term["start"][:4]) - result["year"]
        circa = bool(birth and ((birth["circa"] and birth["year"] == result["year"])
                                 or birth["ambiguous"]))
        stats[f"how_{result['how']}"] += 1
        stats[f"precision_{result['precision']}"] += 1
        stats["circa"] += circa

        recovered.add(bg)
        supplement.append({
            "bioguide": bg, "name": full_name(p), "birth_date": result["date"],
            "precision": result["precision"], "wikidata_id": qid,
            "source": source_url(result["date_source"], qid), "retrieved": RETRIEVED,
            "circa": "yes" if circa else "", "agreement": result["how"],
            "directory_says": dir_text, "voteview_year": vv_text, "wikidata_values": wd_text,
        })

        reasons = []
        if result["how"] == "directory-tiebreak":
            reasons.append("no majority; directory used")
        elif result["how"] == "majority":
            reasons.append("sources differ; majority used")
        if result["how"] == "single":
            reasons.append("one source only")
        if age < MIN_HOUSE_AGE:
            reasons.append(f"under {MIN_HOUSE_AGE} at first term")
        if reasons:
            status = ("conflict" if result["how"] in ("majority", "directory-tiebreak")
                      else "weak")
            stats[f"review_{status}"] += 1
            review.append(review_row(status, p, first_term, result["date"], result["precision"],
                                     "; ".join(reasons), dir_text, vv_text, wd_text, qid, age))

    overrides = []
    for p, term, born, age in upstream_suspects(people):
        bg = p["id"]["bioguide"]
        entry, why_not = directory_entry(p, entries)
        birth = parse_birth(entry["bio"]) if entry else None
        says = birth["text"] if birth else f"[no match: {why_not}]"
        vv_years = voteview.get(bg, set())
        vv = "|".join(map(str, sorted(vv_years)))
        action, new_date, prec = decide_override(birth, vv_years)
        stats[f"upstream_{action or 'left_as_published'}"] += 1
        reason = f"congress-legislators date {born} implies age {age} at first term"
        if action:
            overrides.append({
                "bioguide": bg, "name": full_name(p), "upstream_birthday": born,
                "action": action, "birth_date": new_date, "precision": prec,
                "circa": "yes" if birth["circa"] else "",
                "source": source_url("directory", ""), "retrieved": RETRIEVED,
                "directory_says": says, "voteview_year": vv, "reason": reason,
            })
        review.append(review_row("upstream_suspect", p, term, new_date, prec or "as published",
                                 reason=f"{reason}; {action or 'left as published'}", age=age,
                                 dir_text=says, vv_text=vv, wd_text="", qid=p["id"].get("wikidata", "")))

    write(ROOT / "birthdays_overrides.csv", OVERRIDE_COLS, overrides)
    write(ROOT / "birthdays_supplement.csv", SUPPLEMENT_COLS, supplement)
    order = {"upstream_suspect": 0, "conflict": 1, "weak": 2, "rejected": 3, "unrecovered": 4}
    review.sort(key=lambda r: (order[r["status"]], r["first_house_term"]))
    write(ROOT / "birthdays_review.csv", REVIEW_COLS, review)

    print(f"\nRecovered {len(recovered)} of {len(missing)}; "
          f"{len(missing) - len(recovered)} remain undated")
    for k, v in sorted(stats.items()):
        print(f"  {k:28s} {v:5d}")

    thrown_out = {o["bioguide"] for o in overrides if o["action"] == "treat_undated"}
    rows = coverage(people, recovered, thrown_out)
    print("\nSeats with a birth date on convening day (before -> after):")
    print("  cong  convened    seats  before  after")
    for n, when, seats, before, after in rows:
        if before < seats:
            print(f"  {n:4d}  {when}  {seats:5d}  {before / seats:6.1%}  {after / seats:6.1%}")
    total = sum(r[2] for r in rows)
    print(f"  all   {rows[0][1][:4]}-{rows[-1][1][:4]}   {total:6,d}  "
          f"{sum(r[3] for r in rows) / total:6.1%}  {sum(r[4] for r in rows) / total:6.1%}")


def review_row(status, p, term, chosen, prec, reason, dir_text, vv_text, wd_text, qid, age=""):
    return {"status": status, "bioguide": p["id"]["bioguide"], "name": full_name(p),
            "first_house_term": term["start"], "state": term.get("state", ""),
            "chosen_date": chosen or "", "precision": prec or "", "age_at_first_term": age,
            "reason": reason, "directory_says": dir_text, "voteview_year": vv_text,
            "wikidata_values": wd_text, "wikidata_id": qid}


def write(path, cols, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {path.name:28s} {len(rows):5,d} rows")


if __name__ == "__main__":
    main(refresh="--refresh" in sys.argv)
