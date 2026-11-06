// ============================================================
//  config.js  —  Settings for the page
// ============================================================
//
//  Two linked views:
//
//    line chart — the age of the whole House across every Congress.
//    histogram  — one Congress at a time: a dot per member, against a grey
//                 shape showing how a comparison population was aged.
//
//  Both read age as of the day that Congress convened.
//
// ============================================================

export const AGES_FILE     = './house_ages.csv';       // one row per member x Congress
export const CONGRESS_FILE = './house_congresses.csv'; // one row per Congress

export const FIELDS = {
  congress: 'congress',
  convened: 'convened',
  year:     'year',
  id:       'bioguide',
  name:     'name',
  state:    'state',
  district: 'district',
  party:    'party',
  partyRaw: 'party_raw',
  age:       'age_years',
  ageExact:  'age_exact',
  precision: 'age_precision',   // 'day' | 'month' | 'year'
  members:   'members',         // everyone who served, dated or not
  missing:   'missing_birthday',
  approx:    'approx_age',
  youngest:  'youngest',
  q1:        'q1',
  median:    'median',
  q3:        'q3',
  oldest:    'oldest',
};

// ============================================================
//  DEFAULTS
// ============================================================

// The Congress selected on load: 'last', or a Congress number.
export const DEFAULT_CONGRESS = 'last';

// 'chamber' — median, middle half and range of the whole House
// 'party'   — one median line per party family
export const DEFAULT_LINE_MODE = 'chamber';

// 'all'   — compare against every Congress, 1789 to now
// 'prior' — compare against the BASELINE_WINDOW Congresses before the selected one
export const DEFAULT_BASELINE = 'all';
export const BASELINE_WINDOW  = 20;

// A party needs this many members in a Congress before its median is drawn. A
// median of three people is an anecdote, and it would make the line jump.
export const PARTY_LINE_MIN = 10;

// The age axis for the party view, whose medians span far less than the full range.
export const PARTY_AGE_DOMAIN = [30, 70];

// ============================================================
//  COLOR
//  The Senate chart's families, plus a neutral for terms with no party recorded.
//  Order here is the legend order and the within-column stacking order.
// ============================================================

export const PARTY_COLORS = [
  { id: 'Federalist',            label: 'Federalist',            color: '#6a51a3', line: true },
  { id: 'Democratic-Republican', label: 'Democratic-Republican', color: '#41ab5d', line: true },
  { id: 'Whig',                  label: 'Whig',                  color: '#a63603', line: true },
  { id: 'Democratic',            label: 'Democratic',            color: '#3182bd', line: true },
  { id: 'Republican',            label: 'Republican',            color: '#cb181d', line: true },
  { id: 'Other',                 label: 'Other / Independent',   color: '#009e9e', line: false },
  { id: 'Unrecorded',            label: 'No party recorded',     color: '#a8a59d', line: false },
];

// Line chart: one hue, light to dark, so the bands read as nested parts of one
// distribution.
export const RANGE_FILL   = '#e9eef4';
export const MIDDLE_FILL  = '#c5d3e2';
export const MEDIAN_COLOR = '#2f4f75';

// Reference layer in the histogram. Deliberately quiet.
export const SILHOUETTE_FILL   = '#e2e0db';
export const SILHOUETTE_STROKE = '#c2bfb8';

// The selected Congress, and a hovered member's career.
export const SELECTED_COLOR = '#1a1a1a';
export const CAREER_COLOR   = '#1a1a1a';

// ============================================================
//  LAYOUT
// ============================================================

export const DOT_GAP = 1.5;       // surface gap between neighbouring dots, px
export const DOT_MIN = 2;         // dots never render smaller than this diameter

// Share of the space under the header given to the histogram. It is a ceiling:
// the panel takes only the height its dots need, and the line chart gets the rest.
export const HIST_SHARE = 0.42;
export const HIST_MIN_HEIGHT = 170;
