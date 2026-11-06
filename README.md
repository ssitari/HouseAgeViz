# Age of the U.S. House, 1789–2025

An interactive chart of how old members of the U.S. House of Representatives have been across all 119 Congresses. A line chart shows the age of the whole House over time. Below it, a dot plot shows every member of one Congress at a time.

**[View the live chart](https://ssitari.github.io/HouseAgeViz/)**

This is a first draft and a companion to [Senator Age Distribution](https://ssitari.github.io/SenateAgeHistogram/).

---

## Using the chart

- **Choose a Congress** by clicking or dragging along the line chart, with the ‹ › buttons, or with the left and right arrow keys once the chart has focus.
- **Hover over a dot** to name the member and draw their career on the line chart.
- **Line chart menu:** switch between the whole House (median, middle half and range) and one median line per party.
- **Compare menu:** set the grey shape behind the dots to all Congresses or the 20 before the selected one.
- **Members menu:** swap the dots for a table of the same members.

Dots are outlined when an age comes from a birth year or month rather than a full date.

## What counts as a member

A dot is one person in one Congress, and a member serving thirty years contributes fifteen dots.

**Everyone who served during a Congress is counted**, so a member and their mid-term replacement both appear, and a Congress can show more members than seats. The source's term dates are per Congress for most of history, so counting only those seated on opening day would include replacements before about the 1990s and exclude them after. Counting everyone treats all eras alike.

**Age is measured on the day the Congress convened**, including for members who joined later. That is why a few members appear younger than the constitutional minimum of 25. Some of those were genuinely seated underage.

**Non-voting delegates and resident commissioners are included.** They cannot be reliably separated for territories that later became states.

## Excluded people

**46 of the 11,463 people with House service have no usable birth date and are not drawn**, which removes 89 of 41,547 member-Congress rows (0.21%). All 46 served before 1860. The chart notes the count for any Congress they affect, and [house_missing.csv](house_missing.csv) lists the rows.

Three House terms are also left out because the Biographical Directory and Voteview both contradict them. They are listed with their evidence in `TERMS_LEFT_OUT` in [build_house_ages.py](build_house_ages.py):

| Member | Term in the source | Evidence |
|---|---|---|
| Dudley Chase | 33rd Congress, New York | Directory lists only Senate service, for Vermont; Voteview has no House service |
| William Cumback | 33rd Congress, New York | Directory lists only Indiana; Voteview has only the 34th Congress |
| Abijah Gilbert | 31st Congress, California | Directory lists only Senate service, for Florida; the term copies Edward Gilbert's |

## Where the birth dates come from

Membership and most birth dates come from [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) (public domain). It has no birth date for 501 people, nearly all from before 1860, so those were recovered by comparing three sources:

- the [Biographical Directory of the United States Congress, 1774–2005](https://www.govinfo.gov/app/details/GPO-CDOC-108hdoc222) (H. Doc. 108-222), the official record, which also says when a date is approximate or unknown
- [Voteview](https://voteview.com/data), which gives a birth year per member, keyed by Bioguide ID. It may not be independent of the directory.
- [Wikidata](https://www.wikidata.org) (CC0), using the item ID that congress-legislators gives for each person

Source of the date used for each of the 11,463 people, also recorded per person in [house_members.csv](house_members.csv):

| Source of the date | People |
|---|---:|
| congress-legislators | 10,956 |
| Biographical Directory | 333 |
| Wikidata | 112 |
| Voteview | 12 |
| Biographical Directory, replacing an impossible congress-legislators date | 4 |
| None (excluded) | 46 |

### How conflicts were settled

Of the 501 people with no date, 457 were recovered:

| Basis | People |
|---|---:|
| Two or more sources agree | 386 |
| Sources differ, two of three agree | 29 |
| One source only (Wikidata) | 42 |
| Not recovered | 44 |

A day or month from Wikidata is used only when its year agrees with the year chosen. Partial dates are placed at mid-year or mid-month, and 412 of the recovered dates are year or month only. Every value each source gave is kept in [birthdays_supplement.csv](birthdays_supplement.csv), and rows that deserve a second look are in [birthdays_review.csv](birthdays_review.csv).

The largest open conflict is John Swanwick, at 1740 in the directory and Wikidata and 1760 in Voteview.

### Impossible dates in the source

Six congress-legislators birth dates imply an age of 21 or younger at a member's first term, and two of them fall on that member's own term start date. [birthdays_overrides.csv](birthdays_overrides.csv) records what replaces them: the directory's year for four, where Voteview agrees, and no date for two, where the directory says "unknown". Those two are among the 46 excluded people.

## Parties

Party is taken per term and folded into the families used in the Senate chart, plus "No party recorded" for terms with no party in the source, which covers most of the first three Congresses.

"Republican" names two unrelated parties in this source. In House terms the label for Jefferson's party runs through the 23rd Congress and is absent from the 24th to the 33rd. It returns in the 34th (1855) as the modern party, so `build_house_ages.py` treats it as Democratic-Republican through the 33rd.

The 100 members of the 34th Congress labelled "Ind. Republican-Democrat" are counted as Other, so the Republican line begins in the 35th.

## Running it

The page uses ES modules and `fetch`, so it has to be served over HTTP:

```bash
python3 -m http.server 8000
```

To rebuild the data:

```bash
python3 recover_birthdays.py   # first run downloads about 45 MB into data/; needs pdftotext
python3 build_house_ages.py
```

`recover_birthdays.py --refresh` downloads the sources again, which can change the results. That path has not yet been tested end to end.

## Acknowledgements

Most of the code written with assistance from [Claude](https://claude.ai) (Anthropic).
