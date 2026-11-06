#!/usr/bin/env python3
"""
Build House-age tables for the chart.

For every Congress: how old was each person who served in it, on the day it
convened? A member serving thirty years contributes fifteen observations.

The unit is "served during this Congress", not "seated on opening day". The
source's term dates are per-Congress for most of history, so a member and their
mid-term replacement both look seated from the first day: an opening-day count
would include replacements before about the 1990s and exclude them after, which
would put an artificial step in the series. Counting everyone who served treats
every era alike. It also means a Congress can show more members than seats.

Inputs (run recover_birthdays.py first):
  data/legislators-*.json    congress-legislators, public domain
  birthdays_overrides.csv    wins over congress-legislators
  birthdays_supplement.csv   fills blanks in congress-legislators

Outputs:
  house_ages.csv        one row per member x Congress (the dots)
  house_congresses.csv  one row per Congress: date, members, age summary, coverage
  house_members.csv     one row per member: the birth date used and where it came from
  house_missing.csv     member-Congress rows dropped for want of a birth date

Stdlib only.
"""

import csv
import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
AS_OF = date.today().isoformat()   # caps the last Congress considered

# ---------------------------------------------------------------------------
#  PARTY FOLDING
#
#  The same families as SenateAgeHistogram, plus "Unrecorded": the source gives
#  no party at all for most of the earliest House terms, and an absent label is
#  a different thing from a minor party.
# ---------------------------------------------------------------------------

PARTY_MAP = {
    "Federalist": "Federalist",
    "Pro-Administration": "Federalist",
    "Pro-administration": "Federalist",

    "Democratic Republican": "Democratic-Republican",
    "Anti-Administration": "Democratic-Republican",
    "Anti-administration": "Democratic-Republican",
    "Crawford Republican": "Democratic-Republican",

    "Whig": "Whig",
    "Ind. Whig": "Whig",
    "Adams": "Whig",
    "Anti Jacksonian": "Whig",
    "Anti-Jacksonian": "Whig",
    "Anti Jackson": "Whig",

    "Democrat": "Democratic",
    "Jackson": "Democratic",
    "Jacksonian": "Democratic",
    "Jackson Republican": "Democratic",
    "Jacksonian Republican": "Democratic",

    "Republican": "Republican",
}
OTHER = "Other"
UNRECORDED = "Unrecorded"

# "Republican" names two unrelated parties in this source. In House terms the
# bare label for Jefferson's party runs through the 23rd Congress, is absent from
# the 24th to the 33rd, and returns in the 34th (1855) as the modern party. The
# Senate data's gap starts earlier, at the 20th, so the two cutoffs differ.
JEFFERSONIAN_REPUBLICAN_THROUGH = 33


def fold_party(raw, congress):
    if not raw:
        return UNRECORDED
    if raw == "Republican" and congress <= JEFFERSONIAN_REPUBLICAN_THROUGH:
        return "Democratic-Republican"
    return PARTY_MAP.get(raw, OTHER)


# ---------------------------------------------------------------------------
#  TERMS LEFT OUT
#
#  House terms in congress-legislators that the other two sources both contradict:
#  the Biographical Directory gives no such service, and Voteview has no House
#  row for that person in that Congress. Each is a single term with no district.
#  Dudley Chase's made him 81 in a Congress he did not sit in, the oldest member
#  of the House for that year by ten years.
# ---------------------------------------------------------------------------

TERMS_LEFT_OUT = {
    # Directory: "a Senator from Vermont". Voteview: Senate only.
    ("C000325", "1853-12-05"),
    # Directory: "a Representative from Indiana". Voteview: 34th Congress only.
    ("C000980", "1853-12-05"),
    # Directory: "a Senator from Florida". Voteview: Senate only. The term is an
    # exact copy of Edward Gilbert's (G000172), the real representative.
    ("G000171", "1849-12-03"),
}

# ---------------------------------------------------------------------------

def load_people():
    people = []
    for name in ("legislators-current.json", "legislators-historical.json"):
        people.extend(json.loads((DATA / name).read_text(encoding="utf-8")))
    return [p for p in people if house_terms(p)]


def house_terms(p):
    return [t for t in p.get("terms", []) if t.get("type") == "rep"
            and (p["id"]["bioguide"], t.get("start")) not in TERMS_LEFT_OUT]


def congress_opens(n):
    """The constitutional start of Congress n."""
    year = 1789 + 2 * (n - 1)
    return f"{year}-03-04" if n <= 73 else f"{year}-01-03"


def iso(s):
    return date(*map(int, s.split("-")))


def placed(birth_date, precision):
    """Where to put a partial date, so the age lands within a year of truth."""
    d = iso(birth_date)
    if precision == "month":
        d = d.replace(day=15)
    elif precision == "year":
        d = d.replace(month=7, day=1)
    return d


def load_births(people):
    """
    Birth date, precision and source per member. Overrides beat upstream, and
    upstream beats the supplement.
    """
    with open(ROOT / "birthdays_supplement.csv", encoding="utf-8") as fh:
        supplement = {r["bioguide"]: r for r in csv.DictReader(fh)}
    with open(ROOT / "birthdays_overrides.csv", encoding="utf-8") as fh:
        overrides = {r["bioguide"]: r for r in csv.DictReader(fh)}

    out = {}
    for p in people:
        bg = p["id"]["bioguide"]
        upstream = p.get("bio", {}).get("birthday")
        if bg in overrides:
            o = overrides[bg]
            if o["action"] == "treat_undated":
                continue
            out[bg] = (placed(o["birth_date"], o["precision"]), o["precision"], "directory (override)")
        elif upstream:
            out[bg] = (iso(upstream), "day", "congress-legislators")
        elif bg in supplement:
            s = supplement[bg]
            host = s["source"].split("/")[2]
            source = {"www.govinfo.gov": "directory", "www.wikidata.org": "wikidata",
                      "voteview.com": "voteview"}[host]
            out[bg] = (placed(s["birth_date"], s["precision"]), s["precision"], source)
    return out


def convening_dates(terms):
    """
    The day each Congress sat: the modal start date among terms opening in its
    span. Term starts before 1935 can be months after the constitutional date.
    """
    dates = {}
    n = 1
    while congress_opens(n) <= AS_OF:
        lo, hi = congress_opens(n), congress_opens(n + 1)
        starts = Counter(t["start"] for _, t in terms if lo <= t["start"] < hi)
        if starts:
            dates[n] = starts.most_common(1)[0][0]
        n += 1
    return dates


def served_in(terms, n):
    """
    Everyone holding a term that overlaps Congress n. Half-open, because an
    expiring term ends on the date the next Congress opens. A person with two
    terms in one Congress keeps the later one, for its party and district.
    """
    lo, hi = congress_opens(n), congress_opens(n + 1)
    members = {}
    for p, t in terms:
        if t["start"] < hi and t["end"] > lo:
            key = p["id"]["bioguide"]
            if key not in members or t["start"] > members[key][1]["start"]:
                members[key] = (p, t)
    return list(members.values())


def full_name(p):
    n = p["name"]
    if n.get("official_full"):
        return n["official_full"]
    return " ".join(x.strip(" ,") for x in [n.get("first"), n.get("middle"), n.get("last")] if x)


def age_at(born, when):
    """Whole years, and the decimal form."""
    years = when.year - born.year - ((when.month, when.day) < (born.month, born.day))

    def anniversary(y):
        try:
            return born.replace(year=y)
        except ValueError:                   # born Feb 29
            return born.replace(year=y, day=28)

    last, nxt = anniversary(born.year + years), anniversary(born.year + years + 1)
    return years, round(years + (when - last).days / (nxt - last).days, 3)


def quantile(sorted_values, q):
    """Linear interpolation, the same method as d3.quantile in the page."""
    i = (len(sorted_values) - 1) * q
    lo = int(i)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (i - lo)


def write(path, cols, rows):
    try:
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
    except PermissionError:
        print(f"  SKIPPED {path.name}: locked by another process (Excel?)")
        return
    print(f"  wrote {path.name:24s} {len(rows):6,d} rows  {path.stat().st_size / 1e6:5.2f} MB")


def main():
    people = load_people()
    births = load_births(people)
    terms = [(p, t) for p in people for t in house_terms(p)]
    dates = convening_dates(terms)
    print(f"{len(people):,} people with House service; {len(births):,} have a birth date; "
          f"{len(dates)} Congresses, {dates[1]} to {dates[max(dates)]}")

    rows, missing, fell_through = [], [], Counter()
    for n in sorted(dates):
        when = iso(dates[n])
        for p, t in served_in(terms, n):
            bg = p["id"]["bioguide"]
            raw = t.get("party") or ""
            party = fold_party(raw, n)
            if party == OTHER:
                fell_through[raw] += 1
            rec = {"congress": n, "bioguide": bg, "name": full_name(p),
                   "state": t.get("state", ""), "district": t.get("district", ""),
                   "party": party, "party_raw": raw}
            if bg not in births:
                missing.append(rec)
                continue
            born, precision, _ = births[bg]
            years, exact = age_at(born, when)
            rec.update(age_years=years, age_exact=exact, age_precision=precision)
            rows.append(rec)

    write(ROOT / "house_ages.csv",
          ["congress", "bioguide", "name", "state", "district", "party", "party_raw",
           "age_years", "age_exact", "age_precision"], rows)

    # ── house_congresses.csv ──
    ages = defaultdict(list)
    for r in rows:
        ages[r["congress"]].append(r["age_exact"])
    dropped = Counter(r["congress"] for r in missing)
    approx = Counter(r["congress"] for r in rows if r["age_precision"] != "day")
    summary = []
    for n in sorted(dates):
        a = sorted(ages[n])
        summary.append({
            "congress": n, "convened": dates[n], "year": iso(dates[n]).year,
            "members": len(a) + dropped[n], "members_with_age": len(a),
            "missing_birthday": dropped[n], "approx_age": approx[n],
            "youngest": round(a[0], 1), "q1": round(quantile(a, .25), 2),
            "median": round(quantile(a, .5), 2), "q3": round(quantile(a, .75), 2),
            "oldest": round(a[-1], 1),
        })
    write(ROOT / "house_congresses.csv", list(summary[0]), summary)

    # ── house_members.csv — provenance for every date used ──
    members = []
    for p in sorted(people, key=lambda p: p["id"]["bioguide"]):
        bg = p["id"]["bioguide"]
        born = births.get(bg)
        members.append({
            "bioguide": bg, "name": full_name(p),
            "first_house_term": house_terms(p)[0]["start"],
            "birth_date_used": born[0].isoformat() if born else "",
            "precision": born[1] if born else "",
            "date_source": born[2] if born else "none",
        })
    write(ROOT / "house_members.csv", list(members[0]), members)

    write(ROOT / "house_missing.csv",
          ["congress", "bioguide", "name", "state", "district", "party", "party_raw"], missing)

    report(rows, missing, summary, fell_through, members)


def report(rows, missing, summary, fell_through, members):
    print(f"\n{len(rows):,} member-Congress observations; {len(missing):,} dropped "
          f"({len(missing) / (len(rows) + len(missing)):.2%}), "
          f"{sum(m['date_source'] == 'none' for m in members)} people")
    print("date sources:", Counter(m["date_source"] for m in members).most_common())
    print("party families:", Counter(r["party"] for r in rows).most_common())
    print("unrecorded by Congress:", sorted(Counter(
        r["congress"] for r in rows if r["party"] == UNRECORDED).items())[:14])
    print("fell through to Other:", fell_through.most_common())

    print("\nExtremes worth checking:")
    low = sorted((r for r in rows if r["age_years"] < 25), key=lambda r: r["age_years"])
    print(f"  under 25 when the Congress convened: {len(low)}")
    for r in low[:25]:
        print(f"    {r['age_years']:3d}  {r['congress']:3d}th  {r['name']} ({r['state']}) "
              f"[{r['age_precision']}]")
    high = sorted(rows, key=lambda r: -r["age_exact"])[:6]
    print("  oldest:", [(r["name"], r["age_years"], r["congress"]) for r in high])

    print("\nMedian age by Congress (every 10th):")
    for s in summary[::10] + [summary[-1]]:
        print(f"  {s['congress']:3d}th {s['year']}  {s['members']:3d} members  "
              f"median {s['median']:5.1f}  middle half {s['q1']:.1f}-{s['q3']:.1f}  "
              f"range {s['youngest']:.1f}-{s['oldest']:.1f}")
    print("Largest peak column:", max(Counter((r["congress"], r["age_years"]) for r in rows).values()))


if __name__ == "__main__":
    main()
