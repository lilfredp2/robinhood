# Ledger — static portfolio dashboard

A single-page portfolio dashboard built with plain HTML, CSS and one ES module.
No build step, no dependencies, no tracking.

## What's here

```
index.html            the page
assets/styles.css     design tokens, layout, light + dark themes
assets/app.js         data loading, charts, sortable holdings table
data/portfolio.json   all of the content the page renders
```

## Run it locally

The page fetches `data/portfolio.json`, so it needs to be served over HTTP —
opening `index.html` straight from the filesystem will be blocked by CORS.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

It is a static site, so anything that serves files will do. For GitHub Pages:
**Settings → Pages → Build and deployment → Deploy from a branch**, pick this
branch and the `/ (root)` folder. The `.nojekyll` file is already in place so
Pages serves the directory as-is.

## Using your own data

Replace `data/portfolio.json`. The shape is:

| Field | Meaning |
|---|---|
| `account.equity` / `.cash` / `.total` / `.buyingPower` | summary tiles and the hero number |
| `history[]` | `{ date, value, benchmark }` per trading day, oldest first |
| `holdings[]` | `{ symbol, name, sector, shares, cost, price, marketValue, costBasis, gain, gainPct, dayPct }` |
| `disclaimer` | free text shown in the footer |

The performance chart indexes `value` and `benchmark` to 100 at the start of the
selected range, so the two series share one y-axis regardless of their units.
Allocation is grouped from each holding's `sector`.

## Design notes

- **Themes.** Light and dark are separately specified token sets, not an
  inverted filter. The toggle cycles auto → light → dark and remembers the
  choice in `localStorage` (guarded, so blocked storage degrades to auto).
- **Charts.** Two series get both a legend and direct end labels; the
  allocation bars use a single hue because identity is carried by the row
  label, not the color. The categorical pair was validated for color-vision
  deficiency against both surfaces.
- **Gains and losses** are marked with an arrow and a sign as well as a color,
  so they never depend on color alone.
- **Access.** Skip link, visible focus rings, keyboard-reachable chart bars,
  sortable headers operable by Enter/Space, a table view under the performance
  chart, and `prefers-reduced-motion` / `forced-colors` handling.

## Data

`data/portfolio.json` contains **sample data for demonstration only**. It is not
investment advice and is not connected to any brokerage account.
